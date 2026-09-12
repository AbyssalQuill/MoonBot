// 定位"一次就灌进上下文一大坨"的工具结果：把 tool/result 与 tool/call 按 callId 配起来，
// 按体积排序，并打印结果开头 —— 用来判断该工具是不是每轮都被调、值不值得瘦身。
// 用法：node tools/big-tool-results.mjs [session.jsonl.zstd]
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

import { SESSIONS_ROOT as SESS_ROOT } from './_sessions.mjs';
function newestSession(arg) {
  if (arg) return arg;
  const files = [];
  for (const dir of fs.readdirSync(SESS_ROOT)) {
    const p = path.join(SESS_ROOT, dir);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const s of fs.readdirSync(p)) {
      const f = path.join(p, s, 'session.jsonl.zstd');
      if (fs.existsSync(f)) files.push({ f, m: fs.statSync(f).mtimeMs });
    }
  }
  files.sort((a, b) => b.m - a.m);
  return files[0]?.f;
}
const FILE = newestSession(process.argv[2]);
const buf = fs.readFileSync(FILE);
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const idx = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) idx.push(i);
}
const parts = [];
for (let k = 0; k < idx.length; k++) {
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length)).toString('utf8')); } catch { /* 尾部残帧 */ }
}
const events = parts.join('').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const T = (e) => e.type || e.event?.type || '?';
const D = (e) => e.data ?? e.event?.data ?? {};

// callId -> 工具名（tool/call 里名字在 d.name，但也可能在 d.message.content[].toolName）
const callName = new Map();
for (const e of events) {
  if (!/tool[-/]call/i.test(T(e))) continue;
  const d = D(e);
  const id = d.callId ?? d.id ?? d.call?.id ?? d.message?.source?.callId ?? d.message?.content?.[0]?.toolCallId;
  const name = d.name ?? d.tool ?? d.call?.name ?? d.message?.content?.[0]?.toolName ?? d.message?.content?.[0]?.name;
  if (id && name) callName.set(String(id), String(name));
}

function resultText(d) {
  const msg = d.message ?? d;
  const content = msg?.content ?? [];
  const parts = [];
  for (const piece of Array.isArray(content) ? content : []) {
    const inner = piece?.content ?? [];
    for (const it of Array.isArray(inner) ? inner : []) {
      if (typeof it === 'string') parts.push(it);
      else if (it?.type === 'text' && it.text) parts.push(String(it.text));
      else if (it?.text) parts.push(String(it.text));
    }
    if (piece?.type === 'text' && piece.text) parts.push(String(piece.text));
  }
  return parts.join('\n');
}

const results = events.filter((e) => /tool\/result/.test(T(e))).map((e) => {
  const d = D(e);
  const id = String(d.callId ?? d.id ?? d.message?.source?.callId ?? '');
  const text = resultText(d);
  return { id, name: callName.get(id) || '(未知)', chars: JSON.stringify(d).length, textChars: text.length, head: text.slice(0, 260) };
}).sort((a, b) => b.chars - a.chars);

console.log(`tool/result 共 ${results.length} 条，总 ${results.reduce((a, r) => a + r.chars, 0)} chars\n`);
console.log('=== 最大的 10 条 ===');
for (const r of results.slice(0, 10)) {
  console.log(`\n[${r.chars} chars, 正文 ${r.textChars}] ${r.name}  callId=${r.id}`);
  console.log('  ' + r.head.replace(/\s+/g, ' ').slice(0, 240));
}

const byName = new Map();
for (const r of results) {
  const a = byName.get(r.name) || { n: 0, chars: 0, max: 0 };
  a.n++; a.chars += r.chars; a.max = Math.max(a.max, r.chars);
  byName.set(r.name, a);
}
console.log('\n=== 按工具名汇总（结果体积）===');
for (const [n, a] of [...byName.entries()].sort((x, y) => y[1].chars - x[1].chars)) {
  console.log(`  ${n.padEnd(44)} 次=${String(a.n).padStart(3)}  chars=${String(a.chars).padStart(8)}  单次最大=${String(a.max).padStart(7)}`);
}
