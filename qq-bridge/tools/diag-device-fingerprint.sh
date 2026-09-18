#!/bin/bash
# 排查「每次掉线都报新设备、必须扫码」——QQ 的数据目录是按设备指纹哈希命名的，
# 目录名一变，QQ 就当成新设备。这里把相关证据一次性打出来。
echo '=== QQ 数据目录（nt_qq_<hash> = 设备指纹）==='
ls -la --time-style=long-iso /home/qq/.config/QQ/ | grep -E 'nt_qq|^total|^d'

echo
echo '=== 每个 nt_qq_* 里有什么 ==='
for d in /home/qq/.config/QQ/nt_qq_*; do
  echo "--- $d"
  ls -la --time-style=long-iso "$d" | head -n 8
done

echo
echo '=== NapCat 里 nt_qq_ 这个名字是怎么来的 ==='
grep -ohE '.{160}nt_qq_.{160}' /opt/napcat/napcat.mjs | head -n 8

echo
echo '=== NapCat 里 device 相关代码 ==='
grep -ohE '.{110}(deviceSeed|deviceId|device_id|deviceName|machineId|bootId|instanceId).{130}' /opt/napcat/napcat.mjs | head -n 20

echo
echo '=== 有没有写死的 device.json / 设备种子 ==='
find /opt/napcat /home/qq -maxdepth 4 -iname '*device*' -o -maxdepth 4 -iname '*instance*' 2>/dev/null | head -n 20

echo
echo '=== 当前进程用的哪个数据目录 ==='
PID=$(pgrep -f '/opt/QQ/qq' | head -n 1)
echo "qq pid = $PID"
if [ -n "$PID" ]; then
  ls -l /proc/$PID/cwd 2>/dev/null
  tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -iE 'HOME|DEVICE|QQ|INSTANCE' | head -n 20
fi

echo
echo '=== 内核/硬件标识（QQ 可能用来算指纹）==='
echo "machine-id   = $(cat /etc/machine-id)"
echo "boot_id      = $(cat /proc/sys/kernel/random/boot_id)"
echo "hostname     = $(hostname)"
echo "product_uuid = $(cat /sys/class/dmi/id/product_uuid 2>/dev/null || echo '(读不到)')"
echo "board_serial = $(cat /sys/class/dmi/id/board_serial 2>/dev/null || echo '(读不到)')"
echo "disk serial  = $(lsblk -dno SERIAL /dev/vda 2>/dev/null || lsblk -dno SERIAL 2>/dev/null | head -n 1)"
echo "uptime       = $(uptime -p 2>/dev/null)"
