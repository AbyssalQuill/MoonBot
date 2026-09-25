// dsh-compaction-math.mjs —— 桌面端 DSH「永久会话」下的最优压缩阈值
//
// 模型与 MoonBot 的 docs/TECHNICAL.md 同源，但**参数按桌面端自己的实测数据标定**：
//   每次请求成本 = a₀ + b·C     （C = 本次上下文；b ≈ 缓存读价，因为 98.8% 的输入是缓存读）
//   每天成本     = steps·(a₀ + b·(R+T)/2) + (steps·g/(T−R))·rebuildCost
// 对 T 求导令零：(T−R)² = 2·g·rebuildCost / b
//
// 用法：node dsh-compaction-math.mjs [窗口=1000000] [每步增长g=5500] [每天步数=400] [落点R=20000]
import fs from 'node:fs';
import path from 'node:path';

// ── 单价：DeepSeek 官方（空闲时段，元/百万 token）──────────────────────────────
// 来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//   缓存命中 0.02 · 缓存未命中 1 · 输出 4；高峰时段 ×2
const PRICE = { pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2 };
const T = (v) => v * 1e-6;                       // 元/百万 → 元/个

const W = Number(process.argv[2] || 1000000);
const g = Number(process.argv[3] || 5500);
const stepsPerDay = Number(process.argv[4] || 400);
const R = Number(process.argv[5] || 20000);
const s = 3000;                                  // 摘要体量（token）

const b = T(PRICE.pHit);                         // 每 token 每步的承载成本 = 缓存读价
const a0 = 0.002;                                // 每步固定开销
const rebuildCost = T(PRICE.pMiss) * R + T(PRICE.pOut) * s;

console.log('=== 桌面端参数（标定来源见脚本注释）===');
console.log(`  窗口 W            = ${W.toLocaleString('en-US')} tok`);
console.log(`  每步增长 g        = ${g.toLocaleString('en-US')} tok   （由本机实测 uncached+output ÷ 步数推得）`);
console.log(`  每天步数          = ${stepsPerDay}`);
console.log(`  压缩后落点 R      = ${R.toLocaleString('en-US')} tok`);
console.log(`  单价              = 命中 ${PRICE.pHit} / 未命中 ${PRICE.pMiss} / 输出 ${PRICE.pOut} 元每百万（高峰 ×${PRICE.peakMult}）`);
console.log(`  承载边际 b        = ${(b * 1e9).toFixed(4)}e-9 元/token/步`);
console.log(`  单次重建成本      = ${T(PRICE.pMiss) * R ? '' : ''}${rebuildCost.toFixed(5)} 元（= 未命中读回 R + 输出摘要 s）`);

function model(ratio) {
  const Tt = Math.round(ratio * W);
  if (Tt <= R + 2 * g) return null;
  const N = (Tt - R) / g;                        // 一个周期的步数
  const Cbar = (R + Tt) / 2;                     // 周期内平均上下文
  const carry = stepsPerDay * b * Cbar;
  const cycles = stepsPerDay / N;
  const rebuild = cycles * rebuildCost;
  const fixed = stepsPerDay * a0;
  return { ratio, T: Tt, N, Cbar, cycles, carry, rebuild, fixed, perDay: fixed + carry + rebuild };
}

const list = [];
for (let r = 0.02; r <= 1.0 + 1e-9; r += 0.02) { const m = model(r); if (m) list.push(m); }
const best = list.reduce((x, y) => (y.perDay < x.perDay ? y : x));
const flat = list.filter((c) => c.perDay <= best.perDay * 1.02);

// 闭式解
const closed = R + Math.sqrt(2 * g * rebuildCost / b);

console.log('\n=== 扫描（阈值 → 模型每天成本）===');
console.log('  阈值      阈值tokens    周期步数   重建/天    平均上下文        每天成本');
for (const c of list) {
  const show = Math.abs((c.ratio * 100) % 8) < 1e-9 || c === best;
  if (!show) continue;
  console.log(`  ${(c.ratio * 100).toFixed(0).padStart(3)}%   ${c.T.toLocaleString('en-US').padStart(10)}   ${String(Math.round(c.N)).padStart(6)}   ${c.cycles.toFixed(1).padStart(6)}   ${Math.round(c.Cbar).toLocaleString('en-US').padStart(10)}   ¥${c.perDay.toFixed(4)}${c === best ? '  ★' : ''}`);
}

console.log('\n=== 结论 ===');
console.log(`  闭式解 T* = R + √(2·g·重建成本/b) = ${Math.round(closed).toLocaleString('en-US')} tok → 阈值 ${(closed / W * 100).toFixed(1)}%`);
console.log(`  扫描最优 = ${(best.ratio * 100).toFixed(1)}%（T=${best.T.toLocaleString('en-US')}）→ ¥${best.perDay.toFixed(4)}/天`);
console.log(`  稳健区间（比最优差 ≤2%）= ${(flat[0].ratio * 100).toFixed(0)}% ~ ${(flat[flat.length - 1].ratio * 100).toFixed(0)}%`);

// 与现况对比
const DEFAULT_RATIO = 0.8;
const cur = model(DEFAULT_RATIO);
if (cur) {
  console.log(`\n  当前桌面端缺省 80%：T=${cur.T.toLocaleString('en-US')} → ¥${cur.perDay.toFixed(4)}/天`);
  console.log(`  改用 ${(best.ratio * 100).toFixed(0)}% 后        ：¥${best.perDay.toFixed(4)}/天  → 每天省 ¥${(cur.perDay - best.perDay).toFixed(4)}（${(100 * (cur.perDay - best.perDay) / cur.perDay).toFixed(0)}%）`);
}

// 对 R 的敏感性
console.log('\n=== 对「压缩后落点 R」的敏感性（保留得越多，最优阈值越高）===');
for (const rr of [10000, 20000, 50000, 100000, 160000]) {
  const rc = T(PRICE.pMiss) * rr + T(PRICE.pOut) * s;
  const t = rr + Math.sqrt(2 * g * rc / b);
  console.log(`  R=${rr.toLocaleString('en-US').padStart(7)}  → 最优阈值 ${(t / W * 100).toFixed(1).padStart(5)}%  （T=${Math.round(t).toLocaleString('en-US')}）`);
}

console.log('\n=== 对「每步增长 g」的敏感性（R=20000）===');
for (const gg of [1000, 2000, 3500, 5500, 10000]) {
  const t = R + Math.sqrt(2 * gg * rebuildCost / b);
  console.log(`  g=${String(gg).padStart(6)}  → 最优阈值 ${(t / W * 100).toFixed(1).padStart(5)}%  （T=${Math.round(t).toLocaleString('en-US')}）`);
}
