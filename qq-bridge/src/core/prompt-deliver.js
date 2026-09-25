// M4 投递队列核心
// deliverPromptNow 依赖注入：resolveMediaList → mediaResolver（setPromptMediaResolver），api → setPromptApi，
// cfg → initPromptDeliverCore；dshReady 读 dsh-session。
import { withTimeout } from '../lib/async.js';
import { log } from '../lib/log.js';
import { mdToPlain } from '../md-to-plain.js';
import { SENSITIVE_RE } from '../sensitive.js';
import { dshReady, ensureSession } from './dsh-session.js';
import { state, saveState } from './config.js';
import { currentMode, modeAllowed } from './mode.js';
import { withSlangContext } from './slang.js';
import { quarantineSession } from './turn-guard.js';
import { shouldAuditKey, auditAndSend } from './audit.js';
import { sendToQQ } from './qq-send.js';
import { queued, queuedHintAt, queueRetries, promptQueues } from './session-state.js';

export const QUEUE_MAX = 50;
let flushingQueue = false;
export function isFlushingQueue() { return flushingQueue; }

let cfgRef = null;
let apiRef = null;
let mediaResolver = null;
export function initPromptDeliverCore(cfg) { cfgRef = cfg; }
export function setPromptApi(api) { apiRef = api; }
/** resolveMediaList（媒体解析，main 侧实现）注入 */
export function setPromptMediaResolver(fn) { mediaResolver = fn; }
/** 2026-09-22：读取已注入的媒体解析器：在途回合注入（wake-send.js 的 steerIntoRunningTurn）
 *  必须用同一个实现去取图 —— 那份实现里已经有"DSH 附件层单边像素硬上限"的闸门
 *  （media-pipe.js 的 gateImage/ensureDeliverableImage），另写一份必然漂移。 */
export function getPromptMediaResolver() { return mediaResolver; }

export const enqueueForRetry = (key, promptText, opts = {}) => {
  const items = queued.get(key) ?? [];
  if (!items.some((it) => it.promptText === promptText)) {
    if (items.length >= QUEUE_MAX) {
      items.shift();
      log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
    }
    items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
    queued.set(key, items);
  }
  queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
  setTimeout(() => { flushQueue(); }, 3000);
};

export const flushQueue = async () => {
  if (flushingQueue) return;
  flushingQueue = true;
  try {
    const entries = [...queued.entries()];
    queued.clear();
    for (const [key, items] of entries) {
      let sent = 0;
      let failed = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const [kind, idStr] = key.split(':');
          const id = Number(idStr);
          if (!modeAllowed(key, kind, id, cfgRef, currentMode)) {
            log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
            continue;
          }
          const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [] });
          if (!result.ok) {
            log(`补投失败 ${key}: ${result.error || '未知错误'}`);
            failed += 1;
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
          queueRetries.delete(key);
          sent += 1;
        } catch (error) {
          log(`补投异常 ${key}: ${error?.message ?? error}`);
          failed += 1;
          // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
          const rest = items.slice(i);
          const existing = queued.get(key) ?? [];
          queued.set(key, rest.concat(existing));
          break;
        }
      }
      log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
      if (failed > 0) {
        const retries = (queueRetries.get(key) ?? 0) + 1;
        queueRetries.set(key, retries);
        if (retries > 5) {
          log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
          setTimeout(() => {
            queueRetries.delete(key);
            flushQueue();
          }, 60000);
        } else {
          const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
          setTimeout(() => { flushQueue(); }, delay);
        }
      }
    }
  } finally {
    flushingQueue = false;
    /* 2026-09-22：修 M17。这一轮跑完后队列里又有了东西（可能是本轮补投失败放回的，
     * 也可能是补投期间新排进来的）→ 必须再排一次 flush。旧写法什么都不做，而排队的
     * `setTimeout(flushQueue, 3000)` 若恰好在本轮进行中触发，会命中开头的 `if (flushingQueue) return`
     * 直接丢掉，队列就静静躺在那里等到下一次入队才动（表现：消息卡着不补投）。 */
    if (queued.size > 0) {
      setTimeout(() => { flushQueue(); }, 500);
    }
  }
};

