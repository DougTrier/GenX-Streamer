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

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuideCategory {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}
pub fn normalized(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn admit(
    out: &mut Vec<GuideCategory>,
    text: String,
    language: Option<String>,
) -> Result<(), String> {
    if out.len() >= 32 {
        return Err("Guide program exceeds its category count limit.".into());
    }
    if text.trim().is_empty()
        || text.len() > 512
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err("Guide category text is empty, invalid or too long.".into());
    }
    if language.as_ref().is_some_and(|v| {
        v.is_empty() || v.len() > 32 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return Err("Guide category language is invalid.".into());
    }
    if out
        .iter()
        .map(|v| v.text.len())
        .sum::<usize>()
        .saturating_add(text.len())
        > 4096
    {
        return Err("Guide program exceeds its category byte limit.".into());
    }
    out.push(GuideCategory { text, language });
    Ok(())
}
pub fn canonicalize(raw: Vec<GuideCategory>) -> Result<Vec<GuideCategory>, String> {
    let mut admitted = Vec::new();
    for v in raw {
        admit(&mut admitted, v.text, v.language)?;
    }
    let mut keys = BTreeMap::new();
    for mut v in admitted {
        v.text = v
            .text
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .to_owned();
        let key = (
            normalized(&v.text),
            v.language.as_ref().map(|v| v.to_ascii_lowercase()),
        );
        if key.0.is_empty() {
            return Err("Guide category normalized text is empty.".into());
        }
        keys.entry(key).or_insert(v);
    }
    Ok(keys.into_values().collect())
}
pub fn semantic_pairs(categories: &[GuideCategory]) -> Vec<(String, Option<String>)> {
    let mut keys = categories
        .iter()
        .map(|v| {
            (
                normalized(&v.text),
                v.language.as_ref().map(|v| v.to_ascii_lowercase()),
            )
        })
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}
pub fn semantic_key(categories: &[GuideCategory]) -> Result<String, String> {
    serde_json::to_string(&semantic_pairs(categories))
        .map_err(|_| "Guide category encoding failed.".into())
}
pub fn search_text(title: &str, description: Option<&str>, categories: &[GuideCategory]) -> String {
    format!(
        "{} {} {}",
        title,
        description.unwrap_or(""),
        categories
            .iter()
            .map(|v| match normalized(&v.text).as_str() {
                "kids" | "children" | "children's" | "childrens" =>
                    "kids children children's childrens",
                "animation" | "cartoon" | "cartoons" => "animation cartoon cartoons",
                _ => v.text.as_str(),
            })
            .collect::<Vec<_>>()
            .join(" ")
    )
    .nfkc()
    .collect::<String>()
    .to_lowercase()
    .split(|c: char| c.is_whitespace() || c == '\u{feff}')
    .filter(|v| !v.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

#[cfg(test)]
#[path = "category_tests.rs"]
mod tests;
