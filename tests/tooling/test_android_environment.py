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

"""Real isolated-process Android environment restoration; never runs packaging."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'src-tauri/scripts/build-android.ps1'
SHELL = shutil.which('pwsh')

FIXTURE = r"""param([string]$Candidate = (Join-Path $PSScriptRoot 'build-android.ps1'))
$ErrorActionPreference = 'Stop'
$tmgTokens = $null
$tmgErrors = $null
$tmgAst = [Management.Automation.Language.Parser]::ParseFile($Candidate, [ref]$tmgTokens, [ref]$tmgErrors)
if ($tmgErrors.Count) { throw 'Candidate parsing failed' }
$tmgNames = @('Initialize-TmgEnvironmentProvider','Set-TmgProcessEnvironmentEntry','Invoke-TmgBuildEnvironment')
foreach ($tmgName in $tmgNames) {
    $tmgFunctions = @($tmgAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $tmgName }, $true))
    if ($tmgFunctions.Count -ne 1) { throw 'Actual candidate helper missing or duplicated' }
    . ([scriptblock]::Create($tmgFunctions[0].Extent.Text))
}
# Only proposed actual helper definitions are loaded; packaging body never runs.
Initialize-TmgEnvironmentProvider
$tmgKeys = @('JAVA_HOME','ANDROID_HOME','NDK_HOME','CARGO_NET_OFFLINE','TAURI_ANDROID_PROJECT_PATH','TAURI_ENV_DEBUG','WRY_ANDROID_PACKAGE','WRY_ANDROID_LIBRARY','WRY_ANDROID_KOTLIN_FILES_OUT_DIR','CARGO_PROFILE_DEV_OPT_LEVEL','CARGO_PROFILE_DEV_DEBUG','CARGO_PROFILE_DEV_DEBUG_ASSERTIONS','CARGO_PROFILE_DEV_OVERFLOW_CHECKS','CARGO_PROFILE_DEV_STRIP','CC_ENABLE_DEBUG_OUTPUT','CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER','CC_aarch64_linux_android','AR_aarch64_linux_android')
$tmgChanges = [ordered]@{}
$tmgExpected = @{}
for ($i = 0; $i -lt $tmgKeys.Count; $i++) {
    $name = $tmgKeys[$i]
    $present = ($i % 3) -ne 0
    $value = $(if ($i % 3 -eq 1) { '' } else { 'retained-' + $i })
    Set-TmgProcessEnvironmentEntry -Name $name -Present $present -Value $value
    $tmgExpected[$name] = @{ Present=$present; Value=$(if ($present) { $value } else { $null }) }
    $tmgChanges[$name] = 'temporary-' + $i
}
# Concrete regression: absent OVERFLOW_CHECKS must stay absent, not empty.
Set-TmgProcessEnvironmentEntry -Name 'CARGO_PROFILE_DEV_OVERFLOW_CHECKS' -Present $false
$tmgExpected['CARGO_PROFILE_DEV_OVERFLOW_CHECKS'] = @{ Present=$false; Value=$null }
# A separate deliberately empty value must remain present, not become absent.
Set-TmgProcessEnvironmentEntry -Name 'CC_ENABLE_DEBUG_OUTPUT' -Present $true -Value ''
$tmgExpected['CC_ENABLE_DEBUG_OUTPUT'] = @{ Present=$true; Value='' }
Set-TmgProcessEnvironmentEntry -Name 'TMG_UNTOUCHED_TEST_MARKER' -Present $true -Value 'untouched'
# Windows logical environment names are case-insensitive; establish an
# differently-cased original, then exercise upper/lower aliases through helper.
Set-TmgProcessEnvironmentEntry -Name 'JaVa_HoMe' -Present $true -Value 'mixed-case-original'
$tmgExpected['JAVA_HOME'] = @{Present=$true;Value='mixed-case-original'}
$tmgInitialLocation = (Get-Location).Path
function Assert-TmgRestored {
    $vars = [Collections.Hashtable]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $vars[$entry.Key] = $entry.Value
    }
    foreach ($name in $tmgKeys) {
        $expected = $tmgExpected[$name]
        if ($vars.Contains($name) -ne $expected.Present) { throw ('Presence mismatch: ' + $name) }
        if ($expected.Present -and [string]$vars[$name] -cne $expected.Value) { throw ('Value mismatch: ' + $name) }
    }
    if ([Environment]::GetEnvironmentVariable('TMG_UNTOUCHED_TEST_MARKER','Process') -cne 'untouched') { throw 'Unrelated variable changed' }
    if ((Get-Location).Path -ne $tmgInitialLocation) { throw 'Location not restored' }
}
Assert-TmgRestored
$tmgCases = @()
Invoke-TmgBuildEnvironment -Changes $tmgChanges -Location $PSScriptRoot -Work {
    foreach ($name in $tmgKeys) {
        if ([Environment]::GetEnvironmentVariable($name,'Process') -cne $tmgChanges[$name]) { throw 'Mutation was not visible' }
    }
}
Assert-TmgRestored
$tmgCases += 'success-all18-absent-empty-nonempty'
try {
    Invoke-TmgBuildEnvironment -Changes $tmgChanges -Location $PSScriptRoot -Work { throw 'injected-work-failure' }
    throw 'Injected failure missing'
} catch { if ($_.Exception.Message -ne 'injected-work-failure') { throw } }
Assert-TmgRestored
$tmgCases += 'work-failure-all18-restored'
$script:tmgWorkCalled = $false
try {
    Invoke-TmgBuildEnvironment -Changes $tmgChanges -Location (Join-Path $PSScriptRoot 'missing-location-never-created') -Work { $script:tmgWorkCalled = $true }
    throw 'Location failure missing'
} catch { if ($_.Exception.Message -eq 'Location failure missing') { throw } }
if ($script:tmgWorkCalled) { throw 'Work admitted after Push-Location failure' }
Assert-TmgRestored
$tmgCases += 'push-location-failure-restored'
Invoke-TmgBuildEnvironment -Changes $tmgChanges -Location $PSScriptRoot -Work {
    Invoke-TmgBuildEnvironment -Changes @{JAVA_HOME='nested-value'; CC_ENABLE_DEBUG_OUTPUT=$null} -Location $PSScriptRoot -Work {
        if ([Environment]::GetEnvironmentVariable('JAVA_HOME','Process') -ne 'nested-value') { throw 'Nested mutation missing' }
    }
    foreach ($name in $tmgKeys) {
        if ([Environment]::GetEnvironmentVariable($name,'Process') -cne $tmgChanges[$name]) { throw 'Nested snapshot not restored' }
    }
}
Assert-TmgRestored
$tmgCases += 'nested-transaction-restores-parent'
$tmgActualSetter = (Get-Command Set-TmgProcessEnvironmentEntry).ScriptBlock
$script:tmgSetterCalls = 0
$tmgInjectedSetter = {
    param([string]$Name, [bool]$Present, [AllowNull()][AllowEmptyString()][string]$Value)
    $script:tmgSetterCalls++
    if ($script:tmgSetterCalls -eq 2) { throw 'injected-environment-write-failure' }
    & $tmgActualSetter -Name $Name -Present $Present -Value $Value
}
Set-Item -LiteralPath Function:\Set-TmgProcessEnvironmentEntry -Value $tmgInjectedSetter
try {
    try {
        Invoke-TmgBuildEnvironment -Changes ([ordered]@{JAVA_HOME='partial'; NDK_HOME='second'}) -Location $PSScriptRoot -Work { throw 'Work admitted after mutation failure' }
        throw 'Mutation failure missing'
    } catch { if ($_.Exception.Message -ne 'injected-environment-write-failure') { throw } }
} finally { Set-Item -LiteralPath Function:\Set-TmgProcessEnvironmentEntry -Value $tmgActualSetter }
Assert-TmgRestored
$tmgCases += 'real-first-mutation-injected-second-failure-restored'
# Do not invoke Cargo; prove the absent failure-producing profile is null and
# an explicitly valid prior nonempty flag survives a later transaction.
if ($null -ne [Environment]::GetEnvironmentVariable('CARGO_PROFILE_DEV_OVERFLOW_CHECKS','Process')) { throw 'Absent profile was converted to empty' }
Set-TmgProcessEnvironmentEntry -Name 'CARGO_PROFILE_DEV_OVERFLOW_CHECKS' -Present $true -Value 'false'
$tmgExpected['CARGO_PROFILE_DEV_OVERFLOW_CHECKS'] = @{Present=$true; Value='false'}
Invoke-TmgBuildEnvironment -Changes @{CARGO_PROFILE_DEV_OVERFLOW_CHECKS='true'} -Location $PSScriptRoot -Work {}
Assert-TmgRestored
$tmgCases += 'valid-profile-value-preserved'
Invoke-TmgBuildEnvironment -Changes @{java_home='mixed-case-temporary'} -Location $PSScriptRoot -Work {
    if ((Get-Item -LiteralPath 'Env:JAVA_HOME').Value -ne 'mixed-case-temporary') { throw 'Mixed-case mutation failed' }
}
Assert-TmgRestored
$tmgCases += 'mixed-case-existing-key-capture-and-restore'
foreach ($version in @('5.1','7.4')) {
    try { Initialize-TmgEnvironmentProvider -Version ([version]$version); throw 'Unsupported version admitted' }
    catch { if ($_.Exception.Message -ne 'Android environment restoration requires PowerShell 7.5 or newer on Windows') { throw } }
}
Assert-TmgRestored
$tmgCases += 'unsupported-version-refused-before-mutation'

