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

//! Independent protocol fixture harness; does not stand in for the Tauri platform build.
#[path = "../../sharing_policy.rs"]
pub mod sharing_policy;
#[path = "../../relay.rs"]
pub mod relay;
#[path = "../mod.rs"]
pub mod casting;
