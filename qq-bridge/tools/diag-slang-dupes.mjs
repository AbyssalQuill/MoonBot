/* 看现有黑话库里有多少"同一个词的不同写法"（诊断"学过了还一直在候选里"）。
 * 用与 upsertSlangEntry 同一套归一化键分组：归一化后同键、却有两条以上 → 它们是重复的。
 *
 * 用法（cwd = /root/qq-bridge）：node tools/diag-slang-dupes.mjs [state/slang.json]
 */
import fs from 'node:fs';
import { slangKey } from '../src/slang-learner.js';

const file = process.argv[2] || 'state/slang.json';
let entries = [];
try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('读不到 ' + file + '：' + e.message); process.exit(0); }
if (!Array.isArray(entries)) { console.log('不是数组'); process.exit(0); }

const g = new Map();
for (const e of entries) {
  const k = slangKey(e?.content);
  if (!k) continue;
  if (!g.has(k)) g.set(k, []);
  g.get(k).push(e);
}
const dup = [...g.entries()].filter(([, v]) => v.length > 1);

const cnt = {};
for (const e of entries) cnt[e?.status] = (cnt[e?.status] || 0) + 1;

console.log(`词条总数 ${entries.length}  状态分布 ${JSON.stringify(cnt)}`);

/* ── 为什么整库卡在候选里 ──────────────────────────────────────────────────
 * 抽取端只在 `thresholds`（默认 [2,4,8]）**恰好命中**时才会把候选排进研究会话：
 *     if (entry.status === CANDIDATE && thresholds.includes(entry.count) && entry.count > entry.lastInferenceCount)
 * 所以有含义解释、有 lastInferenceCount 的条数能直接反映"研究到底跑过没有"。 */
const byCount = {};
for (const e of entries) byCount[e?.count ?? 0] = (byCount[e?.count ?? 0] || 0) + 1;
const withMeaning = entries.filter((e) => String(e?.meaning ?? '').trim()).length;
const researched = entries.filter((e) => Number(e?.lastInferenceCount) > 0).length;
console.log(`count 分布 ${JSON.stringify(byCount)}`);
console.log(`有含义解释的 ${withMeaning} 条 / 被研究过的（lastInferenceCount>0）${researched} 条`);
console.log(`→ 这两个数如果是 0，说明**研究会话从来没跑成**，候选自然永远确认不了\n`);
console.log(`归一化后**同键重复**的组：${dup.length} 组（这些就是"同一个词占了两条"）\n`);
for (const [k, v] of dup.slice(0, 20)) {
  console.log(`  「${k}」`);
  for (const e of v) console.log(`      ${JSON.stringify(e.content)}  status=${e.status}  count=${e.count}`);
}
if (!dup.length) console.log('（没有重复 —— 说明库是干净的，那"学过了还在候选"就来自抽取端每轮重提，本次改动已从提示词源头堵住）');
