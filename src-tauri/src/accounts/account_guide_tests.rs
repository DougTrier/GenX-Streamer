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

//! Controlled XMLTV fixtures (no network) and the production account schema.
use super::*;
use rusqlite::params;
use std::io::Write;

const ACCOUNT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BATCH: &str = "cccccccccccccccccccccccccccccccc";
/// 2026-10-18 18:00 UTC.
const NOW: i64 = 1_792_346_400_000;
const HOUR: i64 = 3_600_000;

fn ids(values: &[&str]) -> HashSet<String> {
    values.iter().map(|v| v.to_string()).collect()
}
fn read_with(xml: &[u8], wanted: &[&str], limit: usize) -> Result<Parsed, String> {
    parse(
        open_reader(std::io::Cursor::new(xml.to_vec()), EXPANDED_LIMIT)?,
        &ids(wanted),
        NOW - KEEP_BEFORE_MS,
        NOW + KEEP_AFTER_MS,
        limit,
        &mut || Ok(()),
    )
}
fn read(xml: &str, wanted: &[&str]) -> Result<Parsed, String> {
    read_with(xml.as_bytes(), wanted, PROGRAM_LIMIT)
}
const GUIDE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="fixture">
  <channel id="fox32.us"><display-name>FOX 32</display-name></channel>
  <channel id="other.us"><display-name>Other</display-name></channel>
  <programme start="20261018180000 +0000" stop="20261018210000 +0000" channel="fox32.us">
    <title lang="en">NFL Football: Bears at Saints</title>
    <desc lang="en">Chicago &amp; New Orleans meet.</desc>
    <category lang="en">Sports</category>
  </programme>
  <programme start="20261018180000 +0000" stop="20261018210000 +0000" channel="fox32.us">
    <title lang="en">NFL Football: Bears at Saints</title>
    <desc lang="en">Chicago &amp; New Orleans meet.</desc>
    <category lang="en">Sports</category>
  </programme>
  <programme start="20261018180000 +0000" stop="20261018183000 +0000" channel="fox32.us">
    <title>Pregame</title>
  </programme>
  <programme start="20261018160000 -0500" stop="20261018170000 -0500" channel="fox32.us">
    <title>Local News</title>
  </programme>
  <programme start="20260101000000 +0000" stop="20260101010000 +0000" channel="fox32.us">
    <title>Long Ago</title>
  </programme>
  <programme start="not-a-time" channel="fox32.us"><title>Broken Time</title></programme>
  <programme start="20261018220000 +0000" stop="20261018230000 +0000" channel="fox32.us"><desc>No title</desc></programme>
  <programme start="20261018230000 +0000" stop="20261019000000 +0000" channel="fox32.us"><title>Bad <b>markup</b></title></programme>
  <programme start="20261018180000 +0000" stop="20261018190000 +0000" channel="other.us">
    <title>Not this account's channel</title>
  </programme>
  <programme start="20261018190000 +0000" stop="20261018200000 +0000" channel="unlisted.us">
    <title>Channel the file never declared</title>
  </programme>
</tv>"#;

fn summary(parsed: &Parsed) -> Vec<(String, String, i64, i64)> {
    parsed
        .programs
        .iter()
        .map(|p| (p.epg_id.clone(), p.title.clone(), p.start_ms, p.ordinal))
        .collect()
}

#[test]
fn keeps_only_this_accounts_channels_in_the_window_and_counts_unusable_listings() {
    let parsed = read(GUIDE, &["fox32.us", "unlisted.us"]).unwrap();
    let row = |id: &str, title: &str, start: i64, ordinal: i64| {
        (id.to_owned(), title.to_owned(), start, ordinal)
    };
    assert_eq!(
        summary(&parsed),
        vec![
            // The exact repeat collapses; a different listing at the same start
            // keeps file order as its ordinal.
            row("fox32.us", "NFL Football: Bears at Saints", NOW, 0),
            row("fox32.us", "Pregame", NOW, 1),
            // 16:00 at -0500 is 21:00 UTC: the offset is honoured, never guessed.
            row("fox32.us", "Local News", NOW + 3 * HOUR, 0),
            // Matched by the provider's EPG ID even if the file never declared it.
            row(
                "unlisted.us",
                "Channel the file never declared",
                NOW + HOUR,
                0
            ),
        ]
    );
    // Broken time, no title, markup inside a title: counted, never shown.
    assert_eq!(parsed.skipped, 3);
    let game = &parsed.programs[0];
    assert_eq!(
        game.description.as_deref(),
        Some("Chicago & New Orleans meet.")
    );
    assert_eq!(game.categories.len(), 1);
    assert_eq!(game.stop_ms, Some(NOW + 3 * HOUR));
}

#[test]
fn another_channels_id_or_a_similar_name_never_supplies_listings() {
    // XC-034: only the exact provider EPG ID binds a listing to a channel.
    let parsed = read(GUIDE, &["FOX32.US", "fox32"]).unwrap();
    assert!(parsed.programs.is_empty());
    assert_eq!(parsed.skipped, 0);
}

