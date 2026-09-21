// src/core/token-report.js — `/token` 指令：把「今日用量 + 今日花费」说成人话（2026-09-21）
//
// 主人要求：**输入 /token 就自动发出今天的 token 消耗总量与钱数消耗**。
//
// ── 为什么单独一个模块（而不是塞进 mux.js）────────────────────────────────────
//   · mux.js 已经 1300+ 行，指令分支里塞金额计算会越写越乱；
//   · 口径必须**与管理端「学习/用量」页的实测区逐字一致**，否则主人拿两边对数必然对不上。
//     管理端口径（src/pages/Learning.tsx::useLiveCost）：
//       实测 = 只统计**确实带缓存命中字段**的请求（cacheSamples>0 的小时桶），不反推、不外推；
//       金额 = (命中×pHit + 未命中×pMiss + 输出×pOut)/1e6 × 高峰倍率；
//       高峰时段（北京时）= 09:00-12:00 与 14:00-18:00，倍率 ×peakMult。
//     这里逐字复刻那套算法，默认单价也同源（Learning.tsx::COST_DEFAULT）。
//   · 单价可在 config.json 的 `tokenCost` 段覆盖（管理端 Core 设置可改）；
//     **口径不变、只换单价** —— 主人调价后 /token 与面板同时变。
//
// 依赖：core/token-meter.js 的 getTokenReport()（计费日口径，默认北京时 08:00 换日）。
import { getTokenReport } from './token-meter.js';

export const DEFAULT_TOKEN_COST = {
  pHit: 0.02,      // ¥ / 百万 tok，缓存命中（谷时）
  pMiss: 1,        // ¥ / 百万 tok，未命中输入（谷时）
  pOut: 4,         // ¥ / 百万 tok，输出（谷时）
  peakMult: 2,     // 高峰倍率
  peakHours: [9, 10, 11, 14, 15, 16, 17],   // 北京时高峰小时
};

/** 计费口径说明：给 /token 正文末尾那一行用（主人问"这数怎么算出来的"时有据可依）。 */
let cfgRef = null;
export function initTokenReportCore(cfg) {
  cfgRef = cfg || null;
}

function priceCfg() {
  const raw = cfgRef?.tokenCost && typeof cfgRef.tokenCost === 'object' ? cfgRef.tokenCost : {};
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const hours = Array.isArray(raw.peakHours) && raw.peakHours.length
    ? raw.peakHours.map((h) => Number(h)).filter((h) => Number.isFinite(h) && h >= 0 && h <= 23)
    : DEFAULT_TOKEN_COST.peakHours;
  return {
    pHit: numOr(raw.pHit, DEFAULT_TOKEN_COST.pHit),
    pMiss: numOr(raw.pMiss, DEFAULT_TOKEN_COST.pMiss),
    pOut: numOr(raw.pOut, DEFAULT_TOKEN_COST.pOut),
    peakMult: Math.max(1, numOr(raw.peakMult, DEFAULT_TOKEN_COST.peakMult)),
    peakHours: new Set(hours),
  };
}

