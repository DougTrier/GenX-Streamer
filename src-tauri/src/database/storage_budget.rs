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

//! Aggregate storage policy v1. These are database pages, not feed input/JSON limits.
//! Guide growth stops at half the database budget, leaving canonical scan headroom.
//! This is not a promise that every independently admitted maximum-size feed fits.
use rusqlite::Connection;

pub(crate) const DATABASE_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const GUIDE_OCCUPIED_BYTES: u64 = 512 * 1024 * 1024;

pub(crate) fn maximum_pages(page_size: i64) -> Result<i64, String> {
    let size = u64::try_from(page_size).map_err(|_| "sqlite-page-size-invalid")?;
    if !(512..=65_536).contains(&size) || !size.is_power_of_two() {
        return Err("sqlite-page-size-invalid".into());
    }
    Ok((DATABASE_BYTES / size) as i64)
}

pub(crate) fn occupied_bytes(c: &Connection) -> Result<u64, String> {
    let read = |name: &str| -> Result<i64, String> {
        c.pragma_query_value(None, name, |r| r.get(0))
            .map_err(|e| crate::storage_transaction::sql_error_code(&e, "sqlite-operation-failed"))
    };
    let size = read("page_size")?;
    maximum_pages(size)?;
    let pages = read("page_count")?;
    let free = read("freelist_count")?;
    if pages < 0 || free < 0 || free > pages {
        return Err("sqlite-storage-stat-invalid".into());
    }
    (pages as u64 - free as u64)
        .checked_mul(size as u64)
        .ok_or_else(|| "sqlite-storage-stat-invalid".into())
}

pub(crate) struct GuideAdmission {
    before: u64,
    limit: u64,
}
impl GuideAdmission {
    pub(crate) fn capture(c: &Connection) -> Result<Self, String> {
        #[cfg(test)]
        let limit = TEST_GUIDE_LIMIT
            .with(|v| v.get())
            .unwrap_or(GUIDE_OCCUPIED_BYTES);
        #[cfg(not(test))]
        let limit = GUIDE_OCCUPIED_BYTES;
        Ok(Self {
            before: occupied_bytes(c)?,
            limit,
        })
    }
    pub(crate) fn finish(self, c: &Connection) -> Result<(), String> {
        let after = occupied_bytes(c)?;
        // Preserve above-ceiling legacy data: only additional occupied-page growth refuses.
        if after > self.limit && after > self.before {
            return Err("guide-storage-budget-exceeded".into());
        }
        Ok(())
    }
}

#[cfg(test)]
thread_local! {
    static TEST_GUIDE_LIMIT: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn with_guide_limit<T>(limit: u64, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<u64>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_GUIDE_LIMIT.with(|v| v.set(self.0));
        }
    }
    let _restore = Restore(TEST_GUIDE_LIMIT.with(|v| v.replace(Some(limit))));
    work()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn storage_budget_v1_derives_pages_and_counts_real_page_sizes() {
        assert_eq!(DATABASE_BYTES, 2 * GUIDE_OCCUPIED_BYTES);
        for size in [512, 1024, 4096, 16_384, 65_536] {
            let c = Connection::open_in_memory().unwrap();
            c.pragma_update(None, "page_size", size).unwrap();
            c.execute_batch(
                "CREATE TABLE data(value BLOB);INSERT INTO data VALUES(zeroblob(10000))",
            )
            .unwrap();
            let actual: i64 = c
                .pragma_query_value(None, "page_size", |r| r.get(0))
                .unwrap();
            assert_eq!(actual, size);
            let maximum = maximum_pages(actual).unwrap();
            assert_eq!(maximum as u64 * size as u64, DATABASE_BYTES);
            c.pragma_update(None, "max_page_count", maximum).unwrap();
            assert_eq!(
                c.pragma_query_value(None, "max_page_count", |r| r.get::<_, i64>(0))
                    .unwrap(),
                maximum
            );
            let count: i64 = c
                .pragma_query_value(None, "page_count", |r| r.get(0))
                .unwrap();
            assert_eq!(occupied_bytes(&c).unwrap(), count as u64 * size as u64);
            c.execute_batch("DELETE FROM data").unwrap();
            assert!(occupied_bytes(&c).unwrap() <= count as u64 * size as u64);
        }
        for invalid in [-1, 0, 256, 1000, 131_072] {
            assert_eq!(
                maximum_pages(invalid).unwrap_err(),
                "sqlite-page-size-invalid"
            );
        }
    }
}
