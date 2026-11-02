// Copyright 2026 Doug Trier
// SPDX-License-Identifier: Apache-2.0

//! A Java Surface wrapper can outlive its native BufferQueue. An acquired native
//! window identifies the current queue; redundant acquired references are released.

pub(super) fn draw_current_window<W, E>(
    mut acquire: impl FnMut() -> Result<W, E>,
    identity: impl Fn(&W) -> usize,
    mut draw: impl FnMut(Result<W, E>) -> Result<(), E>,
) -> Result<(), E> {
    let acquired = acquire();
    let initial = acquired.as_ref().ok().map(&identity);
    let error = match draw(acquired) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    let replacement = acquire();
    if replacement.as_ref().ok().map(identity) == initial {
        // A genuine failure on the same queue remains visible, and the redundant
        // acquired reference is released. Never retry repeatedly on a bad queue.
        return Err(error);
    }
    // Only a proven native queue replacement permits one same-frame redraw.
    draw(replacement)
}

pub(super) struct SurfaceBinding<W> {
    window: Option<W>,
    identity: Option<usize>,
    geometry: Option<(i32, i32)>,
}

impl<W> SurfaceBinding<W> {
    pub(super) fn new() -> Self {
        Self {
            window: None,
            identity: None,
            geometry: None,
        }
    }

    pub(super) fn prepare<E>(
        &mut self,
        acquired: Result<W, E>,
        identity: impl FnOnce(&W) -> usize,
        geometry: (i32, i32),
        configure: impl FnOnce(&W, (i32, i32)) -> Result<(), E>,
    ) -> Result<&W, E> {
        let incoming = match acquired {
            Ok(incoming) => incoming,
            Err(error) => {
                // Failed acquisition cannot leave the abandoned queue reusable.
                self.window = None;
                self.identity = None;
                self.geometry = None;
                return Err(error);
            }
        };
        let incoming_identity = identity(&incoming);
        if self.identity != Some(incoming_identity) || self.window.is_none() {
            self.window = Some(incoming);
            self.identity = Some(incoming_identity);
            self.geometry = None;
        }
        // Otherwise `incoming` drops its redundant acquired reference here.
        let window = self.window.as_ref().expect("window acquired above");
        if self.geometry != Some(geometry) {
            configure(window, geometry)?;
            self.geometry = Some(geometry);
        }
        Ok(window)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    #[derive(Default)]
    struct Resources {
        acquired: Cell<usize>,
        released: Cell<usize>,
        events: RefCell<Vec<String>>,
    }
    struct Window {
        id: usize,
        resources: Rc<Resources>,
    }
    impl Drop for Window {
        fn drop(&mut self) {
            self.resources
                .released
                .set(self.resources.released.get() + 1);
            self.resources
                .events
                .borrow_mut()
                .push(format!("release {}", self.id));
        }
    }
    fn acquire(resources: &Rc<Resources>, id: usize) -> Window {
        resources.acquired.set(resources.acquired.get() + 1);
        resources.events.borrow_mut().push(format!("acquire {id}"));
        Window {
            id,
            resources: resources.clone(),
        }
    }
    fn prepare(
        binding: &mut SurfaceBinding<Window>,
        resources: &Rc<Resources>,
        id: usize,
        geometry: (i32, i32),
    ) -> Result<usize, &'static str> {
        binding
            .prepare(
                Ok(acquire(resources, id)),
                |window| window.id,
                geometry,
                |window, size| {
                    resources
                        .events
                        .borrow_mut()
                        .push(format!("configure {} {}x{}", window.id, size.0, size.1));
                    Ok(())
                },
            )
            .map(|window| window.id)
    }

