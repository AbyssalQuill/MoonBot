# Restart the MoonBot manager (server/index.js) so freshly synced server code goes live.
# ASCII-only: Windows PowerShell 5.1 reads .ps1 as GBK and CJK literals break parsing.
# Safe shutdown model: the Electron shell's stopBackend() also kills every qbm-node.exe whose path
# is <runtime>\qbm-node.exe, so a replacement we start here is still cleaned up when the window closes.
param([string]$Runtime = $env:QBM_LIVE_RUNTIME)
$ErrorActionPreference = 'Continue'
if (-not $Runtime) {
  # No hardcoded install path: point us at your runtime folder explicitly.
  Write-Host 'QBM_LIVE_RUNTIME is not set. Pass it once, e.g.:'
  Write-Host '  $env:QBM_LIVE_RUNTIME = "C:\MoonBot\resources\runtime"'
  Write-Host '  powershell -File tools\restart-manager.ps1'
  exit 2
}
$runtime = $Runtime
$exe = Join-Path $runtime 'qbm-node.exe'

$procs = @(Get-CimInstance Win32_Process -Filter "Name='qbm-node.exe'" |
  Where-Object { $_.CommandLine -like '*server/index.js*' })
Write-Host ("manager processes before: " + (($procs | ForEach-Object { $_.ProcessId }) -join ','))

# The close-window guardian is a separate process (guard-node.exe running napcat-guardian.mjs) that
# watches the BACKEND pid: when that pid dies it waits out its grace period, re-reads the guard file,
# and -- if no new backend has claimed it -- tears down NapCat + bridge + isolated DSH. Restarting the
# backend from here therefore used to kill the running bridge and DSH (observed 2026-09-19: a manager
# restart left the whole local install stopped). Retire the stale guardian first; the new backend arms
# a fresh one as soon as it listens.
$guards = @(Get-CimInstance Win32_Process -Filter "Name='guard-node.exe'" |
  Where-Object { $_.CommandLine -like '*napcat-guardian.mjs*' })
foreach ($g in $guards) {
  taskkill /PID $g.ProcessId /F | Out-Null
  Write-Host ("  retired stale guardian pid " + $g.ProcessId)
}

foreach ($p in $procs) {
  # /F but NOT /T: children (DSH / bridge / NapCat) must survive - the new manager adopts them by port probe.
  taskkill /PID $p.ProcessId /F | Out-Null
  Write-Host ("  killed pid " + $p.ProcessId)
}
Start-Sleep -Seconds 2

$env:QBM_API_PORT = '1921'
$p = Start-Process -FilePath $exe -ArgumentList 'server/index.js' -WorkingDirectory $runtime -WindowStyle Hidden -PassThru
Write-Host ("started manager pid " + $p.Id)

$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:1921/api/state' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { Write-Host 'manager did NOT come up within 60s'; exit 1 }

$state = (Invoke-WebRequest -Uri 'http://127.0.0.1:1921/api/state' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
Write-Host 'instances after restart:'
foreach ($i in $state.instances) {
  Write-Host ("  " + $i.id + "  phase=" + $i.phase + "  adopted=" + $i.adopted + "  loggedIn=" + $i.loggedIn)
}
Write-Host 'MANAGER_RESTART_OK'
