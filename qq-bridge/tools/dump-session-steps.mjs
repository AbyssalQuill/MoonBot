// 列出该会话里模型自己的输出（assistant/message），看每一轮它究竟说了什么、有没有调发送工具。
import fs from 'node:fs';
import zlib from 'node:zlib';

import { newestSessionFile } from './_sessions.mjs';

const FILE = process.argv[2] || newestSessionFile();
const buf = fs.readFileSync(FILE);
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const idx = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) idx.push(i);
}
const parts = [];
for (let k = 0; k < idx.length; k++) {
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length)).toString('utf8')); } catch {}
}
const events = parts.join('').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const T = (e) => e.type || e.event?.type;
const bj = (ms) => (Number(ms) > 0 ? new Date(Number(ms) + 8 * 3600e3).toISOString().slice(11, 19) : '-');

// 按 step 归拢：每步的 tool/call 与 assistant/message
const steps = new Map();
for (const e of events) {
  const t = T(e);
  const d = e.data ?? e.event?.data ?? {};
  const seq = e.seq ?? e.event?.seq ?? 0;
  const time = e.time ?? e.event?.time ?? 0;
  const stepKey = `${d.turn ?? '?'}/${d.step ?? '?'}`;
  if (!steps.has(stepKey)) steps.set(stepKey, { tools: [], texts: [], time });
  const cur = steps.get(stepKey);
  if (t === 'tool/call') cur.tools.push(String(d.name ?? d.tool ?? '?'));
  if (t === 'assistant/message') {
    const content = d.message?.content ?? d.content ?? [];
    const txt = (Array.isArray(content) ? content : []).map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
    if (txt.trim()) cur.texts.push(txt);
  }
  if (time) cur.time = Math.min(cur.time || time, time);
}

console.log('=== 每步：模型文本 + 调用的工具 ===');
for (const [k, v] of [...steps.entries()].sort((a, b) => (a[1].time || 0) - (b[1].time || 0))) {
  const hasSend = v.tools.some((n) => /qq_send_message|qq_proactive_send/.test(n));
  const mark = hasSend ? '✅发送' : (v.tools.length ? '  ' : '⚠无工具');
  console.log(`  ${bj(v.time)} 步${k.padEnd(6)} ${mark}  工具=[${v.tools.join(',')}]  文本="${v.texts.join(' ').replace(/\s+/g, ' ').slice(0, 60)}"`);
}

