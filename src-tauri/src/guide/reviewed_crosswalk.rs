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

//! Runtime publisher identity metadata, not an EPG dataset or name heuristic.
//! The complete response must match the installed authority hash before parsing.
//! VerifiedCrosswalk has no deserializer or caller-supplied construction path.
use crate::scan_manifest_work::Context;
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use reqwest::{redirect::Policy, Url};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    net::{SocketAddr, ToSocketAddrs},
    sync::Arc,
    time::Duration,
};
use tokio::time::Instant;

pub(crate) const FEED: &str =
    "https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz";
const AUTHORITY: &str =
    "https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml";
const PIN: &str = "dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e";
const BYTES: usize = 2 * 1024 * 1024;
const ROWS: usize = 1024;
pub(crate) fn authority_stamp() -> &'static str {
    PIN
}

pub(crate) struct VerifiedCrosswalk {
    identities: BTreeMap<String, String>,
    ambiguous_identities: usize,
}
impl VerifiedCrosswalk {
    pub(crate) fn target(&self, provider_id: &str) -> Option<&str> {
        self.identities.get(provider_id).map(String::as_str)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub status: &'static str,
    pub code: Option<&'static str>,
    pub canonical_identities: usize,
    pub ambiguous_identities: usize,
    pub cache_hit: bool,
}
impl Outcome {
    pub(crate) fn not_requested() -> Self {
        Self {
            status: "not-requested",
            code: None,
            canonical_identities: 0,
            ambiguous_identities: 0,
            cache_hit: false,
        }
    }
    fn unavailable(code: &'static str) -> Self {
        Self {
            status: "unavailable",
            code: Some(code),
            canonical_identities: 0,
            ambiguous_identities: 0,
            cache_hit: false,
        }
    }
    fn available(crosswalk: &VerifiedCrosswalk, cache_hit: bool) -> Self {
        Self {
            status: "available",
            code: None,
            canonical_identities: crosswalk.identities.len(),
            ambiguous_identities: crosswalk.ambiguous_identities,
            cache_hit,
        }
    }
}
pub(crate) struct Acquisition {
    pub authority: Option<Arc<VerifiedCrosswalk>>,
    pub outcome: Outcome,
}
impl Acquisition {
    pub(crate) fn not_requested() -> Self {
        Self {
            authority: None,
            outcome: Outcome::not_requested(),
        }
    }
}
// One fixed authority/pin, one successful bounded in-memory value. Failed work
// is never cached permanently; a subsequent owned request performs a real retry.
static SINGLE_FLIGHT: tokio::sync::Mutex<Option<Arc<VerifiedCrosswalk>>> =
    tokio::sync::Mutex::const_new(None);
/// Cache-only connections must never start or wait on network acquisition.
/// A busy fetch leaves exact IDs/legacy aliases available for this pass.
pub(crate) fn cached_only() -> Acquisition {
    let Ok(cache) = SINGLE_FLIGHT.try_lock() else {
        return Acquisition::not_requested();
    };
    match cache.as_ref() {
        Some(authority) => Acquisition {
            authority: Some(authority.clone()),
            outcome: Outcome::available(authority, true),
        },
        None => Acquisition::not_requested(),
    }
}
fn check(owner: &Context, deadline: Instant) -> Result<(), &'static str> {
    owner.check().map_err(|_| "guide-crosswalk-cancelled")?;
    if Instant::now() >= deadline {
        return Err("guide-crosswalk-timeout");
    }
    Ok(())
}
async fn checked<T>(
    future: impl Future<Output = Result<T, &'static str>>,
    owner: &Context,
    deadline: Instant,
) -> Result<T, &'static str> {
    tokio::pin!(future);
    loop {
        check(owner, deadline)?;
        tokio::select! {
            result=&mut future => {check(owner,deadline)?;return result;},
            _=tokio::time::sleep(Duration::from_millis(50))=>{},
            _=tokio::time::sleep_until(deadline)=>return Err("guide-crosswalk-timeout"),
        }
    }
}
async fn resolve(
    host: &str,
    port: u16,
    owner: &Context,
    deadline: Instant,
) -> Result<Vec<SocketAddr>, &'static str> {
    check(owner, deadline)?;
    let host = host.to_owned();
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let mut addresses = Vec::new();
        for address in (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|_| "guide-crosswalk-network-unavailable")?
        {
            if addresses.len() >= 128 || !crate::sharing_policy::public_upstream(address.ip()) {
                return Err("guide-crosswalk-destination-refused");
            }
            addresses.push(address);
        }
        if addresses.is_empty() {
            return Err("guide-crosswalk-network-unavailable");
        }
        Ok(addresses)
    });
    let interrupted = loop {
        if let Err(code) = check(owner, deadline) {
            break code;
        }
        tokio::select! {
            result=&mut task => {
                // Ready is consumed only here; never poll this completed handle again.
                let result=result.map_err(|_|"guide-crosswalk-network-unavailable")?;
                check(owner,deadline)?;
                return result;
            },
            _=tokio::time::sleep(Duration::from_millis(50))=>{},
            _=tokio::time::sleep_until(deadline)=>break "guide-crosswalk-timeout",
        }
    };
    // OS getaddrinfo is not forcibly cancellable. The twenty-second deadline
    // closes admission, but cleanup may take longer: retain owner/singleflight
    // and join the actual resolver rather than claiming it was killed on time.
    let _ = task.await;
    Err(interrupted)
}
async fn fetch(owner: &Context, deadline: Instant) -> Result<Vec<u8>, &'static str> {
    let url = Url::parse(AUTHORITY).map_err(|_| "guide-crosswalk-authority-invalid")?;
    let host = url.host_str().ok_or("guide-crosswalk-authority-invalid")?;
    let port = url
        .port_or_known_default()
        .ok_or("guide-crosswalk-authority-invalid")?;
    let addresses = resolve(host, port, owner, deadline).await?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(remaining.min(Duration::from_secs(5)))
        .read_timeout(remaining.min(Duration::from_secs(5)))
        .timeout(remaining)
        .user_agent("TMG-TV/0.1")
        .build()
        .map_err(|_| "guide-crosswalk-network-unavailable")?;
    let mut response = checked(
        async {
            client
                .get(url.clone())
                .send()
                .await
                .map_err(|_| "guide-crosswalk-network-unavailable")
        },
        owner,
        deadline,
    )
    .await?;
    if response.status() != reqwest::StatusCode::OK || response.url() != &url {
        return Err("guide-crosswalk-response-refused");
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .is_some_and(|v| !v.to_str().is_ok_and(|v| v.eq_ignore_ascii_case("identity")))
    {
        return Err("guide-crosswalk-response-refused");
    }
    if response.content_length().is_some_and(|v| v > BYTES as u64) {
        return Err("guide-crosswalk-too-large");
    }
    let mut bytes = Vec::new();
    loop {
        let next = checked(
            async {
                response
                    .chunk()
                    .await
                    .map_err(|_| "guide-crosswalk-network-unavailable")
            },
            owner,
            deadline,
        )
        .await?;
        let Some(next) = next else { break };
        if next.len() > BYTES.saturating_sub(bytes.len()) {
            return Err("guide-crosswalk-too-large");
        }
        bytes.extend_from_slice(&next);
    }
    if bytes.is_empty() {
        return Err("guide-crosswalk-response-refused");
    }
    Ok(bytes)
}
fn channel(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    identities: &mut BTreeMap<String, String>,
    ambiguous: &mut BTreeSet<String>,
) -> Result<(), &'static str> {
    let mut site = None;
    let mut canonical = None;
    let mut raw = None;
    let mut fields = std::collections::HashSet::new();
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| "guide-crosswalk-xml-invalid")?;
        if fields.len() >= 32 || !fields.insert(attribute.key.as_ref().to_vec()) {
            return Err("guide-crosswalk-xml-invalid");
        }
        let value = attribute
            .decoded_and_normalized_value(quick_xml::XmlVersion::Explicit1_0, reader.decoder())
            .map_err(|_| "guide-crosswalk-xml-invalid")?;
        if value.len() > 16_384 || value.chars().any(char::is_control) {
            return Err("guide-crosswalk-xml-invalid");
        }
        match attribute.key.as_ref() {
            b"site" => site = Some(value.into_owned()),
            b"xmltv_id" => canonical = Some(value.into_owned()),
            b"site_id" => raw = Some(value.into_owned()),
            _ => {}
        }
    }
    if site.as_deref() != Some("pluto.tv") {
        return Err("guide-crosswalk-authority-invalid");
    }
    let canonical = canonical.ok_or("guide-crosswalk-xml-invalid")?;
    // An explicitly empty publisher ID authorizes nothing; its label/raw ID
    // cannot be promoted into an invented identity.
    if canonical.is_empty() {
        return Ok(());
    }
    let raw = raw.ok_or("guide-crosswalk-xml-invalid")?;
    if canonical.trim() != canonical
        || !canonical.contains('@')
        || canonical.contains("://")
        || raw.len() != 24
        || !raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("guide-crosswalk-identity-invalid");
    }
    // Validate every record before consulting quarantine. A malformed later
    // record cannot hide behind an earlier identity conflict.
    if ambiguous.contains(&canonical) {
        return Ok(());
    }
    if let Some(previous) = identities.get(&canonical) {
        if previous != &raw {
            identities.remove(&canonical);
            ambiguous.insert(canonical);
        }
    } else {
        if identities.len() + ambiguous.len() >= ROWS {
            return Err("guide-crosswalk-too-large");
        }
        identities.insert(canonical, raw);
    }
    Ok(())
}
fn parse(
    bytes: &[u8],
    owner: &Context,
    deadline: Instant,
) -> Result<VerifiedCrosswalk, &'static str> {
    parse_checked(bytes, &mut || check(owner, deadline))
}
fn parse_checked(
    bytes: &[u8],
    check: &mut dyn FnMut() -> Result<(), &'static str>,
) -> Result<VerifiedCrosswalk, &'static str> {
    check()?;
    if bytes.is_empty() || bytes.len() > BYTES {
        return Err("guide-crosswalk-too-large");
    }
    if format!("{:x}", Sha256::digest(bytes)) != PIN {
        return Err("guide-crosswalk-hash-mismatch");
    }
    std::str::from_utf8(bytes).map_err(|_| "guide-crosswalk-xml-invalid")?;
    let parsed = parse_xml_checked(bytes, check)?;
    Ok(VerifiedCrosswalk {
        identities: parsed.identities,
        ambiguous_identities: parsed.ambiguous.len(),
    })
}
#[cfg(test)]
pub(crate) fn pinned_fixture() -> VerifiedCrosswalk {
    parse_checked(
        include_bytes!(
            "../../../tests/fixtures/native/guide-crosswalk/pluto-us-dc1eaca8.channels.xml"
        ),
        &mut || Ok(()),
    )
    .expect("pinned fixture authority")
}
// Parsed data carries no authority. Only the size/hash/UTF-8-gated entry above
// can mint VerifiedCrosswalk for publication; labels never establish identity.
struct ParsedIdentities {
    identities: BTreeMap<String, String>,
    ambiguous: BTreeSet<String>,
}
fn parse_xml_checked(
    bytes: &[u8],
    check: &mut dyn FnMut() -> Result<(), &'static str>,
) -> Result<ParsedIdentities, &'static str> {
    check()?;
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = true;
    let mut stack = Vec::<Vec<u8>>::new();
    let mut root = false;
    let mut closed = false;
    let mut identities = BTreeMap::new();
    let mut ambiguous = BTreeSet::new();
    let mut records = 0usize;
    loop {
        check()?;
        match reader
            .read_event()
            .map_err(|_| "guide-crosswalk-xml-invalid")?
        {
            Event::Start(element) => {
                if stack.is_empty() {
                    if root || closed || element.name().as_ref() != b"channels" {
                        return Err("guide-crosswalk-xml-invalid");
                    }
                    root = true;
                } else if stack.len() == 1 && element.name().as_ref() == b"channel" {
                    records += 1;
                    if records > ROWS {
                        return Err("guide-crosswalk-too-large");
                    }
                    channel(&reader, &element, &mut identities, &mut ambiguous)?;
                } else {
                    return Err("guide-crosswalk-xml-invalid");
                }
                stack.push(element.name().as_ref().to_vec());
            }
            Event::Empty(element) => {
                if stack.len() != 1 || element.name().as_ref() != b"channel" {
                    return Err("guide-crosswalk-xml-invalid");
                }
                records += 1;
                if records > ROWS {
                    return Err("guide-crosswalk-too-large");
                }
                channel(&reader, &element, &mut identities, &mut ambiguous)?;
            }
            Event::End(element) => {
                if stack.pop().as_deref() != Some(element.name().as_ref()) {
                    return Err("guide-crosswalk-xml-invalid");
                }
                if stack.is_empty() {
                    closed = true;
                }
            }
            Event::Text(text) => {
                if stack.len() != 2 && !text.iter().all(u8::is_ascii_whitespace) {
                    return Err("guide-crosswalk-xml-invalid");
                }
                // Channel labels are intentionally never identity input or output.
            }
            Event::GeneralRef(value)
                if stack.len() == 2
                    && matches!(&*value, b"amp" | b"lt" | b"gt" | b"apos" | b"quot") => {}
            Event::CData(_) if stack.len() == 2 => {}
            Event::Decl(_) if !root => {}
            Event::Comment(_) => {}
            Event::Eof => break,
            _ => return Err("guide-crosswalk-xml-invalid"),
        }
    }
    if !root || !closed || !stack.is_empty() {
        return Err("guide-crosswalk-xml-invalid");
    }
    if identities.is_empty() {
        return Err(if ambiguous.is_empty() {
            "guide-crosswalk-xml-invalid"
        } else {
            "guide-crosswalk-identity-conflict"
        });
    }
    check()?;
    Ok(ParsedIdentities {
        identities,
        ambiguous,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PINNED: &[u8] = include_bytes!(
        "../../../tests/fixtures/native/guide-crosswalk/pluto-us-dc1eaca8.channels.xml"
    );

    #[test]
    fn guide_crosswalk_pinned_publisher_catalog_retains_unique_identities() {
        assert_eq!(format!("{:x}", Sha256::digest(PINNED)), PIN);
        let parsed = parse_checked(PINNED, &mut || Ok(())).expect(
            "five conflicting publisher identities must not discard 220 independent identities",
        );
        assert_eq!(parsed.identities.len(), 220);
        for identity in [
            "CBSNewsLosAngeles.us@SD",
            "CBSNewsNewYork.us@SD",
            "PlutoTVCars.us@SD",
            "TVLandDrama.us@SD",
            "TVLandSitcoms.us@SD",
        ] {
            assert_eq!(parsed.target(identity), None);
        }
        assert_eq!(
            parsed.target("CBSSportsGolazoNetwork.us@SD"),
            Some("63a0e33a45264d000850ed7e")
        );
        let outcome = serde_json::to_value(Outcome::available(&parsed, false)).unwrap();
        assert_eq!(outcome["canonicalIdentities"], 220);
        assert_eq!(outcome["ambiguousIdentities"], 5);
    }

    fn record(id: &str, target: &str) -> String {
        format!("<channel site=\"pluto.tv\" xmltv_id=\"{id}\" site_id=\"{target}\">Label</channel>")
    }
    fn document(rows: &[String]) -> Vec<u8> {
        format!("<channels>{}</channels>", rows.join("")).into_bytes()
    }
    fn parsed(bytes: &[u8]) -> Result<ParsedIdentities, &'static str> {
        parse_xml_checked(bytes, &mut || Ok(()))
    }

    #[test]
    fn guide_crosswalk_conflict_quarantine_is_order_independent_and_permanent() {
        let a = "a".repeat(24);
        let b = "b".repeat(24);
        let c = "c".repeat(24);
        for targets in [
            [&a, &b, &a],
            [&a, &a, &b],
            [&b, &a, &a],
            [&a, &b, &c],
            [&c, &a, &b],
            [&b, &c, &a],
        ] {
            let mut rows = vec![record("Independent.us@SD", &c)];
            rows.extend(
                targets
                    .iter()
                    .map(|target| record("Conflicting.us@SD", target)),
            );
            let result = parsed(&document(&rows)).unwrap();
            assert_eq!(result.identities.len(), 1);
            assert_eq!(result.identities.get("Independent.us@SD"), Some(&c));
            assert!(!result.identities.contains_key("Conflicting.us@SD"));
            assert_eq!(
                result
                    .ambiguous
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                vec!["Conflicting.us@SD"]
            );
        }
    }

    #[test]
    fn guide_crosswalk_identical_duplicates_and_shared_target_are_not_conflicts() {
        let target = "a".repeat(24);
        let result = parsed(&document(&[
            record("One.us@SD", &target),
            record("One.us@SD", &target),
            record("Different.us@SD", &target),
            // An explicitly empty identity grants nothing, regardless of label.
            record("", &"b".repeat(24)),
        ]))
        .unwrap();
        assert_eq!(result.identities.len(), 2);
        assert!(result.ambiguous.is_empty());
    }

    #[test]
    fn guide_crosswalk_invalid_record_after_quarantine_still_refuses_whole_revision() {
        let prior = [
            record("Independent.us@SD", &"c".repeat(24)),
            record("Conflict.us@SD", &"a".repeat(24)),
            record("Conflict.us@SD", &"b".repeat(24)),
        ];
        for invalid in [
            record("Conflict.us@SD", "not-a-valid-site-id"),
            "<channel site=\"other.tv\" xmltv_id=\"Conflict.us@SD\" site_id=\"aaaaaaaaaaaaaaaaaaaaaaaa\"/>".into(),
            "<channel site=\"pluto.tv\" xmltv_id=\"Conflict.us@SD\"/>".into(),
            "<channel site=\"pluto.tv\" xmltv_id=\"BadIdentity\" site_id=\"aaaaaaaaaaaaaaaaaaaaaaaa\"/>".into(),
            "<channel site=\"pluto.tv\" site=\"pluto.tv\" xmltv_id=\"Conflict.us@SD\" site_id=\"aaaaaaaaaaaaaaaaaaaaaaaa\"/>".into(),
        ] {
            let mut rows = prior.to_vec(); rows.push(invalid);
            assert!(parsed(&document(&rows)).is_err());
        }
    }

    #[test]
    fn guide_crosswalk_xml_schema_and_row_limits_remain_refusals() {
        let good = record("One.us@SD", &"a".repeat(24));
        for malformed in [
            format!("<wrong>{good}</wrong>"), format!("<channels>{good}</broken>"),
            format!("<channels><nested>{good}</nested></channels>"),
            format!("<!DOCTYPE channels [<!ENTITY external SYSTEM \"file:///never-opened\">]><channels>{good}</channels>"),
            format!("<channels>{good}<?instruction forbidden?></channels>"),
        ] { assert!(parsed(malformed.as_bytes()).is_err()); }
        assert_eq!(
            parsed(&document(&vec![good; ROWS + 1])).err(),
            Some("guide-crosswalk-too-large")
        );
        assert!(parsed(b"<channels/>").is_err());
    }

    #[test]
    fn guide_crosswalk_only_conflicting_identities_never_mint_authority() {
        assert_eq!(
            parsed(&document(&[
                record("Conflict.us@SD", &"a".repeat(24)),
                record("Conflict.us@SD", &"b".repeat(24))
            ]))
            .err(),
            Some("guide-crosswalk-identity-conflict")
        );
    }

    #[test]
    fn guide_crosswalk_pin_byte_and_cancellation_gates_still_precede_authority() {
        let mut modified = PINNED.to_vec();
        modified[0] ^= 1;
        assert_eq!(
            parse_checked(&modified, &mut || Ok(())).err(),
            Some("guide-crosswalk-hash-mismatch")
        );
        assert_eq!(
            parse_checked(&vec![b'x'; BYTES + 1], &mut || Ok(())).err(),
            Some("guide-crosswalk-too-large")
        );
        assert_eq!(
            parse_checked(PINNED, &mut || Err("guide-crosswalk-cancelled")).err(),
            Some("guide-crosswalk-cancelled")
        );
        let mut checks = 0;
        assert_eq!(
            parse_checked(PINNED, &mut || {
                checks += 1;
                if checks >= 20 {
                    Err("guide-crosswalk-timeout")
                } else {
                    Ok(())
                }
            })
            .err(),
            Some("guide-crosswalk-timeout")
        );
    }

    #[test]
    fn guide_crosswalk_outcomes_expose_only_fixed_bounded_counts() {
        let result = parse_checked(PINNED, &mut || Ok(())).unwrap();
        let available = serde_json::to_value(Outcome::available(&result, true)).unwrap();
        assert_eq!(available.as_object().unwrap().len(), 5);
        assert_eq!(available["ambiguousIdentities"], 5);
        assert_eq!(available["canonicalIdentities"], 220);
        assert_eq!(available["cacheHit"], true);
        for outcome in [
            Outcome::not_requested(),
            Outcome::unavailable("guide-crosswalk-timeout"),
        ] {
            let value = serde_json::to_value(outcome).unwrap();
            assert_eq!(value["ambiguousIdentities"], 0);
            assert_eq!(value["canonicalIdentities"], 0);
            assert_eq!(value["cacheHit"], false);
        }
    }
}
pub(crate) async fn acquire(owner: Arc<Context>) -> Result<Acquisition, String> {
    owner.check()?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let guard = checked(async { Ok(SINGLE_FLIGHT.lock().await) }, &owner, deadline).await;
    owner.check()?;
    let mut guard = match guard {
        Ok(guard) => guard,
        Err(code) => {
            return Ok(Acquisition {
                authority: None,
                outcome: Outcome::unavailable(code),
            })
        }
    };
    if let Some(crosswalk) = guard.as_ref() {
        return Ok(Acquisition {
            authority: Some(crosswalk.clone()),
            outcome: Outcome::available(crosswalk, true),
        });
    }
    let result = fetch(&owner, deadline).await;
    owner.check()?;
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(code) => {
            return Ok(Acquisition {
                authority: None,
                outcome: Outcome::unavailable(code),
            })
        }
    };
    let parse_owner = owner.clone();
    // Always join actual CPU parsing, even after cancellation or an IPC observer
    // disappearing. No SQLite/root lease is held through fetch or parsing.
    let result =
        tauri::async_runtime::spawn_blocking(move || parse(&bytes, &parse_owner, deadline)).await;
    owner.check()?;
    let result = result.unwrap_or(Err("guide-crosswalk-parser-unavailable"));
    match result {
        Ok(value) => {
            let value = Arc::new(value);
            *guard = Some(value.clone());
            Ok(Acquisition {
                authority: Some(value.clone()),
                outcome: Outcome::available(&value, false),
            })
        }
        Err(code) => Ok(Acquisition {
            authority: None,
            outcome: Outcome::unavailable(code),
        }),
    }
}
