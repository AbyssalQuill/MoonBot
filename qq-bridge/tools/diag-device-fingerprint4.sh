#!/bin/bash
# 第 4 步：还原 08:18 那次"换了个设备目录"是怎么发生的（有没有重启、怎么停的）。
echo '=== systemd 里 napcat 在 08:00-08:25 的启停 ==='
journalctl -u napcat --since '2026-09-18 08:00:00' --until '2026-09-18 08:30:00' --no-pager 2>/dev/null | tail -n 40

echo
echo '=== NapCat 日志里 08:1x 的登录流程 ==='
for f in $(ls -t /opt/napcat/logs/*.log 2>/dev/null | head -n 5); do
  hit=$(grep -acE '160|161|162|180|181|182' "$f" 2>/dev/null)
  echo "--- $(basename "$f")  匹配行=$hit"
done

echo
echo '=== 直接全文找"新设备/设备/扫码/登录"近期记录 ==='
grep -ahE '新设备|设备异常|设备锁|扫码|二维码|快速登录|风险' /opt/napcat/logs/*.log 2>/dev/null | tail -n 25

echo
echo '=== 网卡 MAC / 主机名（可能进指纹）==='
ip -o link show 2>/dev/null | awk '{print $2, $17}'
echo "hostname = $(hostname)"
echo "hostnamectl:"; hostnamectl 2>/dev/null | head -n 6

echo
echo '=== QQ 是否响应 SIGTERM（看历史上是不是被 SIGKILL）==='
journalctl -u napcat --no-pager 2>/dev/null | grep -aE 'SIGKILL|SIGTERM|Killing process' | tail -n 12

echo
echo '=== QQ 启动包装 ==='
head -c 400 /opt/QQ/qq 2>/dev/null | strings | head -n 12
file /opt/QQ/qq 2>/dev/null
