// src/core/token-report.js — `/token` 指令：把「今日用量 + 今日花费」说成人话（2026-09-21）
//
// 需求：输入 /token 就自动发出今天的 token 消耗总量与钱数消耗。
//
// ── 为什么单独一个模块（而不是塞进 mux.js）────────────────────────────────────
//   · mux.js 已经 1300+ 行，指令分支里塞金额计算会越写越乱；
//   · 口径必须与管理端「学习/用量」页的实测区逐字一致，否则用户拿两边对数必然对不上。
//     管理端口径（src/pages/Learning.tsx::useLiveCost）：
//       实测 = 只统计确实带缓存命中字段的请求（cacheSamples>0 的小时桶），不反推、不外推；
//       金额 = (命中×pHit + 未命中×pMiss + 输出×pOut)/1e6 × 高峰倍率；
//       高峰时段（北京时）= 09:00-12:00 与 14:00-18:00，倍率 ×peakMult。
//     这里逐字复刻那套算法，默认单价也同源（Learning.tsx::COST_DEFAULT）。
//   · 单价可在 config.json 的 `tokenCost` 段覆盖（管理端 Core 设置可改）；
//     口径不变、只换单价 —— 用户调价后 /token 与面板同时变。
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

/** 计费口径说明：给 /token 正文末尾那一行用（用户问"这数怎么算出来的"时有据可依）。 */
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
 *
 * 2026-09-22 修「/token 与管理端面板对不上」——是口径混用，不是算错：
 * 线上实测（北京 10:00 那次，数字全部可复算）：
 *   · 面板顶部「今日已用」            = 592,685  ← `today.billedTotal`，计费日（08:00 换日 = 提供方控制台口径）
 *   · 面板「实测计量」里的「今日 token 合计」= 12,182,789 ← 分时桶合计，北京自然日 00:00 起
 *   · 面板两处都对，区别只在口径；面板自己也在正文里写了「北京自然日 00:00 起合计 …… 其中
 *     00:00–08:00 那段平台算在昨天」。
 * 而旧版 /token 把两个口径挨着印：第一行总量取计费日（592.7k），第二行的"新输入/命中/输出"
 * 与金额却来自自然日分时桶（12.18M 那一套）——读起来就是"592.7k 下面挂着 12.18M 的分量"，
 * 当然像算错了。现在逐行标注口径，并且每个数字都能在面板里指到出处：
 *   第 1 行 = 面板顶部「今日已用」（计费日，平台口径）
 *   第 2/3 行 = 面板「实测计量」的命中率与命中/未命中/输出、及其下方「今日 token 合计」（自然日）
 *   第 4 行 = 面板「今日费用」（实测，按自然日分时，含谷时/高峰拆分）
 *   最后一行 = 面板「今日预计」
 * `days>1` 那条路原来还有个真 bug：总量取的是 today.billedTotal（只算今天），却印成"近 N 天"。
 * 现在按 `dates`（计费日逐日）求和。
 * @param {{days?:number}} opts days=取几天（默认 1=今天）
 * @returns {{ok:boolean, text:string, data:object}}
 */
