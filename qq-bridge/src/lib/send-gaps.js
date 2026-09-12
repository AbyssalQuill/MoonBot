// default发送节奏纯函数
//
// 【2026-09-11 重整】节奏统一以「线性节拍」为准（social.send.linear*，默认开启）：
//   同会话连续投递 delay(n) = min(linearCapMs, linearBaseMs + n*linearStepMs)
//   首条 n=0 → linearBaseMs（默认 0 = 秒回，不延迟）
// 本文件的 computeGaps 只在线性节拍**关闭**时才被 sendMessages 使用，属兜底路径。
//
// 已去掉 `burstIntervalMinMs` / `burstIntervalMaxMs`：
//   它们原本是 clampGap 的下限来源（1800ms），导致"gapBaseMs/gapPerCharMs 都配 0 = 秒回"
//   永远无法生效（0 被夹到 1800）。现在下限改成不来自配置的硬性 MIN_GAP_MS，
//   显式配 0 就真的接近即时，同时保留一个极小下限防止被 QQ 判为刷屏。
import { randInt } from './rand.js';

/** 硬性最小间隔（纯安全下限，不来自配置）。 */
export const MIN_GAP_MS = 100;
/** 线性节拍关闭时的兜底间隔范围（原 burstIntervalMinMs/MaxMs 的默认值内联于此）。 */
const FALLBACK_GAP_MIN_MS = 1000;
const FALLBACK_GAP_MAX_MS = 3000;

/**
 * 读数值配置：**显式配置的 0 就是 0**，只有真正没配（undefined/null/空串/非数字）才用默认值。
 * （原来用 `Number(x) || 默认值`，把配置里的 0 当成"没配"。）
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
    // 显式 0 就按 0 算 → 接近即时（只受 MIN_GAP_MS 限）；没配则用 3500/140 的拟人默认。
    const base = Math.max(0, numCfg(sendCfg?.gapBaseMs, 3500));
    const perChar = Math.max(0, numCfg(sendCfg?.gapPerCharMs, 140));
    const jitter = Math.min(1, Math.max(0, numCfg(sendCfg?.gapJitterRatio, 0.3)));
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      // 线性底 + 每字递增，再叠加随机抖动：真人打字的停顿忽快忽慢，不是均匀的
      let g = base + chars * perChar;
      if (jitter > 0) g = g * (1 - jitter + Math.random() * jitter * 2);
      delays.push(clampGap(g, sendCfg));
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