#[test]
fn malformed_or_unsafe_xml_fails_the_whole_read() {
    let truncated = &GUIDE[..GUIDE.len() - 40];
    assert_eq!(
        read(truncated, &["fox32.us"]).unwrap_err(),
        "account-guide-malformed"
    );
    let subset = r#"<?xml version="1.0"?><!DOCTYPE tv [<!ENTITY a "aaaa">]><tv></tv>"#;
    assert_eq!(
        read(subset, &["fox32.us"]).unwrap_err(),
        "account-guide-malformed"
    );
    let latin = r#"<?xml version="1.0" encoding="ISO-8859-1"?><tv></tv>"#;
    assert_eq!(
        read(latin, &["fox32.us"]).unwrap_err(),
        "account-guide-encoding-unsupported"
    );
    assert_eq!(read("", &["fox32.us"]).unwrap_err(), "account-guide-empty");
    assert_eq!(
        read("<html>Blocked</html>", &["fox32.us"]).unwrap_err(),
        "account-guide-malformed"
    );
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

#[test]
fn gzip_is_recognized_by_its_bytes_and_expansion_is_bounded() {
    // XC-035: the same guide plain or gzip; never decompressed twice.
    let plain = read(GUIDE, &["fox32.us"]).unwrap();
    let packed = read_with(&gzip(GUIDE.as_bytes()), &["fox32.us"], PROGRAM_LIMIT).unwrap();
    assert_eq!(summary(&plain), summary(&packed));
    // A gzip bomb stops at the expansion cap instead of filling memory or disk.
    let bomb = gzip(&vec![b' '; 4 * 1024 * 1024]);
    let error = parse(
        open_reader(std::io::Cursor::new(bomb), 1024 * 1024).unwrap(),
        &ids(&["fox32.us"]),
        NOW - KEEP_BEFORE_MS,
        NOW + KEEP_AFTER_MS,
        PROGRAM_LIMIT,
        &mut || Ok(()),
    )
    .unwrap_err();
    assert_eq!(error, "account-guide-too-large");
    // A corrupt gzip tail is a failed read, not a partial guide.
    let mut corrupt = gzip(GUIDE.as_bytes());
    corrupt.truncate(corrupt.len() - 12);
    assert!(read_with(&corrupt, &["fox32.us"], PROGRAM_LIMIT).is_err());
}

#[test]
fn too_many_listings_is_refused_not_silently_cut() {
    assert_eq!(
        read_with(GUIDE.as_bytes(), &["fox32.us"], 2).unwrap_err(),
        "account-guide-too-large"
    );
}

#[test]
fn cancellation_stops_the_read() {
    let mut body = String::from(r#"<?xml version="1.0"?><tv>"#);
    for i in 0..5000 {
        body.push_str(&format!(
            r#"<programme start="20261018{:02}0000 +0000" channel="x"><title>T</title></programme>"#,
            i % 24
        ));
    }
    body.push_str("</tv>");
    let error = parse(
        open_reader(std::io::Cursor::new(body.into_bytes()), EXPANDED_LIMIT).unwrap(),
        &ids(&["x"]),
        NOW - KEEP_BEFORE_MS,
        NOW + KEEP_AFTER_MS,
        PROGRAM_LIMIT,
        &mut || Err("canceled".into()),
    )
    .unwrap_err();
    assert_eq!(error, "canceled");
}

// --- storage ------------------------------------------------------------

fn channel_id(letter: char) -> String {
    format!("account-{ACCOUNT}-{}", letter.to_string().repeat(64))
}
/// (letter, name, group, epg id, removed, favorite)
type ChannelRow = (
    char,
    &'static str,
    &'static str,
    Option<&'static str>,
    bool,
    bool,
);
const CHANNELS: &[ChannelRow] = &[
    (
        'a',
        "FOX 32 Chicago",
        "US| LOCALS",
        Some("fox32.us"),
        false,
        true,
    ),
    (
        'b',
        "NFL PPV 1",
        "US| NFL PPV",
        Some("unlisted.us"),
        false,
        false,
    ),
    ('c', "No Guide TV", "US| GENERAL", None, false, false),
    (
        'd',
        "Removed FOX",
        "US| LOCALS",
        Some("fox32.us"),
        true,
        false,
    ),
];
fn database() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    crate::account_media_store::initialize(&c).unwrap();
    crate::account_catalog_query::install_indexes(&c).unwrap();
    c.execute_batch(&format!(
        "INSERT INTO account_vault_versions_v1 VALUES('{ACCOUNT}',1,1);
         INSERT INTO account_vault_meta_v1 VALUES('{ACCOUNT}','Fixture','xtream','https://provider.invalid',0,1,'{SECRET}');
         INSERT INTO account_media_catalog_v1 VALUES('{ACCOUNT}',1,'{SECRET}','{BATCH}',1);
         INSERT INTO account_media_page_v1 VALUES('page-1','{ACCOUNT}','{BATCH}',0,0);
         INSERT INTO account_preferences_meta_v1 VALUES('{ACCOUNT}',1);"
    ))
    .unwrap();
    for (letter, name, group, epg, removed, favorite) in CHANNELS {
        let reference = letter.to_string().repeat(32);
        c.execute(
            "INSERT INTO account_vault_references_v1 VALUES(?1,?2,1,'media')",
            params![reference, ACCOUNT],
        )
        .unwrap();
        c.execute(
            "INSERT INTO account_media_entry_v1 VALUES(?1,?2,?3,?4,NULL,?5,?6,'page-1')",
            params![ACCOUNT, channel_id(*letter), name, group, epg, reference],
        )
        .unwrap();
        if *removed || *favorite {
            c.execute(
                "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,?3,?4,NULL)",
                params![ACCOUNT, channel_id(*letter), favorite, removed],
            )
            .unwrap();
        }
    }
    c
}
fn stored(c: &mut Connection) -> Status {
    let wanted = super::wanted(c, ACCOUNT).unwrap();
    let parsed = parse(
        open_reader(
            std::io::Cursor::new(GUIDE.as_bytes().to_vec()),
            EXPANDED_LIMIT,
        )
        .unwrap(),
        &wanted,
        NOW - KEEP_BEFORE_MS,
        NOW + KEEP_AFTER_MS,
        PROGRAM_LIMIT,
        &mut || Ok(()),
    )
    .unwrap();
    commit(c, ACCOUNT, 1, &parsed, NOW, &mut || Ok(())).unwrap()
}

#[test]
fn guide_history_paid_exact_channel_scope_admits_ppv_without_shared_epg_fanout() {
    let mut c = database();
    stored(&mut c);
    c.execute(
        "UPDATE account_media_entry_v1 SET epg_id='fox32.us' WHERE channel_id=?1",
        [channel_id('b')],
    )
    .unwrap();
    let history = vec![channel_id('b')];
    let listed = listed_channels_history(
        &c,
        ACCOUNT,
        NOW,
        NOW + HOUR,
        "",
        false,
        None,
        Some(&history),
        None,
    )
    .unwrap();
    assert_eq!(listed.channel_ids, history);
    assert_eq!(listed.ppv_channel_ids, history);
    assert!(!programs_history(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        Some(&channel_id('b')),
        None,
        "",
        Some(&history),
        None
    )
    .unwrap()
    .is_empty());
    assert!(programs_history(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        Some(&channel_id('a')),
        None,
        "",
        Some(&history),
        None
    )
    .unwrap()
    .is_empty());
    c.execute(
        "UPDATE account_media_entry_v1 SET category='US Ａｄｕｌｔ PPV' WHERE channel_id=?1",
        [channel_id('b')],
    )
    .unwrap();
    c.execute(
        "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,0,0,'News')",
        params![ACCOUNT, channel_id('b')],
    )
    .unwrap();
    assert!(listed_channels_history(
        &c,
        ACCOUNT,
        NOW,
        NOW + HOUR,
        "",
        false,
        None,
        Some(&history),
        None
    )
    .unwrap()
    .channel_ids
    .is_empty());
    assert_eq!(
        listed_channels_history(
            &c,
            ACCOUNT,
            NOW,
            NOW + HOUR,
            "",
            false,
            None,
            Some(&history),
            Some(false)
        )
        .unwrap()
        .channel_ids,
        history
    );
    assert!(listed_channels_history(
        &c,
        ACCOUNT,
        NOW,
        NOW + HOUR,
        "",
        false,
        None,
        Some(&[]),
        None
    )
    .unwrap()
    .channel_ids
    .is_empty());
    let wrong = vec![format!("account-{}-{}", "f".repeat(32), "b".repeat(64))];
    assert!(listed_channels_history(
        &c,
        ACCOUNT,
        NOW,
        NOW + HOUR,
        "",
        false,
        None,
        Some(&wrong),
        None
    )
    .is_err());
    assert!(programs_history(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        None,
        None,
        "",
        Some(&history),
        None
    )
    .is_err());
    assert!(programs_history(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        Some(&channel_id('b')),
        None,
        "",
        Some(&history),
        None
    )
    .unwrap()
    .is_empty());
    assert!(!programs_history(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        Some(&channel_id('b')),
        None,
        "",
        Some(&history),
        Some(false)
    )
    .unwrap()
    .is_empty());
    c.execute(
        "UPDATE account_channel_preferences_v1 SET removed=1 WHERE channel_id=?1",
        [channel_id('b')],
    )
    .unwrap();
    assert!(listed_channels_history(
        &c,
        ACCOUNT,
        NOW,
        NOW + HOUR,
        "",
        false,
        None,
        Some(&history),
        Some(false)
    )
    .unwrap()
    .channel_ids
    .is_empty());
}

#[test]
fn guide_history_paid_adult_normalization_keeps_all_five_existing_terms() {
    let mut c = database();
    stored(&mut c);
    c.execute(
        "UPDATE account_media_entry_v1 SET epg_id='fox32.us' WHERE channel_id=?1",
        [channel_id('b')],
    )
    .unwrap();
    c.execute(
        "INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,0,0,'News')",
        params![ACCOUNT, channel_id('b')],
    )
    .unwrap();
    let history = vec![channel_id('b')];
    for term in ["Ａｄｕｌｔ", "ＸＸＸ", "１８＋", "🔞", "ＰＯＲＮ"] {
        c.execute(
            "UPDATE account_media_entry_v1 SET category=?1 WHERE channel_id=?2",
            params![format!("US {term} PPV"), channel_id('b')],
        )
        .unwrap();
        assert!(
            listed_channels_history(
                &c,
                ACCOUNT,
                NOW,
                NOW + HOUR,
                "",
                false,
                None,
                Some(&history),
                None
            )
            .unwrap()
            .channel_ids
            .is_empty(),
            "original marker {term}"
        );
        assert!(programs_history(
            &c,
            ACCOUNT,
            "fox32.us",
            NOW,
            NOW + HOUR,
            None,
            100,
            false,
            Some(&channel_id('b')),
            None,
            "",
            Some(&history),
            None
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            listed_channels_history(
                &c,
                ACCOUNT,
                NOW,
                NOW + HOUR,
                "",
                false,
                None,
                Some(&history),
                Some(false)
            )
            .unwrap()
            .channel_ids,
            history
        );
    }
}

#[test]
fn paid_ppv_metadata_and_programmes_stay_out_of_regular_guide_search() {
    let mut c = database();
    stored(&mut c);
    c.execute("INSERT INTO account_channel_preferences_v1 VALUES(?1,?2,1,0,'Sports') ON CONFLICT(account_id,channel_id) DO UPDATE SET category='Sports'", params![ACCOUNT, channel_id('b')]).unwrap();
    let rows = channels(&c, ACCOUNT).unwrap();
    assert!(rows.iter().find(|r| r.id == channel_id('b')).unwrap().ppv);
    assert!(!rows.iter().find(|r| r.id == channel_id('a')).unwrap().ppv);
    let ppv = listed_in_scope(&c, ACCOUNT, NOW, NOW + 3 * HOUR, "", true).unwrap();
    assert_eq!(ppv, ["unlisted.us"]);
    assert!(
        programs(&c, ACCOUNT, "unlisted.us", NOW, NOW + 3 * HOUR, None, 100)
            .unwrap()
            .is_empty()
    );
    assert!(!programs_in_scope(
        &c,
        ACCOUNT,
        "unlisted.us",
        NOW,
        NOW + 3 * HOUR,
        None,
        100,
        true,
        Some(&channel_id('b'))
    )
    .unwrap()
    .is_empty());
    c.execute("INSERT INTO account_guide_program_v1 VALUES(?1,'fox32.us',?2,?3,10,'Boxing PPV 17','Sports match','[]')",params![ACCOUNT,NOW,NOW+HOUR]).unwrap();
    assert!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "boxing")
        .unwrap()
        .is_empty());
    assert_eq!(
        listed_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "boxing", true).unwrap(),
        ["fox32.us"]
    );
    assert!(
        programs(&c, ACCOUNT, "fox32.us", NOW, NOW + HOUR, None, 100)
            .unwrap()
            .iter()
            .all(|p| p.title != "Boxing PPV 17")
    );
    assert_eq!(
        programs_in_scope(
            &c,
            ACCOUNT,
            "fox32.us",
            NOW,
            NOW + HOUR,
            None,
            100,
            true,
            Some(&channel_id('a'))
        )
        .unwrap()
        .iter()
        .map(|p| p.title.as_str())
        .collect::<Vec<_>>(),
        ["Boxing PPV 17"]
    );
    // Current live membership remains authoritative even when stale guide rows exist.
    c.execute(
        "UPDATE account_channel_preferences_v1 SET removed=1 WHERE account_id=?1 AND channel_id=?2",
        params![ACCOUNT, channel_id('b')],
    )
    .unwrap();
    assert!(listed_in_scope(&c, ACCOUNT, NOW, NOW + 3 * HOUR, "", true)
        .unwrap()
        .iter()
        .all(|epg| epg != "unlisted.us"));
}

