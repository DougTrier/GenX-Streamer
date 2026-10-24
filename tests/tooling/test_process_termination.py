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

"""LX12 (docs/lifecycle-media-invariants.md): GenX ends its own process only
from approved places, so no other path (backgrounding, playback, Windows) can
terminate it.

- Kotlin `killProcess` appears only in the renderer-recovery helpers that
  already relaunch a fresh process, and in ViewingPlugin.endProcess.
- The native code (every Rust source file, not only one) asks for
  `endProcess` exactly once, inside `finalize_activity_exit` (lifecycle.rs),
  which is Android-only and runs it through `end_after_drain` (LX06).
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KOTLIN = ROOT / 'src-tauri/gen/android/app/src/main/java/com/tmg/tv'
NATIVE = ROOT / 'src-tauri/src'
ALLOWED_KILL = {'RendererRecoveryPlugin.kt', 'RendererRelaunchActivity.kt', 'ViewingPlugin.kt'}


def kill_sites(files):
    """(file name, line) for every killProcess call outside comments."""
    sites = []
    for name, text in files:
        for number, line in enumerate(text.splitlines(), 1):
            code = line.split('//')[0]
            if 'killProcess(' in code and not code.lstrip().startswith('*'):
                sites.append((name, number))
    return sites


def violations(kotlin_files, native):
    """native: {relative path: text} for every Rust source file."""
    problems = [f'killProcess in {name}:{line}' for name, line in kill_sites(kotlin_files)
                if name not in ALLOWED_KILL]
    viewing = dict(kotlin_files).get('ViewingPlugin.kt', '')
    viewing_kills = [s for s in kill_sites([('ViewingPlugin.kt', viewing)])]
    if len(viewing_kills) != 1 or 'fun endProcess(' not in viewing:
        problems.append('ViewingPlugin must kill only inside endProcess')
    else:
        body = viewing.split('fun endProcess(', 1)[1].split('\n  }', 1)[0]
        if 'killProcess(' not in body:
            problems.append('ViewingPlugin kills outside endProcess')
    calls = [(path, m.start()) for path, text in native.items()
             for m in re.finditer(r'"endProcess"', text)]
    if len(calls) != 1:
        problems.append(f'endProcess requested {len(calls)} times in the native code')
    else:
        path, position = calls[0]
        before = native[path][:position]
        function = before.rsplit('async fn ', 1)[-1].split('(', 1)[0]
        attribute = before.rsplit('async fn ', 1)[0][-80:]
        if function != 'finalize_activity_exit' or '#[cfg(target_os = "android")]' not in attribute:
            problems.append(f'endProcess requested from {function}, not the Android-only finalize_activity_exit')
        if 'end_after_drain(' not in before.rsplit('async fn finalize_activity_exit', 1)[-1]:
            problems.append('endProcess is not gated by end_after_drain')
    return problems


def current():
    files = [(p.name, p.read_text(encoding='utf-8')) for p in KOTLIN.glob('*.kt')]
    native = {p.relative_to(NATIVE).as_posix(): p.read_text(encoding='utf-8')
              for p in NATIVE.rglob('*.rs')}
    return files, native


class ProcessTerminationTest(unittest.TestCase):
    def test_current_sources_end_the_process_only_from_approved_places(self):
        files, native = current()
        self.assertEqual(violations(files, native), [])

    def test_a_stray_kill_or_ungated_request_is_rejected(self):
        files, native = current()
        stray = files + [('ViewingLifecycle.kt', 'fun onStop() { Process.killProcess(Process.myPid()) }')]
        self.assertTrue(any('ViewingLifecycle.kt' in p for p in violations(stray, native)))
        # A second request in any other native file is caught, not only in lifecycle.rs.
        twice = {**native, 'playback_stray.rs': 'async fn on_background() { run_mobile_plugin_async("endProcess", json!({})) }\n'}
        self.assertTrue(any('2 times' in p for p in violations(files, twice)))
        ungated = {path: text.replace('android_task_finish::end_after_drain(', 'android_task_finish::skip_drain(')
                   for path, text in native.items()}
        self.assertTrue(any('not gated' in p for p in violations(files, ungated)))

if __name__ == '__main__':
    unittest.main()
