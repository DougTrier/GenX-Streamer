param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[a-z0-9_-]{3,64}$' -or $Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid crate identity' }
$tmgRelative = if ($Name.Length -eq 3) { "3/$($Name[0])/$Name" } else { "$($Name.Substring(0,2))/$($Name.Substring(2,2))/$Name" }
$tmgRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$tmgOutput = Join-Path $tmgRepo "artifacts/toolchains/$Name-index.jsonl"
$tmgIndex = Invoke-WebRequest -Uri "https://index.crates.io/$tmgRelative" -TimeoutSec 30
[IO.File]::WriteAllText($tmgOutput, $tmgIndex.Content)
$tmgRecord = $tmgIndex.Content.Split("`n") | ForEach-Object { if ($_) { $_ | ConvertFrom-Json } } | Where-Object vers -eq $Version
if (!$tmgRecord -or $tmgRecord.yanked) { throw 'Version absent or withdrawn' }
$tmgArchive = Join-Path $tmgRepo "artifacts/toolchains/$Name-$Version.crate"
Invoke-WebRequest -Uri "https://static.crates.io/crates/$Name/$Name-$Version.crate" -OutFile $tmgArchive -TimeoutSec 60
if ((Get-FileHash -LiteralPath $tmgArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $tmgRecord.cksum) { throw 'Publisher checksum mismatch' }
$tmgCargoRoot = $env:CARGO_HOME
if (!$tmgCargoRoot) { $tmgCargoRoot = Join-Path $env:USERPROFILE '.cargo' }
$tmgCache = Join-Path $tmgCargoRoot 'registry/cache/index.crates.io-1949cf8c6b5b557f'
$tmgIndexCache = Join-Path $tmgCargoRoot "registry/index/index.crates.io-1949cf8c6b5b557f/.cache/$tmgRelative"
Copy-Item -LiteralPath $tmgArchive -Destination (Join-Path $tmgCache "$Name-$Version.crate")
@'
import json, pathlib, sys
source,target=sys.argv[1:]
payload=bytearray(b'\x03\x02\x00\x00\x00etag: "verified-official-index"\x00')
for line in pathlib.Path(source).read_text(encoding='utf-8-sig').splitlines():
    row=json.loads(line)
    payload.extend(row['vers'].encode()+b'\x00'+line.encode()+b'\x00')
path=pathlib.Path(target)
path.parent.mkdir(parents=True,exist_ok=True)
path.write_bytes(payload)
'@ | python - $tmgOutput $tmgIndexCache
if ($LASTEXITCODE -ne 0) { throw 'Index cache population failed' }
Write-Output "$Name $Version SHA256 $($tmgRecord.cksum) verified against official sparse index"