#[test]
fn ppv_guide_membership_is_exact_channel_not_a_shared_epg_alias() {
    let mut c = database();
    stored(&mut c);
    c.execute(
        "UPDATE account_media_entry_v1 SET epg_id='fox32.us' WHERE channel_id=?1",
        [channel_id('b')],
    )
    .unwrap();
    assert_eq!(
        listed_channels_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "", true)
            .unwrap()
            .channel_ids,
        [channel_id('b')]
    );
    assert_eq!(
        listed_channels_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "", false)
            .unwrap()
            .channel_ids,
        [channel_id('a')]
    );
    assert!(programs_in_scope(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        true,
        Some(&channel_id('a'))
    )
    .unwrap()
    .is_empty());
    assert!(!programs_in_scope(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        true,
        Some(&channel_id('b'))
    )
    .unwrap()
    .is_empty());
    assert!(programs_in_scope(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        Some(&channel_id('b'))
    )
    .unwrap()
    .is_empty());
    assert_eq!(
        programs_in_scope(
            &c,
            ACCOUNT,
            "fox32.us",
            NOW,
            NOW + HOUR,
            None,
            100,
            true,
            None
        )
        .unwrap_err(),
        "account-guide-channel-invalid"
    );
    let foreign = format!("account-{}-{}", "c".repeat(32), "a".repeat(64));
    assert_eq!(
        programs_in_scope(
            &c,
            ACCOUNT,
            "fox32.us",
            NOW,
            NOW + HOUR,
            None,
            100,
            true,
            Some(&foreign)
        )
        .unwrap_err(),
        "account-guide-channel-invalid"
    );
    assert!(programs_in_scope(
        &c,
        ACCOUNT,
        "unlisted.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        true,
        Some(&channel_id('b'))
    )
    .unwrap()
    .is_empty());
    assert!(programs_in_scope(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        true,
        Some(&channel_id('f'))
    )
    .unwrap()
    .is_empty());
    c.execute("INSERT INTO account_guide_program_v1 VALUES(?1,'fox32.us',?2,?3,10,'Boxing PPV17',NULL,'[]')",params![ACCOUNT,NOW,NOW+HOUR]).unwrap();
    assert_eq!(
        listed_channels_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "boxing", true)
            .unwrap()
            .channel_ids,
        [channel_id('a'), channel_id('b')]
    );
    assert!(
        listed_channels_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "boxing", false)
            .unwrap()
            .channel_ids
            .is_empty()
    );
    assert_eq!(
        programs_in_scope(
            &c,
            ACCOUNT,
            "fox32.us",
            NOW,
            NOW + HOUR,
            None,
            100,
            true,
            Some(&channel_id('a'))
        )
        .unwrap()
        .iter()
        .map(|p| p.title.as_str())
        .collect::<Vec<_>>(),
        ["Boxing PPV17"]
    );
}

