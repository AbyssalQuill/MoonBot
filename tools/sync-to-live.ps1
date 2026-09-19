# Sync this repo's source into the runtime copies (live install + packaging payloads).
# NOTE: keep this file ASCII-only -- Windows PowerShell 5.1 reads .ps1 as GBK and CJK literals break parsing.
#
# No hardcoded paths: everything is derived, so the repo works from any drive/user folder.
#   repo root : parent of this script's folder (tools\)
#   payloads  : <sibling>\QQ-Bridge-packaging\...     (the packaging project next to this repo)
#   live      : $env:QBM_LIVE_RUNTIME                 (the running install; unset = skip it)
#
#   powershell -File tools\sync-to-live.ps1
#   $env:QBM_LIVE_RUNTIME = 'C:\MoonBot\resources\runtime'    # optional
$ErrorActionPreference = 'Stop'

$repoRoot  = Split-Path $PSScriptRoot -Parent
$pkgRoot   = Join-Path (Split-Path $repoRoot -Parent) 'QQ-Bridge-packaging'
$liveRoot  = [string]$env:QBM_LIVE_RUNTIME
$srcBridge = Join-Path $repoRoot 'qq-bridge'
$srcMgr    = $repoRoot

# Sync the whole src/ and tools/ trees: the invariant we want is "live src == source src, byte for byte".
# That beats maintaining a per-change file list (miss one file and production silently runs old code).
# 2026-09-12: added 'dsh' -- the agent presets (persona / WAKE TYPES / RULES) live under qq-bridge/dsh,
# and the bridge installs them into the isolated DSH home at startup. Without this, preset edits
# never reach the running install (found the hard way: live preset hash stayed old).
# 2026-09-12 (later): added 'scripts' and 'plugins' -- qq-bridge/plugins (dsh-qq-hold, qq-mode-console)
# is loaded at runtime but was NEVER in the sync list, and scripts/ (setup-dsh, check-*) had drifted too.
# 2026-09-19: 加上 'characters' —— 出厂角色库（21 个角色包 + 1 张散装卡，约 1.5MB）以前只存在于仓库里，
# 每个安装包 payload 的 qq-bridge\characters 都只剩一个 _template 空模板，于是新装的机器上
# qq_character_list / read / pack / search 四个只读工具什么都读不到（"换角色玩"直接哑火）。
$bridgeDirs = @('src', 'tools', 'dsh', 'scripts', 'plugins', 'characters')

# Packaging payloads (relative to the packaging project). runtime-src is the manager-only variant,
# so it carries no qq-bridge and is filtered out of the bridge list below.
$payloadDirs = @(
  'moonbot-app\runtime-full',
  'moonbot-app\runtime-src',
  'full\app',
  # electron-builder intermediate output (win-unpacked): the installer is packed from it, so
  # editing it here is the same as editing the files inside the installer.
  'moonbot-app\dist-eb\win-unpacked\resources\runtime'
)

$mgrDests = @()
if ($liveRoot) { $mgrDests += $liveRoot }
foreach ($rel in $payloadDirs) { $mgrDests += (Join-Path $pkgRoot $rel) }
$bridgeDests = @($mgrDests | Where-Object { Test-Path (Join-Path $_ 'qq-bridge') } | ForEach-Object { Join-Path $_ 'qq-bridge' })

if (-not $liveRoot) { Write-Host 'NOTE: QBM_LIVE_RUNTIME not set -> live runtime skipped (payloads only).' }
if (-not (Test-Path $pkgRoot)) { Write-Host ('WARNING: packaging root not found: ' + $pkgRoot) }

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

# Root-level bridge files that the deploy path needs on the target host. start-bridge.sh was NOT in any
# copy list (neither here nor in the server sync), so a fresh install shipped no start script at all and
# the server kept running whatever copy it already had -- found 2026-09-15 when server-side preset
# refresh silently stayed dead because the new env export never reached the host.
$bridgeRootFiles = @('start-bridge.sh', 'config.example.json')
Write-Host '=== 1b) bridge root files (deploy scripts) ==='
foreach ($rel in $bridgeRootFiles) {
  $from = Join-Path $srcBridge $rel
  if (-not (Test-Path $from)) { Write-Host ("  SKIP (not in source): " + $rel); continue }
  foreach ($d in $bridgeDests) {
    Copy-Item $from (Join-Path $d $rel) -Force
    Write-Host ("  " + $rel + " -> " + $d + "  md5=" + (Hash8 (Join-Path $d $rel)))
  }
}

