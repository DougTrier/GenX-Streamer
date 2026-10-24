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

//! Searching the archive catalog: search metadata, word matching, cartoons and
//! music, match ranking and the query itself.

use super::*;

/// Versioned value inside the existing bounded search_text column. Legacy flat
/// aliases remain readable; refresh upgrades only the explicitly fetched item.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchMetadata {
    pub title: String,
    pub series: String,
    pub subjects: String,
    pub collections: String,
    pub description: String,
    pub languages: Vec<String>,
    #[serde(default)]
    pub provider_type: String,
    #[serde(default)]
    pub artwork: Option<Artwork>,
}

pub(super) const SEARCH_METADATA_PREFIX: &str = "@genx-search-v3:";

pub(crate) fn encode_search_metadata(value: &SearchMetadata) -> Result<String, String> {
    validate_search_metadata(value)?;
    let body = serde_json::to_string(value).map_err(|_| "archive-search-metadata-invalid")?;
    let value = format!("{SEARCH_METADATA_PREFIX}{body}");
    if value.len() > 16384 {
        return Err("archive-search-metadata-limit".into());
    }
    Ok(value)
}

pub(super) fn validate_search_metadata(m: &SearchMetadata) -> Result<(), String> {
    if (!m.title.is_empty() && !text(&m.title, 512))
        || m.languages.len() > 16
        || m.languages.iter().any(|s| !text(s, 128))
        || [&m.series, &m.subjects, &m.collections]
            .iter()
            .any(|s| s.len() > 16384 || s.chars().any(|c| c.is_control() && c != '\n'))
        || m.provider_type.len() > 1024
        || m.provider_type.chars().any(|c| c.is_control() && c != '\n')
        || m.artwork.as_ref().is_some_and(|art| !art.validate())
        || m.description.len() > 4096
        || m.description.chars().any(char::is_control)
    {
        return Err("archive-search-metadata-invalid".into());
    }
    Ok(())
}

pub(super) fn decode_search_metadata(value: &str) -> Result<Option<SearchMetadata>, String> {
    if value.len() > 16384 {
        return Err("archive-search-metadata-limit".into());
    }
    let Some(body) = value
        .strip_prefix(SEARCH_METADATA_PREFIX)
        .or_else(|| value.strip_prefix("@genx-search-v2:"))
    else {
        return Ok(None);
    };
    let m: SearchMetadata =
        serde_json::from_str(body).map_err(|_| "archive-search-metadata-invalid")?;
    validate_search_metadata(&m)?;
    Ok(Some(m))
}