#[test]
fn paid_guide_membership_classifies_live_rows_once_and_uses_indexed_programme_lookups() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let mut c = database();
    stored(&mut c);
    let add = |from: i64, to: i64| {
        c.execute(&format!("WITH RECURSIVE n(i) AS(VALUES(?1) UNION ALL SELECT i+1 FROM n WHERE i<?2) INSERT INTO account_vault_references_v1 SELECT printf('%032x',i+100),'{ACCOUNT}',1,'media' FROM n"), params![from,to]).unwrap();
        c.execute(&format!("WITH RECURSIVE n(i) AS(VALUES(?1) UNION ALL SELECT i+1 FROM n WHERE i<?2) INSERT INTO account_media_entry_v1 SELECT '{ACCOUNT}','account-{ACCOUNT}-'||printf('%064x',i+100),'Sports channel','US Sports',NULL,'unrelated-'||i,printf('%032x',i+100),'page-1' FROM n"), params![from,to]).unwrap();
        c.execute(&format!("WITH RECURSIVE n(i) AS(VALUES(?1) UNION ALL SELECT i+1 FROM n WHERE i<?2) INSERT INTO account_guide_program_v1 SELECT '{ACCOUNT}','unrelated-'||i,{NOW},{},0,'Ordinary football',NULL,'[]' FROM n",NOW+HOUR),params![from,to]).unwrap();
    };
    let measure = || {
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        c.progress_handler(
            100,
            Some(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                false
            }),
        )
        .unwrap();
        let result =
            listed_channels_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "football", false).unwrap();
        c.progress_handler(0, None::<fn() -> bool>).unwrap();
        (result.channel_ids.len(), count.load(Ordering::SeqCst))
    };
    add(1, 1000);
    let (first_rows, first) = measure();
    add(1001, 2000);
    let (second_rows, second) = measure();
    assert_eq!(second_rows - first_rows, 1000);
    assert!(
        first > 0 && second < first * 3,
        "doubling unrelated rows must stay below quadratic work: {first}, {second}"
    );
}

