//! Prepared, unrun fixtures: fresh siblings must still prevent ambiguous reuse.
use super::*;

fn fixture() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE scan_manifest(id TEXT,job_id TEXT,review_digest TEXT,state INTEGER);
        CREATE TABLE source_activation_row(manifest_id TEXT,ordinal INTEGER,source_id TEXT,source_revision TEXT);
        CREATE TABLE source_snapshot_source(source_id TEXT,revision INTEGER);
        CREATE TABLE source_snapshot_entry(source_id TEXT,ordinal INTEGER,channel TEXT,available INTEGER);
        INSERT INTO scan_manifest VALUES('manifest','job','digest',1);
        INSERT INTO source_activation_row VALUES('manifest',0,'s','1');
        INSERT INTO source_snapshot_source VALUES('s',1);").unwrap();
    c
}
fn channel(provider: &str, name: &str) -> Value {
    json!({"sourceId":"s","providerId":provider,"name":name,"category":"News"})
}
#[test]
fn unselected_full_source_sibling_after_first_page_preserves_both_ambiguities() {
    let c = fixture();
    let selected_channel = channel("provider", "Station");
    for ordinal in 0..66 {
        let value = match ordinal {
            0 => selected_channel.clone(),
            65 => channel("provider", "Ｓｔａｔｉｏｎ"),
            _ => channel(&format!("other-{ordinal}"), "Different"),
        };
        c.execute(
            "INSERT INTO source_snapshot_entry VALUES('s',?1,?2,1)",
            params![ordinal, value.to_string()],
        )
        .unwrap();
    }
    let candidate = json!({"sourceId":"s","channel":selected_channel});
    let observation = Value::Null;
    let selected = [crate::scan_resume_reconcile::Selected {
        original_index: 0,
        candidate: &candidate,
        observation: &observation,
    }];
    let result = prepare(
        &c,
        &json!({"jobId":"job","reviewDigest":"digest"}),
        &selected,
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(
        result.ambiguous(&candidate["channel"]).unwrap(),
        (true, true)
    );
    assert_eq!(result.provider.len(), 1);
    assert_eq!(result.metadata.len(), 1);
}
#[test]
fn replaced_source_revision_refuses_preparation() {
    let c = fixture();
    c.execute("UPDATE source_snapshot_source SET revision=2", [])
        .unwrap();
    let candidate = json!({"sourceId":"s","channel":channel("provider", "Station")});
    let observation = Value::Null;
    let selected = [crate::scan_resume_reconcile::Selected {
        original_index: 0,
        candidate: &candidate,
        observation: &observation,
    }];
    assert_eq!(
        prepare(
            &c,
            &json!({"jobId":"job","reviewDigest":"digest"}),
            &selected,
            &mut || Ok(())
        )
        .err()
        .unwrap(),
        "source-snapshot-revision-stale"
    );
}
