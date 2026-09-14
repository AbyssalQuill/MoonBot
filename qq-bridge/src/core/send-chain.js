// QQ 出站发送链（P4-3 中央化 → 2026-09-06 升级为按会话分链）：
// - 同一会话（chainKey=convKey）的任务严格串行，保持"真人先文字后表情/分条"顺序与间隔；
// - 不同会话之间可并行执行（提速：一次回复多条分属不同群的发送不必排队干等）；
// - 全桥仍受全局并发上限（MAX_IN_FLIGHT）约束，避免同时向 QQ 网关打出过多请求触发频率限制。
// - 会话代际：/reset、卡死隔离或控制台重置时调用 cancelKeyedSends(key)，
//   让该会话"已入链但尚未开始"的旧任务在启动前自检过期并跳过（不再把旧回合内容发到新上下文里）。
// enqueueSend(task, chainKey)：chainKey 省略时走全局默认链（兼容旧语义）。
import { log } from '../lib/log.js';

const chains = new Map();       // chainKey -> 吞错后的链尾（保证链不因一次失败而坏死）
const epochs = new Map();       // chainKey -> 会话代际（cancelKeyedSends 递增）
let defaultChain = Promise.resolve();

// 全局并发闸：同一时刻最多 MAX_IN_FLIGHT 个发送任务在途（睡眠间隔/网络等待都算在途）。
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const waiters = [];

function gate(task) {
  return new Promise((resolve, reject) => {
    const go = () => {
      inFlight += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          inFlight -= 1;
          const next = waiters.shift();
          if (next) next();
        });
    };
    if (inFlight < MAX_IN_FLIGHT) go();
    else waiters.push(go);
  });
}

function swallow(p) { return p.then(() => undefined, () => undefined); }

/** 取消某会话已入链但尚未开始的发送（旧任务启动前自检过期跳过），并清空旧链尾。 */
export function cancelKeyedSends(chainKey) {
  if (chainKey == null || String(chainKey) === '') return;
  epochs.set(chainKey, (epochs.get(chainKey) || 0) + 1);
  chains.delete(chainKey);
  linearCounts.delete(String(chainKey));
  log(`[send-chain] 已取消 ${chainKey} 的待发任务（会话重置/隔离）`);
}

/** 取消所有会话的待发任务（工作区级重置用）。 */
export function cancelAllKeyedSends() {
  epochs.clear();
  chains.clear();
  linearCounts.clear();
  log('[send-chain] 已取消所有会话待发任务');
}

/** 把一个发送任务追加到对应会话链尾（省略 chainKey 时追加到全局默认链）并返回新链。 */
export function enqueueSend(task, chainKey) {
  const keyed = chainKey != null && String(chainKey) !== '';
  const epoch = keyed ? (epochs.get(chainKey) || 0) : 0;
  const tail = keyed ? (chains.get(chainKey) || Promise.resolve()) : defaultChain;
  const run = tail.then(() => {
    if (keyed && (epochs.get(chainKey) || 0) !== epoch) {
      log(`[send-chain] 跳过已取消的待发任务（${chainKey} 已重置）`);
      return undefined;
    }
    return gate(task);
  });
  if (keyed) chains.set(chainKey, swallow(run));
  else defaultChain = swallow(run);
  // 链尾吞错：错误通过 run 暴露给等待方（await enqueueSend(...)），但不会污染后续任务
  return run;
}

/** 当前会话链尾（省略 chainKey 时为全局默认链）：等该链所有已入队任务完成后 resolve。 */
export function currentSendChain(chainKey) {
  if (chainKey != null && String(chainKey) !== '') return chains.get(chainKey) || Promise.resolve();
  return defaultChain;
}

/** 诊断用：当前在途任务数 */
export function sendChainInFlight() { return inFlight; }

