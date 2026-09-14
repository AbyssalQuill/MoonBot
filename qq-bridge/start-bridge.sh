#!/usr/bin/env bash
# QQ 桥的 Linux 启动脚本（服务器部署用）。
#
# 为什么需要它：server/deploy.js 的「启动桥」步骤和管理器服务器卡片的
# 「启动 QQ 桥 / 停止 QQ 桥」都按这个姿势起桥：
#     cd /root/qq-bridge && nohup bash start-bridge.sh ...
# 老模板服务器上是手工放的同名脚本，仓库里却没有 —— 于是"从本机复刻"出来的服务器
# 永远起不来桥（症状：3100 不监听、管理器里回 BRIDGE-NOT-RUNNING）。
# 把脚本随仓库发出去，两条代码路径就都成立了。
#
# 用法：cd <qq-bridge> && bash start-bridge.sh     （前台跑；调用方自己 nohup/setsid 后台化）
set -u
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo 'node not found in PATH' >&2; exit 1; }
# 【2026-09-14】DSH Web 每次启动都会把带 token 的访问地址打进自己的启动日志，桥靠读它换鉴权 cookie
# （dsh-client.js 的 readLatestToken / _ensureSession）。本机是管理器把 DSH 子进程 stdout 写进实例日志、
# 再用环境变量告诉桥；服务器上 dsh-web 由 systemd 拉起，日志默认只进 journald —— 那样桥读不到 token，
# 表现就是每 3 秒刷 `remote.mux WebSocket 连接失败`。服务端约定：dsh-web.service 用
# StandardOutput/StandardError=append 写这个文件（deploy.js 生成的 unit 已带），这里给默认路径兜底。
: "${DSH_ISOLATED_LOG_FILE:=/root/.dsh/dsh-web.log}"
export DSH_ISOLATED_LOG_FILE
rm -f state/bridge.lock
exec node src/bridge.js