pub(super) fn words(value: &str) -> Vec<String> {
    fold(value)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

// Matching and relevance share word boundaries and the existing bounded
// name alias, never arbitrary substring/stemming. Possessive punctuation does
// not make an otherwise equivalent programme title a weaker language tier.
pub(super) fn search_words(value: &str) -> Vec<String> {
    static POSSESSIVE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let possessive = POSSESSIVE.get_or_init(|| {
        regex::Regex::new(r"(?u)\b([\p{L}\p{N}]{4,})['’]s\b")
            .expect("constant Archive possessive grammar")
    });
    words(&possessive.replace_all(&fold(value), "$1"))
}

pub(super) fn word_matches(candidate: &str, query: &str) -> bool {
    candidate == query
        || (query.chars().count() >= 4 && candidate.strip_suffix('s') == Some(query))
        || (candidate.chars().count() >= 4 && query.strip_suffix('s') == Some(candidate))
}

pub(super) fn same_words(candidate: &[String], query: &[String]) -> bool {
    candidate.len() == query.len() && candidate.iter().zip(query).all(|(a, b)| word_matches(a, b))
}

pub(super) fn meaningful_match(value: &str, query: &str) -> bool {
    let haystack = search_words(value);
    let tokens = search_words(query);
    !tokens.is_empty()
        && tokens.iter().all(|t| {
            if matches!(
                t.as_str(),
                "cartoon" | "cartoons" | "animation" | "animated"
            ) {
                haystack.iter().any(|w| {
                    matches!(
                        w.as_str(),
                        "cartoon" | "cartoons" | "animation" | "animated"
                    )
                })
            } else {
                haystack.iter().any(|w| word_matches(w, t))
            }
        })
}

pub(super) fn subject_match(value: &str, query: &str) -> bool {
    // YouTube's broad category includes live action, vlogs and news. Its
    // literal "Film & Animation" label does not establish cartoon content.
    value.split([';', ',', '\n']).any(|label| {
        let label_words = words(label);
        let boilerplate =
            label_words == ["film", "animation"] || label_words == ["film", "and", "animation"];
        !boilerplate && meaningful_match(label, query)
    })
}

pub(crate) fn cartoon_query(query: &str) -> bool {
    matches!(
        query.trim().to_ascii_lowercase().as_str(),
        "cartoon" | "cartoons" | "animation" | "animated"
    )
}

pub(super) fn animation_collection(value: &str) -> bool {
    value.lines().any(|label| {
        matches!(
            label.trim(),
            "animationandcartoons" | "classic_cartoons" | "animation_unsorted"
        )
    })
}

pub(super) fn music_performance(subjects: &str, title: &str) -> bool {
    subjects.split([';', ',', '\n']).any(|label| {
        matches!(
            words(label).join(" ").as_str(),
            "live performance"
                | "music video"
                | "concert"
                | "concerts"
                | "live music"
                | "local music"
                | "show gig"
                | "one man band"
        )
    }) || words(title).windows(2).any(|pair| pair == ["live", "at"])
}

pub(super) fn cartoon_basis(
    title: &str,
    metadata: Option<&SearchMetadata>,
    query: &str,
) -> Option<&'static str> {
    let title_evidence = meaningful_match(title, query)
        || metadata.is_some_and(|m| meaningful_match(&m.title, query));
    let series_evidence = metadata.is_some_and(|m| meaningful_match(&m.series, query));
    let category = metadata.is_some_and(|m| animation_collection(&m.collections));
    // A title keyword can name a band/song or a school concert. In music
    // context require a separate animation claim, not a repeated cartoon tag.
    let animation_corroboration = metadata.is_some_and(|m| {
        category
            || m.subjects
                .split([';', ',', '\n'])
                .chain(m.provider_type.split([';', ',', '\n']))
                .any(|label| {
                    matches!(
                        words(label).join(" ").as_str(),
                        "animation"
                            | "animated short"
                            | "animated shorts"
                            | "animated film"
                            | "animated series"
                    )
                })
    });
    if metadata.is_some_and(|m| {
        music_performance(&m.subjects, if title.is_empty() { &m.title } else { title })
    }) && !animation_corroboration
    {
        return None;
    }
    if title_evidence {
        return Some("title");
    }
    if series_evidence {
        return Some("series");
    }
    if metadata.is_some_and(|m| subject_match(&m.subjects, query)) {
        return Some("subject");
    }
    // This exact provider taxonomy is genre evidence, not arbitrary collection
    // text matching and not verified work identity or audio language.
    category.then_some("genre")
}

pub(super) fn incidental_named_match(
    title: &str,
    metadata: Option<&SearchMetadata>,
    query: &str,
) -> bool {
    // One ambiguous name in an interview, pet feature or live performance is
    // not evidence of the requested program. A specific multiword request can
    // still select that exact interview/band, and blank browsing stays intact.
    let query_words = search_words(query);
    if query_words.len() != 1
        || same_words(&search_words(title), &query_words)
        // Asking for the context itself is not an incidental-name search.
        || matches!(query_words[0].as_str(), "interview" | "interviews" | "concert" | "concerts" | "music" | "live" | "band" | "pet" | "pets" | "adopt")
    {
        return false;
    }
    let title_words = words(title);
    let context = music_performance(metadata.map_or("", |m| m.subjects.as_str()), title)
        || title.to_ascii_lowercase().contains("live @")
        || title_words
            .iter()
            .any(|w| w == "interview" || w == "interviews")
        || title_words.windows(3).any(|w| w == ["adopt", "a", "pet"]);
    context
        && !matches!(
            content_type(metadata),
            ContentType::Tv | ContentType::Movie | ContentType::Short
        )
}

pub(crate) fn match_basis(
    title: &str,
    aliases: &str,
    files: &str,
    query: &str,
) -> Result<Option<&'static str>, String> {
    if query.trim().is_empty() {
        return Ok(Some("browse"));
    }
    let metadata = decode_search_metadata(aliases)?;
    if cartoon_query(query) {
        return Ok(cartoon_basis(title, metadata.as_ref(), query));
    }
    // Legacy mixed aliases establish no typed metadata. Their actual saved
    // title can still disclose an incidental pet/interview/performance context;
    // use only that title, preserving blank and specifically named browsing.
    if incidental_named_match(
        if title.is_empty() {
            metadata.as_ref().map_or("", |m| m.title.as_str())
        } else {
            title
        },
        metadata.as_ref(),
        query,
    ) {
        return Ok(None);
    }
    if meaningful_match(title, query) {
        return Ok(Some("title"));
    }
    if let Some(m) = metadata {
        if meaningful_match(&m.title, query) {
            return Ok(Some("title"));
        }
        if meaningful_match(&m.series, query) {
            return Ok(Some("series"));
        }
        if subject_match(&m.subjects, query) {
            return Ok(Some("subject"));
        }
    }
    if meaningful_match(files, query) {
        return Ok(Some("file"));
    }
    Ok(None)
}