// ── 发送线性节拍（学习规格「发消息线性延迟」，2026-09-07）──────────────
// 目标：唤醒/首轮即时；但同一会话「连续」投递的多条消息，投递间隔按线性递增：
//   delay(n) = min(cap, base + n*step)，n = 该会话已「连续成功」投递数（发送成功后自增）。
// 首条 n=0 → base（默认 0 → 秒醒，不延迟）；第二条 n=1 → base+step；…封顶 cap。
// 会话静默超过 resetMs（默认 60s）未投递 → n 归零，隔了很久的下一条不再线性延迟。
// 线性关闭（enabled=false）时两个函数都返回空语义，调用方完整保留旧节奏（零侵入）。
// 计数与等待点分离：投递任务执行前查 nextSendPaceMs(key)，投递成功后调 markSendDelivered(key)。
// 非文本投递（表情/图/戳一戳等，各自独立 enqueueSend）不经过本计数，不计入、也不受线性约束。
const LINEAR_DEFAULTS = {
  enabled: true,        // social.send.linearEnabled
  mode: 'perChar',      // social.send.linearMode：perChar(按字速度，默认) | count(旧的计数递增)
  baseMs: 0,            // social.send.linearBaseMs（0=首条不延迟）——count 模式用；perChar 模式下只有当"字数算不出来"时的兜底
  stepMs: 350,          // social.send.linearStepMs —— count 模式用
  capMs: 4000,          // social.send.linearCapMs（两种模式共用的上限）
  minMs: 250,           // social.send.linearMinMs（perChar 模式的下限：太短的气泡也别贴脸连发）
  perCharMs: 150,       // social.send.linearPerCharMs（**每个字**的打字时间，perChar 模式的主参数）
  jitterRatio: 0.25,    // social.send.linearJitterRatio（打字速度的随机抖动；未配时回落到 gapJitterRatio）
  resetMs: 60000,       // social.send.linearResetMs（可配，默认 60s，未挂可调项）
  gapPerCharMs: 140,    // 旧按字长节奏（send-gaps byLength 同款默认），只取 60% 作长文兜底下限
  gapJitterRatio: 0.3   // 旧节奏抖动系数：下限 = ×(1-jitter)
};
const linearCounts = new Map(); // chainKey -> { n: 连续成功投递数, lastAt: 最近成功时间, lastLen: 最近一条字数 }
let linearCfgReader = null;     // qq-send.initQqSendCore 注册：每次取当前 social.send（可变对象，热调即时生效）

/** 注册节拍配置读取器：返回 { enabled, baseMs, stepMs, capMs, resetMs, gapPerCharMs, gapJitterRatio } 或 null。 */
export function setSendLinearCfgReader(fn) { linearCfgReader = fn; }

function linearCfgNow() {
  let user = null;
  try { user = linearCfgReader ? linearCfgReader() : null; } catch {}
  const merged = { ...LINEAR_DEFAULTS, ...(user && typeof user === 'object' ? user : {}) };
  // 字段名兼容（2026-09-11 修）：可调项 UI（tunables.js）写的是 social.send.linearEnabled，
  // 而本模块历史上读的是 cfg.enabled（LINEAR_DEFAULTS.enabled）。两者对不上 → 「线性节拍」
  // 开关形同虚设（实测：把 linearEnabled 设成 false 后间隔仍是线性的 350/700ms）。
  // 这里两个名字都认，显式 enabled 优先；都没配 → 保持默认开启（对现有 config 无行为变化）。
  const isObj = user && typeof user === 'object';
  if (isObj && user.enabled === undefined && user.linearEnabled !== undefined) {
    merged.enabled = user.linearEnabled !== false;
  }
  // 【2026-09-12 修 · 上面那次只修了一半，这才是"发送慢"的真凶】
  // 同一个字段名不一致的问题，**另外四个参数一直没修**：
  //   config 里写的是 linearBaseMs / linearStepMs / linearCapMs / linearResetMs，
  //   而本模块内部读的是 baseMs / stepMs / capMs / resetMs —— 名字对不上 → 永远取不到，
  //   于是**一直用内置默认值 350 / 4000 / 0 / 60000**：
  //     · 每条"连续发送"要等 min(4000, 350×n) 毫秒，热聊时 n 早早顶到上限 → **每条都得干等 4 秒**；
  //     · 配置里分明写着 150 / 1500（有人是照"更快一点"调的），**一个字符都没生效过**。
  //   实测对得上：245 次 qq_send_message 的耗时分布正好落在 0.5s + {0,350,700,1050,…,3500}，
  //   即 350×n 封顶 4000（NapCat 自身 RTT 只有 18ms，全量日志里发送失败/重试各 0 次）。
  // 现在四个都做别名映射：显式写 linear*（配置的口径）优先；只写了 plain 名也照旧认。
  if (isObj) {
    if (user.baseMs === undefined && user.linearBaseMs !== undefined) merged.baseMs = user.linearBaseMs;
    if (user.stepMs === undefined && user.linearStepMs !== undefined) merged.stepMs = user.linearStepMs;
    if (user.capMs === undefined && user.linearCapMs !== undefined) merged.capMs = user.linearCapMs;
    if (user.resetMs === undefined && user.linearResetMs !== undefined) merged.resetMs = user.linearResetMs;
    // 【2026-09-15 线性延迟改成"按单个字的速度"】新增三个键，同样做别名映射（配置里写 linear* 优先）。
    if (user.mode === undefined && user.linearMode !== undefined) merged.mode = String(user.linearMode);
    if (user.perCharMs === undefined && user.linearPerCharMs !== undefined) merged.perCharMs = user.linearPerCharMs;
    if (user.minMs === undefined && user.linearMinMs !== undefined) merged.minMs = user.linearMinMs;
    if (user.jitterRatio === undefined && user.linearJitterRatio !== undefined) merged.jitterRatio = user.linearJitterRatio;
  }
  return merged;
}

