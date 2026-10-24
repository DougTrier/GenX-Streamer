# Copyright 2026 Doug Trier
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Exact upstream-tree guard and deterministic event-source model, not Android runtime proof."""
import hashlib
import json
from collections import deque
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "src-tauri/vendor/tao"
# GenX's null-intent fix (GENX-PATCHES.md): (published, patched) snippet pairs.
NULL_INTENT_FIXES = json.loads((Path(__file__).parent / "tao_null_intent_fixes.json").read_text("utf8"))
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

    def test_exact_archive_tree_with_only_the_reviewed_changes(self):
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
            if relative == self.provenance["nullIntentFile"]:
                self.assertEqual(hashlib.sha256(data).hexdigest(), self.provenance["nullIntentFileSha256"])
                text = data.decode("utf8")
                for published, patched in NULL_INTENT_FIXES:
                    self.assertEqual(text.count(patched), 1)
                    text = text.replace(patched, published)
                data = text.encode("utf8")
            self.assertEqual(hashlib.sha256(data).hexdigest(), digest, relative)
        self.assertTrue((VENDOR / "LICENSE").is_file())

    def test_links_without_a_type_uri_or_stream_never_unwrap_a_null(self):
        """A genx:// link opened while GenX runs has no MIME type; tao 0.35.0 unwrapped it and
        hung GenX on a 32-bit Google TV (October 24, 2026). Every nullable intent field read in
        handle_intent is filtered before use."""
        glue = (VENDOR / self.provenance["nullIntentFile"]).read_text("utf8")
        handler = glue[glue.index("pub unsafe fn handle_intent"):glue.index("pub unsafe fn start(")]
        for field in ['"getType"', '"getUri"', '"android.intent.extra.STREAM"']:
            after = handler[handler.index(field):]
            statement = after[:after.index(";\n")]
            self.assertIn("!", statement)
            self.assertIn("is_null()", statement)
        self.assertNotIn(".get_string(&intent_type)\n        .unwrap()", handler)

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