[ordered]@{ status='PASS'; powershell=[string]$PSVersionTable.PSVersion; cases=$tmgCases; caseCount=$tmgCases.Count; actualCandidateHelpers=$true; noPackagingBodyInvoked=$true; repositoryModified=$false; deviceOperations=0 } | ConvertTo-Json -Depth 4
"""

@unittest.skipUnless(os.name == 'nt', 'Windows process environment contract')
class AndroidEnvironmentTests(unittest.TestCase):
    def test_actual_helpers_preserve_all_scoped_environment_states_and_failures(self):
        self.assertIsNotNone(SHELL, 'PowerShell 7.5+ required for this Windows contract')
        with tempfile.TemporaryDirectory(prefix='GenX-android-environment-') as directory:
            fixture = Path(directory) / 'fixture.ps1'
            fixture.write_text(FIXTURE, encoding='utf-8')
            result = subprocess.run(
                [SHELL, '-NoProfile', '-NonInteractive', '-File', str(fixture),
                 '-Candidate', str(SCRIPT)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt['status'], 'PASS')
            self.assertEqual(receipt['caseCount'], 8)
            self.assertEqual(set(receipt['cases']), {
                'success-all18-absent-empty-nonempty', 'work-failure-all18-restored',
                'push-location-failure-restored', 'nested-transaction-restores-parent',
                'real-first-mutation-injected-second-failure-restored',
                'valid-profile-value-preserved', 'mixed-case-existing-key-capture-and-restore',
                'unsupported-version-refused-before-mutation'})
            self.assertTrue(receipt['actualCandidateHelpers'])
            self.assertTrue(receipt['noPackagingBodyInvoked'])
            self.assertEqual(receipt['deviceOperations'], 0)


if __name__ == '__main__':
    unittest.main()