/** 千分位（金额/大数读起来不费眼） */
export function fmtNum(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US');
}
/** 1_234_567 → 1.23M；12_345 → 12.3k；< 1000 原样 */
export function fmtTok(v) {
  const n = Math.round(Number(v) || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return fmtNum(n);
}

/**
 * 纯函数：小时桶数组 → 实测口径汇总（与管理端 useLiveCost 的实测分支逐字一致）。
 * @param {Array<{hour:number,prompt:number,completion:number,cacheRead:number,cacheWrite:number,cachePrompt:number,cacheCompletion:number,cacheSamples:number}>} hours
 * @param {{pHit:number,pMiss:number,pOut:number,peakMult:number,peakHours:Set<number>}} price
 */
export function summarizeMeasuredCost(hours, price) {
  let mHit = 0; let mMiss = 0; let mOut = 0; let mSamples = 0;
  let cost = 0; let offCost = 0; let peakCost = 0; let peakHours = 0;
  let dayMiss = 0; let dayOut = 0; let dayCacheRead = 0; let dayCacheWrite = 0; let dayTotal = 0;
  for (const h of Array.isArray(hours) ? hours : []) {
    dayMiss += Number(h?.prompt) || 0;
    dayOut += Number(h?.completion) || 0;
    dayCacheRead += Number(h?.cacheRead) || 0;
    dayCacheWrite += Number(h?.cacheWrite) || 0;
    dayTotal += (Number(h?.prompt) || 0) + (Number(h?.completion) || 0) + (Number(h?.cacheRead) || 0);
    const mult = price.peakHours.has(Number(h?.hour)) ? price.peakMult : 1;
    const samples = Number(h?.cacheSamples) || 0;
    if (samples > 0) {
      const hit = Number(h?.cacheRead) || 0;
      const miss = Number(h?.cachePrompt) || 0;
      const out = Number(h?.cacheCompletion) || 0;
      mHit += hit; mMiss += miss; mOut += out; mSamples += samples;
      const c = ((hit * price.pHit + miss * price.pMiss + out * price.pOut) / 1e6) * mult;
      cost += c;
      if (mult > 1) { peakCost += c; peakHours += 1; } else { offCost += c; }
    }
  }
  const measuredRate = (mHit + mMiss) > 0 ? mHit / (mHit + mMiss) : null;
  return {
    mHit, mMiss, mOut, mSamples, cost, offCost, peakCost, peakHours,
    dayMiss, dayOut, dayCacheRead, dayCacheWrite, dayTotal, measuredRate,
  };
}

/**
 * 组一条 `/token` 回复（短句、人话；空行分气泡由调用方决定）。
 * @param {{days?:number}} opts days=取几天（默认 1=今天）
 * @returns {{ok:boolean, text:string, data:object}}
 */
export function buildTokenReportText(opts = {}) {
  const days = Math.max(1, Math.min(60, Math.round(Number(opts.days) || 1)));
  let rep = null;
  try { rep = getTokenReport(days); } catch (e) {
    return { ok: false, text: `用量库读不出来：${e?.message ?? e}`, data: {} };
  }
  const price = priceCfg();
  const sum = summarizeMeasuredCost(rep?.todayHourly, price);
  const today = rep?.today ?? {};
  // 计费总量：提供方 total_tokens 口径（未命中 + 命中 + 缓存写 + 输出）。
  // today.billedTotal 只有真实行；估算行（estTotal）单独列，绝不并进钱里。
  const billed = Number(today.billedTotal) || 0;
  const est = Number(today.estTotal) || 0;
  const scope = days === 1 ? '今日' : `近 ${days} 天`;
  const lines = [];

  if (billed <= 0 && est <= 0) {
    lines.push(`${scope}还没有用量记录（一条 usage 帧都还没收到）`);
    return { ok: true, text: lines.join('\n'), data: { billed, est, cost: 0 } };
  }

  const money = days === 1
    ? sum.cost
    : (() => {   // 多日：逐日按同样口径累加（dates 里没有分时，用整日四项近似并加高峰说明）
      let c = 0;
      for (const d of rep?.dates ?? []) {
        c += ((Number(d.cacheRead) || 0) * price.pHit
          + (Number(d.prompt) || 0) * price.pMiss
          + (Number(d.completion) || 0) * price.pOut) / 1e6;
      }
      return c;
    })();

  lines.push(`${scope} ${fmtTok(billed)} tok · ¥${money.toFixed(4)}`);
  const rate = sum.measuredRate;
  const parts = [];
  if (rate != null) parts.push(`命中 ${(rate * 100).toFixed(1)}%`);
  parts.push(`新输入 ${fmtTok(sum.dayMiss)} / 命中 ${fmtTok(sum.dayCacheRead)} / 输出 ${fmtTok(sum.dayOut)}`);
  lines.push(parts.join(' · '));
  if (days === 1 && sum.peakHours > 0) {
    lines.push(`谷时 ¥${sum.offCost.toFixed(4)} · 高峰 ¥${sum.peakCost.toFixed(4)}（${sum.peakHours} 个小时 ×${price.peakMult}）`);
  }
  if (est > 0) lines.push(`另有估算 ${fmtTok(est)} tok（没拿到真实 usage 的回合，不计钱）`);
  if (days === 1) {
    const proj = Number(rep?.todayEstimatedTotal) || 0;
    if (proj > billed) lines.push(`按今天的节奏，全天大概 ${fmtTok(proj)} tok`);
  }
  return {
    ok: true,
    text: lines.join('\n'),
    data: { billed, est, cost: money, rate, peakCost: sum.peakCost, offCost: sum.offCost, days },
  };
}
