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

param(
    [ValidateSet('Debug', 'Release')][string]$Profile = 'Debug',
    [switch]$UseExistingSharedBuild
)
$ErrorActionPreference = 'Stop'
$buildRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$buildCli = Join-Path $buildRepo 'node_modules/.bin/tauri.cmd'
if (!(Test-Path -LiteralPath $buildCli -PathType Leaf)) { throw 'Install the pinned project dependencies before packaging.' }
function Get-SharedFingerprint {
    $distRoot = Join-Path $buildRepo 'dist'
    if (!(Test-Path -LiteralPath (Join-Path $distRoot 'index.html') -PathType Leaf)) { throw 'Shared build is missing.' }
    return @(Get-ChildItem -LiteralPath $distRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($distRoot.Length) + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }) -join "`n"
}
$buildOverlay = Join-Path ([IO.Path]::GetTempPath()) ('genx-windows-build-' + [guid]::NewGuid().ToString('N') + '.json')
$buildArguments = @('build', '--no-bundle', '--ci')
if ($Profile -eq 'Debug') { $buildArguments += '--debug' }
Push-Location -LiteralPath $buildRepo
try {
    if ($UseExistingSharedBuild) {
        $sharedBefore = Get-SharedFingerprint
        '{"build":{"beforeBuildCommand":""}}' | Set-Content -LiteralPath $buildOverlay -Encoding utf8
        $buildArguments += @('--config', $buildOverlay)
    }
    # cargo build alone is a development-server build; packaging must use Tauri's build mode.
    & $buildCli @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }
    if ($UseExistingSharedBuild -and (Get-SharedFingerprint) -ne $sharedBefore) { throw 'Shared assets changed during packaging.' }
    $buildBinary = Join-Path $buildRepo ('src-tauri/target/' + $Profile.ToLowerInvariant() + '/tmg-tv.exe')
    if (!(Test-Path -LiteralPath $buildBinary -PathType Leaf)) { throw 'Packaged executable is missing.' }
    $buildResult = [ordered]@{
        status = 'BUILT'
        scope = 'Binary packaging only; runtime, signing and release acceptance require separate evidence.'
        profile = $Profile
        path = $buildBinary
        sha256 = (Get-FileHash -LiteralPath $buildBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    # The executable takes the internal package name (tmg-tv) that development
    # tools use; a release also gets the user-facing name, byte-identical.
    if ($Profile -eq 'Release') {
        $namedBinary = Join-Path (Split-Path -Parent $buildBinary) 'GenX Streamer.exe'
        try { Copy-Item -LiteralPath $buildBinary -Destination $namedBinary -Force }
        catch { throw 'Could not write GenX Streamer.exe. Close any running copy and build again.' }
        $buildResult.userPath = $namedBinary
    }
    $buildResult | ConvertTo-Json -Compress
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $buildOverlay -PathType Leaf) { Remove-Item -LiteralPath $buildOverlay }
}
