#!/bin/bash
# 排查「NapCat/QQ 掉线后报检测到设备异常 / 新设备登录，必须扫码」——一条命令把证据全打出来。
#
# 为什么需要它：QQ 判断"是不是同一台设备"靠它自己从机器上读出来的一组标识，
# 而这些标识在**容器**里往往不稳定（这台的 hostnamectl 显示 Virtualization: lxc，
# DMI 的 product_uuid / board_serial 读不到），于是能用的就剩 machine-id、hostname、
# 网卡 MAC。QQ 的数据目录 `~/.config/QQ/nt_qq_<hash>` 就是它算出来的身份 ——
# **目录名一变，服务端就当新设备**，这是最直接的判据。
#
# 配套的"钉死身份"脚本见 pin-napcat-device.sh。
#
# 用法：在目标机上 `bash diag-napcat-device.sh`（只读，不改任何东西）
set -u

echo '################ 1. 机器身份（QQ 能用到的外部标识）################'
echo "hostname     = $(hostname)"
hostnamectl 2>/dev/null | sed -n '1,7p'
echo "machine-id   = $(cat /etc/machine-id 2>/dev/null || echo '(读不到)')"
echo "dbus mid     = $(cat /var/lib/dbus/machine-id 2>/dev/null || echo '(读不到)')"
echo "boot_id      = $(cat /proc/sys/kernel/random/boot_id)"
echo "product_uuid = $(cat /sys/class/dmi/id/product_uuid 2>/dev/null || echo '(读不到——容器里正常)')"
echo "board_serial = $(cat /sys/class/dmi/id/board_serial 2>/dev/null || echo '(读不到——容器里正常)')"
echo "网卡 MAC     = $(ip -o link show 2>/dev/null | awk '/eth0/ {print $17}' | head -n 1)"
echo "内核/发行版   = $(uname -r) / $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}")"

echo
echo '################ 2. QQ 的实例目录（变了 = 被当成新设备）################'
ls -la --time-style=long-iso /home/qq/.config/QQ/ 2>/dev/null | grep -E 'nt_qq|^d' || echo '(读不到 /home/qq/.config/QQ)'
for d in /home/qq/.config/QQ/nt_qq_*/; do
  [ -d "$d" ] || continue
  echo "--- $(basename "$d")"
  ls -la --time-style=long-iso "$d/nt_db/nt_msg.db" "$d/nt_db/profile_info.db" 2>/dev/null
done
echo "--- 登录账号标记（global/nt_data/Login）---"
ls -la --time-style=long-iso /home/qq/.config/QQ/nt_qq/global/nt_data/Login/ 2>/dev/null

echo
echo '################ 3. 停服务时 QQ 是不是被硬杀 ################'
echo '（SIGKILL = 会话状态来不及落盘，叠加身份漂移就容易被判"新设备"）'
journalctl -u napcat --no-pager 2>/dev/null | grep -aE 'SIGKILL|SIGTERM|Killing process|Stopping|Started' | tail -n 12

echo
echo '################ 4. NapCat 侧 ################'
echo "--- 服务状态 ---"
systemctl is-active napcat 2>/dev/null || true
echo "--- 已钉的身份（pin-napcat-device.sh 写的）---"
cat /opt/napcat/config/device-pin.json 2>/dev/null || echo '(还没钉过，跑一次 pin-napcat-device.sh)'
echo "--- QQ 进程 ---"
pgrep -af '/opt/QQ/qq' | head -n 3
echo "--- 登录票据（快速登录的依据）---"
ls -la --time-style=long-iso /opt/napcat/config/napcat_[0-9]*.json 2>/dev/null
echo "--- 当前登录态 ---"
curl -s -m 8 -X POST http://127.0.0.1:3000/get_login_info \
  -H "Authorization: Bearer $(grep -o '"token"[^,]*' /opt/napcat/config/onebot11_*.json 2>/dev/null | head -n 1 | sed 's/.*: *"//;s/"//')" \
  -H 'Content-Type: application/json' -d '{}' 2>/dev/null | head -c 300
echo
