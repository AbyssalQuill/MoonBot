#!/bin/bash
# 把 QQ/NapCat 看到的**设备身份**钉死（幂等，可重复跑）。
#
# 【为什么需要】
# 反复出现「掉线后报检测到设备异常 / 新设备登录，必须扫码」。QQ 判断"是不是同一台设备"靠的是
# 它自己从机器上读出来的一组标识；这台 VPS 是 **LXC 容器**（`hostnamectl` 显示 Virtualization: lxc），
# 容器里读不到 DMI 的 product_uuid / board_serial，于是它能用的就剩下这几个：
#
#   · /etc/machine-id（systemd machine id）      ← 容器重建会换
#   · hostname                                   ← 这台上是个 UUID 主机名，容器重建/迁移会换
#   · 网卡 MAC（eth0）                            ← **由宿主机分配**，容器重建会换（容器内改有断网风险，本脚本不碰）
#   · /home/qq/.config/QQ 里的 nt_qq_<hash> 实例目录 ← 上面几个一变，QQ 就新建一个目录 = 新设备
#
# 本脚本做**安全**的那两件（不碰网络）：
#   1) 保证 /etc/machine-id 存在且 /var/lib/dbus/machine-id 与它一致（不一致本身就是"身份漂移"）；
#   2) 把 hostname 固定成一个与机器无关的常量（不再随容器 UUID 变）。
# 并把钉死后的身份记到 /opt/napcat/config/device-pin.json，方便日后比对"是不是又飘了"。
#
# ⚠️ 注意：改 hostname **本身会让 QQ 觉得换了一次设备**（一次性），之后才稳定 ——
# 所以只在需要时跑，别反复跑。
#
# 用法：sudo bash pin-napcat-device.sh [--hostname moonbot-qq]
set -u

HOSTNAME_WANT="moonbot-qq"
for i in "$@"; do
  case "$i" in
    --hostname=*) HOSTNAME_WANT="${i#*=}" ;;
    --hostname) shift ;;
  esac
done
# 也支持 `--hostname xxx` 这种两段式
prev=""
for i in "$@"; do
  if [ "$prev" = "--hostname" ]; then HOSTNAME_WANT="$i"; fi
  prev="$i"
done

PIN_FILE="/opt/napcat/config/device-pin.json"
changed=""

echo "=== 钉设备身份：$(date '+%F %T') ==="

# ── 1. machine-id ────────────────────────────────────────────────────────────
MID="$(cat /etc/machine-id 2>/dev/null | tr -d '\r\n ')"
if [ -z "$MID" ]; then
  # 空 machine-id 在容器里很常见（systemd 认为该由宿主提供），这时 QQ 每次读到的都不同
  MID="$(tr -d '-' < /proc/sys/kernel/random/uuid)"
  echo "$MID" > /etc/machine-id
  changed="${changed}machine-id(新建) "
  echo "  machine-id 原本是空的 → 生成并写入：$MID"
else
  echo "  machine-id 已存在：$MID（未改动）"
fi
DBUS_MID="$(cat /var/lib/dbus/machine-id 2>/dev/null | tr -d '\r\n ')"
if [ ! -e /var/lib/dbus/machine-id ] || [ "$DBUS_MID" != "$MID" ]; then
  mkdir -p /var/lib/dbus
  rm -f /var/lib/dbus/machine-id
  ln -sf /etc/machine-id /var/lib/dbus/machine-id
  changed="${changed}dbus-machine-id(对齐) "
  echo "  /var/lib/dbus/machine-id 与 /etc/machine-id 不一致 → 已对齐"
else
  echo "  /var/lib/dbus/machine-id 一致（未改动）"
fi

# ── 2. hostname ─────────────────────────────────────────────────────────────
CUR_HOST="$(hostname)"
if [ "$CUR_HOST" != "$HOSTNAME_WANT" ]; then
  if command -v hostnamectl >/dev/null 2>&1; then
    hostnamectl set-hostname "$HOSTNAME_WANT" 2>/dev/null || true
  fi
  # hostnamectl 在容器里可能被拒（只读 /etc/hostname），兜底直接写
  if [ "$(hostname)" != "$HOSTNAME_WANT" ]; then
    echo "$HOSTNAME_WANT" > /etc/hostname
    command -v hostname >/dev/null 2>&1 && hostname "$HOSTNAME_WANT" 2>/dev/null || true
  fi
  changed="${changed}hostname($CUR_HOST→$HOSTNAME_WANT) "
  echo "  hostname：$CUR_HOST → $HOSTNAME_WANT"
  echo "  ⚠️ 改 hostname 会让 QQ 当成换了一次设备（一次性），下次可能要扫一次码，之后才稳定"
else
  echo "  hostname 已经是 $HOSTNAME_WANT（未改动）"
fi

# ── 3. 记下当前身份，便于日后比对 ────────────────────────────────────────────
NOW_HOST="$(hostname)"
MAC="$(ip -o link show 2>/dev/null | awk '/eth0/ {print $17}' | head -n 1)"
mkdir -p /opt/napcat/config
cat > "$PIN_FILE" <<JSONEOF
{
  "pinnedAt": "$(date '+%F %T %z')",
  "hostname": "$NOW_HOST",
  "machineId": "$MID",
  "eth0Mac": "$MAC",
  "note": "eth0 的 MAC 由宿主机(LXC)分配，容器内改它可能导致断网 —— 本文件只做记录，不做修改。",
  "changedThisRun": "$changed"
}
JSONEOF
echo "  已记录到 $PIN_FILE"

echo
echo "=== 当前身份 ==="
echo "  hostname   = $NOW_HOST"
echo "  machine-id = $MID"
echo "  eth0 MAC   = ${MAC:-(读不到)}   ← 宿主机分配，容器重建会换"
echo "  boot_id    = $(cat /proc/sys/kernel/random/boot_id)"
echo
echo "=== QQ 的实例目录（nt_qq_<hash>，变了就是"换了设备"）==="
ls -la --time-style=long-iso /home/qq/.config/QQ/ 2>/dev/null | grep nt_qq_
echo
if [ -z "$changed" ]; then
  echo "本次没有改动任何东西（身份本来就是稳定的）。"
else
  echo "本次改动：$changed"
  echo "→ 需要重启 NapCat 让 QQ 重新读取；重启后可能要扫一次码，之后应当稳定。"
fi
