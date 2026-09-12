// 第二份报告：按 QQ 会话分组，量化"冷会话（0% 缓存命中）"到底是谁、有多贵。
// 这是判断"切换会话到底烧掉多少"的关键证据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时目录从本文件位置推导（tools/ -> qq-bridge/），绝不写死盘符/安装路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILE = path.join(ROOT, 'state', 'token-usage.jsonl');
const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const num = (o, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
    if (Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
};

const byConv = new Map();
const sessOfConv = new Map();
for (const r of rows) {
  const key = String(r.convKey ?? '(无)');
  const sid = String(r.sessionId ?? '?');
  const t = num(r, 'total');
  const cr = num(r, 'cacheRead');
  const p = num(r, 'prompt');
  const c = num(r, 'completion');
  if (!t) continue;
  const cur = byConv.get(key) || { n: 0, t: 0, cr: 0, p: 0, c: 0, sids: new Map() };
  cur.n++; cur.t += t; cur.cr += cr; cur.p += p; cur.c += c;
  cur.sids.set(sid, (cur.sids.get(sid) || 0) + 1);
  byConv.set(key, cur);
  if (!sessOfConv.has(key)) sessOfConv.set(key, new Set());
  sessOfConv.get(key).add(sid);
}

console.log('=== 按 QQ 会话分组（按总 token 降序）===');
console.log('会话'.padEnd(30) + '调用  总token    缓存读    缓存率  非缓存输入  会话数');
for (const [key, v] of [...byConv.entries()].sort((a, b) => b[1].t - a[1].t)) {
  const ratio = v.t ? Math.round((v.cr / v.t) * 100) : 0;
  const cold = v.t - v.cr - v.c;
  console.log(
    key.padEnd(30) +
    String(v.n).padStart(4) + '  ' +
    String(v.t).padStart(9) + '  ' +
    String(v.cr).padStart(9) + '  ' +
    String(ratio + '%').padStart(6) + '  ' +
    String(cold).padStart(10) + '  ' +
    String(v.sids.size).padStart(5)
  );
}

console.log('\n=== 每个会话用过几个 DSH session（= 轮换次数+1）===');
for (const [key, sids] of [...sessOfConv.entries()].sort((a, b) => b[1].size - a[1].size)) {
  if (sids.size <= 1) continue;
  console.log(`  ${key}: ${sids.size} 个 session`);
  [...sids].slice(0, 8).forEach((s) => console.log(`      ${s}…`));
}

console.log('\n=== 冷会话（缓存读=0）清单 ===');
const coldSess = new Map();
for (const r of rows) {
  const sid = String(r.sessionId ?? '?');
  const t = num(r, 'total'), cr = num(r, 'cacheRead');
  if (!t) continue;
  const cur = coldSess.get(sid) || { n: 0, t: 0, cr: 0, key: String(r.convKey ?? '?') };
  cur.n++; cur.t += t; cur.cr += cr;
  coldSess.set(sid, cur);
}
const colds = [...coldSess.entries()].filter(([, v]) => v.cr === 0);
let coldTok = 0, coldCalls = 0;
for (const [, v] of colds) { coldTok += v.t; coldCalls += v.n; }
console.log(`共 ${colds.length} 个 session / ${coldCalls} 次调用 / ${coldTok} token（全部按全价计）`);
for (const [sid, v] of colds.sort((a, b) => b[1].t - a[1].t).slice(0, 10)) {
  console.log(`  ${sid}…  convKey=${v.key}  调用 ${v.n}  全价 token ${v.t}`);
}
