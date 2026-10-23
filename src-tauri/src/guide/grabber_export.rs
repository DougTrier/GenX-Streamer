//! Optional seven-day guide preparation for a separately run iptv-org/epg grabber.
//! Builds a `channels.xml` for the user's own saved channels from the published
//! guides.json tuples (`channel`, `feed`, `site`, `site_id`). GenX never runs the
//! grabber, scrapes a site or invents an ID: each row uses the channel's exact
//! saved provider ID as `xmltv_id`, so a generated XMLTV maps by equality.
use super::crosswalk_pack::Pack;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) const GUIDES_URL: &str = "https://iptv-org.github.io/api/guides.json";
const BODY_LIMIT: usize = 48 * 1024 * 1024;
const ROW_LIMIT: usize = 500_000;
const XML_LIMIT: usize = 8 * 1024 * 1024;
/// Already fetched directly by GenX as hosted XMLTV; a grabber would duplicate it.
const DIRECT_SITES: &[&str] = &["i.mjh.nz"];

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GuideRow {
    channel: Option<String>,
    feed: Option<String>,
    site: String,
    site_id: String,
    site_name: Option<String>,
    lang: Option<String>,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrabberExport {
    pub xml: String,
    pub channels: usize,
    pub unmatched: usize,
    pub sites: Vec<SiteCount>,
    pub source: &'static str,
}
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SiteCount {
    pub site: String,
    pub channels: usize,
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}
fn plain(text: &str, limit: usize) -> bool {
    !text.is_empty() && text.len() <= limit && !text.chars().any(char::is_control)
}

/// One site per channel: the site covering most of the user's channels wins,
/// so the grabber needs as few sites as possible. Ties use site name order.
pub(crate) fn build(
    rows: &[GuideRow],
    providers: &[String],
    pack: Option<&Pack>,
) -> Result<GrabberExport, String> {
    if rows.len() > ROW_LIMIT || providers.len() > 100_000 {
        return Err("guide-grabber-limit".into());
    }
    // Canonical channel@feed -> candidate rows.
    let mut by_identity: HashMap<String, Vec<&GuideRow>> = HashMap::new();
    for row in rows {
        let (Some(channel), Some(feed)) = (row.channel.as_deref(), row.feed.as_deref()) else {
            continue;
        };
        if DIRECT_SITES.contains(&row.site.as_str())
            || !plain(channel, 256)
            || !plain(feed, 64)
            || !plain(&row.site, 128)
            || !plain(&row.site_id, 512)
        {
            continue;
        }
        by_identity
            .entry(format!("{channel}@{feed}"))
            .or_default()
            .push(row);
    }
    // Saved provider ID -> canonical identity (bare IDs use the published main feed).
    let mut wanted: Vec<(&str, String)> = Vec::new();
    let mut seen = HashSet::new();
    let mut unmatched = 0usize;
    for provider in providers {
        if !seen.insert(provider.as_str()) {
            continue;
        }
        let canonical = if provider.contains('@') {
            Some(provider.clone())
        } else {
            pack.and_then(|p| p.main_feed(provider))
                .map(|feed| format!("{provider}@{feed}"))
        };
        match canonical.filter(|c| by_identity.contains_key(c)) {
            Some(canonical) => wanted.push((provider.as_str(), canonical)),
            None => unmatched += 1,
        }
    }
    let mut site_counts: HashMap<&str, usize> = HashMap::new();
    for (_, canonical) in &wanted {
        let sites: HashSet<&str> = by_identity[canonical]
            .iter()
            .map(|r| r.site.as_str())
            .collect();
        for site in sites {
            *site_counts.entry(site).or_default() += 1;
        }
    }
    let mut chosen: BTreeMap<String, (&str, &GuideRow)> = BTreeMap::new();
    for (provider, canonical) in &wanted {
        let best = by_identity[canonical]
            .iter()
            .max_by(|a, b| {
                site_counts[a.site.as_str()]
                    .cmp(&site_counts[b.site.as_str()])
                    .then_with(|| b.site.cmp(&a.site))
                    .then_with(|| b.site_id.cmp(&a.site_id))
            })
            .copied()
            .expect("nonempty candidate rows");
        chosen.insert((*provider).to_owned(), (provider, best));
    }
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<channels>\n");
    let mut per_site: BTreeMap<String, usize> = BTreeMap::new();
    for (provider, row) in chosen.values() {
        let lang = row
            .lang
            .as_deref()
            .filter(|l| plain(l, 16) && l.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-'))
            .unwrap_or("en");
        let label = row
            .site_name
            .as_deref()
            .filter(|n| plain(n, 256))
            .unwrap_or(provider);
        xml.push_str(&format!(
            "  <channel site=\"{}\" lang=\"{}\" xmltv_id=\"{}\" site_id=\"{}\">{}</channel>\n",
            escape(&row.site),
            escape(lang),
            escape(provider),
            escape(&row.site_id),
            escape(label)
        ));
        if xml.len() > XML_LIMIT {
            return Err("guide-grabber-limit".into());
        }
        *per_site.entry(row.site.clone()).or_default() += 1;
    }
    xml.push_str("</channels>\n");
    let mut sites: Vec<SiteCount> = per_site
        .into_iter()
        .map(|(site, channels)| SiteCount { site, channels })
        .collect();
    sites.sort_by(|a, b| b.channels.cmp(&a.channels).then(a.site.cmp(&b.site)));
    Ok(GrabberExport {
        xml,
        channels: chosen.len(),
        unmatched,
        sites,
        source: GUIDES_URL,
    })
}

pub(crate) fn parse_rows(bytes: &[u8]) -> Result<Vec<GuideRow>, String> {
    if bytes.len() > BODY_LIMIT {
        return Err("guide-grabber-limit".into());
    }
    let rows: Vec<GuideRow> =
        serde_json::from_slice(bytes).map_err(|_| "guide-grabber-invalid".to_owned())?;
    if rows.len() > ROW_LIMIT {
        return Err("guide-grabber-limit".into());
    }
    Ok(rows)
}

pub(crate) async fn fetch_rows(flag: &AtomicBool) -> Result<Vec<GuideRow>, String> {
    let canceled = || {
        if flag.load(Ordering::SeqCst) {
            Err("guide-grabber-canceled".to_owned())
        } else {
            Ok(())
        }
    };
    canceled()?;
    let mut response = crate::network::response_with_budget(GUIDES_URL, false, None, 60_000)
        .await
        .map_err(|_| "guide-grabber-network-unavailable".to_owned())?;
    canceled()?;
    if response.status().as_u16() != 200 {
        return Err("guide-grabber-unavailable".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > BODY_LIMIT as u64)
    {
        return Err("guide-grabber-limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(part) = response
        .chunk()
        .await
        .map_err(|_| "guide-grabber-network-unavailable".to_owned())?
    {
        canceled()?;
        if bytes.len() + part.len() > BODY_LIMIT {
            return Err("guide-grabber-limit".into());
        }
        bytes.extend_from_slice(&part);
    }
    tokio::task::spawn_blocking(move || parse_rows(&bytes))
        .await
        .map_err(|_| "guide-grabber-invalid".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(channel: &str, feed: &str, site: &str, id: &str) -> GuideRow {
        GuideRow {
            channel: Some(channel.into()),
            feed: Some(feed.into()),
            site: site.into(),
            site_id: id.into(),
            site_name: Some(format!("{channel} <{site}>")),
            lang: Some("en".into()),
        }
    }

    #[test]
    fn chooses_the_site_covering_most_saved_channels_and_keeps_exact_saved_ids() {
        let rows = vec![
            row("A.us", "SD", "tvtv.us", "1"),
            row("A.us", "SD", "other.com", "a"),
            row("B.us", "SD", "tvtv.us", "2"),
            row("F.us", "SD", "tvtv.us", "6"),
            row("C.us", "HD", "other.com", "c"),
            row("D.us", "SD", "i.mjh.nz", "Roku/all#d"),
            GuideRow {
                channel: None,
                feed: None,
                ..row("E.us", "SD", "tvtv.us", "5")
            },
        ];
        let providers: Vec<String> = [
            "A.us@SD", "B.us@SD", "C.us@HD", "D.us@SD", "Z.us@SD", "A.us@SD", "F.us@SD",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let export = build(&rows, &providers, None).unwrap();
        assert_eq!(export.channels, 4);
        assert_eq!(export.unmatched, 2); // D is hosted directly; Z has no tuple.
        assert_eq!(
            export.sites,
            vec![
                SiteCount {
                    site: "tvtv.us".into(),
                    channels: 3
                },
                SiteCount {
                    site: "other.com".into(),
                    channels: 1
                }
            ]
        );
        assert!(export.xml.contains(
            "<channel site=\"tvtv.us\" lang=\"en\" xmltv_id=\"A.us@SD\" site_id=\"1\">A.us &lt;tvtv.us&gt;</channel>"
        ));
        assert!(!export
            .xml
            .contains("other.com\" lang=\"en\" xmltv_id=\"A.us@SD\""));
        assert!(export.xml.starts_with("<?xml") && export.xml.ends_with("</channels>\n"));
    }

    #[test]
    fn bare_saved_ids_use_only_the_published_main_feed_and_stay_exact_in_output() {
        let pack = super::super::crosswalk_pack::loaded().unwrap();
        assert_eq!(pack.main_feed("beINSPORTSXTRA.us"), Some("SD"));
        let rows = vec![
            row("beINSPORTSXTRA.us", "SD", "tvtv.us", "77"),
            row("beINSPORTSXTRA.us", "HD", "tvtv.us", "78"),
        ];
        let export = build(&rows, &["beINSPORTSXTRA.us".into()], Some(pack)).unwrap();
        assert_eq!(export.channels, 1);
        assert!(export
            .xml
            .contains("xmltv_id=\"beINSPORTSXTRA.us\" site_id=\"77\""));
        let without_pack = build(&rows, &["beINSPORTSXTRA.us".into()], None).unwrap();
        assert_eq!((without_pack.channels, without_pack.unmatched), (0, 1));
    }

    #[test]
    fn hostile_text_is_escaped_or_dropped_and_input_is_bounded() {
        let mut hostile = row("X.us", "SD", "site\"><x", "id&1");
        hostile.site_name = Some("Name\u{0}<b>".into());
        hostile.lang = Some("en\"x".into());
        let export = build(&[hostile], &["X.us@SD".into()], None).unwrap();
        assert!(export.xml.contains("site=\"site&quot;&gt;&lt;x\""));
        assert!(export.xml.contains("site_id=\"id&amp;1\""));
        assert!(export.xml.contains("lang=\"en\""));
        assert!(!export.xml.contains('\u{0}'));
        assert!(parse_rows(b"{\"not\":\"array\"}").is_err());
        assert!(parse_rows(&vec![b' '; BODY_LIMIT + 1]).is_err());
        assert_eq!(parse_rows(b"[]").unwrap().len(), 0);
    }
}