export async function deliverPromptNow(key, promptText, opts = {}) {
  if (!dshReady) {
    const items = queued.get(key) ?? [];
    if (items.length >= QUEUE_MAX) {
      items.shift();
      log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
    }
    items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
    queued.set(key, items);
    return { ok: true, queued: true };
  }
  let sessionId;
  try {
    sessionId = await ensureSession(key);
  } catch (error) {
    if (String(error?.message ?? error).includes('会话创建期间已重置')) {
      enqueueForRetry(key, promptText, opts);
      return { ok: true, retried: true };
    }
    throw error;
  }
  let content = [{ type: 'text', text: withSlangContext(promptText) }];
  if (Array.isArray(opts.media) && opts.media.length > 0) {
    const imageParts = await mediaResolver(opts.media);
    content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
  }
  let accepted;
  try {
    // 投递加超时：DSH 会话回合卡死时 prompt 可能永不返回，30s 后按失败处理并隔离该会话
    //
    // 2026-09-12 架构收敛：唤醒投递从此只用 steer，永远不再用 queue。
    // 这是"消息停在 next-turn 队列里再也出不来"（2026-09-11 23:58 报的故障）的根治点。
    // 依据是逐层读过的 DSH 源码，不是推测：
    //   · `{mode:'queue'}` → `agent.followup()` → `send(msg,'next-turn',true)`
    //     （`dsh-agent-loop/lib/index.js:401-403`）→ 进 inbox 的 next-turn 队列。
    //     next-turn 只在回合循环的下一次迭代被 claim（同文件 534 起的 `while(true)` →
    //     `preStep(target)` → `inbox.claim(target)`）。所以只要"当前这个回合永不结束"
    //     （模型挂着 qq_wait_for_messages 长轮询 / 被一次重启打断后僵在 running），
    //     这条消息就永久停在 next-turn 里——模型永远看不到，桥也收不到任何事件。
    //   · `{mode:'steer'}` → `agent.steer()` → `send(msg,'next-step',true)` → next-step 队列。
    //     而 `inbox.claim()`（`dsh-agent/lib/index.js:56-61`）总是先把 next-step 全部取走，
    //     再按 target 补取一条 next-turn：
    //       回合正在跑 → 本回合的下一个 step 边界就交给模型（不乱起新回合、不多花一整轮）；
    //       agent 空闲   → `send()` 里 `wakingAfterAbort` 不成立（`phase.kind==='idle'`，同文件 396-397），
    //                      target 保持 next-step，`wakeDriver()` 直接开一个回合，
    //                      而回合第一步 preStep 就把 next-step 全领走 → 照样第一时刻送达。
    //     ⇒ steer 是全定义（total）的：无论会话忙不忙，它都必定被取走，不可能被搁浅。
    // 为什么以前用 queue："忙时不想插进在途回合"。可那条路线的代价就是上面那次永久卡死，
    // 而卡死的代价远大于"对话窗口里多一条注入"——2026-09-11 已定调：不静默 > 不注入。
    // 备注：真正"零注入"的快路径没有被这条改动影响——模型挂着 qq_wait_for_messages 时，
    // 消息作为工具结果回到它手里（social-state.js 顶部的 activeWaits 守卫），根本不走这里。
    accepted = await withTimeout(apiRef.sessions.prompt({ sessionId, mode: 'steer', content }), 30000, `DSH prompt ${sessionId}`);
  } catch (error) {
    // 投递超时/失败：DSH 会话可能已卡死，隔离该会话，避免投递队列永久卡 busy
    quarantineSession(key, sessionId);
    log(`[default] DSH 投递超时/失败 ${key}，会话已隔离（${error?.message ?? error}）`);
    return { ok: false, error: `投递失败（会话已重置，将自动恢复）：${error?.message ?? error}` };
  }
  if (!accepted.result.ok) {
    const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
    const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
    if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
    return { ok: false, error: safeErrText };
  }
  // 单默认模式（default=default）：命令文本不自动转发到 QQ（历史 chat 自动转发分支已删除）
  return { ok: true };
}

export function deliverPrompt(key, promptText, opts = {}) {
  return new Promise((resolve, reject) => {
    let entry = promptQueues.get(key);
    if (!entry) {
      entry = { queue: [], running: false };
      promptQueues.set(key, entry);
    }
    entry.queue.push({ promptText, opts, resolve, reject });
    processPromptQueue(key);
  });
}

export async function processPromptQueue(key) {
  const entry = promptQueues.get(key);
  if (!entry || entry.running) return;
  const item = entry.queue.shift();
  if (!item) {
    if (entry.queue.length === 0) promptQueues.delete(key);
    return;
  }
  entry.running = true;
  try {
    const result = await deliverPromptNow(key, item.promptText, item.opts);
    item.resolve(result);
  } catch (error) {
    item.reject(error);
  } finally {
    entry.running = false;
    if (entry.queue.length) processPromptQueue(key);
    else promptQueues.delete(key);
  }
}

export function drainPromptQueue(key, errorMsg) {
  const entry = promptQueues.get(key);
  if (!entry) return;
  for (const item of entry.queue) item.reject(new Error(errorMsg));
  entry.queue = [];
  promptQueues.delete(key);
}

export function drainAllPromptQueues(errorMsg) {
  for (const [, entry] of promptQueues) {
    for (const item of entry.queue) item.reject(new Error(errorMsg));
  }
  promptQueues.clear();
}
