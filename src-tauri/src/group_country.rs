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

//! Deterministic country of a paid provider's channel group, such as
//! "UK ➾ Sport", "Germany", "US Roku ➾ News" or "Turky". Codes are those of
//! the app's official country list (ISO 3166-1 alpha-2, with UK for the United
//! Kingdom). Regional or language groups ("EX-YU", "Arabic", "Africa") and
//! anything unrecognized have no country.
use std::collections::HashMap;
use std::sync::OnceLock;

const COUNTRIES: &str = include_str!("../../src/location/countries.json");
/// Spellings providers use that are not the official English name.
const ALIASES: &[(&str, &str)] = &[
    ("uk", "UK"),
    ("gb", "UK"),
    ("gbr", "UK"),
    ("england", "UK"),
    ("greatbritain", "UK"),
    ("britain", "UK"),
    ("usa", "US"),
    ("america", "US"),
    ("unitedstatesofamerica", "US"),
    ("uae", "AE"),
    ("emirates", "AE"),
    ("ksa", "SA"),
    ("saudiarabien", "SA"),
    ("turky", "TR"),
    ("turkiye", "TR"),
    ("turkish", "TR"),
    ("kwait", "KW"),
    ("czech", "CZ"),
    ("czechrepublic", "CZ"),
    ("greek", "GR"),
    ("albanian", "AL"),
    ("shqiptare", "AL"),
    ("bosnienundherzegowina", "BA"),
    ("bosnia", "BA"),
    ("russia", "RU"),
    ("russian", "RU"),
    ("southkorea", "KR"),
    ("korea", "KR"),
    ("iran", "IR"),
    ("persian", "IR"),
    ("palestine", "PS"),
    ("palestinianterritories", "PS"),
    ("macedonia", "MK"),
    ("cotedivoire", "CI"),
    ("ivorycoast", "CI"),
    ("stkittsnevis", "KN"),
    ("vietnam", "VN"),
    ("deutschland", "DE"),
    ("german", "DE"),
    ("french", "FR"),
    ("italian", "IT"),
    ("spanish", "ES"),
    ("espana", "ES"),
    ("polish", "PL"),
    ("portuguese", "PT"),
    ("brasil", "BR"),
    ("dutch", "NL"),
    ("holland", "NL"),
    ("swedish", "SE"),
    ("norwegian", "NO"),
    ("danish", "DK"),
    ("finnish", "FI"),
    ("hungarian", "HU"),
    ("romanian", "RO"),
    ("bulgarian", "BG"),
    ("croatian", "HR"),
    ("serbian", "RS"),
    ("ukrainian", "UA"),
    ("indian", "IN"),
    ("hongkong", "HK"),
    ("taiwan", "TW"),
    ("syria", "SY"),
    ("moldova", "MD"),
    ("bolivia", "BO"),
    ("venezuela", "VE"),
    ("tanzania", "TZ"),
    ("laos", "LA"),
    ("newzealand", "NZ"),
];
/// Two-letter prefixes that IPTV panels commonly use for a language or region
/// rather than the ISO country with the same code.
const NOT_COUNTRY_PREFIXES: &[&str] = &["AR", "EX", "LA"];
const SEPARATORS: &[char] = &['➾', '|', '│', '▎', ':', '»', '►', '•', '/'];

