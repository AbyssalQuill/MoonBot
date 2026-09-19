#!/usr/bin/env bash
# 重启服务器上的桥：先停旧的、等它真的退干净，再起新的，最后**如实回报**。
#
# 【为什么要有这个脚本文件，而不是把命令内联在管理端的 ssh 调用里】
#   2026-09-19 实测两次：内联那条命令要同时穿过「管理端 JS 字符串 → ssh → 远端 shell」几层解析，
#   单引号一被吃掉，`pkill -f 'node src/bridge[.]js'` 就变成 `pkill -f node src/bridge[.]js`
#   （参数错 → 一个进程都没杀），于是旧桥继续占着 3100、新起的实例报 EADDRINUSE 自己退出；
#   而成功判据只看"有没有桥进程"——旧桥正好命中，界面永远显示"重启成功"、新代码一行没生效。
#   逻辑放进脚本文件：可以直接 review、可以单独重跑、再也不会被引号搅坏。
#
# 用法（服务器上）：bash /root/qq-bridge/tools/restart-bridge.sh [桥目录]
# 退出码：0 = 新桥已经在跑（或本来就只有它一个在跑）；1 = 没起来
set -u
BRIDGE_DIR="${1:-/root/qq-bridge}"
cd "$BRIDGE_DIR" 2>/dev/null || { echo "bridge-dir-missing $BRIDGE_DIR"; exit 1; }
[ -f start-bridge.sh ] || { echo "start-script-missing $BRIDGE_DIR/start-bridge.sh"; exit 1; }

PATTERN='node src/bridge[.]js'
OLD="$(pgrep -f "$PATTERN" | tr '\n' ',' | sed 's/,$//')"

if [ -n "$OLD" ]; then
  pkill -f "$PATTERN" 2>/dev/null || true
  # 它有优雅停机（会话表/状态落盘）：最多等 20 秒自己退干净，再不行才 -9
  i=0
  while [ "$i" -lt 20 ]; do
    pgrep -f "$PATTERN" >/dev/null 2>&1 || break
    sleep 1
    i=$((i + 1))
  done
  if pgrep -f "$PATTERN" >/dev/null 2>&1; then
    echo "force-killing old bridge: $OLD"
    pkill -9 -f "$PATTERN" 2>/dev/null || true
    sleep 2
  fi
fi

nohup bash start-bridge.sh </dev/null >/dev/null 2>&1 &
sleep 8

NEW="$(pgrep -f "$PATTERN" | head -1)"
if [ -z "$NEW" ]; then
  echo "bridge-down (old=${OLD:-none})"
  exit 1
fi

# 这两个数字才是"新代码真的在跑"的证据：控制台端口被新进程占住 + 到 NapCat(3001) 的连接在
# （NapCat 没起来时 console 可能还在启动预算里，所以只报数不据此判失败）
CONN="$(ss -tn 2>/dev/null | grep -c ':3001' || true)"
PORT="$(ss -lptn 2>/dev/null | grep -c ':3100' || true)"
echo "bridge-up pid=$NEW old=${OLD:-none} napcat-conn=$CONN console-listen=$PORT"
