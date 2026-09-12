// 只统计**有 cacheRead 字段**的行（9-11 之后的真实数据），量化：
//   ① 缓存命中率  ② 每次会话轮换要额外付多少全价 token（缓存重建成本）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时目录从本文件位置推导（tools/ -> qq-bridge/），绝不写死盘符/安装路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILE = path.join(ROOT, 'state', 'token-usage.jsonl');
const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.cacheRead !== undefined);   // ← 关键：只保留有该字段的

console.log(`有 cacheRead 字段的行: ${rows.length} 条`);

const byConv = new Map();
const bySess = new Map();
for (const r of rows) {
  const key = String(r.convKey ?? '(无)');
  const sid = String(r.sessionId ?? '?');
  const t = Number(r.total) || 0, cr = Number(r.cacheRead) || 0, c = Number(r.completion) || 0;
  const fresh = Math.max(0, t - cr - c);
  const a = byConv.get(key) || { n: 0, t: 0, cr: 0, fresh: 0, c: 0, sess: new Set() };
  a.n++; a.t += t; a.cr += cr; a.fresh += fresh; a.c += c; a.sess.add(sid);
  byConv.set(key, a);
  const b = bySess.get(sid) || { key, n: 0, t: 0, cr: 0, fresh: 0, first: null, firstFresh: 0, ts: [] };
  b.n++; b.t += t; b.cr += cr; b.fresh += fresh;
  if (b.first === null || Number(r.tsMs) < b.first) { b.first = Number(r.tsMs); }
  b.ts.push({ ts: Number(r.tsMs), fresh });
  bySess.set(sid, b);
}

console.log('\n=== 按 QQ 会话（只算有字段的行）===');
console.log('会话'.padEnd(28) + '调用   总token   缓存读    缓存率  全价新输入  session数');
for (const [key, v] of [...byConv.entries()].sort((a, b) => b[1].t - a[1].t)) {
  console.log(
    key.padEnd(28) +
    String(v.n).padStart(5) + '  ' +
    String(v.t).padStart(8) + '  ' +
    String(v.cr).padStart(8) + '  ' +
    String(Math.round((v.cr / (v.t || 1)) * 100) + '%').padStart(6) + '  ' +
    String(v.fresh).padStart(10) + '  ' +
    String(v.sess.size).padStart(8)
  );
}

// 轮换成本 = 每个会话的**第一次调用**里那部分全价新输入（缓存必须从零重建）
console.log('\n=== 轮换成本：每个 session 第一次调用的全价新输入 ===');
let rotTotal = 0, rotN = 0;
const list = [];
for (const [sid, b] of bySess) {
  b.ts.sort((a, c) => a.ts - c.ts);
  const firstFresh = b.ts[0]?.fresh ?? 0;
  rotTotal += firstFresh; rotN++;
  list.push({ sid, key: b.key, firstFresh, n: b.n, t: b.t });
}
console.log(`共 ${rotN} 个 session，首调用全价新输入合计 = ${rotTotal} token（平均每个 ${Math.round(rotTotal / Math.max(1, rotN))}）`);
list.sort((a, b) => b.firstFresh - a.firstFresh).slice(0, 10).forEach((x) => {
  console.log(`  ${x.sid.slice(0, 20)}…  ${String(x.key).padEnd(22)} 首次全价=${String(x.firstFresh).padStart(6)}  该会话共 ${x.n} 次/${x.t} token`);
});

// 稳态 vs 冷启动
const allT = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
const allCr = rows.reduce((a, r) => a + (Number(r.cacheRead) || 0), 0);
const allC = rows.reduce((a, r) => a + (Number(r.completion) || 0), 0);
const allFresh = allT - allCr - allC;
console.log(`\n=== 总计 ===`);
console.log(`total=${allT}  缓存读=${allCr}（${Math.round((allCr / allT) * 100)}%）  全价新输入=${allFresh}（${Math.round((allFresh / allT) * 100)}%）  输出=${allC}`);
console.log(`其中"轮换重建"占全价新输入的 ${Math.round((rotTotal / Math.max(1, allFresh)) * 100)}%`);
