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

//! Reviewed, feed-scoped canonical identifier admission; caller provenance cannot grant authority.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
const FEED: &str =
    "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz";
const PROVENANCE: &str =
    "https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml";
const CONFIG_HASH: &str = "dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e";
const REVIEWED: [(&str, &str); 3] = [
    ("PGATour.us@SD", "5de94dacb394a300099fa22a"),
    ("CBSSportsGolazoNetwork.us@SD", "63a0e33a45264d000850ed7e"),
    ("WorldPokerTour.us@US", "5616f9c0ada51f8004c4b091"),
];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedAliases {
    pub schema_version: u8,
    pub guide_location: String,
    pub provenance_location: String,
    pub provenance_sha256: String,
    pub pairs: Vec<AliasPair>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AliasPair {
    pub catalog_source_id: String,
    pub app_channel_id: String,
    pub provider_id: String,
    pub xmltv_channel_id: String,
}
/// Rows must come from the held IMMEDIATE SQLite snapshot after both revision checks.
pub struct CatalogTarget<'a> {
    pub source_id: &'a str,
    pub channel_id: &'a str,
    pub provider_id: Option<&'a str>,
    pub removed: bool,
}
struct BoundedSize(usize);
impl std::io::Write for BoundedSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        if self.0 > 512 * 1024 {
            return Err(std::io::Error::other("guide-alias-limit"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn id(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
/// Full refusal; never trim an oversized or conflicting request.
/// feed_ids must come from the admitted parsed feed, not remote strings supplied by JS.
pub fn admit(
    descriptor: &ReviewedAliases,
    saved_guide_location: &str,
    catalog: &[CatalogTarget<'_>],
    feed_ids: &HashSet<&str>,
    canceled: &AtomicBool,
) -> Result<BTreeMap<(String, String), String>, &'static str> {
    if descriptor.schema_version != 1
        || descriptor.pairs.is_empty()
        || descriptor.pairs.len() > 1024
    {
        return Err("guide-alias-limit-or-schema");
    }
    if serde_json::to_writer(BoundedSize(0), descriptor).is_err() {
        return Err("guide-alias-limit-or-schema");
    }
    if saved_guide_location != FEED
        || descriptor.guide_location != FEED
        || descriptor.provenance_location != PROVENANCE
        || descriptor.provenance_sha256 != CONFIG_HASH
    {
        return Err("guide-alias-source-refused");
    }
    let mut index = HashMap::new();
    for target in catalog {
        if canceled.load(Ordering::Acquire) {
            return Err("guide-cancelled");
        }
        if index
            .insert((target.source_id, target.channel_id), target)
            .is_some()
        {
            return Err("guide-alias-target-unavailable");
        }
    }
    let mut result = BTreeMap::new();
    for pair in &descriptor.pairs {
        if !id(&pair.catalog_source_id, 256)
            || !id(&pair.app_channel_id, 16_384)
            || !id(&pair.provider_id, 16384)
            || !id(&pair.xmltv_channel_id, 16_384)
        {
            return Err("guide-alias-invalid");
        }
        if !REVIEWED
            .iter()
            .any(|(p, g)| *p == pair.provider_id && *g == pair.xmltv_channel_id)
        {
            return Err("guide-alias-authority-refused");
        }
        if canceled.load(Ordering::Acquire) {
            return Err("guide-cancelled");
        }
        let target = index
            .get(&(
                pair.catalog_source_id.as_str(),
                pair.app_channel_id.as_str(),
            ))
            .ok_or("guide-alias-target-unavailable")?;
        if target.removed || target.provider_id != Some(pair.provider_id.as_str()) {
            return Err("guide-alias-target-unavailable");
        }
        if !feed_ids.contains(pair.xmltv_channel_id.as_str()) {
            return Err("guide-alias-channel-unavailable");
        }
        if feed_ids.contains(pair.provider_id.as_str()) && pair.provider_id != pair.xmltv_channel_id
        {
            return Err("guide-alias-identity-conflict");
        }
        if result
            .insert(
                (pair.catalog_source_id.clone(), pair.app_channel_id.clone()),
                pair.xmltv_channel_id.clone(),
            )
            .is_some()
        {
            return Err("guide-alias-duplicate");
        }
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor() -> ReviewedAliases {
        ReviewedAliases {
            schema_version: 1,
            guide_location: FEED.into(),
            provenance_location: PROVENANCE.into(),
            provenance_sha256: CONFIG_HASH.into(),
            pairs: vec![AliasPair {
                catalog_source_id: "source".into(),
                app_channel_id: "pga".into(),
                provider_id: REVIEWED[0].0.into(),
                xmltv_channel_id: REVIEWED[0].1.into(),
            }],
        }
    }
    #[test]
    fn exact_scoped_variants_remain_distinct() {
        let mut d = descriptor();
        let mut variant = d.pairs[0].clone();
        variant.app_channel_id = "pga-hd".into();
        d.pairs.push(variant);
        let c = [
            CatalogTarget {
                source_id: "source",
                channel_id: "pga",
                provider_id: Some(REVIEWED[0].0),
                removed: false,
            },
            CatalogTarget {
                source_id: "source",
                channel_id: "pga-hd",
                provider_id: Some(REVIEWED[0].0),
                removed: false,
            },
        ];
        let feed = HashSet::from([REVIEWED[0].1]);
        let result = admit(&d, FEED, &c, &feed, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result.values().collect::<HashSet<_>>().len(), 1);
    }
    #[test]
    fn authority_and_source_are_not_asserted_by_caller() {
        let c = [CatalogTarget {
            source_id: "source",
            channel_id: "pga",
            provider_id: Some(REVIEWED[0].0),
            removed: false,
        }];
        let feed = HashSet::from([REVIEWED[0].1]);
        let mut d = descriptor();
        assert!(admit(
            &d,
            "https://other.example/feed",
            &c,
            &feed,
            &AtomicBool::new(false)
        )
        .is_err());
        d.pairs[0].provider_id = "PGA Tour".into();
        assert!(admit(&d, FEED, &c, &feed, &AtomicBool::new(false)).is_err());
    }
    #[test]
    fn removal_missing_scope_and_collision_refuse_whole() {
        let c = [CatalogTarget {
            source_id: "source",
            channel_id: "pga",
            provider_id: Some(REVIEWED[0].0),
            removed: false,
        }];
        let feed = HashSet::from([REVIEWED[0].1]);
        let mut d = descriptor();
        d.pairs.push(d.pairs[0].clone());
        assert!(admit(&d, FEED, &c, &feed, &AtomicBool::new(false)).is_err());
        d.pairs.pop();
        d.pairs[0].catalog_source_id = "other-source".into();
        assert!(admit(&d, FEED, &c, &feed, &AtomicBool::new(false)).is_err());
        d.pairs[0].catalog_source_id = "source".into();
        assert!(admit(&d, FEED, &c, &HashSet::new(), &AtomicBool::new(false)).is_err());
        assert!(admit(
            &d,
            FEED,
            &c,
            &HashSet::from([REVIEWED[0].0, REVIEWED[0].1]),
            &AtomicBool::new(false)
        )
        .is_err());
        let removed = [CatalogTarget {
            source_id: "source",
            channel_id: "pga",
            provider_id: Some(REVIEWED[0].0),
            removed: true,
        }];
        assert!(admit(&d, FEED, &removed, &feed, &AtomicBool::new(false)).is_err());
    }
    #[test]
    fn explicit_limits_and_cancellation_refuse_without_partial_admission() {
        let c = [CatalogTarget {
            source_id: "source",
            channel_id: "pga",
            provider_id: Some(REVIEWED[0].0),
            removed: false,
        }];
        let feed = HashSet::from([REVIEWED[0].1]);
        let mut d = descriptor();
        assert_eq!(
            admit(&d, FEED, &c, &feed, &AtomicBool::new(true)).unwrap_err(),
            "guide-cancelled"
        );
        d.pairs = vec![d.pairs[0].clone(); 1025];
        assert!(admit(&d, FEED, &c, &feed, &AtomicBool::new(false)).is_err());
        d = descriptor();
        d.pairs[0].app_channel_id = "x".repeat(16384);
        d.pairs = vec![d.pairs[0].clone(); 40];
        assert_eq!(
            admit(&d, FEED, &c, &feed, &AtomicBool::new(false)).unwrap_err(),
            "guide-alias-limit-or-schema"
        );
    }
}