#[test]
fn the_accounts_epg_ids_come_from_its_live_channels() {
    let c = database();
    assert_eq!(
        super::wanted(&c, ACCOUNT).unwrap(),
        ids(&["fox32.us", "unlisted.us"])
    );
}
#[test]
fn guide_location_uses_the_same_country_resolver_and_original_group_as_paid_browsing() {
    let mut c = database();
    stored(&mut c);
    for (group, expected) in [
        ("USA | LOCALS", Some("US")),
        ("US| SPORTS", Some("US")),
        ("Canada | NEWS", Some("CA")),
        ("Unknown group", None),
    ] {
        c.execute(
            "UPDATE account_media_entry_v1 SET category=?2 WHERE channel_id=?1",
            params![channel_id('a'), group],
        )
        .unwrap();
        c.execute(
            "UPDATE account_channel_preferences_v1 SET category='Sports' WHERE channel_id=?1",
            [channel_id('a')],
        )
        .unwrap();
        let row = channels(&c, ACCOUNT)
            .unwrap()
            .into_iter()
            .find(|row| row.id == channel_id('a'))
            .unwrap();
        assert_eq!(row.country.as_deref(), expected);
        assert_eq!(row.category, "Sports");
    }
}

#[test]
fn a_committed_guide_lists_channels_listings_and_search_for_this_account() {
    let mut c = database();
    assert_eq!(status(&c, ACCOUNT).unwrap(), None);
    let receipt = stored(&mut c);
    assert_eq!(
        (
            receipt.revision,
            receipt.programs,
            receipt.channels,
            receipt.skipped
        ),
        (1, 4, 2, 3)
    );
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(receipt));
    // Removed channels stay out; a channel without an EPG ID has no guide row.
    let rows = channels(&c, ACCOUNT).unwrap();
    let names: Vec<(&str, bool)> = rows.iter().map(|r| (r.name.as_str(), r.favorite)).collect();
    assert_eq!(names, vec![("FOX 32 Chicago", true), ("NFL PPV 1", false)]);
    assert_eq!(rows[0].id, channel_id('a'));
    assert_eq!(rows[0].category, "US| LOCALS");
    assert_eq!(rows[0].stream_reference, "a".repeat(32));
    let mut window = listed(&c, ACCOUNT, NOW, NOW + 3 * HOUR, "").unwrap();
    window.sort();
    assert_eq!(window, vec!["fox32.us".to_string()]);
    assert_eq!(
        listed(&c, ACCOUNT, NOW, NOW + 3 * HOUR, "bears SAINTS").unwrap(),
        vec!["fox32.us".to_string()]
    );
    assert!(listed(&c, ACCOUNT, NOW, NOW + 3 * HOUR, "hockey")
        .unwrap()
        .is_empty());
    // A long programme that began before the window still shows in it.
    assert_eq!(
        listed(&c, ACCOUNT, NOW + 2 * HOUR, NOW + 2 * HOUR + 1, "").unwrap(),
        vec!["fox32.us".to_string()]
    );
    let page = programs(&c, ACCOUNT, "fox32.us", NOW, NOW + 4 * HOUR, None, 1).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].title, "NFL Football: Bears at Saints");
    let next = programs(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + 4 * HOUR,
        Some((page[0].start_ms, page[0].ordinal)),
        100,
    )
    .unwrap();
    let titles: Vec<&str> = next.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(titles, vec!["Pregame", "Local News"]);
}