# Dev-only leftovers that must never reach an installer payload. They are gitignored in the repo (they
# carry the owner's QQ / group ids / bot QQ), but copying tools/ wholesale brought them back into
# full\\app / runtime-full / win-unpacked -- found 2026-09-15 by scanning a built payload before packing.
$devOnlyToolFiles = @(
  'tool-text-worklist*.json', 'tooltext-*.json', 'top-tool-text*.txt', 'manifest-*.json',
  '*.before-compress.js', 'wl-group-*.json'
)
Write-Host '=== 1c) strip dev-only files from payload tools/ ==='
foreach ($d in $bridgeDests) {
  $toolsDir = Join-Path $d 'tools'
  if (-not (Test-Path $toolsDir)) { continue }
  $n = 0
  foreach ($pat in $devOnlyToolFiles) {
    Get-ChildItem -Path $toolsDir -Filter $pat -File -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
      $n++
    }
  }
  if ($n -gt 0) { Write-Host ("  removed " + $n + " dev-only file(s) from " + $toolsDir) }
}

# 1d) 撤掉模板角色卡（2026-09-19）：出厂改带 21 个真实角色包 + 1 张散装卡，_template 反而会在「角色库导入」里
# 抢走列表、让新机器看着像空库。Copy-Item 只加不删，所以旧 payload 里残留的那一份必须在这里显式清掉
# —— 与上面 dev-only 清理同一套路。
Write-Host '=== 1d) retire the _template character pack from payload characters/ ==='
foreach ($d in $bridgeDests) {
  $charDir = Join-Path $d 'characters'
  if (-not (Test-Path $charDir)) { Write-Host ("  SKIP (no characters dir: " + $charDir + ")"); continue }
  $stale = Join-Path $charDir '_template'
  if (Test-Path $stale) { Remove-Item -LiteralPath $stale -Recurse -Force; Write-Host ("  removed retired pack " + $stale) }
  $packs = @(Get-ChildItem -LiteralPath $charDir -Directory -Force | Where-Object { -not $_.Name.StartsWith('_') })
  $n = (Get-ChildItem -LiteralPath $charDir -Recurse -File | Measure-Object).Count
  $bytes = (Get-ChildItem -LiteralPath $charDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  Write-Host ("  characters packs=" + $packs.Count + " files=" + $n + " bytes=" + $bytes + "  -> " + $charDir)
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
$srcMeme = Join-Path $repoRoot 'meme'
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
$live = if ($liveRoot) { Join-Path $liveRoot 'qq-bridge' } else { '' }
if (-not $live) {
  Write-Host '  skipped (QBM_LIVE_RUNTIME not set)'
} else {
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
  # 【2026-09-19】live 那份 preset 里的 [PERSONA] / [SPEECH RULES] 段是桥按 persona.md / speech-rules.md
  # 现场合成的（lib/preset-compose.js），比对前必须先剥掉，否则每次都会误报 "live preset is stale"。
  function Strip-ComposeBlock([string]$text) {
    $m = [regex]::Match($text, '(?s)\n?[ \t]*# === qq-bridge persona/rules BEGIN ===.*?# === qq-bridge persona/rules END ===')
    if ($m.Success) { return $text.Remove($m.Index, $m.Length) }
    return $text
  }
  $presetRel = 'dsh\agent-presets\default\agent.cordis.yml'
  $presetSrc = Hash8 (Join-Path $srcBridge $presetRel)
  $livePresetFile = Join-Path $live $presetRel
  if (Test-Path $livePresetFile) {
    $tmpPreset = Join-Path $env:TEMP ('qbm-preset-' + [guid]::NewGuid().ToString('N') + '.yml')
    $liveStripped = Strip-ComposeBlock ([System.IO.File]::ReadAllText($livePresetFile))
    [System.IO.File]::WriteAllText($tmpPreset, $liveStripped, (New-Object System.Text.UTF8Encoding($false)))
    $presetLive = Hash8 $tmpPreset
    Remove-Item $tmpPreset -Force -ErrorAction SilentlyContinue
  } else { $presetLive = Hash8 $livePresetFile }
  Write-Host ("  preset src=" + $presetSrc + " live=" + $presetLive)
  if ($presetSrc -ne $presetLive) { Write-Host '  DIFF: live preset is stale -- restart the bridge so it re-installs presets' }
}
Write-Host 'DONE'
