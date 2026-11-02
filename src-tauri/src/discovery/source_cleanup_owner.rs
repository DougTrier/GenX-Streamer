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

//! Owned, missing-only cleanup checks. One deadline covers the complete network
//! pass, including site pacing. No SQL/store lease survives a network await.
use crate::{
    network, scan_manifest_work,
    storage_transaction::source_cleanup::{
        Begin, BeginReply, CancelReply, Fact, Finish, Reply, Target,
    },
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tokio::time::Instant;

const NETWORK_BUDGET: Duration = Duration::from_secs(20);
const TARGET_LIMIT: usize = 256;
const HOST_GAP: Duration = Duration::from_millis(350);
const OWNER_POLL: Duration = Duration::from_millis(50);

fn now() -> Result<u64, String> {
    crate::commands::scan::native_now_ms("source-cleanup-clock-invalid")?
        .try_into()
        .map_err(|_| "source-cleanup-clock-invalid".into())
}

pub(crate) async fn begin(
    request: Begin,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<BeginReply, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (reply, _) = owner
            .storage(None, move |store, check| {
                store.begin_source_cleanup(&request, std::env::consts::OS, now()?, check)
            })
            .await?;
        Ok(reply)
    })
    .await
}

pub(crate) async fn cancel(
    request: Finish,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<CancelReply, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let (reply, _) = owner
            .storage(None, move |store, check| {
                store.cancel_source_cleanup(&request, check)
            })
            .await?;
        Ok(reply)
    })
    .await
}

pub(crate) async fn finish(
    request: Finish,
    request_id: String,
    app: tauri::AppHandle,
) -> Result<Reply, String> {
    scan_manifest_work::owned(request_id, app, move |owner| async move {
        let cancel_request = request.clone();
        let (prepared, generation) = owner
            .storage(None, move |store, check| {
                store.prepare_source_cleanup(&request, std::env::consts::OS, now()?, check)
            })
            .await?;
        let prepared = Arc::new(prepared);
        let operation = async {
            owner.check()?;
            let probe_owner = owner.clone();
            let probe_prepared = prepared.clone();
            let results = inspect_targets(
                &prepared.targets,
                Limits::default(),
                || owner.check(),
                move |url, allow_http| {
                    let probe_owner = probe_owner.clone();
                    let probe_prepared = probe_prepared.clone();
                    async move {
                        probe_owner
                            .storage(Some(generation), move |store, check| {
                                store.check_source_cleanup(
                                    &probe_prepared,
                                    std::env::consts::OS,
                                    now()?,
                                    check,
                                )
                            })
                            .await?;
                        probe_owner.check()?;
                        let response = network::health_inspect(&url, allow_http, 20_000).await;
                        Ok(match response {
                            Ok(value) => Observation {
                                status: Some(value.status),
                                recognized: (200..300).contains(&value.status)
                                    && matches!(value.kind, Some("hls" | "media")),
                                // A rate-limited or busy origin is not contacted again
                                // during this pass, even if another alias uses its host.
                                block_host: matches!(value.status, 429 | 503)
                                    || value.retry_after.is_some(),
                            },
                            Err(_) => Observation {
                                status: None,
                                recognized: false,
                                block_host: true,
                            },
                        })
                    }
                },
                now,
            )
            .await?;
            owner.check()?;
            let (reply, _) = owner
                .storage(Some(generation), move |store, check| {
                    store.commit_source_cleanup(
                        &prepared,
                        &results.facts,
                        std::env::consts::OS,
                        now()?,
                        results.checked_targets,
                        results.budget_exhausted,
                        check,
                    )
                })
                .await?;
            Ok(reply)
        }
        .await;
        if operation.is_err() {
            // Cancellation can make the retained owner refuse this best-effort
            // cleanup too. A claimed round cannot be prepared a second time;
            // the frontend finally-cancel/new round also invalidates the orphan.
            let _ = owner
                .storage(Some(generation), move |store, check| {
                    store.cancel_source_cleanup(&cancel_request, check)
                })
                .await;
        }
        operation
    })
    .await
}

#[derive(Clone, Copy)]
struct Limits {
    budget: Duration,
    targets: usize,
    host_gap: Duration,
    poll: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            budget: NETWORK_BUDGET,
            targets: TARGET_LIMIT,
            host_gap: HOST_GAP,
            poll: OWNER_POLL,
        }
    }
}
#[derive(Clone, Copy)]
struct Observation {
    status: Option<u16>,
    recognized: bool,
    block_host: bool,
}
#[derive(Clone, Copy)]
struct Remembered {
    observation: Observation,
    observed_at: u64,
}
struct Results {
    facts: Vec<Fact>,
    checked_targets: usize,
    budget_exhausted: bool,
}