pub(crate) fn prepared_matches_query(title: &PreparedTitle, query: &str) -> Result<bool, String> {
    let files = title
        .files
        .iter()
        .map(|f| {
            format!(
                "{}\n{}",
                f.name,
                f.file_title.as_deref().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(match_basis(&title.title, &title.search_aliases, &files, query)?.is_some())
}

pub(super) fn search_phrase(value: &str) -> String {
    fold(value).split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn title_match_rank(title: &str, query: &str) -> u8 {
    let title = search_words(title);
    let query = search_words(query);
    if query.is_empty() {
        return 4;
    }
    if same_words(&title, &query) {
        0
    } else if title.len() > query.len() && same_words(&title[..query.len()], &query) {
        1
    } else if title
        .windows(query.len())
        .any(|part| same_words(part, &query))
    {
        2
    } else if query
        .iter()
        .all(|token| title.iter().any(|word| word_matches(word, token)))
    {
        3
    } else {
        4
    }
}

pub(crate) fn query(
    c: &Connection,
    q: &Query,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Page, String> {
    query_valid(q.schema_version, &q.request_id, q.offset, q.page_size, 1400)?;
    if !valid_decade(q.decade)
        || q.query.len() > 512
        || q.query.chars().any(char::is_control)
        || (q.offset > 0 && q.expected_revision.is_none())
    {
        return Err("archive-query-invalid".into());
    }
    let tx = sql(c.unchecked_transaction())?;
    let rev = current(&tx)?;
    if q.expected_revision
        .as_deref()
        .map(revision)
        .transpose()?
        .is_some_and(|r| r != rev)
    {
        return Err("archive-revision-stale".into());
    }
    let matched = query_matches(&tx, q, check)?;
    let total = matched.len();
    let items: Vec<Title> = matched
        .into_iter()
        .skip(q.offset)
        .take(q.page_size)
        .collect();
    check()?;
    sql(tx.commit())?;
    Ok(Page {
        schema_version: 1,
        revision: rev.to_string(),
        total_count: total,
        offset: q.offset,
        more: q.offset + items.len() < total,
        items,
    })
}

// Shared by public paging and discovery's atomic before/after visibility proof.
// Caller owns the read snapshot or IMMEDIATE write transaction. No nested BEGIN.
pub(super) fn query_matches(
    c: &Connection,
    q: &Query,
    check: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Vec<Title>, String> {
    let phrase = search_phrase(&q.query);
    let tokens: Vec<String> = phrase.split_whitespace().map(str::to_owned).collect();
    let mut read=sql(c.prepare("SELECT t.title_ref,t.title,t.kind,t.release_year,t.rights,t.observed_ms,(SELECT count(*) FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1),(SELECT CASE WHEN count(*)=1 THEN min(duration_seconds) ELSE NULL END FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1),ROW_NUMBER() OVER(PARTITION BY t.release_year ORDER BY t.downloads DESC,t.item_id),t.search_text,t.curated,(SELECT group_concat(file_name||char(10)||COALESCE(file_title,''),char(10)) FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1),COALESCE(p.favorite,0) FROM archive_title_v1 t LEFT JOIN archive_preferences_v1 p ON p.title_ref=t.title_ref WHERE (?1=0 OR t.curated=1) AND (?2 IS NULL OR t.release_year BETWEEN ?2 AND CASE WHEN ?2=2020 THEN 2100 ELSE ?2+9 END) AND (?3=0 OR COALESCE(p.favorite,0)=1) AND EXISTS(SELECT 1 FROM archive_file_v1 f WHERE f.title_ref=t.title_ref AND f.eligible=1) ORDER BY COALESCE(p.favorite,0) DESC,t.release_year,t.downloads DESC,t.item_id"))?;
    let mut rows = sql(read.query(params![q.curated_only, q.decade, q.favorites_only]))?;
    let mut matched = Vec::new();
    while let Some(r) = sql(rows.next())? {
        check()?;
        let search: String = sql(r.get(9))?;
        let filenames: String = sql(r.get(11))?;
        if search.len() > 16384 || filenames.len() > 1000 * 1538 {
            return Err("archive-search-metadata-limit".into());
        }
        let title: String = sql(r.get(1))?;
        let normalized_title = search_phrase(&title);
        let Some(basis) = match_basis(&title, &search, &filenames, &q.query)? else {
            continue;
        };
        let metadata = decode_search_metadata(&search)?;
        let content = content_type(metadata.as_ref());
        if q.content_type != ContentType::All && q.content_type != content {
            continue;
        }
        let languages = metadata
            .as_ref()
            .map(|m| m.languages.clone())
            .unwrap_or_default();
        if !q.language_mode.includes(&languages) {
            continue;
        }
        let subjects = metadata
            .as_ref()
            .map(|m| {
                m.subjects
                    .lines()
                    .map(str::trim)
                    .filter(|s| text(s, 128))
                    .take(16)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let description = metadata
            .as_ref()
            .map(|m| m.description.trim())
            .filter(|s| text(s, 2048) && !s.contains("://") && !s.contains('<') && !s.contains('>'))
            .map(str::to_owned);
        let stored_kind: String = sql(r.get(2))?;
        let kind = match content {
            ContentType::Tv => "tv".to_owned(),
            ContentType::Movie | ContentType::Short => "movie".to_owned(),
            _ => stored_kind,
        };
        let relevance = match basis {
            "title" => title_match_rank(&normalized_title, &phrase),
            "series" => 4,
            "subject" | "genre" => 5,
            "file" => 6,
            _ => 7,
        };
        let listed_year = sql(r.get(3))?;
        let date_assessment = crate::archive_date_assessment::from_legacy_year(listed_year)?;
        matched.push((
            relevance,
            normalized_title,
            Title {
                title_ref: sql(r.get(0))?,
                title,
                title_provenance: "provider-item",
                language_provenance: if languages.is_empty() {
                    "unknown"
                } else {
                    "provider-item"
                },
                provider_languages: languages,
                provider_subjects: subjects,
                provider_description: description,
                match_basis: basis,
                kind,
                content_type: content,
                content_type_provenance: if content == ContentType::Unknown {
                    "unknown"
                } else {
                    "provider-item"
                },
                provider_series: metadata
                    .as_ref()
                    .map(|m| m.series.trim())
                    .filter(|s| text(s, 512) && !s.contains('\n'))
                    .map(str::to_owned),
                artwork: metadata
                    .as_ref()
                    .and_then(|m| m.artwork.as_ref())
                    .map(Artwork::info),
                release_year: listed_year,
                date_assessment: Some(date_assessment),
                curated: sql(r.get(10))?,
                favorite: sql(r.get(12))?,
                rights: sql(r.get(4))?,
                observed_ms: sql(r.get(5))?,
                file_count: sql(r.get(6))?,
                duration_seconds: sql(r.get(7))?,
                rank: sql(r.get(8))?,
                quality: "metadata-h264",
                provider_id: None,
                source_url: None,
            },
        ));
        if matched.len() > 1400 {
            return Err("archive-title-limit".into());
        }
    }
    drop(rows);
    drop(read);
    check()?;
    for item in crate::archive_provider_catalog::query_rows(c, q, check)? {
        let normalized = search_phrase(&item.title);
        let relevance = match item.match_basis {
            "title" => title_match_rank(&normalized, &phrase),
            "series" => 4,
            "subject" | "genre" => 5,
            "file" => 6,
            _ => 7,
        };
        matched.push((relevance, normalized, item));
        if matched.len() > 1400 {
            return Err("archive-title-limit".into());
        }
    }
    // Unicode normalization stays consistent with literal token matching.
    // Sort the bounded native matches before slicing, within this same read
    // snapshot; do not rank a frontend page or infer identity from filenames.
    // Blank browsing retains SQL's per-year popularity and item-id order.
    if !tokens.is_empty() {
        matched.sort_unstable_by(|a, b| {
            b.2.favorite
                .cmp(&a.2.favorite)
                .then_with(|| a.0.cmp(&b.0))
                .then_with(|| {
                    q.language_mode
                        .rank(&a.2.provider_languages)
                        .cmp(&q.language_mode.rank(&b.2.provider_languages))
                })
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.title_ref.cmp(&b.2.title_ref))
        });
    } else if q.language_mode == LanguageMode::EnglishFirst {
        // Stable sorting keeps the original per-year popularity/item order
        // within each favorite/language tier, before native pagination.
        matched.sort_by_key(|(_, _, item)| {
            (
                !item.favorite,
                q.language_mode.rank(&item.provider_languages),
            )
        });
    }
    Ok(matched.into_iter().map(|(_, _, item)| item).collect())
}
