// 定位「以后注意点」在会话事件里出现的位置（哪类事件、什么上下文）。
import fs from 'node:fs';
import zlib from 'node:zlib';

import { newestSessionFile } from './_sessions.mjs';

const FILE = process.argv[2] || newestSessionFile();
const KW = process.argv[3] || '以后注意点';

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

const byType = {};
for (const e of events) {
  const s = JSON.stringify(e);
  if (!s.includes(KW)) continue;
  const t = e.type || e.event?.type || '?';
  byType[t] = (byType[t] || 0) + 1;
}
console.log(`=== 含「${KW}」的事件类型分布 ===`);
Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}  ${t}`));

console.log(`\n=== 前 3 个命中片段的上下文 ===`);
let shown = 0;
for (const e of events) {
  const s = JSON.stringify(e);
  const p = s.indexOf(KW);
  if (p < 0) continue;
  console.log(`--- 事件类型: ${e.type || e.event?.type}  seq=${e.seq ?? e.event?.seq ?? '-'}`);
  console.log('    ' + s.slice(Math.max(0, p - 260), p + 140).replace(/\\n/g, ' | '));
  if (++shown >= 3) break;
}

// 归一化：把「注」或「意」拆开的情况也找一下
console.log(`\n=== 原始文本里 "注意" 的出现位置（前 6 处）===`);
let c = 0;
for (const e of events) {
  const s = JSON.stringify(e);
  let p = -1;
  while ((p = s.indexOf('注意', p + 1)) >= 0) {
    console.log(`--- ${e.type || e.event?.type}: …${s.slice(Math.max(0, p - 70), p + 60).replace(/\\n/g, ' | ')}…`);
    if (++c >= 6) break;
  }
  if (c >= 6) break;
}
