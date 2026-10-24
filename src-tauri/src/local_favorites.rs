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

//! Local favorites: stations saved from any area's scan, saved areas (an
//! area is a stored search, rerun when chosen) and saved websites. The owner's own data, so a
//! corrupt file is never silently replaced: reads report it, and the next save
//! keeps a copy beside the new file. Bounded, validated, atomically replaced.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager;

const BYTES: u64 = 256 * 1024;
const MAX_STATIONS: usize = 200;
const MAX_AREAS: usize = 50;
const MAX_SITES: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteTv {
    pub name: String,
    pub call_sign: Option<String>,
    pub website: String,
    pub place: String,
    pub distance_km: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteRadio {
    pub id: String,
    pub name: String,
    pub stream: String,
    pub codec: String,
    pub bitrate: u32,
    pub homepage: Option<String>,
    pub area: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteStation {
    /// The area code or ZIP whose scan found it.
    pub area: String,
    pub tv: Option<FavoriteTv>,
    pub radio: Option<FavoriteRadio>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteArea {
    pub area: String,
    pub label: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoriteSite {
    pub url: String,
    pub title: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Favorites {
    pub schema_version: u32,
    pub stations: Vec<FavoriteStation>,
    pub areas: Vec<FavoriteArea>,
    /// Absent in files saved before websites existed.
    #[serde(default)]
    pub sites: Vec<FavoriteSite>,
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}
fn web(value: &str, https_only: bool) -> bool {
    value.len() <= 2048
        && reqwest::Url::parse(value).is_ok_and(|url| {
            (url.scheme() == "https" || (!https_only && url.scheme() == "http"))
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}
fn area(value: &str) -> bool {
    crate::local_streams::valid_area_code(value) || crate::local_streams::valid_zip(value)
}
fn valid_station(s: &FavoriteStation) -> bool {
    if !area(&s.area) {
        return false;
    }
    match (&s.tv, &s.radio) {
        (Some(tv), None) => {
            text(&tv.name, 120)
                && tv.call_sign.as_deref().is_none_or(|c| text(c, 32))
                && web(&tv.website, true)
                && text(&tv.place, 120)
                && tv.distance_km <= 20_000
        }
        (None, Some(radio)) => {
            text(&radio.id, 64)
                && text(&radio.name, 120)
                && web(&radio.stream, false)
                && radio.codec.chars().count() <= 32
                && !radio.codec.chars().any(char::is_control)
                && radio.homepage.as_deref().is_none_or(|h| web(h, false))
                && radio.area.chars().count() <= 120
                && !radio.area.chars().any(char::is_control)
        }
        _ => false,
    }
}
fn key(s: &FavoriteStation) -> String {
    match (&s.tv, &s.radio) {
        (Some(tv), _) => format!("tv:{}", tv.website),
        (_, Some(radio)) => format!("radio:{}", radio.id),
        _ => String::new(),
    }
}
pub(crate) fn validate(f: &Favorites) -> Result<(), String> {
    let unique = |keys: Vec<String>| {
        let mut sorted = keys.clone();
        sorted.sort();
        sorted.dedup();
        sorted.len() == keys.len()
    };
    if f.schema_version != 1
        || f.stations.len() > MAX_STATIONS
        || f.areas.len() > MAX_AREAS
        || f.sites.len() > MAX_SITES
        || !f
            .sites
            .iter()
            .all(|s| web(&s.url, true) && text(&s.title, 160))
        || !unique(f.sites.iter().map(|s| s.url.clone()).collect())
        || !f.stations.iter().all(valid_station)
        || !f.areas.iter().all(|a| area(&a.area) && text(&a.label, 160))
        || !unique(f.stations.iter().map(key).collect())
        || !unique(f.areas.iter().map(|a| a.area.clone()).collect())
    {
        return Err("local-favorites-invalid".into());
    }
    Ok(())
}

pub struct Store {
    path: PathBuf,
    lock: Mutex<()>,
}
impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }
    fn load(&self) -> Result<Favorites, String> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Favorites {
                    schema_version: 1,
                    ..Favorites::default()
                })
            }
            Err(_) => return Err("local-favorites-read-failed".into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > BYTES {
            return Err("local-favorites-file-invalid".into());
        }
        let mut bytes = Vec::new();
        File::open(&self.path)
            .and_then(|f| f.take(BYTES + 1).read_to_end(&mut bytes))
            .map_err(|_| "local-favorites-read-failed")?;
        let favorites: Favorites =
            serde_json::from_slice(&bytes).map_err(|_| "local-favorites-file-invalid")?;
        validate(&favorites).map_err(|_| "local-favorites-file-invalid")?;
        Ok(favorites)
    }
    pub fn read(&self) -> Result<Favorites, String> {
        let _lock = self.lock.lock().map_err(|_| "local-favorites-lock")?;
        self.load()
    }
    pub fn save(&self, favorites: Favorites) -> Result<Favorites, String> {
        validate(&favorites)?;
        let bytes = serde_json::to_vec(&favorites).map_err(|_| "local-favorites-encode-failed")?;
        if bytes.len() as u64 > BYTES {
            return Err("local-favorites-capacity".into());
        }
        let _lock = self.lock.lock().map_err(|_| "local-favorites-lock")?;
        let parent = self.path.parent().ok_or("local-favorites-path-invalid")?;
        fs::create_dir_all(parent).map_err(|_| "local-favorites-write-failed")?;
        // A file that cannot be read is kept beside the new one, never lost.
        if matches!(self.load(), Err(e) if e == "local-favorites-file-invalid") {
            fs::copy(&self.path, self.path.with_extension("unreadable.json"))
                .map_err(|_| "local-favorites-write-failed")?;
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| "local-favorites-write-failed")?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "local-favorites-write-failed")?;
        temporary
            .persist(&self.path)
            .map_err(|_| "local-favorites-write-failed")?;
        Ok(favorites)
    }
}

#[tauri::command]
pub async fn local_favorites_read(app: tauri::AppHandle) -> Result<Favorites, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.read()
    })
    .await
    .map_err(|_| "local-favorites-worker-failed".to_string())?
}
#[tauri::command]
pub async fn local_favorites_save(
    favorites: Favorites,
    app: tauri::AppHandle,
) -> Result<Favorites, String> {
    let work = app.state::<crate::NativeState>().admit_work()?;
    let store = app.state::<Arc<Store>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        store.save(favorites)
    })
    .await
    .map_err(|_| "local-favorites-worker-failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("local-favorites-v1.json"));
        (dir, store)
    }
    fn tv(website: &str) -> FavoriteStation {
        FavoriteStation {
            area: "309".into(),
            tv: Some(FavoriteTv {
                name: "Fixture 31".into(),
                call_sign: Some("WFIX".into()),
                website: website.into(),
                place: "Peoria".into(),
                distance_km: 3,
            }),
            radio: None,
        }
    }
    fn radio(id: &str, stream: &str) -> FavoriteStation {
        FavoriteStation {
            area: "61602".into(),
            tv: None,
            radio: Some(FavoriteRadio {
                id: id.into(),
                name: "Fixture FM".into(),
                stream: stream.into(),
                codec: "MP3".into(),
                bitrate: 128,
                homepage: None,
                area: "Peoria".into(),
            }),
        }
    }
    fn favorites(stations: Vec<FavoriteStation>) -> Favorites {
        Favorites {
            schema_version: 1,
            stations,
            areas: vec![FavoriteArea {
                area: "309".into(),
                label: "Peoria, Bloomington".into(),
            }],
            sites: vec![FavoriteSite {
                url: "https://site.fixture.invalid/news".into(),
                title: "Fixture News".into(),
            }],
        }
    }

    #[test]
    fn empty_until_saved_then_round_trips() {
        let (_dir, store) = store();
        assert!(store.read().unwrap().stations.is_empty());
        let saved = favorites(vec![
            tv("https://tv.fixture.invalid/"),
            radio("r1", "http://radio.fixture.invalid/live"),
        ]);
        store.save(saved.clone()).unwrap();
        assert_eq!(store.read().unwrap(), saved);
    }

    #[test]
    fn refuses_invalid_entries_without_writing() {
        let (_dir, store) = store();
        for bad in [
            favorites(vec![tv("http://tv.fixture.invalid/")]),
            favorites(vec![radio("r1", "rtsp://radio.fixture.invalid/")]),
            favorites(vec![radio("r1", "https://u:p@radio.fixture.invalid/")]),
            favorites(vec![
                tv("https://tv.fixture.invalid/"),
                tv("https://tv.fixture.invalid/"),
            ]),
            Favorites {
                schema_version: 2,
                ..favorites(vec![])
            },
            favorites(vec![FavoriteStation {
                area: "109".into(),
                ..tv("https://tv.fixture.invalid/")
            }]),
        ] {
            assert_eq!(store.save(bad).unwrap_err(), "local-favorites-invalid");
        }
        assert!(!store.path.exists());
    }

    #[test]
    fn a_file_from_before_websites_still_reads() {
        let (_dir, store) = store();
        fs::write(
            &store.path,
            br#"{"schemaVersion":1,"stations":[],"areas":[{"area":"309","label":"Peoria"}]}"#,
        )
        .unwrap();
        let read = store.read().unwrap();
        assert_eq!(read.areas.len(), 1);
        assert!(read.sites.is_empty());
    }

    #[test]
    fn refuses_plain_http_or_duplicate_websites() {
        let (_dir, store) = store();
        let mut bad = favorites(vec![]);
        bad.sites[0].url = "http://site.fixture.invalid/".into();
        assert_eq!(store.save(bad).unwrap_err(), "local-favorites-invalid");
        let mut twice = favorites(vec![]);
        twice.sites.push(twice.sites[0].clone());
        assert_eq!(store.save(twice).unwrap_err(), "local-favorites-invalid");
    }

    #[test]
    fn a_corrupt_file_is_reported_and_kept_on_the_next_save() {
        let (dir, store) = store();
        fs::write(&store.path, b"{not json").unwrap();
        assert_eq!(store.read().unwrap_err(), "local-favorites-file-invalid");
        store.save(favorites(vec![])).unwrap();
        assert_eq!(
            fs::read(dir.path().join("local-favorites-v1.unreadable.json")).unwrap(),
            b"{not json"
        );
        assert!(store.read().unwrap().stations.is_empty());
    }
}
