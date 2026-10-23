"""Exact upstream-tree guard and deterministic event-source model, not Android runtime proof."""
import hashlib
import json
from collections import deque
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "src-tauri/vendor/tao"
DRAIN = """      // Backport tauri-apps/tao#1304: an fd event can consume the wake indication.
      // Always drain queued user events before MainEventsCleared, even on fd polls.
      while let Ok(event) = self.receiver.try_recv() {
        call_event_handler!(
          event_handler,
          self.window_target(),
          control_flow,
          event::Event::UserEvent(event)
        );
      }

"""


def poll_iteration(source, event_source, queue):
    """Model only the actual source's two queue-drain locations; no fake IPC completion."""
    delivered = []

    def drain():
        while queue:
            delivered.append(queue.popleft())

    if event_source == "User":
        drain()
    # This exact post-match block is guarded by the original-source reverse hash test.
    if DRAIN in source:
        drain()
    return delivered


class AndroidEventLoopPatchTests(unittest.TestCase):
    def setUp(self):
        self.provenance = json.loads((VENDOR / "GENX-PATCH-PROVENANCE.json").read_text("utf8"))
        self.source = (VENDOR / self.provenance["patchedFile"]).read_text("utf8")

    def test_exact_archive_tree_with_only_two_reviewed_changes(self):
        self.assertEqual(self.provenance["registryArchiveSha256"],
                         "1cf65722394c2ac443e80120064987f8914ee1d4e4e36e63cdf10f2990f01159")
        expected = self.provenance["originalFiles"]
        self.assertEqual(len(expected), 119)
        actual = {p.relative_to(VENDOR).as_posix() for p in VENDOR.rglob("*") if p.is_file()}
        self.assertEqual(actual, set(expected) | {"GENX-PATCHES.md", "GENX-PATCH-PROVENANCE.json"})
        for relative, digest in expected.items():
            data = (VENDOR / relative).read_bytes()
            if relative == self.provenance["patchedFile"]:
                self.assertEqual(hashlib.sha256(data).hexdigest(), self.provenance["patchedFileSha256"])
                self.assertEqual(self.source.count(DRAIN), 1)
                self.assertEqual(self.source.count("    let _ = self.queue.send(event);\n    self.looper.wake();"), 1)
                data = self.source.replace(DRAIN, "").replace(
                    "    let _ = self.queue.send(event);\n    self.looper.wake();",
                    "    _ = self.queue.try_send(event);\n    self.looper.wake();").encode("utf8")
            self.assertEqual(hashlib.sha256(data).hexdigest(), digest, relative)
        self.assertTrue((VENDOR / "LICENSE").is_file())

    def test_source_drain_after_poll_match_before_main_events_cleared(self):
        self.assertIn("        None => {}\n      }\n\n" + DRAIN + "      call_event_handler!(", self.source)
        self.assertLess(self.source.index(DRAIN), self.source.index("event::Event::MainEventsCleared"))
        self.assertIn('crossbeam_channel::unbounded()', self.source)

    def test_fd_callback_with_pending_user_responses_reproduces_old_failure(self):
        queue = deque(["listen-registry-eval", "listen-response"])
        pristine = self.source.replace(DRAIN, "")
        self.assertEqual(poll_iteration(pristine, "Callback", queue), [])
        self.assertEqual(len(queue), 2)
        self.assertEqual(poll_iteration(self.source, "Callback", queue),
                         ["listen-registry-eval", "listen-response"])
        self.assertFalse(queue)

    def test_mixed_poll_sources_drain_once_preserving_order_without_next_ipc(self):
        for event_source in ["User", "Callback", "InputQueue", None]:
            with self.subTest(event_source=event_source):
                queue = deque([1, 2, 3])
                self.assertEqual(poll_iteration(self.source, event_source, queue), [1, 2, 3])
                self.assertFalse(queue)
                self.assertEqual(poll_iteration(self.source, "User", queue), [])


if __name__ == "__main__":
    unittest.main()
