// 上下文构成分析：单个 session 的历史里，究竟是**谁**把上下文撑大的。
// 目的：主人报「额度消耗还是过度大」。每一步都会把整个上下文重发一遍，所以"上下文里有什么"
// 直接等于"每步要花多少"。这里按事件类型 / 角色 / 工具名 统计累积字符数，找出前几名。
//
// 用法：node tools/context-breakdown.mjs [session.jsonl.zstd]
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
if (!FILE || !fs.existsSync(FILE)) { console.error('找不到 session 文件:', FILE); process.exit(1); }
const buf = fs.readFileSync(FILE);
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const idx = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) idx.push(i);
}
const parts = [];
for (let k = 0; k < idx.length; k++) {
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length)).toString('utf8')); } catch { /* 尾部残帧忽略 */ }
}
const events = parts.join('').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const T = (e) => e.type || e.event?.type || '?';
const D = (e) => e.data ?? e.event?.data ?? {};

console.log(`文件: ${FILE}`);
console.log(`事件数: ${events.length}\n`);

// ① 按事件类型统计条数与字符数（"字符数"≈上下文体积）
const byType = new Map();
for (const e of events) {
  const t = T(e);
  const s = JSON.stringify(D(e)) ?? '';
  const a = byType.get(t) || { n: 0, chars: 0 };
  a.n++; a.chars += s.length;
  byType.set(t, a);
}
console.log('=== ① 按事件类型（chars ≈ 该类型在上下文里占的字符）===');
for (const [t, a] of [...byType.entries()].sort((x, y) => y[1].chars - x[1].chars)) {
  console.log(`  ${t.padEnd(24)} 条数=${String(a.n).padStart(4)}  chars=${String(a.chars).padStart(9)}  ~tokens=${String(Math.round(a.chars / 3)).padStart(8)}`);
}

// ② 工具结果：按工具名统计（这是最常见的"隐形膨胀源"）
const byTool = new Map();
for (const e of events) {
  const d = D(e);
  const name = d.name ?? d.tool ?? d.toolName ?? null;
  const t = T(e);
  if (!name) continue;
  if (!/tool/i.test(t)) continue;
  const s = JSON.stringify(d.result ?? d.content ?? d.output ?? d.arguments ?? d.args ?? d) ?? '';
  const a = byTool.get(name) || { n: 0, chars: 0, max: 0 };
  a.n++; a.chars += s.length; a.max = Math.max(a.max, s.length);
  byTool.set(name, a);
}
console.log('\n=== ② 按工具名（含参数与结果）===');
for (const [n, a] of [...byTool.entries()].sort((x, y) => y[1].chars - x[1].chars).slice(0, 20)) {
  console.log(`  ${n.padEnd(46)} 次=${String(a.n).padStart(4)}  chars=${String(a.chars).padStart(9)}  单次最大=${String(a.max).padStart(7)}`);
}

// ③ 消息角色：user / assistant / tool 的历史体积
const byRole = new Map();
for (const e of events) {
  const d = D(e);
  const msg = d.message ?? d;
  const role = msg?.role ?? d.role ?? (T(e).startsWith('assistant') ? 'assistant' : T(e).startsWith('user') ? 'user' : null);
  if (!role) continue;
  const s = JSON.stringify(msg.content ?? msg) ?? '';
  const a = byRole.get(role) || { n: 0, chars: 0 };
  a.n++; a.chars += s.length;
  byRole.set(role, a);
}
console.log('\n=== ③ 按消息角色 ===');
for (const [r, a] of [...byRole.entries()].sort((x, y) => y[1].chars - x[1].chars)) {
  console.log(`  ${r.padEnd(12)} 条数=${String(a.n).padStart(4)}  chars=${String(a.chars).padStart(9)}  ~tokens=${String(Math.round(a.chars / 3)).padStart(8)}`);
}

// ④ 单个最大的事件（前 12 名）——"谁一次就灌进来一大坨"
const big = events.map((e) => ({ t: T(e), d: D(e), s: JSON.stringify(D(e)) ?? '' }))
  .sort((a, b) => b.s.length - a.s.length).slice(0, 12);
console.log('\n=== ④ 单条最大的事件（前 12）===');
for (const b of big) {
  const name = b.d.name ?? b.d.tool ?? b.d.role ?? '';
  console.log(`  ${String(b.s.length).padStart(7)} chars  ${b.t}${name ? ' / ' + name : ''}`);
}

// ⑤ 最后一个请求的实际上下文估算：所有历史事件字符数之和
const totalChars = [...byType.values()].reduce((a, x) => a + x.chars, 0);
console.log(`\n=== ⑤ 会话历史总字符 ${totalChars}  ≈ ${Math.round(totalChars / 3)} tokens（不含工具 schema 与 system prompt）===`);
