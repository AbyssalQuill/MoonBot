#!/bin/bash
# 第 3 步：定位"设备指纹"到底被什么改写 —— 看哪个 nt_qq 目录是活的、
# QQ 自己的日志里怎么记设备、NapCat 有没有做设备伪装。
echo '=== 哪个 nt_qq_ 目录是活的（按 db 修改时间）==='
for d in /home/qq/.config/QQ/nt_qq_*; do
  echo "--- $(basename "$d")"
  ls -la --time-style=long-iso "$d/nt_db/nt_msg.db" "$d/nt_db/profile_info.db" 2>/dev/null
done

echo
echo '=== QQ 自己的日志目录 ==='
ls -la --time-style=long-iso /home/qq/.config/QQ/nt_qq/global/nt_data/Log/ 2>/dev/null | head -n 15

echo
echo '=== QQ 日志里的设备/登录关键词 ==='
for f in $(ls -t /home/qq/.config/QQ/nt_qq/global/nt_data/Log/*.log 2>/dev/null | head -n 3); do
  echo "--- $(basename "$f")"
  grep -aiE 'device|instance|新设备|设备异常|risk|verify|安全' "$f" 2>/dev/null | tail -n 12
done

echo
echo '=== NapCat 是否做设备伪装 ==='
wc -c /opt/napcat/napcat.mjs
grep -aoiE 'device' /opt/napcat/napcat.mjs | wc -l
grep -aoiE '.{80}device.{100}' /opt/napcat/napcat.mjs | head -n 10

echo
echo '=== NapCat 有没有 patch QQ 的 package.json / 注入 ==='
ls -la --time-style=long-iso /opt/QQ/resources/app/ | head -n 15
echo '--- main 字段 ---'
grep -o '"main"[^,]*' /opt/QQ/resources/app/package.json 2>/dev/null | head -n 3

echo
echo '=== login.db 有没有 device 字段 ==='
strings /home/qq/.config/QQ/nt_qq/global/nt_db/login.db 2>/dev/null | grep -aiE 'device|uin|uid' | head -n 15

echo
echo '=== napcat_3199924964.json 内容 ==='
cat /opt/napcat/config/napcat_3199924964.json
echo
echo '=== 该文件的两个备份对比（看是否被改写）==='
for f in $(ls -t /opt/napcat/config/login-backup/*/napcat_3199924964.json 2>/dev/null | head -n 3); do
  echo "--- $f"
  md5sum "$f"
  head -c 200 "$f"; echo
done
