# 现场体检：NapCat / 桥 / DSH 到底有几个进程、端口在不在、守卫状态（只读）
$ErrorActionPreference = 'Continue'
Write-Output '=== 端口 ==='
foreach ($p in @(10721, 3100, 6099, 3000, 3001)) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); Write-Output ("  {0} LISTEN" -f $p) } catch { Write-Output ("  {0} down" -f $p) } finally { $c.Close() }
}
Write-Output '=== NapCat 相关进程（按目录）==='
Get-Process NapCatWinBootMain, QQ -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*napcat-onekey*' } |
  Select-Object Id, ProcessName, Path | Format-Table -AutoSize | Out-String -Width 200
Write-Output '=== qbm-node 进程 ==='
Get-CimInstance Win32_Process -Filter "Name='qbm-node.exe' OR Name='guard-node.exe'" |
  Select-Object ProcessId, Name, CreationDate, @{n = 'cmd'; e = { ($_.CommandLine -replace '.*runtime.', '') } } |
  Format-Table -AutoSize | Out-String -Width 200
Write-Output '=== 守卫状态 ==='
$gf = Join-Path $env:USERPROFILE '.qq-bridge-manager\napcat-guardian.json'
if (Test-Path $gf) { Get-Content $gf -Raw -Encoding UTF8 } else { '  (未武装：当前后端不是由应用启动的，且应用没在跑)' }
$gl = Join-Path $env:USERPROFILE '.qq-bridge-manager\logs\napcat-guardian.log'
if (Test-Path $gl) { Write-Output '--- 守卫动作日志 ---'; Get-Content $gl -Encoding UTF8 | Select-Object -Last 10 } else { Write-Output '  (守卫从未动作过：没有 napcat-guardian.log)' }
Write-Output '=== 硬链接 ==='
$rt = [string]$env:QBM_LIVE_RUNTIME
if (-not $rt) {
  Write-Output '  (设置 QBM_LIVE_RUNTIME 为你的运行时目录后，可检查守卫用的硬链接 guard-node.exe)'
} else {
  foreach ($p in @((Join-Path $rt 'guard-node.exe'), (Join-Path $rt '.guard\guard-node.exe'))) {
    if (Test-Path $p) { Write-Output ("  EXISTS {0}  {1} bytes" -f $p, (Get-Item $p).Length) } else { Write-Output ("  missing {0}" -f $p) }
  }
}
