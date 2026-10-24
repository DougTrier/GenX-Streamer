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
    [ValidateSet('x86_64','aarch64','armv7','armeabi-v7a')][string]$Architecture = 'x86_64',
    [string]$SdkRoot = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }),
    [string]$JdkRoot = 'C:\Program Files\Android\Android Studio\jbr',
    [string]$NdkVersion = '28.2.13676358',
    [switch]$UseExistingSharedBuild,
    [ValidateSet(0,2)][int]$Optimization = 0,
    [switch]$CleanApkPackaging,
    # A signed release APK (docs/release-signing.md): Rust release profile,
    # Gradle release, signed with the key named by GENX_RELEASE_SIGNING (a
    # properties file outside the repository), and its certificate must be
    # the one RELEASE_CERTIFICATE_SHA256 names.
    [switch]$Release,
    # Only to prove the release pipeline with a throwaway key: skips the
    # official-certificate match and says the APK is NOT an official release.
    [switch]$PipelineTest
)
$ErrorActionPreference = 'Stop'
function Get-TmgAndroidRoute([string]$RequestedArchitecture) {
    switch ($RequestedArchitecture) {
        'x86_64' { return @{ Target='x86_64-linux-android'; Abi='x86_64'; GradleArch='X86_64'; TauriTarget='x86_64'; Compiler='x86_64-linux-android24-clang.cmd'; CargoKey='X86_64_LINUX_ANDROID'; CcKey='x86_64_linux_android' } }
        'aarch64' { return @{ Target='aarch64-linux-android'; Abi='arm64-v8a'; GradleArch='Arm64'; TauriTarget='aarch64'; Compiler='aarch64-linux-android24-clang.cmd'; CargoKey='AARCH64_LINUX_ANDROID'; CcKey='aarch64_linux_android' } }
        { $_ -in @('armv7','armeabi-v7a') } { return @{ Target='armv7-linux-androideabi'; Abi='armeabi-v7a'; GradleArch='Arm'; TauriTarget='armv7'; Compiler='armv7a-linux-androideabi24-clang.cmd'; CargoKey='ARMV7_LINUX_ANDROIDEABI'; CcKey='armv7_linux_androideabi' } }
        default { throw 'Unsupported Android architecture; packaging refused' }
    }
}
function Get-TmgDevelopmentProfile([int]$Level) {
    if ($Level -notin @(0,2)) { throw 'Unsupported development optimization; packaging refused' }
    return [ordered]@{ schemaVersion=1; profile='dev'; optimization=$Level; debug=2; debugAssertions=$true; overflowChecks=$true; gradle='Debug'; jniDebug=$true; stripped=$false }
}
function Assert-TmgCleanBuildPath([string]$AndroidRoot) {
    $root = [IO.Path]::GetFullPath($AndroidRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $app = [IO.Path]::GetFullPath((Join-Path $root 'app'))
    $build = [IO.Path]::GetFullPath((Join-Path $app 'build'))
    if (!(Test-Path -LiteralPath $app -PathType Container) -or
        !($build.StartsWith($app + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'Android clean containment failed; packaging refused'
    }
    # Resolve every existing ancestor: Gradle must never clean through a junction.
    $cursor = $build
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Android clean reparse path refused' }
            if ($cursor -eq $build -and !$item.PSIsContainer) { throw 'Android clean build path is not a directory' }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    return $build
}
function Get-TmgCompilerFlags([string]$Line) {
    # Only fixed compiler flag tokens leave verbose compiler output. No commands,
    # environment values, filesystem locations or source text are persisted here.
    if ($Line -notmatch '(?i)(rustc|clang)') { return }
    $flags = @([regex]::Matches($Line, '(?<![A-Za-z0-9_-])(?:-C[ =]+(?:opt-level=[0-3sz]|debuginfo=[012]|debug-assertions=(?:on|off)|overflow-checks=(?:on|off))|-O[0123sz]|-g(?:dwarf-[2345])?|-fPIC)(?![A-Za-z0-9_-])') | ForEach-Object { $_.Value -replace '\s+', ' ' } | Sort-Object -Unique)
    if ($flags.Count) { return [ordered]@{ compiler= $(if ($Line -match '(?i)rustc') {'rustc'} else {'clang'}); flags=$flags } }
}
function Initialize-TmgEnvironmentProvider {
    param([version]$Version = $PSVersionTable.PSVersion)
    # PowerShell 7.5 introduced present-empty Env entries. Windows PowerShell
    # 5.1 and earlier PowerShell Core cannot restore that state with this API.
    # Refuse BEFORE mutation rather than silently deleting deliberate empties.
    if ($Version -lt [version]'7.5' -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Android environment restoration requires PowerShell 7.5 or newer on Windows'
    }
}
function Set-TmgProcessEnvironmentEntry {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Present,
        [AllowNull()][AllowEmptyString()][string]$Value)
    Initialize-TmgEnvironmentProvider
    $tmgEnvironmentPath = 'Env:' + $Name
    if ($Present) {
        Set-Item -LiteralPath $tmgEnvironmentPath -Value $Value -ErrorAction Stop
        if (!(Test-Path -LiteralPath $tmgEnvironmentPath) -or (Get-Item -LiteralPath $tmgEnvironmentPath).Value -cne $Value) {
            throw 'Android process environment value could not be preserved'
        }
    } else {
        if (Test-Path -LiteralPath $tmgEnvironmentPath) {
            Remove-Item -LiteralPath $tmgEnvironmentPath -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $tmgEnvironmentPath) {
            throw 'Android process environment absence could not be preserved'
        }
    }
}
function Invoke-TmgBuildEnvironment {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Changes,
        [Parameter(Mandatory)][string]$Location, [Parameter(Mandatory)][scriptblock]$Work)
    Initialize-TmgEnvironmentProvider
    $tmgProcessEnvironment = [Collections.Hashtable]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($tmgEntry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $tmgProcessEnvironment[$tmgEntry.Key] = $tmgEntry.Value
    }
    $tmgSavedEnvironment = @{}
    foreach ($tmgName in $Changes.Keys) {
        if ([string]::IsNullOrWhiteSpace($tmgName) -or $tmgName.Contains('=') -or $tmgName.Contains([char]0)) {
            throw 'Android environment key invalid; build refused'
        }
        $tmgPresent = $tmgProcessEnvironment.Contains($tmgName)
        $tmgSavedEnvironment[$tmgName] = @{ Present=$tmgPresent; Value=$(if ($tmgPresent) { [string]$tmgProcessEnvironment[$tmgName] } else { $null }) }
    }
    $tmgLocationPushed = $false
    try {
        # Full capture precedes the first mutation and Push-Location.
        foreach ($tmgName in $Changes.Keys) {
            Set-TmgProcessEnvironmentEntry -Name $tmgName -Present ($null -ne $Changes[$tmgName]) -Value $Changes[$tmgName]
        }
        Push-Location -LiteralPath $Location
        $tmgLocationPushed = $true
        & $Work
    } finally {
        try { if ($tmgLocationPushed) { Pop-Location } }
        finally {
            $tmgRestoreFailed = $false
            foreach ($tmgName in $tmgSavedEnvironment.Keys) {
                try {
                    $tmgSaved = $tmgSavedEnvironment[$tmgName]
                    Set-TmgProcessEnvironmentEntry -Name $tmgName -Present $tmgSaved.Present -Value $tmgSaved.Value
                } catch { $tmgRestoreFailed = $true }
            }
            if ($tmgRestoreFailed) { throw 'Android process environment restoration failed' }
        }
    }
}

$tmgRoute = Get-TmgAndroidRoute $Architecture
$tmgRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$tmgAndroid = Join-Path $tmgRepo 'src-tauri/gen/android'
$tmgNdk = Join-Path $SdkRoot "ndk/$NdkVersion"
foreach ($tmgRequiredPath in @($tmgAndroid, $tmgNdk, (Join-Path $JdkRoot 'bin/java.exe'))) {
    if (!(Test-Path -LiteralPath $tmgRequiredPath)) { throw "Missing Android build prerequisite: $tmgRequiredPath" }
}
$tmgToolchain = Join-Path $tmgNdk 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$tmgLinker = Join-Path $tmgToolchain $tmgRoute.Compiler
$tmgArchiver = Join-Path $tmgToolchain 'llvm-ar.exe'
foreach ($tmgTool in @($tmgLinker, $tmgArchiver)) {
    if (!(Test-Path -LiteralPath $tmgTool -PathType Leaf)) { throw 'Selected Android NDK toolchain is missing; packaging refused' }
}
$tmgInstalledTargets = @(& rustup target list --installed)
if ($LASTEXITCODE -ne 0) { throw 'Rust target inspection failed; packaging refused' }
if ($tmgRoute.Target -notin $tmgInstalledTargets) { throw "Rust target $($tmgRoute.Target) is not installed; no build or download performed" }
$tmgTarget = $tmgRoute.Target
$tmgAbi = $tmgRoute.Abi
$tmgGradleArch = $tmgRoute.GradleArch
$tmgProfile = if ($Release) { [ordered]@{ schemaVersion=1; profile='release'; gradle='Release' } } else { Get-TmgDevelopmentProfile $Optimization }
$tmgVariant = if ($Release) { 'Release' } else { 'Debug' }
$tmgSigning = $null
if ($Release) {
    $tmgSigning = $env:GENX_RELEASE_SIGNING
    if ([string]::IsNullOrWhiteSpace($tmgSigning) -or !(Test-Path -LiteralPath $tmgSigning -PathType Leaf)) {
        throw 'Release signing file missing: set GENX_RELEASE_SIGNING to the properties file beside your release key (docs/release-signing.md)'
    }
    $tmgSigning = [IO.Path]::GetFullPath($tmgSigning)
    $tmgRepoFull = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if ($tmgSigning.StartsWith($tmgRepoFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release signing file must be outside the repository; build refused'
    }
}
$tmgBuildEnvironment = [ordered]@{
    JAVA_HOME = $JdkRoot
    ANDROID_HOME = $SdkRoot
    NDK_HOME = $tmgNdk
    CARGO_NET_OFFLINE = 'true'
    TAURI_ANDROID_PROJECT_PATH = $tmgAndroid
    TAURI_ENV_DEBUG = $(if ($Release) { 'false' } else { 'true' })
    WRY_ANDROID_PACKAGE = 'com.tmg.tv'
    WRY_ANDROID_LIBRARY = 'tmg_tv_lib'
    WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION = "override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean { return com.tmg.tv.RendererRecoveryBridge.gone(view) }"
    WRY_ANDROID_KOTLIN_FILES_OUT_DIR = (Join-Path $tmgAndroid 'app/src/main/java/com/tmg/tv/generated')
    CARGO_PROFILE_DEV_OPT_LEVEL = [string]$Optimization
    CARGO_PROFILE_DEV_DEBUG = '2'
    CARGO_PROFILE_DEV_DEBUG_ASSERTIONS = 'true'
    CARGO_PROFILE_DEV_OVERFLOW_CHECKS = 'true'
    CARGO_PROFILE_DEV_STRIP = 'none'
    CC_ENABLE_DEBUG_OUTPUT = $(if ($Optimization -eq 2) { '1' } else { $null })
}
$tmgBuildEnvironment["CARGO_TARGET_$($tmgRoute.CargoKey)_LINKER"] = $tmgLinker
$tmgBuildEnvironment["CC_$($tmgRoute.CcKey)"] = $tmgLinker
$tmgBuildEnvironment["AR_$($tmgRoute.CcKey)"] = $tmgArchiver
# wry writes generated Kotlin here and requires the folder to exist; git keeps
# no empty folders, so a fresh clone lacks it.
New-Item -ItemType Directory -Force -Path $tmgBuildEnvironment['WRY_ANDROID_KOTLIN_FILES_OUT_DIR'] | Out-Null
$tmgStage = 'shared-build'
Invoke-TmgBuildEnvironment -Changes $tmgBuildEnvironment -Location $tmgRepo -Work {
Write-Output ('Development profile ' + ($tmgProfile | ConvertTo-Json -Compress))
try {
    if (!$UseExistingSharedBuild) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Shared application build failed' }
    }
    if (!(Test-Path -LiteralPath (Join-Path $tmgRepo 'dist/index.html'))) { throw 'Validated shared assets are missing' }
    & (Join-Path $PSScriptRoot 'sync-launcher-icons.ps1')
    function Get-TmgDistFingerprint {
        $tmgRows = Get-ChildItem -LiteralPath (Join-Path $tmgRepo 'dist') -File -Recurse | Sort-Object FullName | ForEach-Object {
            "$($_.FullName.Substring($tmgRepo.Length)):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
        }
        $tmgHasher = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($tmgHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($tmgRows -join "`n")))).Replace('-', '') }
        finally { $tmgHasher.Dispose() }
    }
    $tmgDistFingerprint = Get-TmgDistFingerprint
    Write-Output "Shared assets SHA256 $tmgDistFingerprint"
    $tmgStage = 'native-build'
    $tmgCargoArguments = @('build','--locked','--offline','--manifest-path','src-tauri/Cargo.toml','--target',$tmgTarget,'--features','tauri/custom-protocol')
    if ($Release) { $tmgCargoArguments += '--release' }
    if ($Optimization -eq 2 -and !$Release) {
        $tmgObserved = [Collections.Generic.HashSet[string]]::new()
        $tmgNativeErrorPreference = $ErrorActionPreference
        try {
            # Windows PowerShell represents native stderr as ErrorRecord objects.
            # Capture it without treating a successful verbose compile as failure.
            $ErrorActionPreference = 'Continue'
            & cargo @tmgCargoArguments -vv 2>&1 | ForEach-Object {
                $flags = Get-TmgCompilerFlags ([string]$_)
                if ($null -ne $flags) {
                    $record = $flags | ConvertTo-Json -Compress
                    if ($tmgObserved.Add($record)) { Write-Output ("Observed compiler flags " + $record) }
                }
                elseif ([string]$_ -match '^\s*(Compiling |Fresh |Finished )') {
                    Write-Output ([string]$_)
                }
                elseif ([string]$_ -match '^\s*(error|warning)(?:\[|:)') {
                    Write-Output ('Compiler diagnostic ' + $Matches[1] + ' (verbose detail redacted)')
                }
            }
        } finally { $ErrorActionPreference = $tmgNativeErrorPreference }
        Write-Output ('Compiler evidence ' + (@{schemaVersion=1;observedRecords=$tmgObserved.Count;cachedFlagsUnobserved=($tmgObserved.Count -eq 0)} | ConvertTo-Json -Compress))
    } else { & cargo @tmgCargoArguments }
    if ($LASTEXITCODE -ne 0) { throw 'Android native compilation failed; no APK packaging performed' }
    if ((Get-TmgDistFingerprint) -ne $tmgDistFingerprint) { throw 'Shared assets changed during compilation; APK packaging refused' }
    $tmgLibrary = Join-Path $tmgRepo "src-tauri/target/$tmgTarget/$($tmgVariant.ToLower())/libtmg_tv_lib.so"
    if (!(Test-Path -LiteralPath $tmgLibrary -PathType Leaf)) { throw 'Native compilation did not produce its required library' }
    $tmgJni = Join-Path $tmgAndroid "app/src/main/jniLibs/$tmgAbi"
    New-Item -ItemType Directory -Path $tmgJni -Force | Out-Null
    $tmgDestination = Join-Path $tmgJni 'libtmg_tv_lib.so'
    Copy-Item -LiteralPath $tmgLibrary -Destination $tmgDestination -Force
    if ((Get-FileHash -LiteralPath $tmgLibrary).Hash -ne (Get-FileHash -LiteralPath $tmgDestination).Hash) { throw 'Native library copy verification failed' }
    Push-Location -LiteralPath $tmgAndroid
    try {
        $tmgStage = 'gradle-clean'
        if ($CleanApkPackaging) {
            Assert-TmgCleanBuildPath $tmgAndroid | Out-Null
            & ./gradlew.bat ':app:clean' --console=plain
            if ($LASTEXITCODE -ne 0) { throw 'Android Gradle clean failed; packaging refused' }
        }
        $tmgStage = 'gradle-package'
        # Explicit compiled-library copy avoids Windows symlink privilege requirements.
        # Excluding the Rust task is safe only after the checked compile+hash match above.
        $tmgGradleArguments = @(":app:assemble${tmgGradleArch}$tmgVariant", '-x', ":app:rustBuild${tmgGradleArch}$tmgVariant", "-PabiList=$tmgAbi", "-ParchList=$($tmgGradleArch.ToLower())", "-PtargetList=$($tmgRoute.TauriTarget)", '--console=plain')
        if ($Release) { $tmgGradleArguments += "-PgenxSigning=$tmgSigning" }
        & ./gradlew.bat @tmgGradleArguments
        if ($LASTEXITCODE -ne 0) { throw 'Android Gradle packaging failed' }
        $tmgApk = Join-Path $tmgAndroid "app/build/outputs/apk/$($tmgGradleArch.ToLower())/$($tmgVariant.ToLower())/app-$($tmgGradleArch.ToLower())-$($tmgVariant.ToLower()).apk"
        if (!(Test-Path -LiteralPath $tmgApk -PathType Leaf)) { throw 'Gradle did not produce its required APK' }
        $tmgAapt2 = Join-Path $SdkRoot 'build-tools/36.0.0/aapt2.exe'
        if (!(Test-Path -LiteralPath $tmgAapt2 -PathType Leaf)) { throw 'Android TV package guard requires SDK build-tools 36.0.0' }
        & python -B -X utf8 (Join-Path $tmgRepo 'scripts/check-android-tv.py') --apk $tmgApk --aapt2 $tmgAapt2
        if ($LASTEXITCODE -ne 0) { throw 'Android TV launcher/package metadata verification failed' }
        if ($Release) {
            # The APK's certificate must be the official one GenX checks itself against.
            $tmgApksigner = Join-Path $SdkRoot 'build-tools/36.0.0/apksigner.bat'
            $tmgCerts = @(& $tmgApksigner verify --print-certs $tmgApk 2>&1 | ForEach-Object { [string]$_ })
            if ($LASTEXITCODE -ne 0) { throw 'Release APK signature verification failed' }
            $tmgSigners = @($tmgCerts | Where-Object { $_ -match 'certificate SHA-256 digest: ([0-9a-f]{64})' } | ForEach-Object { $Matches[1] })
            $tmgIdentity = Get-Content -Raw -LiteralPath (Join-Path $tmgRepo 'src-tauri/src/platform/app_identity.rs')
            if ($tmgIdentity -notmatch 'RELEASE_CERTIFICATE_SHA256: &str = "([0-9a-f]*)"') { throw 'Release certificate constant not found' }
            $tmgOfficial = $Matches[1]
            $tmgMatches = $tmgSigners.Count -eq 1 -and $tmgOfficial.Length -eq 64 -and $tmgSigners[0] -eq $tmgOfficial
            if (!$tmgMatches -and !$PipelineTest) {
                throw 'The release APK is not signed with the certificate RELEASE_CERTIFICATE_SHA256 names; build refused'
            }
            Write-Output ('Release signing ' + (@{schemaVersion=1;signerSha256=$tmgSigners;official=$tmgMatches;pipelineTest=[bool]$PipelineTest} | ConvertTo-Json -Compress))
        }
        Get-FileHash -LiteralPath $tmgApk -Algorithm SHA256
    } finally { Pop-Location }
} catch {
    Write-Output ('Android packaging failure ' + (@{schemaVersion=1;stage=$tmgStage;optimization=$Optimization;cleanApkPackaging=[bool]$CleanApkPackaging;status='failed'} | ConvertTo-Json -Compress))
    throw
}
}
