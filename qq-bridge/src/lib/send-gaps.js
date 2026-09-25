// 发送节奏兜底函数（只有 linearEnabled=false 时才走到 computeGaps）
//
// 2026-09-15：节奏只留"按字数"一种。
//   · 唯一权威实现在 core/send-chain.js 的 nextSendPaceMs：
//     批内首条秒回，第 2 条起 = 字数 × linearPerCharMs（夹在 [linearMinMs, linearCapMs]，带抖动）。
//   · 本文件的 byLength 分支现在直接复用同一组参数（linearPerCharMs / linearMinMs / linearCapMs /
//     linearJitterRatio），不再有自己那套 gapBaseMs/gapPerCharMs/gapJitterRatio —— 两套参数必然打架。
//   · fixed / auto 是按调用显式指定间隔的路径（qq_send_message 的 gapMode 参数），与线性节拍无关，保留。
import { randInt } from './rand.js';

/** 硬性最小间隔（纯安全下限，不来自配置）。 */
export const MIN_GAP_MS = 100;
/** 未显式指定时的兜底间隔范围。 */
const FALLBACK_GAP_MIN_MS = 1000;
const FALLBACK_GAP_MAX_MS = 3000;

/**
 * 读数值配置：显式配置的 0 就是 0，只有真正没配（undefined/null/空串/非数字）才用默认值。
 */
const numCfg = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

// 把"想用的间隔"夹到 [MIN_GAP_MS, maxGapMs] 内（纯函数，不读运行态）
export function clampGap(ms, sendCfg) {
  const max = Math.max(MIN_GAP_MS, numCfg(sendCfg?.maxGapMs, 10000));
  return Math.max(MIN_GAP_MS, Math.min(max, Math.round(numCfg(ms, MIN_GAP_MS))));
}

// 依模式计算相邻两条消息之间的延迟数组（长度 = messages.length - 1；不足 2 条返回 []）
export function computeGaps(messages, gapMode, gapMs, gaps, sendCfg) {
  const delays = [];
  if (!messages || messages.length <= 1) return delays;
  const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
  if (mode === 'fixed') {
    if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
      for (let i = 0; i < messages.length - 1; i++) delays.push(clampGap(gaps[i], sendCfg));
    } else {
      const g = clampGap(numCfg(gapMs, FALLBACK_GAP_MIN_MS), sendCfg);
      for (let i = 0; i < messages.length - 1; i++) delays.push(g);
    }
  } else if (mode === 'byLength') {
    // 与 nextSendPaceMs 同一组参数：上一条字数 × 每字毫秒，±抖动，夹在 [下限, 上限]
    const perChar = Math.max(0, numCfg(sendCfg?.linearPerCharMs, 150));
    const minMs = Math.max(0, numCfg(sendCfg?.linearMinMs, 250));
    const capMs = Math.max(0, numCfg(sendCfg?.linearCapMs, 4000));
    const jitter = Math.min(0.9, Math.max(0, numCfg(sendCfg?.linearJitterRatio, 0.25)));
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      const factor = jitter > 0 ? (1 - jitter + Math.random() * jitter * 2) : 1;
      const typing = Math.round(chars * perChar * factor);
      delays.push(clampGap(Math.max(Math.min(minMs, capMs), Math.min(capMs, typing)), sendCfg));
    }
  } else {
    // auto：随机间隔（保留长停顿的概率分支）
    const longProb = Math.min(1, Math.max(0, numCfg(sendCfg?.longGapProbability, 0)));
    for (let i = 0; i < messages.length - 1; i++) {
      const useLong = longProb > 0 && Math.random() < longProb;
      const min = useLong ? numCfg(sendCfg?.longGapMinMs, 5000) : FALLBACK_GAP_MIN_MS;
      const max = useLong ? numCfg(sendCfg?.longGapMaxMs, 10000) : FALLBACK_GAP_MAX_MS;
      delays.push(clampGap(randInt(Math.max(MIN_GAP_MS, min), Math.max(MIN_GAP_MS, max)), sendCfg));
    }
  }
  return delays;
}