#[test]
fn a_new_guide_replaces_the_old_one_whole() {
    let mut c = database();
    stored(&mut c);
    let only = r#"<?xml version="1.0"?><tv><programme start="20261018200000 +0000" stop="20261018210000 +0000" channel="fox32.us"><title>Replacement</title></programme></tv>"#;
    let parsed = read(only, &["fox32.us", "unlisted.us"]).unwrap();
    let receipt = commit(&mut c, ACCOUNT, 1, &parsed, NOW + HOUR, &mut || Ok(())).unwrap();
    assert_eq!((receipt.revision, receipt.programs), (2, 1));
    assert!(
        programs(&c, ACCOUNT, "unlisted.us", NOW, NOW + 4 * HOUR, None, 100)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_failed_or_stale_publication_keeps_the_last_good_guide() {
    // XC-036: the account changed during the download, or the write was canceled.
    let mut c = database();
    let good = stored(&mut c);
    let parsed = read(GUIDE, &["fox32.us"]).unwrap();
    assert_eq!(
        commit(&mut c, ACCOUNT, 2, &parsed, NOW, &mut || Ok(())).unwrap_err(),
        "account-revision-conflict"
    );
    assert_eq!(
        commit(&mut c, ACCOUNT, 1, &parsed, NOW, &mut || Err(
            "canceled".into()
        ))
        .unwrap_err(),
        "canceled"
    );
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(good));
    assert_eq!(
        programs_in_scope(
            &c,
            ACCOUNT,
            "unlisted.us",
            NOW,
            NOW + 4 * HOUR,
            None,
            100,
            true,
            Some(&channel_id('b'))
        )
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn an_edited_account_hides_the_old_guide_and_removal_deletes_it() {
    let mut c = database();
    stored(&mut c);
    // Editing the sign-in makes a new account revision: the old guide is not shown.
    c.execute_batch(&format!(
        "UPDATE account_vault_versions_v1 SET revision=2 WHERE id='{ACCOUNT}';
         UPDATE account_vault_meta_v1 SET revision=2 WHERE id='{ACCOUNT}';"
    ))
    .unwrap();
    assert_eq!(status(&c, ACCOUNT).unwrap(), None);
    assert!(channels(&c, ACCOUNT).unwrap().is_empty());
    assert!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "").unwrap().is_empty());
    // Removing the account cascades its guide away.
    c.execute_batch(&format!(
        "DELETE FROM account_channel_preferences_v1 WHERE account_id='{ACCOUNT}';
         DELETE FROM account_preferences_meta_v1 WHERE account_id='{ACCOUNT}';
         DELETE FROM account_vault_references_v1 WHERE account_id='{ACCOUNT}';
         DELETE FROM account_vault_meta_v1 WHERE id='{ACCOUNT}';"
    ))
    .unwrap();
    let left: i64 = c
        .query_row("SELECT COUNT(*) FROM account_guide_program_v1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn search_matches_whole_words_not_letters_inside_words() {
    // "nfl" must not match "conflict" (as in the Free TV guide's search).
    let mut c = database();
    let xml = r#"<?xml version="1.0"?><tv>
      <programme start="20261018180000 +0000" stop="20261018190000 +0000" channel="fox32.us"><title>NFL Football</title></programme>
      <programme start="20261018180000 +0000" stop="20261018190000 +0000" channel="unlisted.us"><title>History of Conflict</title><desc>Influential battles.</desc></programme>
    </tv>"#;
    let parsed = read(xml, &["fox32.us", "unlisted.us"]).unwrap();
    commit(&mut c, ACCOUNT, 1, &parsed, NOW, &mut || Ok(())).unwrap();
    assert_eq!(
        listed(&c, ACCOUNT, NOW, NOW + HOUR, "nfl").unwrap(),
        vec!["fox32.us".to_string()]
    );
    assert_eq!(
        listed(&c, ACCOUNT, NOW, NOW + HOUR, "NFL foot").unwrap(),
        vec!["fox32.us".to_string()]
    );
    assert!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "conflict")
        .unwrap()
        .is_empty());
    assert_eq!(
        listed_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "conflict", true).unwrap(),
        vec!["unlisted.us".to_string()]
    );
    assert_eq!(
        listed_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "battles", true).unwrap(),
        vec!["unlisted.us".to_string()]
    );
    assert!(listed_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "flict", true)
        .unwrap()
        .is_empty());
}

