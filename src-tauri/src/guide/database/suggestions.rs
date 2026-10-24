// Copyright 2026 Doug Trier
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Guide suggestions: matching channel names to guide channels.

use super::*;

pub(super) fn exact_name(value: &str) -> String {
    // ECMAScript whitespace, matching the shared NFKC display-name helper (NEL is not whitespace there).
    normalized(value).split(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

pub(super) fn insert_channel_names(
    c: &Connection,
    source: &str,
    id: &str,
    names: &[String],
) -> Result<(), String> {
    valid_text(source, 256, true)?;
    valid_text(id, 16_384, true)?;
    if names.is_empty() || names.len() > 32 {
        return Err("guide-invalid-stored-channel".into());
    }
    let mut insert = sql(c.prepare("INSERT INTO guide_channel_name VALUES(?1,?2,?3,?4,?5)"))?;
    for (ordinal, name) in names.iter().enumerate() {
        valid_text(name, 512, true)?;
        sql(insert.execute(params![source, id, ordinal as i64, name, exact_name(name)]))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuideSuggestionQuery {
    pub guide_source_id: String,
    pub expected_source_revision: i64,
    pub expected_published_revision: Option<i64>,
    pub provider_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SuggestionMatch {
    ProviderId,
    DisplayName,
    Ambiguous,
    Unmatched,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionCacheStatus {
    Current,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSuggestionCandidate {
    pub xmltv_channel_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSuggestions {
    pub source_revision: i64,
    pub published_revision: Option<i64>,
    pub cache_status: SuggestionCacheStatus,
    pub r#match: SuggestionMatch,
    pub candidate_count: i64,
    pub candidates_preview: Vec<GuideSuggestionCandidate>,
    pub preview_complete: bool,
    pub review_required: bool,
}

/// Counts all exact matches via indexes, returning at most twenty labels for explicit review.
pub fn lookup_suggestions(
    c: &Connection,
    query: &GuideSuggestionQuery,
) -> Result<GuideSuggestions, String> {
    valid_text(&query.guide_source_id, 256, true)?;
    valid_text(&query.name, 512, true)?;
    if let Some(provider) = &query.provider_id {
        valid_text(provider, 16_384, true)?;
    }
    let tx = sql(c.unchecked_transaction())?;
    let (source_revision, published_revision): (i64, Option<i64>) = sql(tx.query_row(
        "SELECT revision,published_revision FROM guide_source WHERE id=?1",
        [&query.guide_source_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    if source_revision != query.expected_source_revision
        || published_revision != query.expected_published_revision
    {
        return Err("guide-stale-revision".into());
    }
    let mut result = GuideSuggestions {
        source_revision,
        published_revision,
        cache_status: SuggestionCacheStatus::Current,
        r#match: SuggestionMatch::Unmatched,
        candidate_count: 0,
        candidates_preview: Vec::new(),
        preview_complete: true,
        review_required: true,
    };
    if published_revision.is_none() {
        result.cache_status = SuggestionCacheStatus::Unavailable;
    } else if published_revision != Some(source_revision) {
        result.cache_status = SuggestionCacheStatus::Stale;
    } else {
        let provider_exists = if let Some(provider) = &query.provider_id {
            sql(tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM guide_channel WHERE guide_source_id=?1 AND id=?2)",
                params![query.guide_source_id, provider],
                |r| r.get::<_, bool>(0),
            ))?
        } else {
            false
        };
        let (condition, value) = if provider_exists {
            (
                "id=?2",
                query.provider_id.as_deref().unwrap_or_default().to_owned(),
            )
        } else {
            (
                "id IN(SELECT channel_id FROM guide_channel_name WHERE guide_source_id=?1 AND normalized_name=?2)",
                exact_name(&query.name),
            )
        };
        result.candidate_count = sql(tx.query_row(
            &format!("SELECT count(*) FROM guide_channel WHERE guide_source_id=?1 AND {condition}"),
            params![query.guide_source_id, value],
            |r| r.get(0),
        ))?;
        result.r#match = if provider_exists {
            SuggestionMatch::ProviderId
        } else if result.candidate_count == 1 {
            SuggestionMatch::DisplayName
        } else if result.candidate_count > 1 {
            SuggestionMatch::Ambiguous
        } else {
            SuggestionMatch::Unmatched
        };
        let mut statement=sql(tx.prepare(&format!("SELECT id,(SELECT name FROM guide_channel_name n WHERE n.guide_source_id=g.guide_source_id AND n.channel_id=g.id AND n.ordinal=0) FROM guide_channel g WHERE guide_source_id=?1 AND {condition} ORDER BY id LIMIT 20")))?;
        let rows = sql(
            statement.query_map(params![query.guide_source_id, value], |r| {
                Ok(GuideSuggestionCandidate {
                    xmltv_channel_id: column_text(r, 0, 16_384)?,
                    display_name: column_text(r, 1, 512)?,
                })
            }),
        )?;
        result.candidates_preview = sql(rows.collect())?;
        result.preview_complete = result.candidate_count <= 20;
    }
    sql(tx.commit())?;
    Ok(result)
}
