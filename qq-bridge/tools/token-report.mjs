// 聚合 token-usage.jsonl：搞清楚"钱到底花在哪一步、缓存命中多少"。
// 用法：node tools/token-report.mjs [条数]
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'state', 'token-usage.jsonl');
const tailN = Number(process.argv[2]) || 400;

if (!fs.existsSync(FILE)) {
  console.log('没有 token-usage.jsonl：' + FILE);
  process.exit(0);
}
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
const rows = [];
for (const l of lines.slice(-tailN)) {
  try { rows.push(JSON.parse(l)); } catch {}
}
console.log(`共 ${lines.length} 行，本次分析最近 ${rows.length} 行`);
if (!rows.length) process.exit(0);

// 探明字段
console.log('\n=== 单条样本（字段名）===');
console.log(JSON.stringify(rows[rows.length - 1], null, 1).slice(0, 700));

const num = (o, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
    if (Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
};

let sumPrompt = 0, sumCacheRead = 0, sumCacheWrite = 0, sumCompletion = 0, sumTotal = 0, n = 0;
const bySession = new Map();
for (const r of rows) {
  const p = num(r, 'prompt', 'promptTokens', 'usage.prompt', 'usage.promptTokens', 'input');
  const cr = num(r, 'cacheRead', 'cache_read', 'promptCacheHitTokens', 'usage.cacheRead', 'usage.promptCacheHitTokens');
  const cw = num(r, 'cacheWrite', 'cache_write', 'usage.cacheWrite');
  const c = num(r, 'completion', 'completionTokens', 'usage.completion', 'output');
  const t = num(r, 'total', 'totalTokens', 'usage.total') || (p + c);
  if (!t) continue;
  n++;
  sumPrompt += p; sumCacheRead += cr; sumCacheWrite += cw; sumCompletion += c; sumTotal += t;
  const sid = String(r.sessionId ?? r.session ?? '?').slice(0, 18);
  const cur = bySession.get(sid) || { t: 0, cr: 0, n: 0 };
  cur.t += t; cur.cr += cr; cur.n++;
  bySession.set(sid, cur);
}

if (n) {
  console.log(`\n=== 最近 ${n} 次调用合计 ===`);
  console.log(`total=${sumTotal}  prompt=${sumPrompt}  缓存读=${sumCacheRead}  ≈${sumPrompt ? Math.round((sumCacheRead / sumPrompt) * 100) : 0}%`);
  console.log(`completion=${sumCompletion}  缓存写=${sumCacheWrite}`);
  console.log(`每次调用平均 total=${Math.round(sumTotal / n)}  prompt=${Math.round(sumPrompt / n)}  缓存读=${Math.round(sumCacheRead / n)}`);

  console.log('\n=== 按会话分组（前 8）===');
  [...bySession.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 8).forEach(([sid, v]) => {
    console.log(`  ${sid}…  调用 ${v.n} 次  total=${v.t}  其中缓存读=${v.cr}（${v.t ? Math.round((v.cr / v.t) * 100) : 0}%）`);
  });
}
