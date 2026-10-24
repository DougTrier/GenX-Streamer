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

//! Channel Catalog: the saved channel list as the app reads it. Catalog pages
//! and projections, groups, logos, favorites, channel health and series identity.
//!
//! Guide for contributors: docs/components/channel-catalog.md.

pub(crate) mod catalog_endpoint_projection;
pub(crate) mod catalog_group_mutation;
pub(crate) mod catalog_query;
pub(crate) mod channel_logos;
pub(crate) mod health_storage;
pub(crate) mod local_favorites;
pub(crate) mod native_catalog;
pub(crate) mod refresh_cadence;
pub(crate) mod series_identity;
