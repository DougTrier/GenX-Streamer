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

# Clean-Windows launch check for the portable ZIP (T081; owner request, October 23, 2026).
# Runs inside Windows Sandbox (a disposable clean Windows; the host changes nothing):
#   - extracts the ZIP to a folder with spaces and Unicode characters, and to a
#     write-protected folder;
#   - launches GenX from each as a standard user (runas /trustlevel:0x20000);
#   - records whether it stayed open with a window, where data and WebView2 went,
#     a screenshot, and whether an ordinary close ended it;
#   - writes results.json to the results folder and shuts the sandbox down.
#
#   pwsh -NoProfile -File scripts/windows-sandbox-launch-check.ps1 -Zip <zip> -Out <new folder>
param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Out) { throw 'Output folder already exists; choose a new one.' }
$zipPath = (Resolve-Path -LiteralPath $Zip).Path
$input = Join-Path $Out 'input'
$results = Join-Path $Out 'results'
New-Item -ItemType Directory -Path $input, $results | Out-Null
Copy-Item -LiteralPath $zipPath -Destination (Join-Path $input 'GenX.zip')

$inner = @'
$ErrorActionPreference = 'Continue'
$in = 'C:\genx-input'; $out = 'C:\genx-results'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$report = [ordered]@{ started = (Get-Date).ToString('o'); user = $env:USERNAME;
  userIsAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
  webView2Runtime = [bool](Get-ChildItem 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application' -ErrorAction SilentlyContinue);
  cases = @() }
function Shot($name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $out "$name.png")); $bmp.Dispose()
}
function Check($name, $dir, [switch]$ReadOnly, [switch]$Direct) {
  $case = [ordered]@{ name = $name; folder = $dir; readOnly = [bool]$ReadOnly; standardUser = -not $Direct }
  try {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Expand-Archive -LiteralPath (Join-Path $in 'GenX.zip') -DestinationPath $dir -Force
    if ($ReadOnly) {
      # Deny writes to this user (deny entries override the administrator's allow).
      $case.icacls = (icacls $dir /deny ($env:USERNAME + ':(OI)(CI)(W,AD,WD,DC)') 2>&1 | Out-String).Trim()
      $case.folderWritableByUser = $false
      try { [IO.File]::WriteAllText((Join-Path $dir 'probe.txt'), 'x'); $case.folderWritableByUser = $true } catch {}
    }
    $exe = Join-Path $dir 'GenX Streamer.exe'
    $case.entries = @(Get-ChildItem -LiteralPath $dir | ForEach-Object Name)
    if ($Direct) { Start-Process -FilePath $exe -WorkingDirectory $dir }
    else {
      $runas = Start-Process -FilePath 'runas.exe' -ArgumentList '/trustlevel:0x20000', ('"' + $exe + '"') -PassThru -Wait
      $case.runasExitCode = $runas.ExitCode
    }
    $process = $null
    for ($i = 0; $i -lt 90 -and -not $process; $i++) {
      Start-Sleep -Seconds 1
      $process = Get-Process -Name 'GenX Streamer' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    }
    $case.windowOpened = [bool]$process
    $case.genxProcesses = @(Get-Process -Name 'GenX Streamer' -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ id = $_.Id; window = ($_.MainWindowHandle -ne 0); title = $_.MainWindowTitle } })
    $case.webViewProcesses = @(Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue).Count
    if (-not $process) { Shot ($name + '-no-window') }
    if ($process) {
      Start-Sleep -Seconds 20
      $process.Refresh()
      $case.stillRunningAfter20s = -not $process.HasExited
      $case.windowTitle = $process.MainWindowTitle
      Shot $name
      $case.dataBesideExe = Test-Path -LiteralPath (Join-Path $dir 'data\genx.sqlite3')
      $case.dataFolderEntries = @(Get-ChildItem -LiteralPath (Join-Path $dir 'data') -ErrorAction SilentlyContinue | ForEach-Object Name)
      $case.webViewFolders = @(Get-ChildItem -Path $dir, $env:LOCALAPPDATA, $env:APPDATA -Recurse -Directory -Filter 'EBWebView' -Depth 4 -ErrorAction SilentlyContinue | ForEach-Object FullName)
      $null = $process.CloseMainWindow()
      $case.closedNormally = $process.WaitForExit(30000)
      if ($case.closedNormally) { $case.exitCode = $process.ExitCode }
      else { Stop-Process -Id $process.Id -Force; $case.forcedAfterTimeout = $true }
    }
  } catch { $case.error = $_.Exception.Message }
  $script:report.cases += $case
}
Check 'spaces-unicode-direct' 'C:\Users\Public\GenX direct\Ünïcødé 测试 ñ\GenX Streamer' -Direct
Get-Process -Name 'GenX Streamer' -ErrorAction SilentlyContinue | Stop-Process -Force
Check 'spaces-unicode' 'C:\Users\Public\GenX test folder\Ünïcødé 测试 ñ\GenX Streamer'
Get-Process -Name 'GenX Streamer' -ErrorAction SilentlyContinue | Stop-Process -Force
Check 'read-only' 'C:\Users\Public\GenX read only\GenX Streamer' -ReadOnly
$report.finished = (Get-Date).ToString('o')
$report | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 (Join-Path $out 'results.json')
'done' | Out-File -Encoding ascii (Join-Path $out 'done.txt')
shutdown.exe /s /t 5
'@
# Windows PowerShell 5.1 reads UTF-8 scripts correctly only with a BOM.
[IO.File]::WriteAllText((Join-Path $input 'inner.ps1'), $inner, (New-Object Text.UTF8Encoding $true))

$config = @"
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder><HostFolder>$input</HostFolder><SandboxFolder>C:\genx-input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$results</HostFolder><SandboxFolder>C:\genx-results</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\genx-input\inner.ps1</Command></LogonCommand>
</Configuration>
"@
$wsb = Join-Path $Out 'launch-check.wsb'
Set-Content -LiteralPath $wsb -Value $config -Encoding utf8
Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsSandbox.exe') -ArgumentList ('"' + $wsb + '"')
$deadline = (Get-Date).AddMinutes(15)
while (-not (Test-Path -LiteralPath (Join-Path $results 'done.txt')) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
if (-not (Test-Path -LiteralPath (Join-Path $results 'done.txt'))) { Write-Output 'INCOMPLETE: no results within 15 minutes'; exit 3 }
Get-Content -LiteralPath (Join-Path $results 'results.json') -Raw