fn automatic_policy(c: &Connection) {
    c.execute_batch("CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,automatic_guide_updates INTEGER);INSERT INTO metadata VALUES(1,1)").unwrap();
}
#[test]
fn automatic_guide_requires_permission_due_cached_schedule_and_manual_refresh_stays_independent() {
    let mut c = database();
    automatic_policy(&c);
    let before = c.total_changes();
    assert_eq!(
        admit_automatic(&c, ACCOUNT, 1, NOW).unwrap_err(),
        "account-guide-not-cached"
    );
    assert_eq!(before, c.total_changes());
    let saved = stored(&mut c);
    let due = NOW + crate::guide::refresh::INTERVAL_MS;
    assert_eq!(
        admit_automatic(&c, ACCOUNT, 1, due - 1).unwrap_err(),
        "account-guide-not-due"
    );
    admit_automatic(&c, ACCOUNT, 1, due).unwrap();
    c.execute("UPDATE metadata SET automatic_guide_updates=0", [])
        .unwrap();
    assert_eq!(
        admit_automatic(&c, ACCOUNT, 1, due).unwrap_err(),
        "guide-refresh-disabled"
    );
    let parsed = read(GUIDE, &["fox32.us"]).unwrap();
    let manual = commit(&mut c, ACCOUNT, 1, &parsed, due, &mut || Ok(())).unwrap();
    assert_eq!(manual.revision, saved.revision + 1);
}
#[test]
fn automatic_guide_rechecks_midfetch_permission_account_and_manual_winner_before_commit() {
    let mut c = database();
    automatic_policy(&c);
    let saved = stored(&mut c);
    let due = NOW + crate::guide::refresh::INTERVAL_MS;
    let parsed = read(GUIDE, &["fox32.us"]).unwrap();
    admit_automatic(&c, ACCOUNT, 1, due).unwrap();
    // A revoked toggle while XML was in flight cannot publish its response.
    c.execute("UPDATE metadata SET automatic_guide_updates=0", [])
        .unwrap();
    assert_eq!(
        commit_automatic(&mut c, ACCOUNT, 1, &parsed, due, &mut || Ok(())).unwrap_err(),
        "guide-refresh-disabled"
    );
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(saved.clone()));
    c.execute("UPDATE metadata SET automatic_guide_updates=1", [])
        .unwrap();
    admit_automatic(&c, ACCOUNT, 1, due).unwrap();
    c.execute(
        "UPDATE account_vault_versions_v1 SET active=0 WHERE id=?1",
        [ACCOUNT],
    )
    .unwrap();
    assert_eq!(
        commit_automatic(&mut c, ACCOUNT, 1, &parsed, due, &mut || Ok(())).unwrap_err(),
        "account-revision-conflict"
    );
    c.execute(
        "UPDATE account_vault_versions_v1 SET active=1 WHERE id=?1",
        [ACCOUNT],
    )
    .unwrap();
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(saved));
    admit_automatic(&c, ACCOUNT, 1, due).unwrap();
    let manual = commit(&mut c, ACCOUNT, 1, &parsed, due, &mut || Ok(())).unwrap();
    assert_eq!(
        commit_automatic(&mut c, ACCOUNT, 1, &parsed, due + 1, &mut || Ok(())).unwrap_err(),
        "account-guide-not-due"
    );
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(manual));
}
#[test]
fn automatic_guide_cancel_and_expired_response_keep_last_good_schedule() {
    let mut c = database();
    automatic_policy(&c);
    let saved = stored(&mut c);
    let due = NOW + crate::guide::refresh::INTERVAL_MS;
    let mut parsed = read(GUIDE, &["fox32.us"]).unwrap();
    assert_eq!(
        commit_automatic(&mut c, ACCOUNT, 1, &parsed, due, &mut || Err(
            "canceled".into()
        ))
        .unwrap_err(),
        "canceled"
    );
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(saved.clone()));
    for p in &mut parsed.programs {
        p.stop_ms = Some(due);
    }
    assert_eq!(
        commit_automatic(&mut c, ACCOUNT, 1, &parsed, due, &mut || Ok(())).unwrap_err(),
        "account-guide-no-future-schedule"
    );
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(saved));
}

#[test]
fn sports_paid_guide_uses_categories_exact_channels_and_matching_ppv_only() {
    let mut c = database();
    stored(&mut c);
    c.execute(
        "UPDATE account_media_entry_v1 SET epg_id='fox32.us' WHERE account_id=?1 AND channel_id=?2",
        params![ACCOUNT, channel_id('b')],
    )
    .unwrap();
    c.execute(r#"UPDATE account_guide_program_v1 SET title='Bears at Packers',description=NULL,categories='[{"text":"NFL"}]' WHERE account_id=?1 AND epg_id='fox32.us'"#,[ACCOUNT]).unwrap();
    assert_eq!(
        listed_channels_in_scope(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false)
            .unwrap()
            .channel_ids,
        [channel_id('a')],
        "legacy metadata parity includes stored categories"
    );
    let mut scope = crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: true,
        window_start_ms: NOW,
        window_end_ms: NOW + 7 * 24 * HOUR,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    };
    assert_eq!(
        listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope))
            .unwrap()
            .channel_ids,
        [channel_id('a'), channel_id('b')]
    );
    let rows = programs_sports(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        Some(&channel_id('b')),
        Some(&scope),
        "NFL",
    )
    .unwrap();
    assert!(!rows.is_empty());
    assert!(programs_sports(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        None,
        Some(&scope),
        "NFL"
    )
    .is_err());
    c.execute("INSERT INTO account_guide_program_v1 VALUES(?1,'fox32.us',?2,?3,99,'NBA PPV Finals',NULL,'[]')",params![ACCOUNT,NOW,NOW+HOUR]).unwrap();
    assert!(programs_sports(
        &c,
        ACCOUNT,
        "fox32.us",
        NOW,
        NOW + HOUR,
        None,
        100,
        false,
        Some(&channel_id('b')),
        Some(&scope),
        "NFL"
    )
    .unwrap()
    .iter()
    .all(|p| p.ordinal != 99));
    let before =
        listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope)).unwrap();
    assert_eq!(before.ppv_channel_ids, [channel_id('b')]);
    c.execute("UPDATE account_guide_program_v1 SET title='NFL PPV Game' WHERE account_id=?1 AND epg_id='fox32.us' AND ordinal<>99",[ACCOUNT]).unwrap();
    let ppv_only =
        listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope)).unwrap();
    assert_eq!(ppv_only.ppv_channel_ids, [channel_id('a'), channel_id('b')]);
    c.execute("INSERT INTO account_guide_program_v1 VALUES(?1,'fox32.us',?2,?3,100,'NFL Pregame',NULL,'[]')",params![ACCOUNT,NOW,NOW+HOUR]).unwrap();
    assert_eq!(
        listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope))
            .unwrap()
            .ppv_channel_ids,
        [channel_id('b')]
    );
    scope.include_ppv = false;
    assert_eq!(
        listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope))
            .unwrap()
            .channel_ids,
        [channel_id('a')]
    );
    scope.window_start_ms = NOW + 8 * 24 * HOUR;
    scope.window_end_ms = scope.window_start_ms + HOUR;
    assert!(
        listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope))
            .unwrap()
            .channel_ids
            .is_empty()
    );
    c.execute(
        "UPDATE account_vault_versions_v1 SET active=0 WHERE id=?1",
        [ACCOUNT],
    )
    .unwrap();
    assert!(
        listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope))
            .unwrap()
            .channel_ids
            .is_empty()
    );
}

