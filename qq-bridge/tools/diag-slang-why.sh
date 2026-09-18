#!/bin/bash
# 为什么黑话研究会话从来没跑成？（诊断用，只读）
cd /root/qq-bridge || exit 1

echo '=== state/ 里与学习相关的文件 ==='
ls -la --time-style=long-iso state/ 2>/dev/null | grep -iE 'slang|learn|persona'

echo
echo '=== config.json 的 slang 段 ==='
python3 - <<'PY'
import json
c = json.load(open('config.json'))
print(json.dumps(c.get('slang'), ensure_ascii=False, indent=2))
print('--- learning 段 ---')
print(json.dumps(c.get('learning'), ensure_ascii=False, indent=2)[:800])
PY

echo
echo '=== 桥日志里黑话/学习相关的行（最近 30 条）==='
for f in state/bridge.log state/bridge-nohup.log bridge.out; do
  [ -f "$f" ] || continue
  echo "--- $f"
  grep -aE '黑话|slang|学习会话|learner' "$f" 2>/dev/null | tail -n 12
done

echo
echo '=== 黑话学习开关的实际值（从运行中的桥问）==='
curl -s -m 8 http://127.0.0.1:3100/api/social/slang/stats 2>/dev/null | head -c 600
echo

echo
echo '=== 候选里 count>=2 的那几条（本该已被研究过）==='
node tools/diag-slang-dupes.mjs 2>/dev/null | head -n 6
