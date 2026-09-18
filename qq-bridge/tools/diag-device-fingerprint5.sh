#!/bin/bash
# 第 5 步：两个 nt_qq_<hash> 分别属于哪个账号？（决定它是"按账号分"还是"按设备分"）
for d in /home/qq/.config/QQ/nt_qq_*/; do
  echo "=============================================================="
  echo "目录: $(basename "$d")"
  echo "--- profile_info.db 里出现的 QQ 号 ---"
  strings "$d/nt_db/profile_info.db" 2>/dev/null | grep -oE '\b[1-9][0-9]{5,11}\b' | sort | uniq -c | sort -rn | head -n 6
  echo "--- nt_msg.db 里出现的 QQ 号（取样）---"
  strings "$d/nt_db/nt_msg.db" 2>/dev/null | grep -oE '\b3199924964\b|\b1736784911\b' | sort | uniq -c | head -n 4
  echo "--- 有没有 uid 形态的串 ---"
  strings "$d/nt_db/profile_info.db" 2>/dev/null | grep -oE 'u_[A-Za-z0-9_-]{10,40}' | sort -u | head -n 4
done

echo
echo '=== global/nt_db/login.db 里的账号 ==='
strings /home/qq/.config/QQ/nt_qq/global/nt_db/login.db 2>/dev/null | grep -oE '\b[1-9][0-9]{5,11}\b|u_[A-Za-z0-9_-]{10,40}' | sort | uniq -c | sort -rn | head -n 10

echo
echo '=== global/nt_data/Login 里有什么 ==='
find /home/qq/.config/QQ/nt_qq/global/nt_data/Login -maxdepth 2 2>/dev/null | head -n 15
ls -la --time-style=long-iso /home/qq/.config/QQ/nt_qq/global/nt_data/Login/ 2>/dev/null | head -n 10

echo
echo '=== NapCat 自己记的"登录票据"文件 ==='
ls -la --time-style=long-iso /opt/napcat/config/napcat_*.json
echo '--- 内容和 uin 字段 ---'
for f in /opt/napcat/config/napcat_[0-9]*.json; do echo "$f:"; cat "$f"; echo; done