fn transport(target: &Target) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update([u8::from(target.allow_http)]);
    digest.update(target.url.as_bytes());
    digest.finalize().into()
}
fn origin(target: &Target) -> Option<String> {
    reqwest::Url::parse(&target.url)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

/// Returns None at the pass deadline. Dropping this function immediately drops
/// its in-flight network future; no background probe survives Stop/root close.
async fn guarded<T>(
    pending: impl Future<Output = T>,
    deadline: Instant,
    poll: Duration,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<Option<T>, String> {
    tokio::pin!(pending);
    let mut interval = tokio::time::interval(poll);
    loop {
        check()?;
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => return Ok(None),
            value = &mut pending => return Ok(Some(value)),
            _ = interval.tick() => {},
        }
    }
}

async fn inspect_targets<F, Fut>(
    targets: &[Target],
    limits: Limits,
    mut check: impl FnMut() -> Result<(), String>,
    mut inspect: F,
    mut observed_at: impl FnMut() -> Result<u64, String>,
) -> Result<Results, String>
where
    F: FnMut(String, bool) -> Fut,
    Fut: Future<Output = Result<Observation, String>>,
{
    let deadline = Instant::now() + limits.budget;
    let mut results = Results {
        facts: Vec::new(),
        checked_targets: 0,
        budget_exhausted: false,
    };
    let mut cache = HashMap::<[u8; 32], Remembered>::new();
    let mut delivered = HashMap::<&str, [u8; 32]>::new();
    let mut cooling = HashMap::<String, Option<Instant>>::new();
    for target in targets {
        check()?;
        let identity = transport(target);
        if let Some(previous) = delivered.insert(&target.key, identity) {
            if previous != identity {
                return Err("source-cleanup-target-key-invalid".into());
            }
            continue;
        }
        let fact = if let Some(remembered) = cache.get(&identity) {
            *remembered
        } else {
            if results.checked_targets >= limits.targets || Instant::now() >= deadline {
                results.budget_exhausted = true;
                break;
            }
            let host = origin(target);
            if let Some(host) = &host {
                match cooling.get(host) {
                    Some(None) => continue,
                    Some(Some(until))
                        if *until > Instant::now()
                            && guarded(
                                tokio::time::sleep_until(*until),
                                deadline,
                                limits.poll,
                                &mut check,
                            )
                            .await?
                            .is_none() =>
                    {
                        results.budget_exhausted = true;
                        break;
                    }
                    _ => {}
                }
            }
            let Some(observation) = guarded(
                inspect(target.url.clone(), target.allow_http),
                deadline,
                limits.poll,
                &mut check,
            )
            .await?
            else {
                results.budget_exhausted = true;
                break;
            };
            let observation = observation?;
            check()?;
            results.checked_targets += 1;
            if let Some(host) = host {
                cooling.insert(
                    host,
                    if observation.block_host {
                        None
                    } else {
                        Some(Instant::now() + limits.host_gap)
                    },
                );
            }
            let remembered = Remembered {
                observation,
                observed_at: observed_at()?,
            };
            cache.insert(identity, remembered);
            remembered
        };
        results.facts.push(Fact {
            key: target.key.clone(),
            status: fact.observation.status,
            recognized: fact.observation.recognized,
            observed_at: fact.observed_at,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    fn target(key: &str, url: &str, allow_http: bool) -> Target {
        Target {
            key: key.into(),
            url: url.into(),
            allow_http,
        }
    }
    fn limits() -> Limits {
        Limits {
            budget: Duration::from_secs(20),
            targets: 256,
            host_gap: Duration::ZERO,
            poll: Duration::from_millis(50),
        }
    }
    fn answer(status: u16) -> Observation {
        Observation {
            status: Some(status),
            recognized: (200..300).contains(&status),
            block_host: matches!(status, 429 | 503),
        }
    }
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn one_deadline_drops_an_unfinished_probe_without_inventing_a_failure_fact() {
        let dropped = Arc::new(AtomicBool::new(false));
        let owner_drop = dropped.clone();
        let started = Instant::now();
        let result = inspect_targets(
            &[target("one", "https://one.invalid/live", false)],
            limits(),
            || Ok(()),
            move |_, _| {
                let guard = Dropped(owner_drop.clone());
                async move {
                    let _guard = guard;
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok(answer(404))
                }
            },
            || Ok(1),
        )
        .await
        .unwrap();
        assert_eq!(started.elapsed(), Duration::from_secs(20));
        assert!(result.budget_exhausted);
        assert_eq!(result.checked_targets, 0);
        assert!(result.facts.is_empty());
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn host_pacing_is_inside_the_same_pass_deadline() {
        let mut scope = limits();
        scope.host_gap = Duration::from_secs(30);
        let result = inspect_targets(
            &[
                target("a", "https://one.invalid/a", false),
                target("b", "https://one.invalid/b", false),
            ],
            scope,
            || Ok(()),
            |_, _| async { Ok(answer(404)) },
            || Ok(1),
        )
        .await
        .unwrap();
        assert!(result.budget_exhausted);
        assert_eq!(result.checked_targets, 1);
        assert_eq!(result.facts.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn owner_cancellation_drops_the_probe_and_refuses_publication() {
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = dropped.clone();
        let mut checks = 0;
        let result = inspect_targets(
            &[target("one", "https://one.invalid/live", false)],
            limits(),
            || {
                checks += 1;
                if checks >= 5 {
                    Err("canceled".into())
                } else {
                    Ok(())
                }
            },
            move |_, _| {
                let guard = Dropped(guard.clone());
                async move {
                    let _guard = guard;
                    std::future::pending::<Result<Observation, String>>().await
                }
            },
            || Ok(1),
        )
        .await;
        assert!(matches!(result, Err(error) if error == "canceled"));
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn aliases_reuse_the_original_fact_but_queries_and_http_grants_stay_distinct() {
        let calls = Arc::new(AtomicUsize::new(0));
        let inspect_calls = calls.clone();
        let mut clock = 40;
        let result = inspect_targets(
            &[
                target("a", "https://one.invalid/live?feed=one", false),
                target("alias", "https://one.invalid/live?feed=one", false),
                target("grant", "https://one.invalid/live?feed=one", true),
                target("query", "https://one.invalid/live?feed=two", false),
            ],
            limits(),
            || Ok(()),
            move |_, _| {
                inspect_calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(answer(410)) }
            },
            || {
                clock += 1;
                Ok(clock)
            },
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(result.checked_targets, 3);
        assert_eq!(result.facts.len(), 4);
        assert_eq!(result.facts[0].observed_at, result.facts[1].observed_at);
        assert_ne!(result.facts[1].observed_at, result.facts[2].observed_at);
    }

    #[tokio::test]
    async fn busy_origin_defers_other_addresses_but_does_not_block_another_host() {
        let result = inspect_targets(
            &[
                target("busy", "https://busy.invalid/a", false),
                target("defer", "https://busy.invalid/b", false),
                target("other", "https://other.invalid/live", false),
            ],
            limits(),
            || Ok(()),
            |url, _| async move {
                if url.contains("busy.invalid") {
                    Ok(answer(503))
                } else {
                    Ok(answer(404))
                }
            },
            || Ok(1),
        )
        .await
        .unwrap();
        assert_eq!(result.checked_targets, 2);
        assert_eq!(result.facts.len(), 2);
        assert_eq!(result.facts[0].status, Some(503));
        assert_eq!(result.facts[1].key, "other");
    }

    #[tokio::test]
    async fn target_cap_leaves_every_unassessed_address_without_a_fact() {
        let targets: Vec<_> = (0..257)
            .map(|i| target(&i.to_string(), &format!("https://one.invalid/{i}"), false))
            .collect();
        let result = inspect_targets(
            &targets,
            limits(),
            || Ok(()),
            |_, _| async { Ok(answer(404)) },
            || Ok(1),
        )
        .await
        .unwrap();
        assert_eq!(result.checked_targets, 256);
        assert_eq!(result.facts.len(), 256);
        assert!(result.budget_exhausted);
    }

    #[tokio::test]
    async fn statuses_and_unknown_delivery_are_not_rewritten_as_hard_dead_answers() {
        let result = inspect_targets(
            &[
                target("access", "https://access.invalid/live", false),
                target("unknown", "https://unknown.invalid/live", false),
                target("healthy", "https://healthy.invalid/live", false),
            ],
            limits(),
            || Ok(()),
            |url, _| async move {
                if url.contains("access.invalid") {
                    Ok(answer(403))
                } else if url.contains("unknown.invalid") {
                    Ok(Observation {
                        status: None,
                        recognized: false,
                        block_host: true,
                    })
                } else {
                    Ok(answer(200))
                }
            },
            || Ok(1),
        )
        .await
        .unwrap();
        assert_eq!(result.facts[0].status, Some(403));
        assert_eq!(result.facts[1].status, None);
        assert!(!result.facts[1].recognized);
        assert_eq!(result.facts[2].status, Some(200));
        assert!(result.facts[2].recognized);
    }

    #[tokio::test]
    async fn changed_authority_is_propagated_without_trying_another_target() {
        let mut calls = 0;
        let result = inspect_targets(
            &[
                target("one", "https://one.invalid/live", false),
                target("two", "https://two.invalid/live", false),
            ],
            limits(),
            || Ok(()),
            |_, _| {
                calls += 1;
                async { Err("source-cleanup-authority-changed".into()) }
            },
            || Ok(1),
        )
        .await;
        assert!(matches!(result, Err(error) if error == "source-cleanup-authority-changed"));
        assert_eq!(calls, 1);
    }
}
