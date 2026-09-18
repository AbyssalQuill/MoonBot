#!/bin/bash
# 追查 nt_qq_<hash> 这个设备指纹目录名到底由什么决定（NapCat 只是壳，真正生成它的是 QQ 本体）。
echo '=== QQ 本体里 nt_qq_ 的生成处 ==='
grep -rl 'nt_qq_' /opt/QQ/resources/app/ 2>/dev/null | head -n 10
echo '--- 片段 ---'
grep -rrohE '.{200}nt_qq_.{200}' /opt/QQ/resources/app/ 2>/dev/null | head -n 8

echo
echo '=== 有没有 uid / instance / deviceId 之类的来源 ==='
grep -rrohE '.{120}(getDeviceId|deviceId|instanceId|getUid|uidHash|ntUid).{140}' /opt/QQ/resources/app/ 2>/dev/null | head -n 10

echo
echo '=== 两个 nt_qq_ 目录里的 uid/账号信息 ==='
for d in /home/qq/.config/QQ/nt_qq_*; do
  echo "--- $d"
  find "$d" -maxdepth 3 -name '*.json' -o -maxdepth 3 -name '*.db' 2>/dev/null | head -n 12
done

echo
echo '=== nt_qq（无后缀）里是什么 ==='
find /home/qq/.config/QQ/nt_qq -maxdepth 3 2>/dev/null | head -n 20

echo
echo '=== 08:10-08:25 的 QQ/NapCat 登录流程日志 ==='
for f in $(ls -t /opt/napcat/logs/*.log 2>/dev/null | head -n 3); do
  echo "--- $f"
  grep -aE '09-18 (08:1[0-9]|08:2[0-5])' "$f" 2>/dev/null | grep -aiE 'login|登录|qrcode|二维码|quick|device|设备|inst|新' | head -n 15
done

echo
echo '=== 当前 QQ 进程的启动参数 ==='
PID=$(pgrep -f '/opt/QQ/qq' | head -n 1)
echo "pid=$PID"
tr '\0' ' ' < /proc/$PID/cmdline 2>/dev/null; echo
