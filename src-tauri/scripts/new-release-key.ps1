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

# Creates GenX Streamer's Android release key, ONCE, for the owner to run in
# their own terminal (docs/release-signing.md). The password is asked here and
# never appears on screen, in a command line or in a log: keytool reads it from
# a process-only environment variable that is removed afterwards.
#
# It writes, in a folder OUTSIDE the repository:
#   genx-release.jks     the key (back it up in two places, with the password)
#   signing.properties   what the release build reads (locked to your account)
#   fingerprint.txt      the certificate's public SHA-256 fingerprint
# It refuses to overwrite an existing key: a release key is created once.
param(
    [string]$Folder = 'D:\GenX-Release',
    [string]$Alias = 'genx-release',
    [string]$Name = 'CN=Doug Trier, O=GenX Streamer',
    [string]$JdkRoot = 'C:\Program Files\Android\Android Studio\jbr'
)
$ErrorActionPreference = 'Stop'
$keytool = Join-Path $JdkRoot 'bin\keytool.exe'
if (!(Test-Path -LiteralPath $keytool -PathType Leaf)) { throw "keytool not found at $keytool (set -JdkRoot)" }

$folderPath = [IO.Path]::GetFullPath($Folder)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ($folderPath.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The release key must live outside the repository. Choose another -Folder.'
}
$keystore = Join-Path $folderPath 'genx-release.jks'
$properties = Join-Path $folderPath 'signing.properties'
if ((Test-Path -LiteralPath $keystore) -or (Test-Path -LiteralPath $properties)) {
    throw "A release key already exists in $folderPath. It is never overwritten; use it, or choose another folder."
}
New-Item -ItemType Directory -Force -Path $folderPath | Out-Null

Write-Host ''
Write-Host 'GenX Streamer release key' -ForegroundColor Cyan
Write-Host "Folder: $folderPath"
Write-Host 'Choose a strong password (at least 12 characters). You will need it for every release.'
$first = Read-Host -AsSecureString 'Password'
$second = Read-Host -AsSecureString 'Repeat the password'
$plain = [Net.NetworkCredential]::new('', $first).Password
if ($plain -cne [Net.NetworkCredential]::new('', $second).Password) { throw 'The two passwords differ; nothing was created.' }
if ($plain.Length -lt 12) { throw 'The password is shorter than 12 characters; nothing was created.' }
if ($plain -match '[\r\n]') { throw 'The password cannot contain line breaks; nothing was created.' }

$env:GENX_RELEASE_KEY_PASSWORD = $plain
try {
    & $keytool -genkeypair -keystore $keystore -alias $Alias -keyalg RSA -keysize 4096 -validity 36500 `
        -dname $Name -storetype PKCS12 -storepass:env GENX_RELEASE_KEY_PASSWORD -keypass:env GENX_RELEASE_KEY_PASSWORD
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $keystore)) { throw 'keytool could not create the key.' }
    $listing = & $keytool -list -v -keystore $keystore -alias $Alias -storepass:env GENX_RELEASE_KEY_PASSWORD
    if ($LASTEXITCODE -ne 0) { throw 'keytool could not read the new key.' }
} finally {
    Remove-Item Env:GENX_RELEASE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
$line = $listing | Where-Object { $_ -match 'SHA256:\s*([0-9A-Fa-f:]{95})' } | Select-Object -First 1
if (!$line) { throw 'The new key has no SHA-256 fingerprint in keytool output.' }
$fingerprint = ($Matches[1] -replace ':', '').ToLowerInvariant()

# What the release build reads. Java properties treat backslash as an escape,
# so the path uses forward slashes and the password's backslashes are doubled.
$escaped = $plain.Replace('\', '\\')
@(
    "storeFile=$($keystore.Replace('\', '/'))"
    "storePassword=$escaped"
    "keyAlias=$Alias"
    "keyPassword=$escaped"
) | Set-Content -LiteralPath $properties -Encoding ascii
$plain = $null; $escaped = $null
# Only your Windows account may read the signing file.
& icacls $properties /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
$fingerprint | Set-Content -LiteralPath (Join-Path $folderPath 'fingerprint.txt') -Encoding ascii

Write-Host ''
Write-Host 'Created:' -ForegroundColor Green
Write-Host "  $keystore"
Write-Host "  $properties  (readable only by $($env:USERNAME))"
Write-Host ''
Write-Host 'Public SHA-256 fingerprint (safe to share; GenX checks itself against it):' -ForegroundColor Cyan
Write-Host "  $fingerprint"
Write-Host ''
Write-Host 'NOW: back up genx-release.jks and your password in two places (for example an' -ForegroundColor Yellow
Write-Host 'encrypted USB drive and your password manager). If they are lost, no installed copy' -ForegroundColor Yellow
Write-Host 'of GenX Streamer can ever be updated again.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'To build a release, set this in the terminal you build from:'
Write-Host "  `$env:GENX_RELEASE_SIGNING = '$properties'"
