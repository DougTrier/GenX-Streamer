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

$ErrorActionPreference = 'Stop'
$tmgRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$tmgManifest = Join-Path $tmgRepo 'src-tauri/icon-manifest.json'
$tmgSource = Join-Path $tmgRepo 'assets/tmg-retro-tv.png'
$tmgIcons = Join-Path $tmgRepo 'src-tauri/icons'
$tmgGenerated = Join-Path $tmgRepo 'artifacts/launcher-icons/generated/icons'
$tmgResources = Join-Path $tmgRepo 'src-tauri/gen/android/app/src/main/res'
$tmgCli = Join-Path $tmgRepo 'node_modules/.bin/tauri.cmd'
foreach ($tmgPath in @($tmgManifest, $tmgSource, $tmgCli, $tmgResources)) {
    if (!(Test-Path -LiteralPath $tmgPath)) { throw "Missing launcher packaging input: $tmgPath" }
}
$tmgSourceHash = (Get-FileHash -LiteralPath $tmgSource -Algorithm SHA256).Hash
& $tmgCli icon $tmgManifest --output $tmgGenerated
if ($LASTEXITCODE -ne 0) { throw 'Official Tauri icon generation failed' }
if ((Get-FileHash -LiteralPath $tmgSource -Algorithm SHA256).Hash -ne $tmgSourceHash) { throw 'Source artwork changed during icon generation' }
# The CLI generates raster assets; adaptive XML and color are explicit packaging inputs.
$tmgAdaptive = '<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><foreground><inset android:insetLeft="22.5%" android:insetTop="22.5%" android:insetRight="22.5%" android:insetBottom="22.5%"><bitmap android:src="@mipmap/ic_launcher_foreground" android:gravity="fill"/></inset></foreground><background android:drawable="@color/ic_launcher_background"/></adaptive-icon>'
$tmgColor = '<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">#111827</color></resources>'
foreach ($tmgFolder in @('mipmap-anydpi-v26', 'values')) {
    New-Item -ItemType Directory -Path (Join-Path (Join-Path $tmgIcons 'android') $tmgFolder) -Force | Out-Null
}
foreach ($tmgName in @('icon.ico','icon.png','32x32.png','64x64.png','128x128.png','128x128@2x.png','StoreLogo.png','Square30x30Logo.png','Square44x44Logo.png','Square71x71Logo.png','Square89x89Logo.png','Square107x107Logo.png','Square142x142Logo.png','Square150x150Logo.png','Square284x284Logo.png','Square310x310Logo.png')) {
    Copy-Item -LiteralPath (Join-Path $tmgGenerated $tmgName) -Destination (Join-Path $tmgIcons $tmgName) -Force
}
foreach ($tmgDensity in @('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi')) {
    foreach ($tmgName in @('ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png')) {
        Copy-Item -LiteralPath (Join-Path $tmgGenerated "android/mipmap-$tmgDensity/$tmgName") -Destination (Join-Path $tmgIcons "android/mipmap-$tmgDensity/$tmgName") -Force
    }
}
# LF line endings and no byte-order mark, matching the repository (.editorconfig).
[IO.File]::WriteAllText((Join-Path $tmgIcons 'android/mipmap-anydpi-v26/ic_launcher.xml'), $tmgAdaptive + "`n")
[IO.File]::WriteAllText((Join-Path $tmgIcons 'android/values/ic_launcher_background.xml'), $tmgColor + "`n")
# Exact resource allowlist: never enumerate arbitrary destination paths or delete stale files.
$tmgRelativePaths = @('values/ic_launcher_background.xml', 'mipmap-anydpi-v26/ic_launcher.xml')
foreach ($tmgDensity in @('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi')) {
    foreach ($tmgName in @('ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png')) {
        $tmgRelativePaths += "mipmap-$tmgDensity/$tmgName"
    }
}
foreach ($tmgRelative in $tmgRelativePaths) {
    $tmgFrom = Join-Path (Join-Path $tmgIcons 'android') $tmgRelative
    $tmgTo = Join-Path $tmgResources $tmgRelative
    if (!(Test-Path -LiteralPath $tmgFrom -PathType Leaf)) { throw "Missing generated icon: $tmgRelative" }
    New-Item -ItemType Directory -Path (Split-Path $tmgTo -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $tmgFrom -Destination $tmgTo -Force
    if ((Get-FileHash -LiteralPath $tmgFrom).Hash -ne (Get-FileHash -LiteralPath $tmgTo).Hash) { throw 'Launcher resource copy mismatch' }
}
# Both adaptive entry points resolve the generated mipmap foreground, never the unused template vector.
$tmgRound = Join-Path $tmgResources 'mipmap-anydpi-v26/ic_launcher_round.xml'
Copy-Item -LiteralPath (Join-Path $tmgResources 'mipmap-anydpi-v26/ic_launcher.xml') -Destination $tmgRound -Force
Write-Output "Launcher artwork SHA256 $tmgSourceHash"
& (Join-Path $PSScriptRoot 'generate-tv-banner.ps1')