#[test]
fn sports_paid_cached_membership_keeps_live_classification_and_programme_work_linear() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let mut c = database();
    stored(&mut c);
    let add = |from: i64, to: i64| {
        c.execute(&format!("WITH RECURSIVE n(i) AS(VALUES(?1) UNION ALL SELECT i+1 FROM n WHERE i<?2) INSERT INTO account_vault_references_v1 SELECT printf('%032x',i+100),'{ACCOUNT}',1,'media' FROM n"),params![from,to]).unwrap();
        c.execute(&format!("WITH RECURSIVE n(i) AS(VALUES(?1) UNION ALL SELECT i+1 FROM n WHERE i<?2) INSERT INTO account_media_entry_v1 SELECT '{ACCOUNT}','account-{ACCOUNT}-'||printf('%064x',i+100),'Local affiliate','US Locals',NULL,'sport-'||i,printf('%032x',i+100),'page-1' FROM n"),params![from,to]).unwrap();
        c.execute(&format!("WITH RECURSIVE n(i) AS(VALUES(?1) UNION ALL SELECT i+1 FROM n WHERE i<?2) INSERT INTO account_guide_program_v1 SELECT '{ACCOUNT}','sport-'||i,{NOW},{},0,'Chicago Bears at Detroit Lions',NULL,'[]' FROM n",NOW+HOUR),params![from,to]).unwrap();
    };
    let scope = crate::catalog::sports::Scope {
        sport: None,
        league: None,
        include_ppv: true,
        window_start_ms: NOW,
        window_end_ms: NOW + 7 * 24 * HOUR,
        vocabulary_version: serde_json::from_str::<serde_json::Value>(
            crate::catalog::sports::VOCABULARY,
        )
        .unwrap()["vocabularyVersion"]
            .as_str()
            .unwrap()
            .into(),
    };
    let measure = || {
        let steps = Arc::new(AtomicUsize::new(0));
        let observed = steps.clone();
        c.progress_handler(
            100,
            Some(move || observed.fetch_add(1, Ordering::SeqCst) > 100_000),
        )
        .unwrap();
        let listed =
            listed_channels_sports(&c, ACCOUNT, NOW, NOW + HOUR, "NFL", false, Some(&scope))
                .unwrap();
        let plan = crate::catalog::sports::Plan::new(&scope, "NFL").unwrap();
        let matched =
            crate::catalog::sports::register_paid_list(&c, &plan, ACCOUNT, false).unwrap();
        let explain = crate::catalog::sports::paid_plan();
        assert!(
            explain
                .iter()
                .any(|p| p.contains("SEARCH g USING PRIMARY KEY")
                    && p.contains("epg_id=?")
                    && p.contains("start_ms>?")
                    && p.contains("start_ms<?")),
            "{explain:?}"
        );
        assert!(
            !explain.iter().any(|p| p.starts_with("SCAN g")),
            "{explain:?}"
        );
        c.progress_handler(0, None::<fn() -> bool>).unwrap();
        assert!(listed.channel_ids.iter().all(|id| matched.all.contains(id)));
        (listed.channel_ids.len(), steps.load(Ordering::SeqCst))
    };
    add(1, 1000);
    let (count1, steps1) = measure();
    let red_steps = Arc::new(AtomicUsize::new(0));
    let red_observed = red_steps.clone();
    c.progress_handler(
        100,
        Some(move || red_observed.fetch_add(1, Ordering::SeqCst) > 10000),
    )
    .unwrap();
    let red = crate::catalog::sports::reordered_paid_probe(&c, ACCOUNT, &scope);
    c.progress_handler(0, None::<fn() -> bool>).unwrap();
    assert!(
        matches!(red,Err(rusqlite::Error::SqliteFailure(ref e,_)) if e.code==rusqlite::ErrorCode::OperationInterrupted),
        "reordered join must exceed bounded VM work: {red:?}"
    );
    eprintln!(
        "sports Paid reordered control interrupted_vm_blocks={}",
        red_steps.load(Ordering::SeqCst)
    );
    add(1001, 2000);
    let (count2, steps2) = measure();
    assert_eq!(count2 - count1, 1000);
    assert!(
        steps1 > 0 && steps2 < steps1 * 3,
        "1000={steps1};2000={steps2}"
    );
    eprintln!("sports Paid indexed fixture channels1000_vm_blocks={steps1} channels2000_vm_blocks={steps2}");
}
