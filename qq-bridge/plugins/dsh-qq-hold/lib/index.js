// dsh-qq-hold —— 回合保持（turn-hold）的 DSH 侧「时序闸门」。
//
// 目标：**让"唤醒"不再另起一轮**。首轮唤醒把回合开起来之后，桥把后续所有消息用 mode:steer
// 塞进同一个回合；本插件负责在那个唯一的关闭时机（`agent/turn-stopping`）里**把回合按住不放**。
//
// 原理（bedrock，见桥侧 src/core/turn-hold.js 顶部）：
//   dsh-agent-loop/lib/index.js:564-572 在回合即将关闭时
//     await this.dispatch.serial("agent/turn-stopping", { turn, signal });
//   然后在钩子返回后**重新检查** this.inbox.nextStep.length。
//   钩子里只要肯等，桥就有时间把新消息 steer 进 next-step；钩子返回后 next-step 非空 →
//   本回合不关，直接跑下一步继续处理。插件因此是"唯一能让回合不关"的位置。
//
// ── 循环续问（关键）─────────────────────────────────────────────────────────
// 不能用一个"挂 30 分钟"的大请求：undici/fetch 的 headersTimeout 默认 300 秒，超了会自己断，
// 于是长期持有会被 HTTP 层截断（症状：桥配了长保持，回合还是几十秒就关了）。
// 所以协议改成**分段**：桥每段最多持有 requestBudgetMs（默认 55s），要它继续持有就回 `again:true`，
// 本插件收到后**立刻再发一次**。对 DSH 而言钩子一直在等待（回合一直不关），
// 对 HTTP 而言每个请求都很短，不碰任何超时。
//
// 设计上刻意让插件"零业务逻辑"：不碰 QQ 会话 / 未读 / 令牌，也不用 createUserMessage。
// 真正决定"继续持有还是放行关闭"、以及真正执行 steer 的，都是桥里那条**已实跑验证过**的路径。
// 插件自己出任何问题（桥没开、超时、解析失败）都只会让回合照常关闭，即退化成加这个功能之前的行为。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 与 qq-mode-console 插件同一套落点约定：<bridge-root>/state/dsh-qq-hold.log
const DIAG = path.join(__dirname, '..', '..', '..', 'state', 'dsh-qq-hold.log');

function diag(msg) {
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'dsh-qq-hold';

export function apply(ctx, config = {}) {
  const endpoint = String(config.endpoint || 'http://127.0.0.1:3100/api/qq/turn-hold');
  // 单次请求超时：必须**略大于**桥侧的 requestBudgetMs（默认 55000），否则桥还没到预算就被插件断开。
  // 注意它**不是**总持有上限 —— 总时长靠"续问轮次"自然延续。
  const timeoutMs = Math.max(1000, Number(config.timeoutMs) || 60000);
  diag(`active: endpoint=${endpoint} timeoutMs=${timeoutMs}（分段续问模式）`);

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }, next) => {
    const sessionId = String(agent?.session?.id ?? '');
    if (sessionId) {
      const turnNo = Number(turn) || 0;
      let rounds = 0;
      // 上限 500 轮 ≈ 500 × 55s，纯属防御，正常由桥的 idleCloseMs / maxExchanges 先结束。
      while (!(signal && signal.aborted) && rounds < 500) {
        rounds++;
        const ac = new AbortController();
        const onAbort = () => { try { ac.abort(); } catch {} };
        if (signal) {
          if (signal.aborted) onAbort();
          else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
        }
        const timer = setTimeout(onAbort, timeoutMs);
        let out = null;
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, turn: turnNo }),
            signal: ac.signal,
          });
          out = await res.json().catch(() => null);
        } catch (error) {
          // 桥没开 / 超时 / 被 abort —— 一律放行关回合，绝不让回合卡死在这里。
          diag(`hold skipped (${error?.name ?? 'Error'}): ${error?.message ?? error}`);
        } finally {
          clearTimeout(timer);
          try { signal?.removeEventListener?.('abort', onAbort); } catch {}
        }
        if (!out) break;
        if (out.again === true) {
          if (rounds === 1) diag(`keep-holding: turn=${turnNo} session=${sessionId}（分段续问中）`);
          continue;   // 桥要我们继续持有 → 立刻再问一次
        }
        if (out.close === false) {
          diag(`HOLD steered: turn=${turnNo} exchanges=${out.exchanges} rounds=${rounds} session=${sessionId}`);
          break;
        }
        if (out.reason && out.reason !== 'disabled') {
          // 只记"真的参与过"的关闭原因；disabled / no-key 是关闭状态下的常态，不记以免日志膨胀。
          diag(`close: reason=${out.reason} turn=${turnNo} rounds=${rounds} session=${sessionId}`);
        }
        break;
      }
    }
    // 有些钩子是中间件式的（带 next）。带就调用，保证不把后续监听器挂死。
    if (typeof next === 'function') return next();
  });
}
