# 本机端到端验证「接口密钥 → 隔离 DSH 凭据文件」（安全版：先备份、测完原样还原）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\_verify-apikey-local.ps1
$ErrorActionPreference = 'Stop'
$iso = Join-Path $env:USERPROFILE '.qq-bridge-manager\dsh-isolated-home-official'
$cred = Join-Path $iso '.credentials.yaml'
$bak = Join-Path $env:TEMP ('cred-verify-baseline-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.yaml')
$api = 'http://127.0.0.1:1921'
$fix = 'FIXTURE_VERIFY_0123456789ABCDEF'

function Show-Structure($path, $title) {
  Write-Host "--- $title ---"
  Get-Content $path -Encoding UTF8 | ForEach-Object {
    $m = [regex]::Match($_, '^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*)$')
    if ($m.Success) {
      $ind = $m.Groups[1].Value.Length
      $val = $m.Groups[3].Value
      $shown = if ($val.Length -gt 0) { "<$($val.Length) chars>" } else { '(empty)' }
      '{0,2} | {1} | {2}' -f $ind, $m.Groups[2].Value, $shown
    } elseif ($_.Trim().Length -eq 0) { '   | (blank)' } else { '   | <other line>' }
  }
}

Copy-Item $cred $bak -Force
Write-Host "baseline backup: $bak ($((Get-Item $bak).Length) bytes)"
$baseText = Get-Content $bak -Raw -Encoding UTF8

Write-Host "`n[1] GET 状态（写入前）"
$g0 = Invoke-RestMethod "$api/api/bridge/config" -TimeoutSec 30
Write-Host ('    apiKeyStatus = ' + ($g0.apiKeyStatus | ConvertTo-Json -Compress))

Write-Host "`n[2] POST 写入 fixture（长度 $($fix.Length)）"
$body = @{ config = @{ dsh = @{ apiKey = $fix } } } | ConvertTo-Json -Depth 6
$w = Invoke-RestMethod "$api/api/bridge/config" -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 90
Write-Host ('    apiKeyWrite  = ' + ($w.apiKeyWrite | ConvertTo-Json -Compress))
Write-Host ('    apiKeyStatus = ' + ($w.apiKeyStatus | ConvertTo-Json -Compress))

Write-Host "`n[3] 磁盘结构（写入后：那条必须是 2 空格缩进、其余逐字节不变）"
Show-Structure $cred 'credentials after write'
$nowText = Get-Content $cred -Raw -Encoding UTF8
$baseLines = $baseText -split "`n"
$nowLines = $nowText -split "`n"
$keyLine = ($baseLines | Where-Object { $_ -match 'XIAOMI_TOKEN_PLAN_CN_API_KEY' })
$expectLine = '  XIAOMI_TOKEN_PLAN_CN_API_KEY: ' + $fix
$nowKeyLine = ($nowLines | Where-Object { $_ -match 'XIAOMI_TOKEN_PLAN_CN_API_KEY' })
Write-Host ("    该行现在是: [" + $nowKeyLine + "]")
if ($nowKeyLine -cne $expectLine) { Write-Host '    FAIL: 写入行不等于期望（缩进/内容不符）'; exit 1 } else { Write-Host '    PASS: 缩进 2 空格 + 值正确' }
$diff = @()
for ($i = 0; $i -lt $baseLines.Count; $i++) {
  if ($baseLines[$i] -ceq $keyLine) { continue }
  if ($baseLines[$i] -cne $nowLines[$i]) { $diff += $i }
}
if ($diff.Count -gt 0) { Write-Host "    FAIL: 除该行外还有 $($diff.Count) 行被改动（索引 $($diff -join ',')）"; exit 1 } else { Write-Host '    PASS: 除该行外每一行逐字节一致' }

