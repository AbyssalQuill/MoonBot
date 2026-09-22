// tools/compaction-threshold.mjs —— 用**实测数据**算最省钱的上下文压缩阈值（2026-09-22 第四次重算）
//
// 为什么需要这个脚本：阈值改过四次（0.06 → 0.12 → 0.08 → 0.16），前三次都是拿"每次请求平均花费
// 对上下文大小"的**粗口径**看的，把两类完全不同的请求混进了同一个桶：
//   ① 常规步 —— 前缀命中缓存，只按缓存价计费（很便宜）；
//   ② 重建步 —— 压缩/轮换/长时间空闲之后，前缀变了，**整段上下文要按未命中重读一遍**（很贵）。
// 于是"上下文越大越贵"这个结论看着成立，其实是"重建次数 × 上下文"在作怪。本脚本把两者分开量：
//   ① 对 50k 以上的常规步做回归 → 得到"上下文每多 1 token、每次请求多花多少"（≈ 缓存命中价）；
//   ② 量出"一次重建"的真实单价，以及它每天发生几次；
//   ③ 用"每天成本 = 步数×(固定 + 边际×平均上下文) + 每天重建次数×重建单价"扫阈值，取最小值。
// 所有参数都从 state/token-usage.jsonl 现场量，改价（config.tokenCost）后重跑即可。
//
// 用法：node tools/compaction-threshold.mjs [stateDir=../state] [windowTokens=1000000]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stateDir = process.argv[2] || path.resolve(HERE, '..', 'state');
const W = Number(process.argv[3] || 1000000);

// ── 单价（与 config.tokenCost 同源；改价请同时改这里与管理端）──────────────────
const PRICE = { pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2, peakHours: new Set([9, 10, 11, 14, 15, 16, 17]) };
const BJ = (t) => new Date(Number(t) + 8 * 3600e3);
const bjHour = (t) => BJ(t).getUTCHours();
const costOf = (r) => {
  const mult = PRICE.peakHours.has(bjHour(r.tsMs)) ? PRICE.peakMult : 1;
  return ((Number(r.cacheRead) * PRICE.pHit + Number(r.prompt) * PRICE.pMiss + Number(r.completion) * PRICE.pOut) / 1e6) * mult;
};

const file = path.join(stateDir, 'token-usage.jsonl');
if (!fs.existsSync(file)) {
  console.error(`找不到用量库：${file}\n（这是桥侧记账文件；在线上跑：cd /root/qq-bridge && node tools/compaction-threshold.mjs）`);
  process.exit(2);
}
const rows = [];
for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  try { rows.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
}
// 只看**主聊天**会话（private:/group:）：旁路（摘要器、学习、记忆抽取）的频率与阈值无关
const main = rows.filter((r) => /^(private|group):/.test(String(r.convKey || '')) && r.est !== true && Number(r.cacheRead) > 0);
if (main.length < 200) {
  console.error(`主聊天样本只有 ${main.length} 条，太少，阈值算不准（先让机器人跑一两天）。`);
  process.exit(2);
}
const sum = (a, f) => a.reduce((x, y) => x + Number(f(y) || 0), 0);
const mean = (a, f) => (a.length ? sum(a, f) / a.length : 0);
const S = (n) => Math.round(n).toLocaleString('en-US');
const spanDays = Math.max(0.5, (Math.max(...main.map((r) => r.tsMs)) - Math.min(...main.map((r) => r.tsMs))) / 86400e3);
const stepsPerDay = main.length / spanDays;
const measuredPerDay = sum(main, costOf) / spanDays;

console.log(`样本：主聊天 ${main.length} 次请求 / ${spanDays.toFixed(1)} 天 → ${stepsPerDay.toFixed(0)} 步每天，实测 ¥${measuredPerDay.toFixed(3)}/天`);

// ① 边际：50k 以上回归（避开"刚重建完"的冷启动桶）
const warm = main.filter((r) => Number(r.cacheRead) >= 50000);
const mx = mean(warm, (r) => r.cacheRead);
const my = mean(warm, costOf);
let sxy = 0; let sxx = 0;
for (const r of warm) { const d = Number(r.cacheRead) - mx; sxy += d * (costOf(r) - my); sxx += d * d; }
const b = sxx > 0 ? sxy / sxx : 0;
const a0 = my - b * mx;
console.log(`① 边际（${warm.length} 次 ≥50k）：每次 = ¥${a0.toFixed(5)} + ${(b * 1e6).toFixed(4)} ¥/M × 上下文（缓存价 ${(PRICE.pHit * 1e6).toFixed(2)} ¥/M）`);

