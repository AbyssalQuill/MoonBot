// 抽取 DSH 会话里最近一次 request/header 的工具 schema 名单与体积
// 用法: node tools-dump-toolschema.mjs <session.jsonl.zstd>
import { readFileSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';

const file = process.argv[2];
if (!file) { console.error('need path'); process.exit(1); }
const buf = readFileSync(file);

// 多帧 zstd：按 magic 28 b5 2f fd 切帧
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
}
starts.push(buf.length);
const frames = [];
for (let i = 0; i < starts.length - 1; i++) frames.push(buf.subarray(starts[i], starts[i + 1]));

async function inflate(frame) {
  const z = createZstdDecompress();
  const chunks = [];
  z.on('data', (c) => chunks.push(c));
  await new Promise((res, rej) => { z.on('end', res); z.on('error', rej); z.end(frame); });
  return Buffer.concat(chunks).toString('utf8');
}

let text = '';
for (const f of frames) {
  try { text += await inflate(f); } catch (e) { /* skip */ }
}
const lines = text.split('\n').filter(Boolean);
let last = null;
for (const line of lines) {
  try {
    const obj = JSON.parse(line);
    const s = JSON.stringify(obj);
    if (s.includes('"tools"') && s.includes('request/header')) last = obj;
  } catch {}
}
if (!last) {
  // 退而求其次：找任何带 tools 的行
  for (const line of lines) {
    if (line.includes('"tools"')) { try { last = JSON.parse(line); } catch {} }
  }
}
if (!last) { console.log('no tools found; lines=' + lines.length); process.exit(0); }
const tools = last?.data?.header?.tools ?? last?.header?.tools ?? null;
if (!tools) { console.log('no header.tools; keys=' + Object.keys(last).join(',')); process.exit(0); }
const rows = tools.map((t) => ({ name: t?.name ?? t?.function?.name ?? '?', chars: JSON.stringify(t).length }))
  .sort((a, b) => b.chars - a.chars);
let total = 0;
for (const r of rows) total += r.chars;
console.log('tool count=' + rows.length + '  total chars=' + total);
const sysLen = JSON.stringify(last?.data?.header?.system ?? '').length;
console.log('system chars=' + sysLen);
for (const r of rows) console.log(String(r.chars).padStart(7), r.name);