Write-Host "`n[4] 重启隔离 DSH：在 fixture 就在文件里的状态下，DSH 能不能正常起来（= 文件没写坏）"
$rst = Invoke-RestMethod "$api/api/instance/dsh-isolated/restart" -Method Post -TimeoutSec 120
Write-Host ('    restart: ' + ($rst | ConvertTo-Json -Compress))
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 6
  $st = Invoke-RestMethod "$api/api/state" -TimeoutSec 30
  $d = $st.instances | Where-Object { $_.id -eq 'dsh-isolated' }
  Write-Host ("    +$((($i + 1) * 6))s phase=$($d.phase) reachable=$($d.reachable) err=$($d.error)")
  if ($d.phase -eq 'running' -and $d.reachable) { $ok = $true; break }
  if ($d.phase -eq 'failed') { break }
}
if (-not $ok) { Write-Host '    FAIL: 带 fixture 的凭据文件让 DSH 起不来（说明文件被写坏）'; Copy-Item $bak $cred -Force; Invoke-RestMethod "$api/api/instance/dsh-isolated/restart" -Method Post -TimeoutSec 120 | Out-Null; exit 1 }
Write-Host '    PASS: DSH 带着这份文件正常起来了（解析通过）'

Write-Host "`n[4b] 清除路径：POST clearApiKey=true（应删掉 refs 里那一行，并触发 DSH 重启）"
$cbody = @{ config = @{ dsh = @{ clearApiKey = $true; provider = 'xiaomi-token-plan-cn' } } } | ConvertTo-Json -Depth 6
$c = Invoke-RestMethod "$api/api/bridge/config" -Method Post -ContentType 'application/json; charset=utf-8' -Body $cbody -TimeoutSec 90
Write-Host ('    apiKeyWrite  = ' + ($c.apiKeyWrite | ConvertTo-Json -Compress))
Write-Host ('    dshChanged   = ' + $c.dshChanged + '（清除也必须为 True：不重启的话进程环境里那把旧 key 会一直用）')
$cst = Invoke-RestMethod "$api/api/bridge/config" -TimeoutSec 30
Write-Host ('    清除后状态   = ' + ($cst.apiKeyStatus | ConvertTo-Json -Compress))
$clearedText = (Get-Content $cred -Raw -Encoding UTF8)
$stillThere = ($clearedText -split "`n" | Where-Object { $_ -match 'XIAOMI_TOKEN_PLAN_CN_API_KEY' }).Count
Write-Host "    文件里该键剩余行数 = $stillThere（应为 0）"
if ($c.apiKeyWrite.action -ne 'removed' -or -not $c.dshChanged -or $stillThere -ne 0 -or $cst.apiKeyStatus.set) {
  Write-Host '    FAIL: 清除路径不符合预期'; Copy-Item $bak $cred -Force; Invoke-RestMethod "$api/api/instance/dsh-isolated/restart" -Method Post -TimeoutSec 120 | Out-Null; exit 1
}
Write-Host '    PASS: 清除只删了那一条、且触发了 DSH 重启'

Write-Host "`n[5] 还原基线并重启 DSH"
Copy-Item $bak $cred -Force
Get-ChildItem $iso -Force -Filter '.credentials.yaml.bak-*' | Remove-Item -Force
Invoke-RestMethod "$api/api/instance/dsh-isolated/restart" -Method Post -TimeoutSec 120 | Out-Null
$restored = (Get-Content $cred -Raw -Encoding UTF8) -ceq $baseText
Write-Host "    还原逐字节一致: $restored"
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 6
  $st = Invoke-RestMethod "$api/api/state" -TimeoutSec 30
  $d = $st.instances | Where-Object { $_.id -eq 'dsh-isolated' }
  if ($d.phase -eq 'running' -and $d.reachable) { Write-Host "    DSH 恢复 running（pid=$($d.proc.pid)）"; break }
  if ($d.phase -eq 'failed') { Write-Host "    FAIL: 还原后 DSH 起不来：$($d.error)"; exit 1 }
}
$g1 = Invoke-RestMethod "$api/api/bridge/config" -TimeoutSec 30
Write-Host ('    apiKeyStatus（还原后）= ' + ($g1.apiKeyStatus | ConvertTo-Json -Compress))
Show-Structure $cred 'credentials after restore'
Remove-Item $bak -Force
Write-Host "`nDONE"
