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

//! The store's channel-list page cache returns exactly what an uncached query
//! returns, across filters, sorts, searches, anchors, cursors and later writes.
use super::*;
use std::sync::{atomic::AtomicBool, Arc};

fn channel(i: usize) -> Value {
    let category = ["News", "Sports", "Movies", "Kids", "Sports;News", "XXX"][i % 6];
    let country = ["US", "UK", "CA", "MX"][i % 4];
    // Every fifth channel shares a provider/stream with its neighbour, so the
    // grouped (endpoint) projection has real groups to collapse.
    let stream = if i % 5 == 1 { i - 1 } else { i };
    json!({
        "id": format!("ch-{i:03}"),
        "sourceId": if i.is_multiple_of(3) { "b" } else { "a" },
        "providerId": format!("Provider{}.us@SD", stream),
        "name": format!("{} Channel {i}", ["Alpha", "News", "Sport", "Zeta"][i % 4]),
        "category": category,
        "geography": {"country": country},
        "urls": [format!("https://example.invalid/live/{stream}")]
    })
}
fn write(store: &PairStore, count: usize, favorites: &[&str], removed: &[&str]) {
    let sources = json!([
        {"id":"a","name":"Source A","kind":"url","location":"https://example.invalid/a.m3u"},
        {"id":"b","name":"Source B","kind":"url","location":"https://example.invalid/b.m3u"}
    ]);
    let catalog = json!({"schemaVersion":1,"sources":sources,"channels":(0..count).map(channel).collect::<Vec<_>>()});
    let preferences = json!({"schemaVersion":1,"sources":sources,"favorites":favorites,"removedChannels":removed,"volume":0.5,"muted":false,"panelWidth":300});
    store
        .write_pair(&catalog.to_string(), &preferences.to_string())
        .unwrap();
}
fn queries() -> Vec<crate::catalog_query::Query> {
    let mut out = Vec::new();
    for (text, filter, sort, favorites_first, hide_adult, geography) in [
        ("", "all", "source", false, false, json!({})),
        ("", "all", "name", true, true, json!({})),
        ("news", "all", "source", false, false, json!({})),
        ("", "sports", "geography", false, true, json!({})),
        (
            "channel 1",
            "all",
            "name",
            false,
            false,
            json!({"country":"US"}),
        ),
        ("", "favorites", "source", false, false, json!({})),
    ] {
        out.push(serde_json::from_value(json!({"schemaVersion":1,"requestId":"cache-fixture","expectedCatalogRevision":null,"expectedViewRevision":null,"query":text,"filter":filter,"geography":geography,"sort":sort,"favoritesFirst":favorites_first,"hideAdult":hide_adult,"after":null,"startIndex":null,"anchorId":null,"pageSize":7})).unwrap());
    }
    out
}
fn walk(store: &PairStore, base: &crate::catalog_query::Query, cached: bool) -> Vec<String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let path = store.root.join(DB);
    let run = |q: &crate::catalog_query::Query| {
        let c = connect(&path, true).unwrap();
        if cached {
            crate::catalog_query::query_page_cached(&c, q, &cancel, &store.page_cache, &path)
        } else {
            crate::catalog_query::query_page(&c, q, &cancel)
        }
        .map(|p| serde_json::to_string(&p).unwrap())
        .unwrap_or_else(|e| format!("error {e}"))
    };
    let mut pages = Vec::new();
    // Offset pages, then a cursor walk, then anchors at every listed row.
    for start in [0, 3, 7, 14, 1000] {
        let mut q = base.clone();
        q.start_index = Some(start);
        pages.push(run(&q));
    }
    let mut q = base.clone();
    for _ in 0..40 {
        let page = run(&q);
        pages.push(page.clone());
        let Ok(parsed) = serde_json::from_str::<Value>(&page) else {
            break;
        };
        if parsed["after"].is_null() {
            break;
        }
        q.after = Some(serde_json::from_value(parsed["after"].clone()).unwrap());
        q.expected_catalog_revision = parsed["catalogRevision"].as_str().map(str::to_owned);
        q.expected_view_revision = parsed["viewRevision"].as_str().map(str::to_owned);
    }
    for id in ["ch-000", "ch-001", "ch-005", "ch-012", "ch-031", "missing"] {
        let mut q = base.clone();
        q.anchor_id = Some(id.into());
        pages.push(run(&q));
    }
    pages
}

#[test]
fn cached_pages_equal_uncached_pages_before_and_after_writes() {
    let root = tempfile::tempdir().unwrap();
    let store = PairStore::new(root.path().into()).unwrap();
    write(&store, 36, &["ch-004", "ch-020"], &["ch-007"]);
    for q in queries() {
        // Twice cached: the second walk is served from the cache.
        let expected = walk(&store, &q, false);
        assert!(expected.iter().any(|p| !p.starts_with("error")));
        assert_eq!(walk(&store, &q, true), expected);
        assert_eq!(walk(&store, &q, true), expected);
    }
    // Catalog and favorites/removal edits must never be answered from the old order.
    let q = queries().remove(1);
    let before = walk(&store, &q, true);
    write(&store, 40, &["ch-033"], &["ch-002", "ch-004"]);
    let after = walk(&store, &q, true);
    assert_ne!(after, before);
    assert_eq!(after, walk(&store, &q, false));
}
