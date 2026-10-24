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

//! GenXtra: the public-domain archive library. Discovery from the archive
//! providers, the local catalog, artwork, bookmarks, downloads and playback.

pub(crate) mod archive_artwork;
pub(crate) mod archive_bookmarks;
pub(crate) mod archive_catalog;
pub(crate) mod archive_date_assessment;
pub(crate) mod archive_discovery;
pub(crate) mod archive_download_owner;
pub(crate) mod archive_download_store;
pub(crate) mod archive_download_transfer;
pub(crate) mod archive_library_store;
pub(crate) mod archive_playback_owner;
pub(crate) mod archive_playback_proxy;
pub(crate) mod archive_provider_catalog;
pub(crate) mod archive_provider_commons;
pub(crate) mod archive_provider_contract;
pub(crate) mod archive_provider_discovery;
pub(crate) mod archive_provider_loc;
pub(crate) mod archive_provider_nasa;
pub(crate) mod archive_provider_net;
pub(crate) mod archive_provider_probe;
