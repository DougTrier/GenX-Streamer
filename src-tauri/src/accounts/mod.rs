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

//! Paid TV accounts: credentials in the vault, reading a provider's channels,
//! guide and on-demand catalog, and playing them through the local proxy.

pub(crate) mod account_acquisition;
pub(crate) mod account_catalog_owner;
pub(crate) mod account_catalog_query;
pub(crate) mod account_guide;
pub(crate) mod account_guide_owner;
pub(crate) mod account_media_store;
pub(crate) mod account_playback_owner;
pub(crate) mod account_playback_proxy;
pub(crate) mod account_preferences;
pub(crate) mod account_vault;
pub(crate) mod account_vault_owner;
pub(crate) mod account_vod;
pub(crate) mod group_country;