    #[test]
    fn stable_queue_releases_every_redundant_reference_and_resize_reconfigures() {
        let resources = Rc::new(Resources::default());
        let mut binding = SurfaceBinding::new();
        for _ in 0..120 {
            assert_eq!(prepare(&mut binding, &resources, 10, (1280, 720)), Ok(10));
            assert_eq!(resources.acquired.get() - resources.released.get(), 1);
        }
        assert_eq!(prepare(&mut binding, &resources, 10, (1920, 1080)), Ok(10));
        let configurations = resources
            .events
            .borrow()
            .iter()
            .filter(|event| event.starts_with("configure"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            configurations,
            ["configure 10 1280x720", "configure 10 1920x1080"]
        );
        drop(binding);
        assert_eq!(resources.acquired.get(), resources.released.get());
    }

    #[test]
    fn same_java_wrapper_new_native_queue_releases_old_and_restores_geometry() {
        let resources = Rc::new(Resources::default());
        let mut binding = SurfaceBinding::new();
        prepare(&mut binding, &resources, 10, (1280, 720)).unwrap();
        // IME open/close or fullscreen replaces the underlying queue while the
        // Java wrapper and decoded picture dimensions can remain unchanged.
        assert_eq!(prepare(&mut binding, &resources, 20, (1280, 720)), Ok(20));
        assert_eq!(
            *resources.events.borrow(),
            [
                "acquire 10",
                "configure 10 1280x720",
                "acquire 20",
                "release 10",
                "configure 20 1280x720"
            ]
        );
        drop(binding);
        assert_eq!(resources.acquired.get(), resources.released.get());
    }

    #[test]
    fn repeated_keyboard_transitions_release_every_native_window() {
        let resources = Rc::new(Resources::default());
        let mut binding = SurfaceBinding::new();
        for identity in 1..100 {
            prepare(&mut binding, &resources, identity, (1280, 720)).unwrap();
            assert_eq!(resources.acquired.get() - resources.released.get(), 1);
        }
        drop(binding);
        assert_eq!(resources.acquired.get(), resources.released.get());
    }

    #[test]
    fn failed_acquisition_releases_old_queue_and_next_frame_can_bind_again() {
        let resources = Rc::new(Resources::default());
        let mut binding = SurfaceBinding::new();
        prepare(&mut binding, &resources, 10, (1280, 720)).unwrap();
        let result = binding.prepare(
            Err("acquire-failed"),
            |window| window.id,
            (1280, 720),
            |_, _| Ok(()),
        );
        assert_eq!(result.err(), Some("acquire-failed"));
        assert_eq!(resources.acquired.get(), resources.released.get());
        assert_eq!(prepare(&mut binding, &resources, 20, (1280, 720)), Ok(20));
    }

    #[test]
    fn configure_failure_is_returned_and_not_cached_as_success() {
        let resources = Rc::new(Resources::default());
        let mut binding = SurfaceBinding::new();
        let result = binding.prepare(
            Ok(acquire(&resources, 10)),
            |window| window.id,
            (1280, 720),
            |_, _| Err("configure-failed"),
        );
        assert_eq!(result.err(), Some("configure-failed"));
        assert_eq!(prepare(&mut binding, &resources, 10, (1280, 720)), Ok(10));
        assert_eq!(resources.acquired.get() - resources.released.get(), 1);
        assert_eq!(
            resources
                .events
                .borrow()
                .iter()
                .filter(|event| event.starts_with("configure"))
                .count(),
            1
        );
        drop(binding);
        assert_eq!(resources.acquired.get(), resources.released.get());
    }

    #[test]
    fn unchanged_queue_draw_failure_is_not_retried_or_hidden() {
        let resources = Rc::new(Resources::default());
        let calls = Cell::new(0);
        let result = draw_current_window(
            || Ok(acquire(&resources, 10)),
            |window| window.id,
            |window| {
                let _window = window?;
                calls.set(calls.get() + 1);
                Err("lock-failed")
            },
        );
        assert_eq!(result, Err("lock-failed"));
        assert_eq!(calls.get(), 1);
        assert_eq!(resources.acquired.get(), 2);
        assert_eq!(resources.acquired.get(), resources.released.get());
    }

    #[test]
    fn replacement_during_draw_retries_same_frame_once_and_preserves_second_error() {
        for succeeds in [true, false] {
            let resources = Rc::new(Resources::default());
            let mut identities = [10, 20].into_iter();
            let calls = RefCell::new(Vec::new());
            let result = draw_current_window(
                || {
                    Ok(acquire(
                        &resources,
                        identities.next().expect("at most two acquisitions"),
                    ))
                },
                |window| window.id,
                |window| {
                    let window = window?;
                    calls.borrow_mut().push(window.id);
                    if window.id == 20 && succeeds {
                        Ok(())
                    } else {
                        Err("post-failed")
                    }
                },
            );
            assert_eq!(result, if succeeds { Ok(()) } else { Err("post-failed") });
            assert_eq!(*calls.borrow(), [10, 20]);
            assert_eq!(resources.acquired.get(), resources.released.get());
        }
    }
}
