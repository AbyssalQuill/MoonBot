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
  /* 【2026-09-22 修 M17·"守卫失效"】epoch 守卫的判据是 `epochs.get(key) !== epoch`（enqueue 时抓下的值），
   * 而这里原来**先** `epochs.clear()`：清空之后两边都是 undefined/0，守卫恒不成立 →
   * 只有"被单独 cancelKeyedSends 过的会话"才会过期，其余会话**取消后旧气泡照发**。
   * 正确做法是把每个 key 的 epoch **+1**（让旧快照失效），再清链尾与节拍计数。 */
  for (const [k, v] of epochs) epochs.set(k, (Number(v) || 0) + 1);
  chains.clear();
  linearCounts.clear();
  log('[send-chain] 已取消所有会话待发任务（epoch 已递增，旧任务落地即被跳过）');
}

/** 把一个发送任务追加到对应会话链尾（省略 chainKey 时追加到全局默认链）并返回新链。 */
export function enqueueSend(task, chainKey) {
  const keyed = chainKey != null && String(chainKey) !== '';
  /* 保证"入过队的 key 一定有 epoch 条目"：否则 cancelAllKeyedSends 递增时漏掉它，
   * 而取消前后的两次捕获都是 0 → 守卫失效（旧气泡照发）。 */
  if (keyed && !epochs.has(chainKey)) epochs.set(chainKey, 0);
  const epoch = keyed ? epochs.get(chainKey) : 0;
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
// ── 发送打字节拍：只保留「按字数」这一种（2026-09-15 主人定稿）────────────────
// 规则：同一条回复（一次 send 调用 = 一批）里，
//   · 第 1 条气泡：立即发出（秒回，主人明确要过的行为）；
//   · 第 2 条起：等"这条气泡自己打完要多久" = 字数 × 每字毫秒（linearPerCharMs），
//     再乘 ±linearJitterRatio 的随机抖动，最后夹在 [linearMinMs, linearCapMs]。
// 曾经的两种多余玩法都已删除：按"连发第几条 × 步长"递增（linearBaseMs/linearStepMs/linearMode=count）、
// 以及线性关闭时那套 gapBaseMs/gapPerCharMs 兜底 —— 它们和"按字数"重复，只会让节奏对不上字数。
// linearEnabled=false 现在就是"完全不延迟"。
// 计数与等待点分离：投递任务执行前查 nextSendPaceMs(key, 本条字数)，投递成功后调 markSendDelivered(key, 字数)。
// 非文本投递（表情/图/戳一戳等，各自独立 enqueueSend）不经过本计数，不计入、也不受节拍约束。
const LINEAR_DEFAULTS = {
  enabled: true,        // social.send.linearEnabled（false = 不做任何打字延迟）
  perCharMs: 150,       // social.send.linearPerCharMs（**每个字**的打字时间，主参数）
  minMs: 250,           // social.send.linearMinMs（下限：太短的气泡也别贴脸连发）
  capMs: 4000,          // social.send.linearCapMs（上限：超长句也不会等到天荒地老）
  jitterRatio: 0.25,    // social.send.linearJitterRatio（每条的随机抖动比例，真人不会每条一样快）
  resetMs: 60000        // social.send.linearResetMs（静默这么久后计数归零，下一条重新秒回）
};
const linearCounts = new Map(); // chainKey -> { n: 连续成功投递数, lastAt: 最近成功时间, lastLen: 最近一条字数 }
let linearCfgReader = null;     // qq-send.initQqSendCore 注册：每次取当前 social.send（可变对象，热调即时生效）

/** 注册节拍配置读取器：返回 { enabled, perCharMs, minMs, capMs, jitterRatio, resetMs } 或 null。 */
export function setSendLinearCfgReader(fn) { linearCfgReader = fn; }

function linearCfgNow() {
  let user = null;
  try { user = linearCfgReader ? linearCfgReader() : null; } catch {}
  const merged = { ...LINEAR_DEFAULTS, ...(user && typeof user === 'object' ? user : {}) };
  const isObj = user && typeof user === 'object';
  // 字段名兼容（2026-09-11 修）：可调项写的是 social.send.linearEnabled，而本模块历史上读 cfg.enabled。
  // 两者对不上 → 「打字节拍」开关形同虚设。现在两个名字都认，显式 enabled 优先。
  if (isObj && user.enabled === undefined && user.linearEnabled !== undefined) {
    merged.enabled = user.linearEnabled !== false;
  }
  // 【2026-09-12 修 · 同名不同字段是"发送慢"的真凶；2026-09-15 改成按字数后仍是同一坑】
  //   配置里写的是 linearPerCharMs / linearMinMs / linearCapMs / linearResetMs / linearJitterRatio，
  //   而模块内部读 perCharMs / minMs / capMs / resetMs / jitterRatio —— 不对齐就永远取不到，
  //   表现是"改了配置没反应"（当初 350/4000 就是被这么忽略掉的）。
  if (isObj) {
    if (user.perCharMs === undefined && user.linearPerCharMs !== undefined) merged.perCharMs = user.linearPerCharMs;
    if (user.minMs === undefined && user.linearMinMs !== undefined) merged.minMs = user.linearMinMs;
    if (user.capMs === undefined && user.linearCapMs !== undefined) merged.capMs = user.linearCapMs;
    if (user.resetMs === undefined && user.linearResetMs !== undefined) merged.resetMs = user.linearResetMs;
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
 *  语义 = "这一条回复是一次新的连发批"：批内第一条不等节拍（秒回），第二条起按字数算。
 *  为什么需要它：计数原本是**按会话跨回合累加**的（只有静默超过 resetMs 才归零），
 *  热聊时上一条的字数会一直影响下一条 → 一条回复的**第一条气泡也要先干等**。
 *  `sendMessages` 每次调用开头调一次，让节奏只描述"这一次连发"。 */
export function resetSendPace(key) {
  if (key == null || String(key) === '') return;
  linearCounts.delete(String(key));
}

/** 每条投递任务执行前调用：返回本条应等待的毫秒数。
 *  无 key（全局默认链）或 linearEnabled=false → 返回 null（调用方不延迟）。
 *
 *  唯一规则（2026-09-15 主人定稿：只保留这一种）：
 *   · 批内第 1 条 → 0（秒回，主人明确要过"模型一决定回，气泡立刻出"）；
 *   · 第 2 条起 → clamp(本条字数 × linearPerCharMs × 抖动, linearMinMs, linearCapMs)。
 *  textLen 省略时退回上一条的字数（老调用点不会因此失控）。 */
export function nextSendPaceMs(key, textLen) {
  if (key == null || String(key) === '') return null;
  const cfg = linearCfgNow();
  if (cfg.enabled === false) return null;
  const cap = Math.max(0, Number(cfg.capMs) || 0);
  const perChar = Math.max(0, Number(cfg.perCharMs) || 0);
  const minMs = Math.max(0, Number(cfg.minMs) || 0);
  const rec = linearEntry(key);
  // 批内第一条：即时
  if (rec.n <= 0) return 0;
  const explicitLen = Number(textLen);
  const len = Number.isFinite(explicitLen) && explicitLen > 0 ? Math.round(explicitLen) : rec.lastLen;
  if (!(perChar > 0) || !(len > 0)) return 0;
  const rawJitter = Number(cfg.jitterRatio);
  const jitter = Number.isFinite(rawJitter) ? Math.min(0.9, Math.max(0, rawJitter)) : 0;
  const factor = jitter > 0 ? (1 - jitter + Math.random() * jitter * 2) : 1;
  const typing = Math.round(len * perChar * factor);
  // clamp(打字时间, 下限, 上限)；下限超过上限时以上限为准（cap 是硬上限）
  return Math.max(Math.min(minMs, cap), Math.min(cap, typing));
}

/** 投递成功后调用（textLen = 本条实际字数，供"下一次算间隔"用）。只有投递成功才推进计数。 */
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
  linearCounts.set(k, rec);
}

void log;
