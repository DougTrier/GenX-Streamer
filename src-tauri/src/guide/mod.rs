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

pub mod database;
pub mod input;
pub mod parser;

pub mod conditional;
pub mod refresh;

pub mod category;

pub(crate) mod crosswalk_pack;
pub(crate) mod grabber_export;
pub mod reviewed_aliases;
pub(crate) mod reviewed_crosswalk;

pub mod cached_matching;
pub mod channel_coverage;
pub(crate) mod listed_channels;
pub(crate) mod provisional;
pub(crate) mod retention;

pub(crate) mod mapping_admission;
