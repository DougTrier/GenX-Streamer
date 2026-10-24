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

# A signed Android release APK (docs/release-signing.md). build-android.ps1
# stays development-only; this script loads its environment helpers (as the
# tooling tests do) and builds in the release profiles.
#
# - universal (default): one APK with both ARM libraries (arm64-v8a and
#   armeabi-v7a), so any ARM phone or TV that receives it can run it
#   (docs/share-links.md SH-010). aarch64: the 64-bit-only APK, for comparison.
# - Signed with the key the GENX_RELEASE_SIGNING properties file names (it
#   must be outside the repository); the APK's certificate must be the one
#   RELEASE_CERTIFICATE_SHA256 names, or the build is refused.
# - -PipelineTest is only for proving the pipeline with a throwaway key: it
#   skips that match and reports the APK as NOT official.
param(
    [ValidateSet('universal','aarch64')][string]$Architecture = 'universal',
    [string]$SdkRoot = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }),
    [string]$JdkRoot = 'C:\Program Files\Android\Android Studio\jbr',
    [string]$NdkVersion = '28.2.13676358',
    [switch]$PipelineTest
)
$ErrorActionPreference = 'Stop'
# The development script's helpers (environment save/restore, routes, clean
# containment), defined here without running its development build.
$tmgTokens = $null; $tmgErrors = $null
$tmgAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'build-android.ps1'), [ref]$tmgTokens, [ref]$tmgErrors)
if ($tmgErrors.Count) { throw 'Development build script could not be read; release refused' }
foreach ($tmgFunction in $tmgAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    . ([scriptblock]::Create($tmgFunction.Extent.Text))
}

$tmgRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$tmgSigning = $env:GENX_RELEASE_SIGNING
if ([string]::IsNullOrWhiteSpace($tmgSigning) -or !(Test-Path -LiteralPath $tmgSigning -PathType Leaf)) {
    throw 'Release signing file missing: set GENX_RELEASE_SIGNING to the properties file beside your release key (docs/release-signing.md)'
}
$tmgSigning = [IO.Path]::GetFullPath($tmgSigning)
if ($tmgSigning.StartsWith([IO.Path]::GetFullPath($tmgRepo), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Release signing file must be outside the repository; build refused'
}
$tmgRoutes = @(if ($Architecture -eq 'universal') { Get-TmgAndroidRoute 'aarch64'; Get-TmgAndroidRoute 'armv7' } else { Get-TmgAndroidRoute 'aarch64' })
$tmgFlavor = if ($Architecture -eq 'universal') { 'Universal' } else { 'Arm64' }
$tmgAndroid = Join-Path $tmgRepo 'src-tauri/gen/android'
$tmgNdk = Join-Path $SdkRoot "ndk/$NdkVersion"
foreach ($tmgRequiredPath in @($tmgAndroid, $tmgNdk, (Join-Path $JdkRoot 'bin/java.exe'))) {
    if (!(Test-Path -LiteralPath $tmgRequiredPath)) { throw "Missing Android build prerequisite: $tmgRequiredPath" }
}
$tmgToolchain = Join-Path $tmgNdk 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$tmgArchiver = Join-Path $tmgToolchain 'llvm-ar.exe'
$tmgInstalledTargets = @(& rustup target list --installed)
if ($LASTEXITCODE -ne 0) { throw 'Rust target inspection failed; packaging refused' }
$tmgBuildEnvironment = [ordered]@{
    JAVA_HOME = $JdkRoot
    ANDROID_HOME = $SdkRoot
    NDK_HOME = $tmgNdk
    CARGO_NET_OFFLINE = 'true'
    TAURI_ANDROID_PROJECT_PATH = $tmgAndroid
    TAURI_ENV_DEBUG = 'false'
    WRY_ANDROID_PACKAGE = 'com.tmg.tv'
    WRY_ANDROID_LIBRARY = 'tmg_tv_lib'
    WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION = "override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean { return com.tmg.tv.RendererRecoveryBridge.gone(view) }"
    WRY_ANDROID_KOTLIN_FILES_OUT_DIR = (Join-Path $tmgAndroid 'app/src/main/java/com/tmg/tv/generated')
}
foreach ($tmgRoute in $tmgRoutes) {
    if ($tmgRoute.Target -notin $tmgInstalledTargets) { throw "Rust target $($tmgRoute.Target) is not installed; no build or download performed" }
    $tmgLinker = Join-Path $tmgToolchain $tmgRoute.Compiler
    foreach ($tmgTool in @($tmgLinker, $tmgArchiver)) {
        if (!(Test-Path -LiteralPath $tmgTool -PathType Leaf)) { throw 'Selected Android NDK toolchain is missing; packaging refused' }
    }
    $tmgBuildEnvironment["CARGO_TARGET_$($tmgRoute.CargoKey)_LINKER"] = $tmgLinker
    $tmgBuildEnvironment["CC_$($tmgRoute.CcKey)"] = $tmgLinker
    $tmgBuildEnvironment["AR_$($tmgRoute.CcKey)"] = $tmgArchiver
}
New-Item -ItemType Directory -Force -Path $tmgBuildEnvironment['WRY_ANDROID_KOTLIN_FILES_OUT_DIR'] | Out-Null
$tmgStage = 'shared-build'
Invoke-TmgBuildEnvironment -Changes $tmgBuildEnvironment -Location $tmgRepo -Work {
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Shared application build failed' }
    & (Join-Path $PSScriptRoot 'sync-launcher-icons.ps1')
    # The Android version, as Tauri's own build writes it (app/tauri.properties
    # is not committed): versionName from tauri.conf.json, versionCode
    # major*1000000 + minor*1000 + patch, so every release updates the last.
    $tmgVersion = [version]((Get-Content -Raw -LiteralPath (Join-Path $tmgRepo 'src-tauri/tauri.conf.json') | ConvertFrom-Json).version)
    $tmgVersionCode = $tmgVersion.Major * 1000000 + $tmgVersion.Minor * 1000 + $tmgVersion.Build
    if ($tmgVersionCode -lt 1) { throw 'The app version must be x.y.z and above 0.0.0' }
    @("tauri.android.versionName=$($tmgVersion.ToString(3))", "tauri.android.versionCode=$tmgVersionCode") |
        Set-Content -LiteralPath (Join-Path $tmgAndroid 'app/tauri.properties') -Encoding ascii
    foreach ($tmgRoute in $tmgRoutes) {
        $tmgStage = "native-build-$($tmgRoute.Abi)"
        & cargo build --locked --offline --release --manifest-path src-tauri/Cargo.toml --target $tmgRoute.Target --features tauri/custom-protocol
        if ($LASTEXITCODE -ne 0) { throw 'Android native compilation failed; no APK packaging performed' }
        $tmgLibrary = Join-Path $tmgRepo "src-tauri/target/$($tmgRoute.Target)/release/libtmg_tv_lib.so"
        $tmgJni = Join-Path $tmgAndroid "app/src/main/jniLibs/$($tmgRoute.Abi)"
        New-Item -ItemType Directory -Path $tmgJni -Force | Out-Null
        $tmgDestination = Join-Path $tmgJni 'libtmg_tv_lib.so'
        Copy-Item -LiteralPath $tmgLibrary -Destination $tmgDestination -Force
        if ((Get-FileHash -LiteralPath $tmgLibrary).Hash -ne (Get-FileHash -LiteralPath $tmgDestination).Hash) { throw 'Native library copy verification failed' }
    }
    Push-Location -LiteralPath $tmgAndroid
    try {
        $tmgStage = 'gradle-package'
        # The Rust libraries were built and copied above; Gradle packages them.
        & ./gradlew.bat ":app:assemble${tmgFlavor}Release" '-x' ":app:rustBuild${tmgFlavor}Release" "-PabiList=$(($tmgRoutes | ForEach-Object { $_.Abi }) -join ',')" "-ParchList=$(($tmgRoutes | ForEach-Object { $_.GradleArch.ToLower() }) -join ',')" "-PtargetList=$(($tmgRoutes | ForEach-Object { $_.TauriTarget }) -join ',')" "-PgenxSigning=$tmgSigning" '--console=plain'
        if ($LASTEXITCODE -ne 0) { throw 'Android Gradle packaging failed' }
        $tmgApk = Join-Path $tmgAndroid "app/build/outputs/apk/$($tmgFlavor.ToLower())/release/app-$($tmgFlavor.ToLower())-release.apk"
        if (!(Test-Path -LiteralPath $tmgApk -PathType Leaf)) { throw 'Gradle did not produce its required APK' }
        $tmgStage = 'verify'
        $tmgAapt2 = Join-Path $SdkRoot 'build-tools/36.0.0/aapt2.exe'
        & python -B -X utf8 (Join-Path $tmgRepo 'scripts/check-android-tv.py') --apk $tmgApk --aapt2 $tmgAapt2
        if ($LASTEXITCODE -ne 0) { throw 'Android TV launcher/package metadata verification failed' }
        # SH-010: every architecture this APK claims is really inside it.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $tmgZip = [IO.Compression.ZipFile]::OpenRead($tmgApk)
        try { $tmgEntries = @($tmgZip.Entries | ForEach-Object { $_.FullName }) } finally { $tmgZip.Dispose() }
        foreach ($tmgRoute in $tmgRoutes) {
            if ("lib/$($tmgRoute.Abi)/libtmg_tv_lib.so" -notin $tmgEntries) { throw "Release APK lacks its $($tmgRoute.Abi) library; build refused" }
        }
        $tmgApksigner = Join-Path $SdkRoot 'build-tools/36.0.0/apksigner.bat'
        $tmgCerts = @(& $tmgApksigner verify --print-certs $tmgApk 2>&1 | ForEach-Object { [string]$_ })
        if ($LASTEXITCODE -ne 0) { throw 'Release APK signature verification failed' }
        $tmgSigners = @($tmgCerts | Where-Object { $_ -match 'certificate SHA-256 digest: ([0-9a-f]{64})' } | ForEach-Object { $Matches[1] })
        $tmgIdentity = Get-Content -Raw -LiteralPath (Join-Path $tmgRepo 'src-tauri/src/platform/app_identity.rs')
        if ($tmgIdentity -notmatch 'RELEASE_CERTIFICATE_SHA256: &str\s*=\s*"([0-9a-f]*)"') { throw 'Release certificate constant not found' }
        $tmgOfficial = $Matches[1]
        $tmgIsOfficial = $tmgSigners.Count -eq 1 -and $tmgOfficial.Length -eq 64 -and $tmgSigners[0] -eq $tmgOfficial
        if (!$tmgIsOfficial -and !$PipelineTest) {
            throw 'The release APK is not signed with the certificate RELEASE_CERTIFICATE_SHA256 names; build refused'
        }
        $tmgBytes = (Get-Item -LiteralPath $tmgApk).Length
        Write-Output ('Release APK ' + (@{schemaVersion=1;architecture=$Architecture;abis=@($tmgRoutes | ForEach-Object { $_.Abi });bytes=$tmgBytes;signerSha256=$tmgSigners;official=$tmgIsOfficial;pipelineTest=[bool]$PipelineTest} | ConvertTo-Json -Compress))
        Get-FileHash -LiteralPath $tmgApk -Algorithm SHA256
    } finally { Pop-Location }
} catch {
    Write-Output ('Android release failure ' + (@{schemaVersion=1;stage=$tmgStage;architecture=$Architecture;status='failed'} | ConvertTo-Json -Compress))
    throw
}
}