struct Table {
    names: HashMap<String, String>,
    codes: HashMap<String, String>,
}
fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut names = HashMap::new();
        let mut codes = HashMap::new();
        let list: Vec<serde_json::Value> = serde_json::from_str(COUNTRIES).unwrap_or_default();
        for row in list {
            let (Some(code), Some(name)) = (row["code"].as_str(), row["name"].as_str()) else {
                continue;
            };
            codes.insert(code.to_owned(), name.to_owned());
            names.insert(fold(name), code.to_owned());
        }
        for (alias, code) in ALIASES {
            if codes.contains_key(*code) {
                names.insert((*alias).to_owned(), (*code).to_owned());
            }
        }
        Table { names, codes }
    })
}
/// Lowercase ASCII letters only, with common accents folded ("Côte d’Ivoire" →
/// "cotedivoire"); digits, emoji, brackets and spacing are dropped.
fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let folded = match ch {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => {
                'a'
            }
            'ç' | 'Ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
            'ñ' | 'Ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
            other if other.is_ascii_alphabetic() => other.to_ascii_lowercase(),
            _ => continue,
        };
        out.push(folded);
    }
    out
}
/// A leading code such as "UK", "DE" or "US Roku": two capital letters as
/// written, then a space or separator.
fn code_prefix(table: &Table, prefix: &str) -> Option<String> {
    let word = prefix.split_whitespace().next()?;
    if word.len() != 2 || !word.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    if NOT_COUNTRY_PREFIXES.contains(&word) {
        return Some(String::new());
    }
    // ISO's GB is the app's UK.
    if word == "GB" {
        return Some("UK".into());
    }
    table.codes.contains_key(word).then(|| word.to_owned())
}
/// The official English name of an app country code, used as its sort key.
pub(crate) fn country_name(code: &str) -> Option<String> {
    table().codes.get(code).cloned()
}
pub(crate) fn group_country(group: &str) -> Option<String> {
    let table = table();
    let trimmed = group.trim();
    let prefix = trimmed.split(SEPARATORS).next().unwrap_or(trimmed).trim();
    if let Some(code) = code_prefix(table, prefix) {
        return (!code.is_empty()).then_some(code);
    }
    for candidate in [trimmed, prefix] {
        if let Some(code) = table.names.get(&fold(candidate)) {
            return Some(code.clone());
        }
    }
    // "UK ➾ General [VIP]" style already matched; "Canada VIP" or "USA HD":
    // the first word alone.
    let first = prefix.split_whitespace().next().unwrap_or(prefix);
    table.names.get(&fold(first)).cloned()
}

#[cfg(test)]
mod tests {
    use super::group_country;
    fn of(group: &str) -> Option<&'static str> {
        group_country(group).map(|code| &*Box::leak(code.into_boxed_str()))
    }
    #[test]
    fn provider_group_names_resolve_to_countries() {
        for (group, code) in [
            ("UK ➾ Sport [VIP]", "UK"),
            ("UK  ➾ News [VIP]", "UK"),
            ("United Kingdom", "UK"),
            ("DE ➾  Kino", "DE"),
            ("Germany", "DE"),
            ("US Roku ➾ News", "US"),
            ("USA", "US"),
            ("FRANCE", "FR"),
            ("Turky", "TR"),
            ("kwait", "KW"),
            ("NewZealand", "NZ"),
            ("czech", "CZ"),
            ("Greek", "GR"),
            ("Saudi Arabien", "SA"),
            ("Bosnien und Herzegowina", "BA"),
            ("Côte d’Ivoire", "CI"),
            ("UAE", "AE"),
            ("ES➾ Música", "ES"),
            ("ZA ➾ DSTV Sport", "ZA"),
            ("Canada", "CA"),
        ] {
            assert_eq!(of(group), Some(code), "{group}");
        }
    }
    #[test]
    fn every_united_kingdom_form_is_the_apps_uk() {
        for group in [
            "GB",
            "GBR",
            "UK",
            "United Kingdom",
            "Great Britain",
            "GB ➾ Sport",
            "GBR ➾ News",
        ] {
            assert_eq!(of(group), Some("UK"), "{group}");
        }
        for group in ["US", "USA", "United States", "US ➾ NFL"] {
            assert_eq!(of(group), Some("US"), "{group}");
        }
    }
    #[test]
    fn case_and_spacing_do_not_change_the_result() {
        for group in [
            "gb",
            "GBR ",
            "  united kingdom",
            "UNITED KINGDOM",
            "United  Kingdom",
        ] {
            assert_eq!(of(group), Some("UK"), "{group:?}");
        }
    }
    #[test]
    fn results_are_always_official_codes() {
        let official: Vec<serde_json::Value> = serde_json::from_str(super::COUNTRIES).unwrap();
        for (_, code) in super::ALIASES {
            assert!(official.iter().any(|row| row["code"] == *code), "{code}");
        }
    }
    #[test]
    fn regions_and_languages_have_no_country() {
        for group in [
            "EX-YU",
            "EX-YU ➾ Movie",
            "Arabic",
            "AR ➾ Movie",
            "Africa",
            "Kurdish",
            "Adult 🔞",
            "",
        ] {
            assert_eq!(of(group), None, "{group}");
        }
    }
}
