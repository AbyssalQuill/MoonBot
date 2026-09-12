// 解出 DSH 会话正文，看模型究竟拿到了哪些内容（回答"它真不知道"）。
// zstd 多帧：先整包试，失败则按魔数 28 b5 2f fd 切帧逐帧解。
import fs from 'node:fs';
import zlib from 'node:zlib';

import { newestSessionFile } from './_sessions.mjs';

const FILE = process.argv[2] || newestSessionFile();

const buf = fs.readFileSync(FILE);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

let text = '';
// ⚠️ 这个文件是**多帧 zstd**：整包 zstdDecompressSync 只会解出第一帧（实测只得到 1 行），
// 必须按魔数 28 b5 2f fd 切帧、逐帧解。所以这里**始终**走切帧路径。
{
  const idx = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) idx.push(i);
  }
  console.log(`发现 ${idx.length} 个疑似帧头`);
  const parts = [];
  for (let k = 0; k < idx.length; k++) {
    const slice = buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length);
    try { parts.push(zlib.zstdDecompressSync(slice).toString('utf8')); } catch {}
  }
  text = parts.join('');
  console.log(`成功解出 ${parts.length}/${idx.length} 帧`);
}

const lines = text.split('\n').filter((l) => l.trim());
console.log(`JSONL 行数: ${lines.length}`);

let events = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }
console.log(`可解析事件: ${events.length}`);

const types = {};
for (const e of events) { const t = e.type || e.event?.type || '?'; types[t] = (types[t] || 0) + 1; }
console.log('\n=== 事件类型分布 ===');
Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([t, n]) => console.log(`  ${String(n).padStart(4)}  ${t}`));

const getType = (e) => e.type || e.event?.type;
const getData = (e) => e.data ?? e.event?.data ?? e;

console.log('\n=== 所有 user/message（模型看到的用户侧输入）===');
let n = 0;
for (const e of events) {
  if (getType(e) !== 'user/message') continue;
  const d = getData(e);
  const msg = d.message ?? d;
  const parts = msg?.content ?? msg?.parts ?? [];
  const txt = (Array.isArray(parts) ? parts : []).map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ');
  n++;
  console.log(`  [${n}] ${String(txt).replace(/\s+/g, ' ').slice(0, 150)}`);
}

console.log('\n=== 搜关键词 ===');
for (const kw of ['以后注意点', '注意点', '数组', '拆分', '笨']) {
  const hit = events.filter((e) => JSON.stringify(e).includes(kw));
  console.log(`  「${kw}」命中 ${hit.length} 处`);
}
