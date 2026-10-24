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

//! Independent owners always settle; an earlier failure is not permission to skip cleanup.
use crate::close_owner::CleanupResult;
use std::future::Future;
use tokio::sync::oneshot;

/// A preparation deadline permits native shutdown to start; it never cancels
/// the original renderer acknowledgment or reports its cleanup as completed.
pub(crate) enum PreparedFrontend {
    Settled(Result<CleanupResult, oneshot::error::RecvError>),
    Pending(oneshot::Receiver<CleanupResult>),
}
impl PreparedFrontend {
    pub(crate) async fn settled(self) -> Result<CleanupResult, oneshot::error::RecvError> {
        match self {
            Self::Settled(result) => result,
            Self::Pending(acknowledgment) => acknowledgment.await,
        }
    }
}
pub(crate) async fn prepare_frontend(
    mut acknowledgment: oneshot::Receiver<CleanupResult>,
    emitted: bool,
    preparation_deadline: impl Future<Output = ()>,
) -> PreparedFrontend {
    if !emitted {
        // No waiter is spawned. join_cleanup handles failed event delivery and
        // disposes this receiver without claiming an acknowledgment arrived.
        return PreparedFrontend::Pending(acknowledgment);
    }
    tokio::select! {
        biased;
        result = &mut acknowledgment => PreparedFrontend::Settled(result),
        _ = preparation_deadline => PreparedFrontend::Pending(acknowledgment),
    }
}

pub(crate) async fn join_owned<R, S, C, L, G, D>(
    recovery: R,
    speech: S,
    casting: C,
    sharing: L,
    guides: G,
    drains: D,
) -> Result<(), &'static str>
where
    R: Future<Output = Result<(), &'static str>>,
    S: Future<Output = Result<(), &'static str>>,
    C: Future<Output = Result<(), &'static str>>,
    L: Future<Output = Result<(), &'static str>>,
    G: Future<Output = Result<(), &'static str>>,
    D: Future<Output = Result<(), &'static str>>,
{
    let (recovery, speech, casting, sharing, guides) =
        tokio::join!(recovery, speech, casting, sharing, guides);
    // Cleanup may admit final disposal-only work; inspect its actual ownership after all
    // subsystem producers settle, even when one of their results already failed.
    let drains = drains.await;
    for result in [recovery, speech, casting, sharing, guides, drains] {
        result?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "native_shutdown_tests.rs"]
mod tests;
