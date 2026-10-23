//! Narrow same-snapshot logo identity capture; no URL/name-based matching.
use super::*;
impl PairStore {
    pub(crate) fn channel_logo_capture(
        &self,
        ids: &[String],
        revision: &str,
        check: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<crate::channel_logos::Capture, String> {
        if ids.is_empty()
            || ids.len() > 32
            || ids.iter().any(|id| id.is_empty() || id.len() > 16384)
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
        {
            return Err("channel-logo-request-invalid".into());
        }
        check()?;
        let mut connection = connect(&self.root.join(DB), true)?;
        let tx = sql(connection.transaction())?;
        let actual: i64 = sql(tx.query_row(
            "SELECT catalog_revision FROM metadata WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        if actual < 0 || actual.to_string() != revision {
            return Err("channel-logo-catalog-stale".into());
        }
        let mut statement = sql(tx.prepare("SELECT CASE WHEN length(CAST(provider_id AS BLOB))<=1024 THEN provider_id ELSE NULL END FROM channel WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM removed WHERE removed.id=channel.id)"))?;
        let mut rows = Vec::with_capacity(ids.len());
        for id in ids {
            check()?;
            use rusqlite::OptionalExtension;
            let provider: Option<Option<String>> =
                sql(statement.query_row([id], |row| row.get(0)).optional())?;
            // A missing ID never lends another channel's image to this row.
            let provider_ids = provider
                .flatten()
                .filter(|p| p.len() <= 1024)
                .into_iter()
                .collect();
            rows.push(crate::channel_logos::LogoRow {
                channel_id: id.clone(),
                provider_ids,
            });
        }
        check()?;
        Ok(crate::channel_logos::Capture {
            root: self.root.clone(),
            rows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PairStore, String) {
        let root = tempfile::tempdir().unwrap();
        let store = PairStore::new(root.path().into()).unwrap();
        let catalog = json!({"schemaVersion":1,"sources":[{"id":"s","name":"Fixture","kind":"file","location":"fixture"}],"channels":[
            {"id":"a","sourceId":"s","providerId":"Exact.us@East","name":"Name cannot lend identity","category":"News","urls":["https://example.invalid/a"]},
            {"id":"b","sourceId":"s","name":"Exact.us@East","category":"News","urls":["https://example.invalid/b"]},
            {"id":"removed","sourceId":"s","providerId":"Other.us","name":"Removed","category":"News","urls":["https://example.invalid/c"]}
        ]});
        let prefs = json!({"schemaVersion":1,"sources":catalog["sources"],"favorites":[],"removedChannels":["removed"],"volume":0.5,"muted":true,"panelWidth":300});
        store
            .write_pair(&catalog.to_string(), &prefs.to_string())
            .unwrap();
        let c = connect(&root.path().join(DB), true).unwrap();
        let revision: i64 = c
            .query_row(
                "SELECT catalog_revision FROM metadata WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        (root, store, revision.to_string())
    }
    #[test]
    fn channel_logo_capture_uses_exact_saved_provider_and_omits_removed_or_name_guesses() {
        let (root, store, revision) = fixture();
        let before = std::fs::read(root.path().join(DB)).unwrap();
        let ids = ["a", "b", "removed", "absent"].map(String::from);
        let capture = store
            .channel_logo_capture(&ids, &revision, &mut || Ok(()))
            .unwrap();
        assert_eq!(capture.root, root.path());
        assert_eq!(capture.rows.len(), 4);
        assert_eq!(capture.rows[0].provider_ids, vec!["Exact.us@East"]);
        assert!(capture.rows[1..]
            .iter()
            .all(|row| row.provider_ids.is_empty()));
        assert_eq!(std::fs::read(root.path().join(DB)).unwrap(), before);
    }
    #[test]
    fn channel_logo_capture_stale_cancel_and_invalid_batches_do_not_mutate_catalog() {
        let (root, store, revision) = fixture();
        let before = std::fs::read(root.path().join(DB)).unwrap();
        let ids = vec!["a".into()];
        assert_eq!(
            store
                .channel_logo_capture(&ids, "999999", &mut || Ok(()))
                .err()
                .unwrap(),
            "channel-logo-catalog-stale"
        );
        assert_eq!(
            store
                .channel_logo_capture(&ids, &revision, &mut || Err("canceled".into()))
                .err()
                .unwrap(),
            "canceled"
        );
        for ids in [
            vec![],
            vec!["a".into(), "a".into()],
            vec!["".into()],
            (0..33).map(|n| n.to_string()).collect(),
        ] {
            assert_eq!(
                store
                    .channel_logo_capture(&ids, &revision, &mut || Ok(()))
                    .err()
                    .unwrap(),
                "channel-logo-request-invalid"
            );
        }
        assert_eq!(std::fs::read(root.path().join(DB)).unwrap(), before);
    }
}
