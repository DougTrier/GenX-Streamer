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
            row("unlisted.us", "Channel the file never declared", NOW + HOUR, 0),
        ]
    );
    // Broken time, no title, markup inside a title: counted, never shown.
    assert_eq!(parsed.skipped, 3);
    let game = &parsed.programs[0];
    assert_eq!(game.description.as_deref(), Some("Chicago & New Orleans meet."));
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
    assert_eq!(read(subset, &["fox32.us"]).unwrap_err(), "account-guide-malformed");
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
const CHANNELS: &[(char, &str, &str, Option<&str>, bool, bool)] = &[
    ('a', "FOX 32 Chicago", "US| LOCALS", Some("fox32.us"), false, true),
    ('b', "NFL PPV 1", "US| NFL PPV", Some("unlisted.us"), false, false),
    ('c', "No Guide TV", "US| GENERAL", None, false, false),
    ('d', "Removed FOX", "US| LOCALS", Some("fox32.us"), true, false),
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
        open_reader(std::io::Cursor::new(GUIDE.as_bytes().to_vec()), EXPANDED_LIMIT).unwrap(),
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
fn the_accounts_epg_ids_come_from_its_live_channels() {
    let c = database();
    assert_eq!(super::wanted(&c, ACCOUNT).unwrap(), ids(&["fox32.us", "unlisted.us"]));
}

#[test]
fn a_committed_guide_lists_channels_listings_and_search_for_this_account() {
    let mut c = database();
    assert_eq!(status(&c, ACCOUNT).unwrap(), None);
    let receipt = stored(&mut c);
    assert_eq!((receipt.revision, receipt.programs, receipt.channels, receipt.skipped), (1, 4, 2, 3));
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
    assert_eq!(window, vec!["fox32.us".to_string(), "unlisted.us".to_string()]);
    assert_eq!(listed(&c, ACCOUNT, NOW, NOW + 3 * HOUR, "bears SAINTS").unwrap(), vec!["fox32.us".to_string()]);
    assert!(listed(&c, ACCOUNT, NOW, NOW + 3 * HOUR, "hockey").unwrap().is_empty());
    // A long programme that began before the window still shows in it.
    assert_eq!(listed(&c, ACCOUNT, NOW + 2 * HOUR, NOW + 2 * HOUR + 1, "").unwrap(), vec!["fox32.us".to_string()]);
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
    assert!(programs(&c, ACCOUNT, "unlisted.us", NOW, NOW + 4 * HOUR, None, 100).unwrap().is_empty());
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
        commit(&mut c, ACCOUNT, 1, &parsed, NOW, &mut || Err("canceled".into())).unwrap_err(),
        "canceled"
    );
    assert_eq!(status(&c, ACCOUNT).unwrap(), Some(good));
    assert_eq!(programs(&c, ACCOUNT, "unlisted.us", NOW, NOW + 4 * HOUR, None, 100).unwrap().len(), 1);
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
        .query_row("SELECT COUNT(*) FROM account_guide_program_v1", [], |r| r.get(0))
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
    assert_eq!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "nfl").unwrap(), vec!["fox32.us".to_string()]);
    assert_eq!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "NFL foot").unwrap(), vec!["fox32.us".to_string()]);
    assert_eq!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "conflict").unwrap(), vec!["unlisted.us".to_string()]);
    assert_eq!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "battles").unwrap(), vec!["unlisted.us".to_string()]);
    assert!(listed(&c, ACCOUNT, NOW, NOW + HOUR, "flict").unwrap().is_empty());
}
