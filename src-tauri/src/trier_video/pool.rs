//! The slice workers' threads, started once per decoder instead of for every
//! picture (starting and joining threads per picture kept Trier's workers
//! from staying busy: 1.6 cores used at 4 threads against FFmpeg's 2.5 on the
//! Galaxy S25; docs/trier-mpeg-video.md).
//!
//! `run(job)` calls `job` on every helper thread and on the calling thread,
//! and returns only once every call has finished. That is what lets a job
//! borrow the caller's data (the frame's bands, the picture's slices) without
//! copying: nothing the job borrows can be gone while any helper still runs
//! it. A panic in a helper is passed on to the caller after all have finished.
use std::any::Any;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

/// Stack of each helper thread (slice work needs little: blocks are 1.5 KB).
const STACK: usize = 256 * 1024;

/// A job as the helpers hold it, its borrow erased (see `run`).
type Job = dyn Fn() + Sync + 'static;

/// A job borrowed for the duration of one `run`.
#[derive(Clone, Copy)]
struct JobRef(*const Job);
// SAFETY: the job is `Sync` (callable from any thread), and `run` keeps it
// alive until every helper has finished with it.
unsafe impl Send for JobRef {}

struct State {
    job: Option<JobRef>,
    /// Incremented for every job, so each helper runs each job once.
    epoch: u64,
    /// Helpers still running the current job.
    running: usize,
    panic: Option<Box<dyn Any + Send>>,
    stop: bool,
}
struct Shared {
    state: Mutex<State>,
    /// Helpers wait here for a job (or for the pool to stop).
    start: Condvar,
    /// The caller waits here for the helpers to finish.
    done: Condvar,
}
fn lock(shared: &Shared) -> std::sync::MutexGuard<'_, State> {
    shared.state.lock().unwrap_or_else(|e| e.into_inner())
}

pub(super) struct Pool {
    shared: Arc<Shared>,
    helpers: Vec<JoinHandle<()>>,
}

impl Pool {
    /// A pool with `helpers` threads besides the caller's (fewer if the system
    /// cannot start them).
    pub(super) fn new(helpers: usize) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                job: None,
                epoch: 0,
                running: 0,
                panic: None,
                stop: false,
            }),
            start: Condvar::new(),
            done: Condvar::new(),
        });
        let helpers = (0..helpers)
            .filter_map(|_| {
                let shared = shared.clone();
                std::thread::Builder::new()
                    .name("trier-slices".into())
                    .stack_size(STACK)
                    .spawn(move || helper(&shared))
                    .ok()
            })
            .collect();
        Pool { shared, helpers }
    }

    /// Threads that run each job, the caller's included.
    pub(super) fn threads(&self) -> usize {
        self.helpers.len() + 1
    }

    /// Runs `job` on every helper and on this thread; returns when all are done.
    pub(super) fn run<'a>(&self, job: &'a (dyn Fn() + Sync + 'a)) {
        // SAFETY: the borrow is erased only for the helpers to call the job
        // while this function waits below until all of them have finished; the
        // pointer is cleared before returning and never used after.
        let job_ref = JobRef(unsafe {
            std::mem::transmute::<*const (dyn Fn() + Sync + 'a), *const Job>(job)
        });
        {
            let mut s = lock(&self.shared);
            s.job = Some(job_ref);
            s.epoch += 1;
            s.running = self.helpers.len();
            self.shared.start.notify_all();
        }
        let mine = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
        let mut s = lock(&self.shared);
        while s.running > 0 {
            s = self.shared.done.wait(s).unwrap_or_else(|e| e.into_inner());
        }
        s.job = None;
        let theirs = s.panic.take();
        drop(s);
        if let Err(e) = mine {
            std::panic::resume_unwind(e);
        }
        if let Some(e) = theirs {
            std::panic::resume_unwind(e);
        }
    }
}

fn helper(shared: &Shared) {
    let mut seen = 0u64;
    loop {
        let job = {
            let mut s = lock(shared);
            while !s.stop && (s.epoch == seen || s.job.is_none()) {
                s = shared.start.wait(s).unwrap_or_else(|e| e.into_inner());
            }
            if s.stop {
                return;
            }
            seen = s.epoch;
            s.job.expect("job")
        };
        // SAFETY: `run` is waiting for this helper, so the job is alive.
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe { (*job.0)() }));
        let mut s = lock(shared);
        if let Err(e) = result {
            s.panic.get_or_insert(e);
        }
        s.running -= 1;
        if s.running == 0 {
            shared.done.notify_all();
        }
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        lock(&self.shared).stop = true;
        self.shared.start.notify_all();
        for h in self.helpers.drain(..) {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn every_thread_runs_each_job_once_and_borrows_are_safe() {
        let pool = Pool::new(3);
        assert_eq!(pool.threads(), 4);
        for round in 0..200 {
            let data = vec![round; 1000];
            let calls = AtomicUsize::new(0);
            let sum = AtomicUsize::new(0);
            pool.run(&|| {
                calls.fetch_add(1, Ordering::Relaxed);
                sum.fetch_add(data.iter().sum::<usize>(), Ordering::Relaxed);
            });
            assert_eq!(calls.load(Ordering::Relaxed), 4);
            assert_eq!(sum.load(Ordering::Relaxed), 4 * 1000 * round);
        }
    }

    #[test]
    fn a_panic_in_a_helper_reaches_the_caller_and_the_pool_goes_on() {
        let pool = Pool::new(2);
        let first = AtomicUsize::new(0);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            pool.run(&|| {
                if first.fetch_add(1, Ordering::Relaxed) == 1 {
                    panic!("one helper fails");
                }
            })
        }));
        assert!(result.is_err());
        let calls = AtomicUsize::new(0);
        pool.run(&|| {
            calls.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(calls.load(Ordering::Relaxed), 3);
    }
}
