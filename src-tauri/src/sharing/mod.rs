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

//! LAN sharing and casting: the sharing server and its pairing, Chromecast
//! and DLNA casting, the public-only relay and the sharing policy; and share
//! links, which send what is playing (or the app itself) to someone else.
//!
//! Guide for contributors: docs/components/sharing-and-casting.md.

pub(crate) mod apk_contents;
pub mod casting;
pub(crate) mod compatibility;
pub mod lan;
pub(crate) mod native_sharing;
pub(crate) mod nearby_download;
pub mod relay;
pub(crate) mod send_to_tv;
pub(crate) mod share_links;
pub mod sharing_policy;
