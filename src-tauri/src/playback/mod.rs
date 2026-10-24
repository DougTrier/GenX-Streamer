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

//! Playback Engine (native side): the Android native players for live and
//! on-demand video, transport-stream audio alignment, viewing settings and
//! keeping the screen awake.
//!
//! Guide for contributors: docs/components/playback-engine.md.

pub(crate) mod native_live;
pub(crate) mod native_video;
pub(crate) mod ts_align;
pub(crate) mod viewing_settings;
pub(crate) mod viewing_wake;
