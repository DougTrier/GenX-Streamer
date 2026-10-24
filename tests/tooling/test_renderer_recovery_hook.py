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

"""Actual supported Wry hook plus scoped process environment restoration; no app packaging."""
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

@unittest.skipUnless(shutil.which('pwsh'), 'PowerShell required')
class RendererRecoveryHookTests(unittest.TestCase):
    def test_actual_hook_preserves_original_client_and_restores_environment_on_failure(self):
        script = str(ROOT / 'src-tauri/scripts/build-android.ps1').replace("'", "''")
        body = r"""$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('SCRIPT',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'script parse failed'}
foreach($name in @('Initialize-TmgEnvironmentProvider','Set-TmgProcessEnvironmentEntry','Invoke-TmgBuildEnvironment')) {
  $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  . ([scriptblock]::Create($fn[0].Extent.Text))
}
$assignment=$ast.FindAll({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$tmgBuildEnvironment'},$true)[0]
$table=$assignment.Right.Find({param($n)$n -is [Management.Automation.Language.HashtableAst]},$true)
$entry=@($table.KeyValuePairs | Where-Object {$_.Item1.Value -eq 'WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION'})
if($entry.Count -ne 1){throw 'supported hook missing'}
$hook=& ([scriptblock]::Create($entry[0].Item2.Extent.Text))
if($hook -notmatch 'override fun onRenderProcessGone' -or $hook -notmatch 'RendererRecoveryBridge.gone\(view\)' -or $hook -match 'setWebViewClient|evaluateJavascript'){throw 'client integration changed'}
$name='WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION'
foreach($old in @($null,'external-existing-hook')) {
  Set-TmgProcessEnvironmentEntry -Name $name -Present ($null -ne $old) -Value $old
  $expected=[Environment]::GetEnvironmentVariable($name,'Process')
  foreach($fail in @($false,$true)) {
    $caught=$false
    try { Invoke-TmgBuildEnvironment -Changes @{$name=$hook} -Location 'ROOT' -Work {
      if([Environment]::GetEnvironmentVariable($name,'Process') -ne $hook){throw 'hook not applied'}
      if($fail){throw 'injected-work-failure'}
    }} catch {if(-not $fail){throw};$caught=$true}
    if($caught -ne $fail){throw 'wrong failure outcome'}
    if([Environment]::GetEnvironmentVariable($name,'Process') -ne $expected){throw 'hook not restored'}
  }
}
'PASS hook4environmentCases noPackaging noDevice'
""".replace('SCRIPT', script).replace("'ROOT'", "'" + str(ROOT).replace("'", "''") + "'")
        result = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', body], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS hook4environmentCases', result.stdout)

if __name__ == '__main__': unittest.main()