/** 当前是否启用线性节拍（未配置时默认 true）。 */
export function sendLinearEnabled() { return linearCfgNow().enabled !== false; }

function linearEntry(key) {
  const k = String(key);
  const cfg = linearCfgNow();
  const now = Date.now();
  let rec = linearCounts.get(k);
  if (!rec || now - rec.lastAt > Number(cfg.resetMs) || cfg.enabled === false) {
    rec = { n: 0, lastAt: rec && cfg.enabled !== false ? rec.lastAt : 0, lastLen: 0 };
    linearCounts.set(k, rec);
  }
  return rec;
}

/** 【2026-09-12 加速】把某会话的"连续发送计数"清零。
 *  语义 = "这一条回复是一次新的连发批"：批内第一条不等节拍、第二条 step、第三条 2×step……
 *  为什么需要它：原实现里计数是**按会话跨回合累加**的（只有静默超过 resetMs 才归零），
 *  热聊时 n 早早顶到 cap → 一条回复里的**第一条气泡也要先干等满 cap**（实测最多 4 秒）。
 *  `sendMessages` 每次调用开头调一次，让节奏只描述"这一次连发"，不再被前几轮的历史拖着。 */
export function resetSendPace(key) {
  if (key == null || String(key) === '') return;
  linearCounts.delete(String(key));
}

/** 每条投递任务执行前调用：返回本条应等待的毫秒数（≥0，首条通常为 0/base）。
 *  无 key（全局默认链）或线性关闭 → 返回 null，调用方保持旧节奏。
 *
 *  【2026-09-15 主人要求「线性延迟改成按单个字的速度」→ 新增 perChar 模式，并成为默认】
 *  两种模式（social.send.linearMode）：
 *   · `perChar`（默认）：**批内第 2 条起**，间隔 = 这条气泡自己打完要多久 = 字数 × 每字毫秒
 *     （linearPerCharMs，默认 150ms/字），再乘 ±(1±jitter) 的抖动，最后夹在 [linearMinMs, linearCapMs]。
 *     批内第 1 条仍然是 0（秒回，主人明确要过"模型一决定回，气泡立刻出"）。
 *     为什么这么改：旧 `count` 模式的间隔只跟"连发第几条"有关、跟字数完全无关 ——
 *     一条 2 字的气泡和 40 个字的长句都等同样的 600/1200/1500ms；主人实测的感觉就是
 *     "节奏很假、长句反而秒出"。按字速度算才是真人的样子。
 *   · `count`（旧行为，保留可切回）：delay = min(cap, base + n*step)，n=批内已成功投递数。
 */
