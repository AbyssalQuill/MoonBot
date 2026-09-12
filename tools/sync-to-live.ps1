# Sync this session's QQ-Bridge changes into the 4 runtime copies.
# NOTE: keep this file ASCII-only -- Windows PowerShell 5.1 reads .ps1 as GBK and CJK literals break parsing.
#   live    : D:\MoonBot\resources\runtime           (the actually running runtime: manager + DSH + bridge)
#   payload : QQ-Bridge-packaging\moonbot-app\runtime-full  (electron-builder full variant)
#             QQ-Bridge-packaging\moonbot-app\runtime-src   (core variant: manager only)
#             QQ-Bridge-packaging\full\app                  (legacy NSIS payload)
$ErrorActionPreference = 'Stop'

$srcBridge = 'C:\Users\17367\Desktop\MoonBot Public\qq-bridge'
$srcMgr    = 'C:\Users\17367\Desktop\MoonBot Public'

# Sync the whole src/ and tools/ trees: the invariant we want is "live src == source src, byte for byte".
# That beats maintaining a per-change file list (miss one file and production silently runs old code).
# 2026-09-12: added 'dsh' -- the agent presets (persona / WAKE TYPES / RULES) live under qq-bridge/dsh,
# and the bridge installs them into the isolated DSH home at startup. Without this, preset edits
# never reach the running install (found the hard way: live preset hash stayed old).
# 2026-09-12 (later): added 'scripts' and 'plugins' -- qq-bridge/plugins (dsh-qq-hold, qq-mode-console)
# is loaded at runtime but was NEVER in the sync list, and scripts/ (setup-dsh, check-*) had drifted too.
$bridgeDirs = @('src', 'tools', 'dsh', 'scripts', 'plugins')

$bridgeDests = @(
  'D:\MoonBot\resources\runtime\qq-bridge',
  'C:\Users\17367\Desktop\QQ-Bridge-packaging\moonbot-app\runtime-full\qq-bridge',
  'C:\Users\17367\Desktop\QQ-Bridge-packaging\full\app\qq-bridge',
  'C:\Users\17367\Desktop\QQ-Bridge-packaging\moonbot-app\dist-eb\win-unpacked\resources\runtime\qq-bridge'
)

$mgrDests = @(
  'D:\MoonBot\resources\runtime',
  'C:\Users\17367\Desktop\QQ-Bridge-packaging\moonbot-app\runtime-full',
  'C:\Users\17367\Desktop\QQ-Bridge-packaging\moonbot-app\runtime-src',
  'C:\Users\17367\Desktop\QQ-Bridge-packaging\full\app',
  # electron-builder intermediate output (win-unpacked): the installer is packed from it, so
  # editing it here is the same as editing the files inside the installer.
  'C:\Users\17367\Desktop\QQ-Bridge-packaging\moonbot-app\dist-eb\win-unpacked\resources\runtime'
)

function Hash8($p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm MD5).Hash.Substring(0,8) } else { 'MISSING' } }

Write-Host '=== 1) bridge src/ + tools/ ==='
foreach ($rel in $bridgeDirs) {
  $from = Join-Path $srcBridge $rel
  if (-not (Test-Path $from)) { Write-Host ("  SKIP (not in source): " + $rel); continue }
  foreach ($d in $bridgeDests) {
    $to = Join-Path $d $rel
    if (-not (Test-Path $to)) { New-Item -ItemType Directory -Force -Path $to | Out-Null }
    # Copy the CONTENTS (src\* -> dest\src). `Copy-Item <dir> <existingDir> -Recurse` would nest it
    # (dest\src\src) and leave the real files untouched -- which silently looked like a successful sync.
    Copy-Item (Join-Path $from '*') $to -Recurse -Force
    $nested = Join-Path $to $rel
    if (Test-Path $nested) { Remove-Item $nested -Recurse -Force }
    Write-Host ("  " + $rel + " -> " + $to)
  }
}

Write-Host '=== 2) manager server/ (whole dir minus node_modules) + dist ==='
$srcServer = Join-Path $srcMgr 'server'
foreach ($d in $mgrDests) {
  $dstServer = Join-Path $d 'server'
  if (-not (Test-Path $dstServer)) { Write-Host ("  SKIP (no server dir): " + $d); continue }
  # Sync the WHOLE server dir: we used to copy only index.js, so sibling files such as deploy.js
  # silently never reached the running install (found that the hard way on 2026-09-12).
  Copy-Item (Join-Path $srcServer '*') $dstServer -Recurse -Force
  Write-Host ("  server/ -> " + $dstServer + "  index=" + (Hash8 (Join-Path $dstServer 'index.js')) + "  deploy=" + (Hash8 (Join-Path $dstServer 'deploy.js')))
}
$srcDist = Join-Path $srcMgr 'dist'
foreach ($d in $mgrDests) {
  $distDir = Join-Path $d 'dist'
  if (-not (Test-Path $distDir)) { Write-Host ("  SKIP (no dist dir): " + $d); continue }
  # hashed bundle names: clear assets first so no stale bundle survives
  $assets = Join-Path $distDir 'assets'
  if (Test-Path $assets) { Remove-Item $assets -Recurse -Force }
  Copy-Item (Join-Path $srcDist 'index.html') (Join-Path $distDir 'index.html') -Force
  Copy-Item (Join-Path $srcDist 'assets') (Join-Path $distDir 'assets') -Recurse -Force
  Write-Host ("  dist -> " + $distDir + "  index=" + (Hash8 (Join-Path $distDir 'index.html')))
}

