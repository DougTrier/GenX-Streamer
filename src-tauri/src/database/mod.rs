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

//! Storage: the SQLite database behind the catalog, the guide and GenXtra.
//! Transactions, backups and recovery, leases, budgets and start-up checks.
//!
//! Guide for contributors: docs/components/channel-catalog.md.

pub(crate) mod storage;
#[allow(
    dead_code,
    reason = "Experimental chunk recovery format remains unwired until durability and fault verification."
)]
pub(crate) mod storage_backup_chunks;
pub(crate) mod storage_backup_policy;
pub(crate) mod storage_budget;
pub(crate) mod storage_leases;
#[cfg(windows)]
pub(crate) mod storage_recovery;
pub(crate) mod storage_startup;
pub(crate) mod storage_timings;
pub(crate) mod storage_transaction;