export function nextSendPaceMs(key, textLen) {
  if (key == null || String(key) === '') return null;
  const cfg = linearCfgNow();
  if (cfg.enabled === false) return null;
  const base = Math.max(0, Number(cfg.baseMs) || 0);
  const step = Math.max(0, Number(cfg.stepMs) || 0);
  const cap = Math.max(0, Number(cfg.capMs) || 0);
  const rec = linearEntry(key);
  const mode = String(cfg.mode || 'perChar').toLowerCase() === 'count' ? 'count' : 'perChar';

  if (mode === 'perChar') {
    const perChar = Math.max(0, Number(cfg.perCharMs) || 0);
    const minMs = Math.max(0, Number(cfg.minMs) || 0);
    // 批内第一条：即时（沿用"首条不等节拍"）
    if (rec.n <= 0) return Math.min(cap, base);
    const explicitLen = Number(textLen);
    const len = Number.isFinite(explicitLen) && explicitLen > 0 ? Math.round(explicitLen) : rec.lastLen;
    if (!(perChar > 0) || !(len > 0)) return Math.min(cap, base);
    const rawJitter = Number(cfg.jitterRatio);
    const jitter = Number.isFinite(rawJitter) ? Math.min(0.9, Math.max(0, rawJitter)) : Math.min(0.9, Math.max(0, Number(cfg.gapJitterRatio) || 0));
    const factor = jitter > 0 ? (1 - jitter + Math.random() * jitter * 2) : 1;
    const typing = Math.round(len * perChar * factor);
    // clamp(打字时间, 下限, 上限)；下限超过上限时以上限为准（与旧语义一致：cap 是硬上限）
    return Math.max(Math.min(minMs, cap), Math.min(cap, typing));
  }

  // ── count 模式（旧行为，一字不改）────────────────────────────────
  // 线性主节拍：delay = min(cap, base + n*step)，首条 n=0 → base
  const pace = step > 0 ? Math.min(cap, base + rec.n * step) : Math.min(cap, base);
  // 旧按字长节奏下限的 60% 作长文兜底（线性为主：短消息不掺旧节奏，长消息保留一点打字下限）。
  // 下限 = (1-jitter) × 字长 × gapPerCharMs；仅当本会话刚连续发过长文本时才有意义（lastLen>0）。
  const perChar = Math.max(0, Number(cfg.gapPerCharMs) || 0);
  const jitter = Math.min(1, Math.max(0, Number(cfg.gapJitterRatio) || 0));
  const floor = perChar > 0 && rec.lastLen > 0 ? Math.min(cap, Math.round(0.6 * (1 - jitter) * rec.lastLen * perChar)) : 0;
  return Math.max(pace, floor);
}

/** 投递成功后调用（textLen = 本条实际字数，用于字长兜底下限）。只有投递成功才推进计数。 */
export function markSendDelivered(key, textLen) {  if (key == null || String(key) === '') return;
  const k = String(key);
  const cfg = linearCfgNow();
  const now = Date.now();
  if (cfg.enabled === false) { linearCounts.delete(k); return; }
  let rec = linearCounts.get(k);
  if (!rec || now - rec.lastAt > Number(cfg.resetMs)) rec = { n: 0, lastAt: now, lastLen: 0 };
  rec.lastAt = now;
  rec.n += 1;
  if (typeof textLen === 'number' && Number.isFinite(textLen)) rec.lastLen = Math.max(0, Math.round(textLen));
  // 计数截断：n 超过封顶所需的最大序数后不再增长（延迟本身由 min(cap,…) 封顶，保持计数整齐）
  const base = Math.max(0, Number(cfg.baseMs) || 0);
  const step = Math.max(0, Number(cfg.stepMs) || 0);
  const cap = Math.max(0, Number(cfg.capMs) || 0);
  if (step > 0) { const maxN = Math.max(0, Math.ceil((cap - base) / step)); if (rec.n > maxN) rec.n = maxN; }
  linearCounts.set(k, rec);
}

void log;