// ② 重建单价与周期长度：上下文大幅回落（< 前一次 60%）= 压缩/轮换发生
const bySess = new Map();
for (const r of main) { const k = r.convKey || r.sessionId; if (!bySess.has(k)) bySess.set(k, []); bySess.get(k).push(r); }
const rebuildCosts = []; const cycleSteps = []; const floors = [];
for (const [, list] of bySess) {
  list.sort((x, y) => (x.tsMs || 0) - (y.tsMs || 0));
  let start = 0;
  for (let i = 1; i < list.length; i++) {
    const prev = Number(list[i - 1].cacheRead) || 0;
    const cur = Number(list[i].cacheRead) || 0;
    if (cur < prev * 0.6) {
      if (i - start >= 5) cycleSteps.push(i - start);
      rebuildCosts.push(costOf(list[i]));
      floors.push(cur);
      start = i;
    }
  }
}
const rebuild = mean(rebuildCosts, (v) => v);
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] || 0;
const N0 = med(cycleSteps);
const Rfloor = med(floors) || 28672;
const g = N0 > 0 ? Math.max(500, (med(main.map((r) => Number(r.cacheRead))) - Rfloor) / N0) : 3500;
console.log(`② 重建：${rebuildCosts.length} 次 / ${spanDays.toFixed(1)} 天 = ${(rebuildCosts.length / spanDays).toFixed(1)} 次每天，每次 ¥${rebuild.toFixed(5)}`);
console.log(`   实测：压缩后落点 ${S(Rfloor)} tok · 每周期 ${N0} 步 · ⇒ 每步增长 g=${S(g)} tok`);

// ③ 扫阈值
function model(ratio) {
  const T = Math.round(ratio * W);
  if (T <= Rfloor + 2 * g) return null;
  const N = (T - Rfloor) / g;
  const Cbar = (Rfloor + T) / 2;
  const stepsCost = stepsPerDay * (a0 + b * Cbar);
  const cyclesPerDay = stepsPerDay / N;
  const rebuildCost = cyclesPerDay * rebuild;
  return { ratio, T, N, Cbar, cyclesPerDay, stepsCost, rebuildCost, perDay: stepsCost + rebuildCost };
}
const list = [];
for (let r = 0.04; r <= 0.6 + 1e-9; r += 0.02) { const m = model(r); if (m) list.push(m); }
const best = list.reduce((x, y) => (y.perDay < x.perDay ? y : x));
// 标定：这份用量数据是在**哪个阈值**下跑出来的？拿模型在同一点的值跟实测比才叫标定
//（拿模型在 0.16 的值去比"0.08 时期测出来的真值"，是两个不同配置，比不出误差）。
let observedRatio = 0.08;
try {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(stateDir, '..', 'config.json'), 'utf8'));
  const v = Number(cfg?.dshCompaction?.thresholdRatio);
  if (Number.isFinite(v) && v > 0) observedRatio = v;
} catch { /* 读不到就用 0.08 */ }
const atObserved = model(observedRatio) || best;
const flat = list.filter((c) => c.perDay <= best.perDay * 1.02);

console.log('\n=== 扫描（比例 → 模型每天成本）===');
for (const c of list) {
  if (Math.abs((c.ratio * 100) % 4) > 1e-9 && c.ratio !== best.ratio) continue;
  console.log(`  ${(c.ratio * 100).toFixed(0).padStart(3)}%  T=${S(c.T).padStart(9)}  周期 ${String(Math.round(c.N)).padStart(3)} 步  重建 ${c.cyclesPerDay.toFixed(1).padStart(4)}/天  平均上下文 ${S(c.Cbar).padStart(9)}  ¥${c.perDay.toFixed(3)}/天${c === best ? '  ★' : ''}`);
}
console.log(`\n★ 最省：${(best.ratio * 100).toFixed(1)}%（T=${S(best.T)} tok）→ ¥${best.perDay.toFixed(3)}/天`);
console.log(`  稳健区间（差 ≤2%）：${(flat[0].ratio * 100).toFixed(0)}% ~ ${(flat[flat.length - 1].ratio * 100).toFixed(0)}%`);
console.log(`  标定：这份用量数据是在阈值 ${(observedRatio * 100).toFixed(0)}% 下跑出来的 → 模型在同一点 ¥${atObserved.perDay.toFixed(3)}/天 · 实测 ¥${measuredPerDay.toFixed(3)}/天（偏差 ${(100 * (atObserved.perDay - measuredPerDay) / measuredPerDay).toFixed(0)}%；越接近 0 越可信）`);
console.log('\n改法：qq-bridge/config.json 的 dshCompaction.thresholdRatio（管理端「Core 设置」也能改），桥热加载后自动重写 DSH 的 cordis.patch.yml，不用重启。');