export function buildTokenReportText(opts = {}) {
  const days = Math.max(1, Math.min(60, Math.round(Number(opts.days) || 1)));
  // opts.nowMs：只给测试用（"日界口径"这类断言必须能在固定时刻复现，不能跟着挂钟走 —— 实测：
  // 同一份测试在北京 11:00 之后会因为"3 小时前那一行也落在计费日里"而失败）
  const nowMs = Number(opts.nowMs);
  let rep = null;
  try { rep = getTokenReport(days, Number.isFinite(nowMs) ? { nowMs } : undefined); } catch (e) {
    return { ok: false, text: `用量库读不出来：${e?.message ?? e}`, data: {} };
  }
  const price = priceCfg();
  const sum = summarizeMeasuredCost(rep?.todayHourly, price);
  const today = rep?.today ?? {};
  // 计费日（平台口径）：未命中 + 命中 + 缓存写 + 输出，只有真实行
  const todayBilled = Number(today.billedTotal) || 0;
  const todayEst = Number(today.estTotal) || 0;
  // 北京自然日 00:00 起：分时桶合计（面板「今日 token 合计」就是它）
  const naturalTotal = sum.dayTotal;
  const naturalSame = naturalTotal > 0 && Math.abs(naturalTotal - todayBilled) < Math.max(1, todayBilled * 0.005);
  const startBj = Number(rep?.dayWindow?.startBjMinutes);
  const hasShift = Number.isFinite(startBj) && startBj > 0;
  const startLabel = hasShift ? `${String(Math.floor(startBj / 60)).padStart(2, '0')}:${String(startBj % 60).padStart(2, '0')}` : '00:00';
  const dayStartLabel = `北京 ${startLabel} 换日`;
  const windowDates = Array.isArray(rep?.dates) ? rep.dates : [];
  const windowTotal = windowDates.reduce((a, d) => a + (Number(d?.total) || 0), 0);
  const rate = sum.measuredRate;
  const ratePart = rate != null ? `命中 ${(rate * 100).toFixed(1)}% · ` : '';
  const compPart = `未命中 ${fmtNum(sum.mMiss)} / 命中 ${fmtNum(sum.mHit)} / 输出 ${fmtNum(sum.mOut)}`;

  if (days === 1) {
    if (todayBilled <= 0 && todayEst <= 0) {
      return {
        ok: true,
        text: `今日还没有用量记录（一条 usage 帧都还没收到）`,
        data: { days, billed: todayBilled, naturalTotal, est: todayEst, cost: 0 },
      };
    }
    const lines = [];
    lines.push(`今日 ${fmtNum(todayBilled)} tok —— 平台计费日（${dayStartLabel}，与提供方控制台对得上）`);
    if (!naturalSame) {
      lines.push(`自然日 00:00 起 ${fmtNum(naturalTotal)} tok（含 00:00–${startLabel} 那段，平台算在昨天）`);
    }
    lines.push(`${ratePart}${compPart}`);
    // 金额口径 = 面板「今日费用」：按自然日分时、只算带缓存字段的请求、高峰小时整体乘倍率
    const money = sum.cost;
    lines.push(sum.peakHours > 0
      ? `费用 ¥${money.toFixed(4)}（谷时 ¥${sum.offCost.toFixed(4)} · 高峰 ¥${sum.peakCost.toFixed(4)}，${sum.peakHours} 个小时 ×${price.peakMult}）`
      : `费用 ¥${money.toFixed(4)}`);
    if (todayEst > 0) lines.push(`另有估算 ${fmtTok(todayEst)} tok（没拿到真实 usage 的回合，不计钱）`);
    const proj = Number(rep?.todayEstimatedTotal) || 0;
    if (proj > todayBilled) lines.push(`按今天的节奏，全天大概 ${fmtNum(proj)} tok`);
    return {
      ok: true,
      text: lines.join('\n'),
      data: {
        days, billed: todayBilled, naturalTotal, naturalSame, est: todayEst, cost: money,
        rate, peakCost: sum.peakCost, offCost: sum.offCost, projected: proj,
      },
    };
  }

  // 近 N 天：总量按 `dates`（计费日逐日）求和 —— 旧版这里错取了"只算今天"的 billedTotal
  const lines = [];
  lines.push(`近 ${days} 天 ${fmtNum(windowTotal)} tok（计费日逐日合计，含今日）`);
  let c = 0;
  for (const d of windowDates) {
    c += ((Number(d?.cacheRead) || 0) * price.pHit
      + (Number(d?.prompt) || 0) * price.pMiss
      + (Number(d?.completion) || 0) * price.pOut) / 1e6;
  }
  lines.push(`费用约 ¥${c.toFixed(4)}（逐日按谷时价算，未含高峰倍率）`);
  if (todayBilled > 0) lines.push(`其中今日 ${fmtNum(todayBilled)} tok · ¥${sum.cost.toFixed(4)}（自然日分时实测）`);
  return {
    ok: true,
    text: lines.join('\n'),
    data: { days, windowTotal, cost: c, billed: todayBilled, naturalTotal, todayCost: sum.cost, rate },
  };
}
