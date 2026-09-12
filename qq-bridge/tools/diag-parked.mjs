// 诊断：积压唤醒是否滞留（读取运行时 social-state.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时目录从本文件位置推导（tools/ -> qq-bridge/），绝不写死盘符/安装路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const P = path.join(ROOT, 'state', 'social-state.json');
const st = JSON.parse(fs.readFileSync(P, 'utf8'));
const now = Date.now();
const bj = (ms) => (ms ? new Date(Number(ms) + 8 * 3600e3).toISOString().slice(11, 19) : '-');

console.log('=== 各会话积压唤醒明细（北京时间为 UTC+8）===');
for (const [key, c] of Object.entries(st.conversations || {})) {
  const parked = Array.isArray(c.pendingWakeReasons) ? c.pendingWakeReasons : [];
  console.log(`--- ${key}`);
  console.log(`    pendingWakeReasons: ${parked.length ? parked.map((r) => `${r.reason}@seq${r.seq}`).join(', ') : '无'}`);
  console.log(`    lastUnreadSeq=${c.lastUnreadSeq}  lastReplyAt=${bj(c.lastReplyAt)}  rbWake=${c._rebroadcastWake || 0}  rotateTurns=${c.rotateTurns}`);
  const rec = Array.isArray(c.recentMessages) ? c.recentMessages : [];
  const answered = new Set((c.answeredMessageIds || []).map(String));
  for (const m of rec.slice(-4)) {
    const txt = String(m.plain || m.text || '').slice(0, 26);
    const tag = m.isSelf ? 'AI' : '对方';
    const mark = m.messageId && answered.has(String(m.messageId)) ? '✓已回' : '  ';
    console.log(`      ${mark} [${m.messageId}] ${bj(m.time)} ${tag}: ${txt}`);
  }
  // 滞留判断：有积压、且该 seq 之后没有回合在跑
  if (parked.length) console.log(`    ⚠ 有 ${parked.length} 条积压唤醒等待补发（补发只在「回合结束」时触发）`);
}
console.log(`\nnow=${bj(now)} (北京时间)`);
