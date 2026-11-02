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

//! Explicit provider PPV markers, shared by channel and programme queries.
//! A paid subscription, sport, league, team or event name alone is not PPV.
use rusqlite::{functions::FunctionFlags, Connection};
use unicode_normalization::UnicodeNormalization;

pub(crate) fn marked(text: &str) -> bool {
    let folded = text.nfkc().collect::<String>().to_lowercase();
    static BREAKS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let words: Vec<&str> = BREAKS
        .get_or_init(|| regex::Regex::new(r"[^\p{L}\p{N}]+").expect("fixed PPV token boundaries"))
        .split(&folded)
        .filter(|s| !s.is_empty())
        .collect();
    words.iter().any(|word| {
        *word == "payperview"
            || word.strip_prefix("ppv").is_some_and(|suffix| {
                suffix.is_empty() || suffix.bytes().all(|c| c.is_ascii_digit())
            })
    }) || words
        .windows(3)
        .any(|w| w == ["pay", "per", "view"] || w == ["p", "p", "v"])
}

pub(crate) fn register(c: &Connection) -> Result<(), String> {
    c.create_scalar_function(
        "genx_ppv",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(
                marked(ctx.get::<Option<String>>(0)?.as_deref().unwrap_or_default())
                    || marked(ctx.get::<Option<String>>(1)?.as_deref().unwrap_or_default()),
            )
        },
    )
    .map_err(|error| {
        crate::storage_transaction::sql_error_code(&error, "ppv-query-storage-failed")
    })?;
    c.create_scalar_function(
        "genx_ppv_program",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let title = ctx.get::<Option<String>>(0)?.unwrap_or_default();
            let categories = ctx.get::<Option<String>>(1)?.unwrap_or_else(|| "[]".into());
            if categories.len() > 32768 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let categories: Vec<crate::guide::category::GuideCategory> =
                serde_json::from_str(&categories).map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(marked(&title) || categories.iter().any(|v| marked(&v.text)))
        },
    )
    .map_err(|error| crate::storage_transaction::sql_error_code(&error, "ppv-query-storage-failed"))
}

/// Original category remains evidence even after a user categorizes the row.
pub(crate) fn channel(name: &str, original: &str, effective: &str) -> String {
    format!("(genx_ppv({name},{original}) OR genx_ppv('',{effective}))")
}

/// Any exact-group alias can supply PPV evidence even when its representative
/// lacks that label. User category/favorite/mapping partitions remain intact.
pub(crate) fn groups_cte() -> String {
    let evidence = channel("pc.name", "pc.category", "pm.custom_category");
    format!("{}, ppv_groups AS MATERIALIZED(SELECT pm.endpoint_key,pm.preferred,pm.custom_category,pm.guide_source,pm.guide_channel,MAX({evidence}) AS ppv FROM endpoint_members pm JOIN channel pc ON pc.id=pm.channel_id GROUP BY pm.endpoint_key,pm.preferred,pm.custom_category,pm.guide_source,pm.guide_channel) ", crate::catalog_endpoint_projection::MEMBERS_CTE.trim_end())
}

pub(crate) fn same_group(left: &str, right: &str) -> String {
    crate::catalog_endpoint_projection::SAME_GROUP
        .replace("am.", &format!("{left}."))
        .replace("em.", &format!("{right}."))
}

/// Indexed alias lookup for a small set of requested programme channels. This
/// avoids rebuilding the global ROW_NUMBER/group projection for every row read.
pub(crate) fn indexed_channel_group(channel_alias: &str) -> String {
    let custom = |a: &str| {
        format!("(SELECT category FROM channel_category_override WHERE channel_id={a}.id)")
    };
    let favorite = |a: &str| format!("EXISTS(SELECT 1 FROM favorite WHERE id={a}.id)");
    let mapping = |a: &str, field: &str| {
        format!("(SELECT {field} FROM guide_mapping WHERE catalog_source_id={a}.source_id AND app_channel_id={a}.id)")
    };
    let evidence = channel("pc.name", "pc.category", &custom("pc"));
    format!("EXISTS(SELECT 1 FROM catalog_endpoint_projection_v1 pe JOIN channel pc ON pc.id=pe.channel_id WHERE pe.endpoint_key=(SELECT endpoint_key FROM catalog_endpoint_projection_v1 WHERE channel_id={channel_alias}.id) AND {}={} AND {} IS {} AND {} IS {} AND {} IS {} AND NOT EXISTS(SELECT 1 FROM removed WHERE id=pc.id) AND {evidence})",favorite("pc"),favorite(channel_alias),custom("pc"),custom(channel_alias),mapping("pc","guide_source_id"),mapping(channel_alias,"guide_source_id"),mapping("pc","xmltv_channel_id"),mapping(channel_alias,"xmltv_channel_id"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_bounded_markers_classify_ppv() {
        for text in [
            "PPV",
            "US | NFL PPV",
            "PPV01 HD",
            "ＰＰＶ 3",
            "P.P.V. Boxing",
            "Pay-Per-View",
            "PAY PER VIEW 2",
            "PayPerView",
            "Sports / PPV 17",
            "PPV\u{0345}",
        ] {
            assert!(marked(text), "{text}");
        }
        for text in [
            "",
            "PPVision",
            "HappyView",
            "paid",
            "Premium Sports",
            "UFC",
            "WWE",
            "NFL Football: Bears at Saints",
            "NBA Finals",
            "Live Event 17",
            "pay per viewpoint",
            "PPVHD",
            "appv",
            "ppv2x",
            "P\u{0345}PV",
        ] {
            assert!(!marked(text), "{text}");
        }
    }

    #[test]
    fn programme_classification_uses_category_text_and_rejects_malformed_metadata() {
        let c = Connection::open_in_memory().unwrap();
        register(&c).unwrap();
        let classified = |title: &str, categories: &str| {
            c.query_row("SELECT genx_ppv_program(?1,?2)", [title, categories], |r| {
                r.get::<_, bool>(0)
            })
        };
        assert!(!classified("UFC Countdown", r#"[{"text":"Sports","language":"ppv"}]"#).unwrap());
        assert!(classified(
            "UFC Countdown",
            r#"[{"text":"Pay-Per-View","language":"en"}]"#
        )
        .unwrap());
        assert!(classified("PPV17", "[]").unwrap());
        assert!(classified("UFC", "invalid").is_err());
    }
}
