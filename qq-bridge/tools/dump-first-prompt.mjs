// 打印轮换后首轮那条完整 prompt（模型开局到底拿到了什么）。
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

const texts = [];
for (const e of events) {
  if ((e.type || e.event?.type) !== 'user/message') continue;
  const d = e.data ?? e.event?.data ?? {};
  const msg = d.message ?? d;
  const content = msg?.content ?? msg?.parts ?? [];
  const t = (Array.isArray(content) ? content : []).map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('\n');
  texts.push({ seq: e.seq ?? e.event?.seq, t });
}

console.log(`共 ${texts.length} 条 user/message`);
const target = texts.find((x) => x.t.includes('[Wake] diving') || x.t.includes('diving'));
if (target) {
  console.log(`\n=== 轮换后首轮完整 prompt（seq=${target.seq}，共 ${target.t.length} 字符）===`);
  console.log(target.t);
} else {
  console.log('没找到 diving 那条；列出各条长度：');
  texts.forEach((x, i) => console.log(`  [${i}] seq=${x.seq} 长度=${x.t.length}  开头: ${x.t.slice(0, 60).replace(/\n/g, ' ')}`));
}
