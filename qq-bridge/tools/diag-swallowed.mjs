// 找"吞消息"：逐条列出主人私聊最近的往来，标出「对方说了但后面没有任何 AI 回复」的条目。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时目录从本文件位置推导（tools/ -> qq-bridge/），绝不写死盘符/安装路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const P = path.join(ROOT, 'state', 'social-state.json');
const st = JSON.parse(fs.readFileSync(P, 'utf8'));
const bj = (ms) => (ms ? new Date(Number(ms) + 8 * 3600e3).toISOString().slice(11, 19) : '-');

for (const [key, c] of Object.entries(st.conversations || {})) {
  if (!key.startsWith('private:')) continue;
  const rec = Array.isArray(c.recentMessages) ? c.recentMessages : [];
  const answered = new Set((c.answeredMessageIds || []).map(String));
  console.log(`\n=== ${key} ===`);
  console.log(`unread=${(c.unread || []).length}  pendingWakeReasons=${(c.pendingWakeReasons || []).length}  ` +
    `turnSteeredSeqs=[${(c.turnSteeredSeqs || []).join(',')}]  rotateTurns=${c.rotateTurns}  lastUnreadSeq=${c.lastUnreadSeq}`);

  const last = rec.slice(-16);
  // 从后往前找最后一条 AI 消息的下标
  let lastAiIdx = -1;
  for (let i = last.length - 1; i >= 0; i--) if (last[i] && last[i].isSelf) { lastAiIdx = i; break; }

  console.log('  seq  时间       方向  已回?  内容');
  last.forEach((m, i) => {
    const dir = m.isSelf ? 'AI  ' : '对方';
    const ok = m.isSelf ? '  -  ' : (m.messageId && answered.has(String(m.messageId)) ? ' ✓已回' : ' ✗未回');
    const txt = String(m.plain || m.text || '').replace(/\s+/g, ' ').slice(0, 26);
    const flag = (!m.isSelf && i > lastAiIdx) ? '   ← 在最后一条 AI 消息之后' : '';
    console.log(`  ${String(m.seq).padStart(4)}  ${bj(m.time)}  ${dir}  ${ok}  ${txt}${flag}`);
  });

  const unanswered = last.filter((m, i) => !m.isSelf && i > lastAiIdx);
  if (unanswered.length) {
    console.log(`  ⚠ 最后一条 AI 回复之后还有 ${unanswered.length} 条对方消息（seq ${unanswered.map((m) => m.seq).join(',')}）`);
  }
  if ((c.unread || []).length) {
    console.log('  ⚠ unread 里还剩：' + (c.unread || []).map((m) => `seq${m.seq}/${String(m.plain || '').slice(0, 12)}`).join(' | '));
  }
}