Write-Host '=== 3) meme pack (whale-fanart-001) ==='
# Whale-girl fan meme pack. Installed at <runtime>/meme, i.e. a SIBLING of qq-bridge --
# mcp-napcat-safe.js resolveMemeRoot() first candidate is ROOT/../meme, all derived
# relative to the install dir (no drive letter / user name assumptions, works on E:\ or
# under another user). 2026-09-13: this directory was never shipped, so the live runtime
# and every installer payload lacked it and qq_whale_meme_search kept answering
# "no meme pack installed" (what the owner saw as the search failure).
$srcMeme = 'C:\Users\17367\Desktop\MoonBot Public\meme'
$memeDests = @()
foreach ($d in $mgrDests) {
  # Only mirror into targets that actually carry qq-bridge (runtime-src is the manager-only
  # core variant and has no bridge, so it needs no meme pack).
  if (Test-Path (Join-Path $d 'qq-bridge')) { $memeDests += $d } else { Write-Host ("  SKIP (no qq-bridge): " + $d) }
}
if (-not (Test-Path $srcMeme)) {
  Write-Host ("  ERROR: source meme dir missing: " + $srcMeme)
} else {
  $srcDb = Join-Path $srcMeme 'whale-fanart-001\index.db'
  $srcN = (Get-ChildItem -LiteralPath $srcMeme -Recurse -File | Measure-Object).Count
  foreach ($d in $memeDests) {
    $to = Join-Path $d 'meme'
    $dstDb = Join-Path $to 'whale-fanart-001\index.db'
    $stale = $true
    if (Test-Path $dstDb) {
      $dstN = (Get-ChildItem -LiteralPath $to -Recurse -File | Measure-Object).Count
      $stale = ((Hash8 $srcDb) -ne (Hash8 $dstDb)) -or ($dstN -ne $srcN)
    }
    if ($stale) {
      # Delete with PowerShell: the pack is full of CJK filenames and Node's fs.rmSync
      # hard-crashes on CJK paths on this machine (0xC0000409).
      if (Test-Path $to) { Remove-Item -LiteralPath $to -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $to | Out-Null
      # Copy the CONTENTS (meme\* -> dest\meme): copying the dir into an existing dir nests it.
      Copy-Item (Join-Path $srcMeme '*') $to -Recurse -Force
      Write-Host ("  copied -> " + $to)
    } else {
      Write-Host ("  up-to-date -> " + $to)
    }
    $n = (Get-ChildItem -LiteralPath $to -Recurse -File | Measure-Object).Count
    $bytes = (Get-ChildItem -LiteralPath $to -Recurse -File | Measure-Object -Property Length -Sum).Sum
    Write-Host ("  meme files=" + $n + " bytes=" + $bytes + " index.db=" + (Hash8 (Join-Path $to 'whale-fanart-001\index.db')) + "  -> " + $to)
  }
}

Write-Host '=== 4) verify: qq-bridge/src source vs live tree ==='
$live = 'D:\MoonBot\resources\runtime\qq-bridge'
$diff = 0
$n = 0
Get-ChildItem (Join-Path $srcBridge 'src') -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($srcBridge.Length + 1)
  $a = Hash8 $_.FullName
  $b = Hash8 (Join-Path $live $rel)
  $n++
  if ($a -ne $b) { $diff++; Write-Host ("  DIFF " + $rel + "  src=" + $a + " live=" + $b) }
}
if ($diff -eq 0) { Write-Host ("  source and live qq-bridge/src are identical (" + $n + " files)") } else { Write-Host ("  " + $diff + " differences listed above") }

Write-Host '=== 5) verify: agent preset (persona / WAKE TYPES / RULES) source vs live ==='
$presetRel = 'dsh\agent-presets\default\agent.cordis.yml'
$presetSrc = Hash8 (Join-Path $srcBridge $presetRel)
$presetLive = Hash8 (Join-Path $live $presetRel)
Write-Host ("  preset src=" + $presetSrc + " live=" + $presetLive)
if ($presetSrc -ne $presetLive) { Write-Host '  DIFF: live preset is stale -- restart the bridge so it re-installs presets' }
Write-Host 'DONE'
