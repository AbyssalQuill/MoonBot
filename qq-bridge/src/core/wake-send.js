// M8 唤醒引擎
// deliverPrompt(投递) 经 setWakeDeliver 注入；api 经 setWakeApi；cfg 经 initWakeCore。
import { fmtBeijing } from '../lib/time.js';
import { log, appendActivity } from '../lib/log.js';
import { isDirectedAtAi } from '../lib/social-timeline.js';
import { withTimeout } from '../lib/async.js';
import { currentMode, selfNickname, isSessionAllowedInCurrentMode } from './mode.js';
import { state, saveState } from './config.js';
import { createStandbySession, ensureSession } from './dsh-session.js';
import { formatMemory, formatProfileText, formatContactsLine, recentChatMessages, fetchUnreadChatMessages, markMessagesRead } from './memory.js';
import { formatGroupInfoLine, formatGroupListLine } from './group-cache.js';
import {
  getSocialState, saveSocialState, social, seenForwardIds,
  cancelReplyCheck, setupSleepTimer, collectFreshWakeMedia, isInSleepWindow,
  formatParticipation, isConversationBusy,
} from './social-state.js';
import { buildCrossChatBlock } from './crosschat.js';
import { activityStatusLine } from './activity.js';
import { armPendingWakeLease, disarmPendingWakeLease } from './turn-guard.js';
import { wakeConfigMissCount, reverse, pendingWakeKeys, TurnStartAt, collectors, agentRunningSessions, holdActiveKeys } from './session-state.js';
import { KNOWN_AGENT_TOKENS } from '../lib/text-safe.js';
import { sanitizeForwardId } from '../forward.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE_DIR } from '../lib/paths.js';

export const TOPIC_WAKE_RE = /(?:\b(?:ai|gpt|deepseek|dsh|llm|aigc)\b|人工智能|大模型|机器人|小鲸鱼|大肥鱼)/i;

let cfgRef = null;
let apiRef = null;
let deliverRef = null;
/** main 启动时调用：注入 cfg */
export function initWakeCore(cfg) { cfgRef = cfg; }
/** DSH client（NodeApiClient）就绪后注入 */
export function setWakeApi(api) { apiRef = api; }
/** 投递函数（main 的 deliverPrompt）注入 */
export function setWakeDeliver(fn) { deliverRef = fn; }

/** 会话归档队列：轮换/重置后旧会话异步归档，不阻塞唤醒处理，也不堆积。
 *  - 入队自动去重（同一 sessionId 只归档一次），串行逐个执行，避免并发打爆 DSH；
 *  - 单次失败最多重试 2 次（间隔递增），仍失败只记日志放弃——不阻塞也不无限堆积。 */
const archiveQueue = [];
const archiveInFlight = new Set();
let archiveRunner = null;

export function queueArchiveSession(sessionId) {
  if (!sessionId) return;
  if (archiveInFlight.has(sessionId) || archiveQueue.includes(sessionId)) return; // 去重
  archiveQueue.push(sessionId);
  if (!archiveRunner) archiveRunner = drainArchiveQueue();
}

async function drainArchiveQueue() {
  let attempt = 0;
  while (archiveQueue.length > 0) {
    const sid = archiveQueue.shift();
    if (!sid) continue;
    archiveInFlight.add(sid);
    try {
      await apiRef.workspace.archiveSession({ sessionId: sid });
      attempt = 0;
    } catch (error) {
      attempt += 1;
      if (attempt <= 2) {
        archiveQueue.push(sid); // 重试（队尾）
        log(`[archive] 归档失败将重试(${attempt}/2) ${sid}: ${error?.message ?? error}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      log(`[archive] 归档放弃 ${sid}: ${error?.message ?? error}`);
    } finally {
      archiveInFlight.delete(sid);
    }
  }
  archiveRunner = null;
}


export function evaluateWakeTrigger(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
  if (kind === 'private') return 'private';
  // 睡眠窗口过滤（群聊专属，省 token）：窗口内只响应 @，probability/keyword/question/speaker 等一律不投递。
  if (isInSleepWindow() && kind === 'group') {
    const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (atSelf || quoteTargetIsSelf) return 'atMention';
    return null;
  }
  const tr = st.wakeConfig?.triggers ?? {};
  if (tr.anyMessage) return 'anyMessage';
  if (tr.atMention) {
    const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (atSelf || quoteTargetIsSelf) return 'atMention';
  }
  if (tr.nameMention && selfNickname) {
    const lower = String(textContent ?? '').toLowerCase();
    if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
  }
  if (Array.isArray(tr.keywords) && tr.keywords.length) {
    const lower = String(plainContent ?? '').toLowerCase();
    for (const kw of tr.keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
      } else if (lower.includes(kwStr)) {
        return `keyword:${kw}`;
      }
    }
  }
  if (tr.question && isDirectedAtAi(plainContent)) return 'question';
  // 智能接话：聊到 AI/技术相关话题时主动参与（全局，AI 自行判断值不值得接）
  if (TOPIC_WAKE_RE.test(String(plainContent ?? ''))) return 'topic';
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
      const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
      return `speaker:${senderLabel}`;
    }
  }
  if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
  return null;
}

// 运行时「人设/发言规则」文件注入（桌面 GUI 写入 qq-bridge/persona.md 与 speech-rules.md，桥只读；
// 缺失跳过；按 mtime 缓存，文件变更下次唤醒自动生效；上限 persona 16000 / speech 6000 字符）
// 【2026-09-12 主人反馈】原来 persona 上限 6000 字符，而一份完整角色卡动辄 9KB+ —— 会被静默截断。
const RUNTIME_OVERRIDE_MAX = { 'persona.md': 16000, 'speech-rules.md': 6000 };
const runtimeOverrideCache = {}; // fileName -> { statKey, text }
function readRuntimeOverrideFile(fileName) {
  const cached = runtimeOverrideCache[fileName];
  for (const dir of [ROOT, STATE_DIR]) {
    const p = path.join(dir, fileName);
    let stat = null;
    try {
      const s = fs.statSync(p);
      if (s.isFile()) stat = s;
    } catch { stat = null; }
    if (!stat) continue;
    const statKey = `${stat.mtimeMs}:${stat.size}`;
    if (cached && cached.key === statKey) return cached.text;
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
      const cap = RUNTIME_OVERRIDE_MAX[fileName] || 6000;
      if (text.length > cap) {
        text = `${text.slice(0, cap).trimEnd()}\n…[truncated]`;
        log(`[wake] ${fileName} 超过 ${cap} 字符，已截断注入（其余部分未进模型）`);
      }
    } catch { text = ''; }
    runtimeOverrideCache[fileName] = { key: statKey, text };
    return text;
  }
  runtimeOverrideCache[fileName] = { key: '', text: '' };
  return '';
}

/** 人设 / 发言规则文件的"当前版本号"（mtime:size）。
 *  【2026-09-12】保存人设后用它判定"要不要重新注入完整 prompt"：
 *  文件一变版本号就变 → 下一条消息就是新人设，不用重启桥、也不用等会话轮换。 */
export function runtimeOverrideStamp() {
  readRuntimeOverrideFile('persona.md');
  readRuntimeOverrideFile('speech-rules.md');
  return `${runtimeOverrideCache['persona.md']?.key || ''}|${runtimeOverrideCache['speech-rules.md']?.key || ''}`;
}

function buildRuntimeOverrideBlock() {
  const personaText = readRuntimeOverrideFile('persona.md');
  const speechText = readRuntimeOverrideFile('speech-rules.md');
  const parts = [];
  // 【2026-09-12 修「上传的人设根本没进模型」】原来的判据是 `persona.md 含中文就整段跳过注入`，
  // 理由是"避免和英文 preset persona 重复"。实际后果：主人上传的中文角色卡**一个字都没被注入**，
  // 模型一直在演内置的精简版小鲸鱼 —— 这正是主人看到的"我上传的人设不是你注入的人设"。
  // 现在：**原样注入，中英文都不拦**；preset 那边也改成了"人设来自 [PERSONA]，内置角色只是兜底"，
  // 两层分工清楚：preset 管规则（安全/工具/唤醒协议），persona.md 管"你是谁"。
  // 人设文件里写的自定义规矩同样生效（不解析、不过滤、不删减）。
  if (personaText) {
    parts.push(`[PERSONA] (owner's character card via the manager - this is WHO YOU ARE; play it in full, including any custom rules written inside it)\n${personaText}`);
  }
  if (speechText) parts.push(`[SPEECH RULES] (how to type - always in force)\n${speechText}`);
  return parts.length ? `\n${parts.join('\n\n')}\n\n` : '';
}

export function buildWakePrompt(key, reason) {
  const st = getSocialState(key);
  // 【2026-09-12】首轮也要带 `[OWNER]` 标记：persona 的 [OWNER MODE] 只认这个标记，
  // 而首轮走的是 buildWakePrompt（不是哨兵轮正文），漏了它就会导致"新会话第一句没用主人语气"。
  const ownerMark = (!!cfgRef?.ownerQQ && key === `private:${cfgRef.ownerQQ}`) ? '[OWNER]\n' : '';
  // 【2026-09-12 令牌行改英文括号】主人要求：【令牌】→ [Token]（英文标签 + 英文方括号）。
  // 语义不变（仍是"本会话当前有效令牌"），但标签换成英文后与其余唤醒标记（[Wake]/[Unread]/[OWNER]）
  // 同一风格；出站泄露检测的标签正则已同步接受 [Token]（见 lib/text-safe.js）。
  const tokenLine = `[Token] ${st.agentToken}\n${ownerMark}\n`;
  const memoryText = formatMemory(st);
  // 注入长期档案（SQLite）：私聊注入对方档案，群聊注入最近活跃群友的档案。
  let profileText = '';
  try {
    if (key.startsWith('private:')) {
      const uid = key.split(':')[1];
      profileText = formatProfileText(uid);
    } else if (key.startsWith('group:')) {
      const lastUids = new Set();
      for (const m of [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().slice(0, 3)) {
        if (m && !m.isSelf && m.userId) lastUids.add(String(m.userId));
      }
      for (const uid of lastUids) {
        const t = formatProfileText(uid);
        if (t) profileText += (profileText ? '\n' : '') + `[${uid}] ${t}`;
      }
    }
  } catch (error) {
    log(`[memory] 档案注入失败: ${error?.message ?? error}`);
  }
  const contactsText = formatContactsLine();
  const memoryLine = [memoryText, contactsText, profileText ? `[Profile] ${profileText}` : ''].filter(Boolean).join('\n') + '\n\n';
  const participationText = formatParticipation(st);
  const participationLine = participationText ? `${participationText}\n\n` : '';
  const preSleepMs = Math.max(0, Number(cfgRef.social?.wake?.preSleepWaitMs) || 300000);
  const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
  const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
  const statusBits = [`${(st.unread || []).length} unread`];
  if (key.startsWith('private:') && st.peerTypingUntil && Date.now() < st.peerTypingUntil) statusBits.push('peer typing');
  // 【2026-09-15 语境】把"正在等你的那条"点名出来：私聊只有一个人说话，未读里最新的一条就是
  // 这一步该答的。以前只有一行 `N unread` + 下面的 [Unread] 列表，模型偶尔会去接更早的话题
  // （线上实测：连续几条回复都在回同一句老话）。这一行只多几十字符，却把"该答谁"钉死。
  if (key.startsWith('private:')) {
    const waiting = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf);
    if (waiting) {
      const who = waiting.isOwner ? 'owner' : (waiting.sender || 'peer');
      const id = waiting.messageId ? `(id:${waiting.messageId})` : '';
      const body = String(waiting.plain || waiting.text || '').replace(/\s+/g, ' ').slice(0, 60);
      const nUnread = (st.unread || []).filter((m) => m && !m.isSelf).length;
      statusBits.push(`waiting on ${who}${id}: ${body}${nUnread > 1 ? ` (+${nUnread - 1} earlier unanswered)` : ''}`);
    }
  }
  if (lastMsg) statusBits.push(`last from ${String(lastMsg.sender || 'unknown')}(${lastMsg.userId || '?'})[${fmtBeijing(Number(lastMsg.time) || 0)}]: ${String(lastMsg.text || lastMsg.plain || '').slice(0, 20)}`);
  if (lastAiMin != null) statusBits.push(`said ${lastAiMin}min ago`);
  const statusLine = `[Now] ${fmtBeijing(Date.now())} (Beijing)\n[Status] ${statusBits.join('; ')}\n\n`;
  const wc = st.wakeConfig || {};
  const wcTr = wc.triggers || {};
  const wcMode = wc.mode === 'active' ? 'active' : 'diving';
  const wcTime = wc.infinite ? 'infinite' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `until ${new Date(wc.sleepUntil).toLocaleTimeString()}` : 'unset');
  const wcTriggers = [];
  if (wcTr.atMention) wcTriggers.push('@');
  if (wcTr.nameMention) wcTriggers.push('name');
  if (wcTr.question) wcTriggers.push('question');
  if (wcTr.poke) wcTriggers.push('poke');
  if (Number(wcTr.probability) > 0) wcTriggers.push(`prob${wcTr.probability}`);
  const wakeLine = `[Wake] ${wcMode}, ${wcTime}${wcTriggers.length ? ` trg:${wcTriggers.join('/')}` : ''}\n\n`;
  const gInfoText = key.startsWith('group:') ? formatGroupInfoLine(key.split(':')[1]) : '';
  const groupListText = formatGroupListLine();
      // 【2026-09-12 规则搬家】原 rulesShort（12 条：跨会话读取/转达/@/提醒/撤回/长文 docx/
      // 收尾与配额/主人私聊收尾/活跃时段/系统配置键，共 4,274 字符）已**整段搬进系统提示词**
      // （agent.cordis.yml 的 [RULES] 段）——唤醒注入不再每轮重复塞一遍，省的是长期驻留的上下文。
  const base = tokenLine + statusLine + wakeLine + memoryLine + participationLine + (gInfoText ? gInfoText + '\n' : '') + (groupListText ? groupListText + '\n\n' : (gInfoText ? '\n' : ''));
  // 【2026-09-12 规则搬家】原 protocolNote（2,886 字符的「回合协议」：➤ 哨兵含义、读/发/收尾步骤、
  // 步数预算、等待工具禁令）已整段搬进系统提示词的 [WAKE DATA] / [WAKE TYPES] 两段。
  // 现在唤醒正文只留数据行：[Token] + [Wake ...]/[Unread n]/[Mid-turn]/[Note]...，不再携带规则散文。
  // 动态覆盖段：本地 persona.md / speech-rules.md（若存在）放在数据之后，清晰分隔，避免与 preset persona 冲突
  const baseWithProtocol = base + buildRuntimeOverrideBlock();
  // 【2026-09-12 规则搬家】每种唤醒原因的"该怎么做"全部写进系统提示词 [WAKE TYPES]（第 1~14 条），
  // 注入这边只留一行**数据**（原因 + 必需的事实）。首轮也只注入一次，之后全是哨兵轮数据行。
  if (reason === 'bootstrap') {
    return `${baseWithProtocol}[Guide] ${key} first connect`;
  }
  if (reason === 'timeout') {
    return `${baseWithProtocol}[Wake] ${key} sleep ended`;
  }
  if (reason === 'replyCheck') {
    const stRc = getSocialState(key);
    const lastMinRc = stRc.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(stRc.lastAiReplyAt)) / 60000)) : null;
    const replyHintRc = lastMinRc != null ? ` (you replied ${lastMinRc} min ago)` : '';
    return `${baseWithProtocol}[Wake] ${key} reply check${replyHintRc}`;
  }
  if (reason === 'proactiveCheck') {
    return `${baseWithProtocol}[Wake] ${key} proactive opening`;
  }
  if (reason === 'poke') {
    return `${baseWithProtocol}[Wake] ${key} poked`;
  }
  return `${baseWithProtocol}[Wake] ${key} ${reason}`;
}

/**
 * 新会话开局「最近消息」滑动窗口块：轮换/重建后首个回合直接把最近 N 条历史拼进 prompt，
 * 让模型开局即有完整上下文（不必依赖“摘要总结”，也不强制先查工具）；
 * (新)=尚未处理，(旧)=较早且未回过（要回必须带引用），(已发)=自己已发出的内容（提示勿重复）。
 */
function formatRecentWindow(st, key, maxCount) {
  let recent = Array.isArray(st.recentMessages) ? st.recentMessages.slice(-maxCount) : [];
  // 内存窗口缺失（进程重启后极早期/新会话）时直接查 SQLite chat_messages 补上开局上下文
  if (!recent.length && key) recent = recentChatMessages(key, maxCount);
  if (!recent.length) return '';
  const unreadSeqs = new Set((Array.isArray(st.unread) ? st.unread : []).map((m) => m && Number(m.seq)).filter((n) => Number.isFinite(n) && n > 0));
  const lastAiT = Number(st.lastAiReplyAt) || 0;
  const lines = recent.map((m) => {
    if (!m) return null;
    const text = String(m.text || m.plain || '');
    const fresh = unreadSeqs.has(Number(m.seq)) || Number(m.time) > lastAiT;
    const mark = m.isSelf ? '(sent)' : (fresh ? '(new)' : '(old)');
    const shown = m.recalled ? `[已撤回]${text.slice(0, 40)}` : (text.length > 120 ? text.slice(0, 120) + '…' : text);
    const who = m.isSelf ? 'me' : ((m.isOwner ? 'owner' : (m.sender || '?')) + (m.userId && !m.isSelf ? '(' + m.userId + ')' : ''));
    return `${who}${mark}${Array.isArray(m.media) && m.media.length ? '[img]' : ''}[${fmtBeijing(Number(m.time) || 0)}]${m.messageId ? '(id:' + m.messageId + ')' : ''}: ${shown}`;
  }).filter(Boolean);
  if (!lines.length) return '';
  return `[Recent messages (opening context - focus (new); never re-answer what you already replied, marked (sent))]\n${lines.join(' || ')}\n\n`;
}

/* ── 会话忙时把新消息「塞进正在跑的那一轮」──────────────────────────────────────
 * 机制（DSH 原生支持，实测语义）：
 *   session/prompt {mode:'queue'}  → agent.followup(msg) → inbox 'next-turn'  → **多出一整轮**
 *   session/prompt {mode:'steer'}  → agent.steer(msg)    → inbox 'next-step'  → 本回合的**下一个
 *                                    step 边界**就交给模型，于是它在自己正在写的那条回复里
 *                                    顺带把新消息答掉，不多唤醒、不多一轮、也不重发整包 prompt。
 *   （dsh-agent-loop: `steer(input){ this.send(input,'next-step',true) }`；即便 agent 空闲，
 *     next-step 也会被 driver 领走开一轮，所以两态都安全。）
 * 失败一律返回 false，调用方退回排队补发（正确性优先，绝不因为塞不进去而漏消息）。
 */
const STEER_MIN_GAP_MS = 4000;   // 同会话节流：消息洪峰时别一句一塞
const STEER_MAX_UNREAD = 10;     // 只带最近这些条，避免把整段未读灌进在途回合
const STEER_TEXT_CAP = 160;
// ── 【2026-09-12 一次连发只注入一次】──────────────────────────────────────────
// 主人实测：他连发两条消息，桥**注入了两次**（日志第 10、11 次），于是模型跑了两步、发了两条气泡，
// 而那一步的代价是**把整个上下文再发一遍**（那个会话当时 8.6 万 token/步）—— 又慢又贵。
// 根因是两条**独立投递路径**各注入一次：turn-hold 的保持循环（force）与唤醒管线的 busy 分支，
// 且第二条消息是在第一次注入**之后**才到的，按 seq 去重（turnSteeredSeqs）根本拦不住它。
// 现在两道闸门，配合起来就是"一批消息一次注入"：
//   ① 收集窗（COLLECT）：真要注入时先等"这口气说完"（连续打字时最多 COLLECT_MAX），把连发合并进同一次注入；
//   ② 周期闸（CYCLE）：同一个**模型步周期**内只允许注入一次。周期边界 = turn-hold 钩子再次被调用
//      （turn-hold.js 调 markSteerCycleStart），非保持会话按时间近似。
//      周期内后到的消息**不注入**：留在 unread 里（不标"已给过"），由下一个周期带走，或由投递看门狗兜底。
const STEER_COLLECT_MS = 1000;       // 距"这口气说完"（停止输入 + 最后一条消息）静默这么久就发车
const STEER_COLLECT_MAX_MS = 3000;   // 对方一直在打字时最多等这么久（别为了合并一直不发）
const STEER_CYCLE_MS = 5000;         // 周期闸时长：turn-hold 会话（有人接管后续批次）用这个
const STEER_CYCLE_SHORT_MS = 1500;   // 非保持会话的周期闸：只挡"几乎是同时"的那批，避免把答复拖到看门狗
const steerCycleAt = new Map();      // key -> 本周期已注入的时间戳
// 【2026-09-15 合并注入（一个模型步 = 一个 [Mid-turn] 块）】见下面 STEER_PENDING_MAX_MS 处的机理说明。
const pendingSteerSince = new Map(); // key -> ts：最早一条"攒着还没投"的消息（记账 + 防饥饿兜底）
const stepBoundaryAt = new Map();    // key -> ts：最近一次观测到的"模型步边界"（mux 的 step/end / turn-hold 钩子）
/** 新的一步开始（模型步边界）：清掉"本周期已注入"闸门，并记下边界时刻。
 *  调用点：mux.js 收到 `step/end`（模型的每一步末尾）、turn-hold.js 的 agent/turn-stopping 钩子、
 *  以及 turn 边界（turn/start）。这些**都是真实的步/回合边界**，不是拍脑袋的计时窗口。
 *  只在"真的改变了什么"时打日志：正常每一步都会调它，无脑打会刷屏。 */
export function markSteerCycleStart(key, why = 'hook') {
  if (!key) return;
  const sealed = steerCycleAt.get(key);
  const pending = pendingSteerSince.has(key);
  steerCycleAt.delete(key);
  stepBoundaryAt.set(key, Date.now());
  if (stepBoundaryAt.size > 200) {
    for (const [k, t] of stepBoundaryAt) if (Date.now() - t > 3600000) stepBoundaryAt.delete(k);
  }
  if (sealed || pending) {
    log(`[steer] ${key} 模型步边界（${why}）→ 注入闸门复位（解除封口=${!!sealed}，还有待发批次=${pending}）`);
  }
}
let steerSeq = 0;                 // 串行化：同一时刻只允许一个 steer 请求在飞
const steerInFlight = new Map();  // key -> true
const lastSteerAt = new Map();    // key -> ts
// 【2026-09-11 tun-hold】即时注入模式下，遇到"上一次注入还在飞"时**排队等**多久（而不是直接失败）。
// 一次注入通常几十~几百毫秒就落地；直接放弃会把刚到的消息退回补发轮，等于即时注入白做。
const STEER_INFLIGHT_WAIT_MS = 3000;
// ── 【2026-09-15 合并注入：一个模型步 = 一个 [Mid-turn] 块】────────────────────────
// 主人反馈（原话）："我相隔极端时间的消息好像 dsh 的思考里不会同时获取到，然后两条不是两个注入吗
// 它会等第一个注入处理完到第二个注入再处理下一条，我倒是希望它能省去第二次注入然后思考过程中还能获取到消息"。
//
// 机理（逐行读过 DSH 源码，不是推测）：
//   · 每一次 steer 都是 inbox 里**独立的一条 next-step 消息**：`steer(i){ this.send(i,'next-step',true) }`
//     （dsh-agent-loop/lib/index.js:399-401）。
//   · 而 `inbox.claim()` 在**下一个 step 的开端**把 next-step **一次全取走**
//     （dsh-agent/lib/index.js:56-61：先 `mutate('next-step',0,this.nextStep.length,[],false)`，再按
//      target 补取一条 next-turn）——由 dsh-agent-loop/lib/index.js:534 的 preStep 在每步开头调用。
//     ⇒ 同一个 step 里注入 N 次，模型在**同一次思考**里就看到 **N 个独立的 [Mid-turn] 块**，
//       只能一块一块顺序处理：这正是主人看到的"两条消息、两个注入、等第一条处理完才轮到第二条"。
//   · 关键推论：**同一个 step 边界本来就只能带走一批**。所以"把这一步里到达的消息攒起来、在步边界
//     一次性注入"，**送达时刻与"消息一到就立刻注入"完全相同**（都是下一个 step 开端），
//     但模型只看到一个块、只发一条气泡 —— 白拿的合并，不花任何额外延迟。
// 因此对"回合保持（turn-hold）托管"的会话：
//   · 非保持循环发起的即时注入（busy 分支 / scheduleWake 的 steer）**一律不投**，只记账；
//   · 由**步边界**统一发车：turn-hold.js 的保持循环（在 agent/turn-stopping 钩子里），
//     或 mux.js 观测到 `step/end` 后调用的 turn-hold.js:flushStepBatch()；
//   · 绝不"等下一轮"：步边界就是这一步的末尾（几十秒级），消息全程留在 unread 里
//     （不标"已给"、写进 _steerDeferredSeqs 防 mark_read 吞掉），投递看门狗 25s 兜底。
// 非保持会话（群聊 / turn-hold 关）**行为保持原样**：那里没有"步边界注入器"，攒着只会把答复拖到看门狗。
// 【2026-09-15 主人反馈「启动服务端的没回复」→ 实测这条兜底太长了】原来这里等 90 秒。
// 实测（服务端 23:56:42 收到消息 → 23:58:21 才发出回复，整整 99 秒）：当时回合并没在跑步骤，
// 只是被 turn-hold 保持着（保持循环 55 秒才来一次"步边界"），于是这条消息一直等到 90 秒兜底才被投出去 ——
// 主人看到的就是"机器人不回"。真正的步边界（step/end）在活跃回合里是几秒级，20 秒等不到就说明
// 这个回合是**空转的保持态**，没有"再等一个边界能合并掉 N 次注入"的好处，直接投才对。
const STEER_PENDING_MAX_MS = 20000;  // 攒这么久还没等到任何步边界 → 兜底即时注入，绝不静默卡住
/**
 * 「这一步该带走的 [Mid-turn] 批」= `st.unread` 里**还没交给模型**的那些行。
 * 判据与改动前 `steerIntoRunningTurn()` 内部那份过滤**逐字一致**（不是新语义，只是同一条规则提出来给
 * 保持循环 / 合并注入共用 —— 两份实现迟早会漂移）：
 *   · 不在 `turnSteeredSeqs`：本回合已经 steer 注入过；
 *   · 不在 `turnSeenUnread`：本回合唤醒正文里已经展示过。
 * 两个集合都在回合结束时被 mux 清零，所以不会跨回合误挡。
 */
export function collectMidTurnBatch(st, limit = STEER_MAX_UNREAD) {
  if (!st) return [];
  const alreadySteered = new Set((Array.isArray(st.turnSteeredSeqs) ? st.turnSteeredSeqs : []).map(Number));
  const alreadyShown = new Set((Array.isArray(st.turnSeenUnread) ? st.turnSeenUnread : []).map(Number));
  return (Array.isArray(st.unread) ? st.unread.slice(-limit) : []).filter((m) => {
    const seq = Number(m?.seq);
    if (!Number.isFinite(seq)) return true;   // 没有 seq 的老行：保守放行（宁可多投一次，也不静默丢）
    if (alreadySteered.has(seq)) return false;
    if (alreadyShown.has(seq)) return false;
    return true;
  });
}
/**
 * 一批消息"先攒着不投"的记账（合并注入用）。两件事，缺一不可：
 *   ① `_steerDeferredSeqs`：告诉 mark_read"这几条还在等下一次注入，别清"
 *      （console-server.js:1604 的防吞兜底就查这个集合）；
 *   ② `pendingSteerSince`：最早一条的等待起点（日志 + 防饥饿兜底要它）。
 * 调用方**必须自己再打一行日志** —— 这个功能吃过四次"静默失败"的亏，
 * 任何"这批先不投"的决定都必须在桥日志里留下痕迹（见下面两个调用点的措辞）。
 * @returns {number} 这批最早一条已经等了多久（ms）
 */
function deferSteerBatch(st, key, batch) {
  if (!pendingSteerSince.has(key)) pendingSteerSince.set(key, Date.now());
  const waitedMs = Date.now() - (Number(pendingSteerSince.get(key)) || Date.now());
  try {
    const seqs = batch.map((m) => Number(m?.seq)).filter((n) => Number.isFinite(n) && n > 0);
    if (seqs.length) {
      const prev = Array.isArray(st._steerDeferredSeqs) ? st._steerDeferredSeqs : [];
      st._steerDeferredSeqs = [...new Set([...prev, ...seqs])].slice(-50);
    }
  } catch (_) { /* 记账失败不影响主流程，但调用方那行日志仍会打 */ }
  return waitedMs;
}
/**
 * 回合边界（`turn/end`）收尾：把"攒着待发"的记账清干净。
 * 回合都没了，攒的批次不再属于任何模型步；消息**留在 unread 里**（没标已给），由回合结束的补发逻辑
 * 与投递看门狗接管 —— 这里只清记账 + 留一行日志（一批消息跨过回合边界还没投出去是异常，必须看得见）。
 */
export function clearSteerPending(key, why = 'turn/end') {
  if (!key) return;
  if (pendingSteerSince.delete(key)) {
    log(`[steer] ${key} 回合边界（${why}）时仍有"攒着未投"的批次 → 记账已收（消息仍在未读，交给补发/看门狗）`);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function steerIntoRunningTurn(key, reason, opts = {}) {
  // opts.force（turn-hold 专用，见 core/turn-hold.js）：跳过 steerEnabled 开关与节流。
  //   turn-hold 的调用点就在 DSH 的 agent/turn-stopping 钩子内部——**那一刻确定有一个回合在跑**，
  //   所以"忙 ≠ 回合在跑"这个误判在这里天然不成立；它有自己的开关 social.turnHold.enabled。
  //   必须绕过节流：节流一拒，hold 循环会误判成"塞不进去"而直接放行关回合，保持就白做了。
  //   下面的 runningTurn 守卫**仍然保留**（多一道保险，宁可放行关回合也不要吞消息）。
  const forced = opts?.force === true;
  // ⚠️ 默认关闭（social.steerEnabled 未设或不为 true 就直接不干）。
  // 2026-09-11 上线当天实测到**吞消息**：`isConversationBusy()` 为真并不等于"有一个模型回合在跑"——
  // 合并窗 `pendingWakeTimer`、投递在途 `pendingWakeKeys`、桥自己的 `promptQueues` 都会让它为真，
  // 而这些情况下 agent 其实是**空闲**的。此时塞一条"[Mid-turn] 这不是新一轮"进去，模型会照着
  // "我在半路"的口气直接收尾（mark_read）而不回复，unread 又被清掉，回合结束时的补发逻辑判定
  // "已被当前回合处理" → **这条消息就永久消失了**（实测：主人 20:03:46 的「笨蛋」再没被回过，
  // 4.7e.1 记录的那次）。根治需要更可靠的"回合真的在跑"信号（见下面 runningTurn 判断），
  // 但在此之前**默认关掉**，行为与加这个功能之前完全一致。
  // 【2026-09-11 turn-hold 补完】三种"允许 steer"的情形：
  //   1. forced：turn-hold 的保持循环（调用点就在 turn-stopping 钩子里，确定有回合在跑）；
  //   2. social.steerEnabled === true：全局开关（默认关，未经验证不打开）；
  //   3. **turn-hold 灰度内的会话 + DSH 权威状态说 running** ——这是新增的第三条，
  //      专门补上"模型正在跑这一步"那段窗口：以前只有 turn-stopping 那一刻能塞，
  //      模型跑一步 40 秒期间到的消息只能被暂存、最后走补发轮（实测 21:27 的 seq25 就是这么被落下的）。
  //      安全性来自 DSH 自己报的 `host/session-status` running 帧，而不是桥猜的"忙"。
  const holdCfg = cfgRef?.social?.turnHold ?? {};
  const holdKeys = Array.isArray(holdCfg.keys) ? holdCfg.keys.map(String).filter(Boolean) : [];
  const holdEligible = holdCfg.enabled === true && !!key
    && (holdKeys.length === 0 || holdKeys.includes(key))
    && (holdCfg.privateOnly === false || String(key).startsWith('private:'));
  // ⚠️⚠️ 这里必须**自己算** sessionId，绝对不能引用下面那个 `const sessionId` ——
  // 它声明在闸门**之后**，提前引用会抛 TDZ 错误。实测 2026-09-11 21:41:01：
  //   `[hold] steer 结果：未成功（返回 false） 异常=Cannot access 'sessionId' before initialization`
  // 后果是整条即时注入链路全废，而且 busy 分支那条 `void …then()` 没有 catch，连日志都不留。
  // 教训：往一个已有函数**前面**插代码时，必须先确认用到的变量都已在它之前声明。
  const sidRaw = state.sessions[key] || null;
  const sidForGate = sidRaw ? String(sidRaw) : '';
  const authoritativeRunning = !!sidForGate && agentRunningSessions.has(sidForGate);
  // ⚠️ 实测结论（2026-09-11 13:30）：`host/session-status` 这个权威帧**没有进桥的事件流**（计数 0，
  // 那批 host/* 帧走的是 Web UI 的 host 流，不是桥订阅的 session 事件流）。所以不能只靠它，
  // 必须回退到桥自己观察到的回合边界：TurnStartAt（turn/start 置位、turn/end 清除）与 collectors。
  // 关键点：TurnStartAt 在**整个回合期间**都为真 —— 包括"模型正在跑这一步"的那几十秒，
  // 而那正是本次要补的窗口（实测 21:27:19 的 seq25 就是落在这里，被暂存后走了补发轮）。
  const observedRunning = !!sidForGate && (TurnStartAt.has(sidForGate) || collectors.has(sidForGate));
  const runningEvidence = authoritativeRunning || observedRunning;
  // 【2026-09-11 21:50 主人诊断："原来的唤醒与这个冲突了" —— 确认属实】"即时注入模式" = 不该被老那套限流挡住：
  //   · forced：保持循环（在 turn-stopping 钩子里）；
  //   · turn-hold 灰度内 + 回合确实在跑：模型正在跑这一步时到达的消息（本次新增的窗口）。
  // 为什么必须绕过节流：实测同一分钟内连发时，seq38/seq39 分别在 1.75s、3.76s 间隔到达，
  // 被 `STEER_MIN_GAP_MS = 4000` 直接挡掉 → 退回 `暂存唤醒原因` → 最后走补发轮，
  // **即时注入等于白做**。防重复改由 `turnSteeredSeqs` 去重保证（同一 seq 永不注入两次）——
  // 那才是真正该守的不变量，而不是"4 秒内只许塞一次"（人类打字速度才是天然的限流）。
  // 【2026-09-12 架构收敛】此刻为止，无论走哪条路径，**"有一批新消息还没交给模型"这件事必须立刻落地**：
  //   · 会话忙 + 回合在跑 → 塞进在途回合（本函数）；
  //   · 会话空闲 / 塞不进去 → 正常唤醒（prompt-deliver.js 里也已经改成 mode:'steer'）。
  // 所以这里不再需要"4 秒内只许塞一次"这种为了防过密的节流：同一个 seq 由 turnSteeredSeqs 保证
  // **永不注入两次**，那才是真正该守的不变量；人类打字速度本身就是天然限流。
  const immediateMode = forced || runningEvidence;
  // 全局开关 `social.steerEnabled`：**默认开**，只有显式写成 `false` 才关闭。
  // 当年（2026-09-11）默认关的原因是"`isConversationBusy()` 为真 ≠ 有回合在跑"——那时没有可靠的
  // 运行态信号，steer 会往一个空闲会话里塞 "[Mid-turn]"，模型照着"我在半路"的口气直接收尾，
  // 于是刚到的消息被 mark_read 清掉、永久消失（主人 20:03:46 的「笨蛋」）。
  // 现在这件事已经由下面那道 `runningTurn` 硬守卫解决了（必须真的有回合在跑），
  // 而 steer 在空闲态本身也是安全的（见 prompt-deliver.js 里对 DSH 源码的核对），
  // 所以不再需要用"默认关"来兜——继续默认关的代价是**每次忙时的消息都退回补发轮**（今天实测了一整晚）。
  const steerSwitchOff = cfgRef?.social?.steerEnabled === false;
  const allowed = forced || !steerSwitchOff;
  if (!allowed) {
    // 【教训·2026-09-11 21:19】这一行曾经是**静默 return false**，而且没把 opts.force 接进来：
    // turn-hold 一直报 steer-failed，日志里却连一条 [steer] 都没有。
    // **本函数里任何 return false 都必须留一行日志**，否则分不清"没接线"和"条件不满足"。
    log(`[steer] 跳过 ${key}：即时注入被 social.steerEnabled=false 显式关闭（force=${forced} turnHold灰度=${holdEligible} 在跑=${runningEvidence}〔权威=${authoritativeRunning}/桥观测=${observedRunning}〕）`);
    return false;
  }
  // 每个提前返回都留一行日志：这个函数一旦静默 return false，日志里就什么都看不到，
  // 排查时分不清"没接线"和"接线了但条件不满足"（第一次上线就吃了这个亏）。
  if (!apiRef) { log('[steer] 跳过：apiRef 未就绪'); return false; }
  if (!key) { log('[steer] 跳过：key 为空'); return false; }
  const st = getSocialState(key);
  const sessionId = state.sessions[key] || null;
  if (!st) { log(`[steer] 跳过 ${key}：社交状态不存在`); return false; }
  if (!sessionId) { log(`[steer] 跳过 ${key}：还没有映射的 DSH 会话（state.sessions 里为空）`); return false; }
  // 核心守卫：**必须真的有一个模型回合在跑**才允许 steer。
  // "忙"的其它成因（合并窗/投递在途/桥内队列）都不是"回合在跑"，那时 steer 会导致模型收尾不回复 → 吞消息。
  const runningTurn = Boolean(sessionId && (agentRunningSessions.has(sessionId) || TurnStartAt.has(sessionId) || collectors.has(sessionId)));
  if (!runningTurn) { log(`[steer] 跳过 ${key}：没有正在跑的模型回合（DSH 权威状态 / TurnStartAt / collectors 都说没在跑，"忙"只是合并窗或投递在途）`); return false; }
  if (steerInFlight.get(key)) {
    if (!immediateMode) { log(`[steer] 跳过 ${key}：上一次注入还在飞`); return false; }
    // 即时注入模式下**排队等**，而不是直接失败。实测 21:50:23：保持循环看到 in-flight 就放弃
    // → 保持结束 steer-failed、消息退回补发；其实上一次注入几十~几百毫秒就落地了，等一下就能塞进去。
    let waited = 0;
    while (steerInFlight.get(key) && waited < STEER_INFLIGHT_WAIT_MS) {
      await sleep(50);
      waited += 50;
    }
    if (steerInFlight.get(key)) { log(`[steer] 跳过 ${key}：等上一次注入落地超时（${waited}ms）`); return false; }
    log(`[steer] ${key} 等到上一次注入落地（${waited}ms），继续即时注入`);
  }
  const last = lastSteerAt.get(key) || 0;
  const sinceMs = Date.now() - last;
  if (!immediateMode && sinceMs < STEER_MIN_GAP_MS) { log(`[steer] 跳过 ${key}：节流中（${sinceMs}ms < ${STEER_MIN_GAP_MS}ms）`); return false; }
  const unreadAll = Array.isArray(st.unread) ? st.unread.slice(-STEER_MAX_UNREAD) : [];
  if (!unreadAll.length) { log(`[steer] 跳过 ${key}：当前没有未读可塞`); return false; }
  // 【防重复注入】本回合**已经给过它**的 seq 不再发第二遍。两个来源都要查：
  //   ① `turnSteeredSeqs` —— 本回合已经 steer 注入过的；
  //   ② `turnSeenUnread`  —— 本回合**唤醒正文里已经展示过**的（wake-send.js:697 在投递唤醒时记录）。
  // ⚠️ ②是 2026-09-11 22:34 补上的：当时只看①，于是「你好呀」在回合开头的唤醒里已经给过，
  //    但它还没被 mark_read、仍留在 unread 里，下一条「可爱捏」触发 steer 时**两条又一起发了一遍**，
  //    模型看到 `[Mid-turn] 2 new message(s)`，主人却只发了两条不同的消息（其中一条被重复投喂）。
  //    代价不只是重复——它会以为主人重发了，可能重复回复。
  // 两者都在回合结束时清零（mux.js），所以不会跨回合误挡。
  const alreadySteered = new Set((Array.isArray(st.turnSteeredSeqs) ? st.turnSteeredSeqs : []).map(Number));
  const alreadyShown = new Set((Array.isArray(st.turnSeenUnread) ? st.turnSeenUnread : []).map(Number));
  // 过滤规则统一走 collectMidTurnBatch()（两份实现迟早漂移）；上面两个 Set 保留只为下面那行日志。
  const unread = collectMidTurnBatch(st);
  if (!unread.length) {
    // 【2026-09-12 修「同一条内容被回两遍」】这里**必须返回 true，不能返回 false**。
    // 语义是"这批消息**已经在模型手里了**"（本回合的唤醒正文展示过，或刚被 steer 注入过）——
    // 调用方（`sendWakePrompt` 的 busy 分支 / turn-hold 的保持循环）要的是"**别再投一次**"，
    // 而不是"投失败了"。返回值只有"真塞进去"和"已经在里面"两种，两者对调用方的决定是一样的。
    //
    // 曾经返回 false，造成过一次**真的发到主人 QQ 的重复**（实测 2026-09-12 01:27:53/01:27:54）：
    //   · 17:07:20 turn-hold 的保持循环先 `steer` 成功（第 4 次）；
    //   · 17:07:21 写路径的 busy 分支也来 steer 同一条 → 被这里去重拦下 → 拿到 **false**；
    //   · busy 分支把 false 读成"没送成" → **落回"正常唤醒流程"** → 又投了一条**完整唤醒**进同一个回合；
    //   · 模型在同一回合里看到同一批未读两遍 → 回了两次
    //     （QQ 上就是「昨天262条，今天48条，一共310条。」+「昨天262 今天48 共310」）。
    // 教训与 §4.7h.2 同源：**一个 boolean 承担不了三种语义**（塞成功 / 已经在手里 / 真失败），
    // 调用方一旦分不清，就会把"已经给过"当成"没给过"——正是 §4.13.3 那条"改这类逻辑先 grep 出所有调用点"。
    log(`[steer] ${key}：这 ${unreadAll.length} 条本回合**已经给过它了**（唤醒已展示 ${alreadyShown.size} 条 / 已注入 ${alreadySteered.size} 条）—— 无需再投，按「已交付」返回 true（防重复投递 → 防重复回复）`);
    return true;
  }
  // ③ 【2026-09-15 合并注入】保持（turn-hold）托管的会话：**不在这里即时注入**。
  //    理由与不变量见文件顶部 STEER_PENDING_MAX_MS 那段：同一个 step 里注入 N 次 = 模型在同一次思考里
  //    看到 N 个 [Mid-turn] 块、一块一块顺序处理（主人报的正是这个）；而"攒到步边界一次带走"的
  //    送达时刻**与之完全相同**（都是下一个 step 开端），却只产生一个块、一条气泡。
  //    这里只记账 + 返回 true（= "不用你再投一遍"），真正的发车交给两个步边界注入器：
  //      · turn-hold.js 的保持循环（agent/turn-stopping 钩子 = 回合准备关闭的步边界）；
  //      · turn-hold.js:flushStepBatch()（mux 观测到 `step/end` = 模型每一步的末尾）。
  //    ⚠️ 只有**保持托管**的会话走这条路：非保持会话没有步边界注入器，攒着只会把答复拖到投递看门狗，
  //       所以那边保持原行为（即时注入 + 时间周期闸）不动。
  if (!forced && holdEligible) {
    // 防饥饿兜底（两道，任一成立就不再攒）：
    //   · 已经跨过一个步边界还没被投出去（说明步边界注入器没生效）→ 立刻自己投；
    //   · 攒的时间超过 STEER_PENDING_MAX_MS（事件流/插件整体失效）→ 立刻自己投。
    // 两者都不成立 = 仍在同一个模型步之内 → 继续攒（这正是合并注入要的效果）。
    const boundaryAt = Number(stepBoundaryAt.get(key)) || 0;
    const sinceAt = Number(pendingSteerSince.get(key)) || 0;
    const missedBoundary = boundaryAt > 0 && sinceAt > 0 && boundaryAt > sinceAt;
    const waitedMs = sinceAt > 0 ? Date.now() - sinceAt : 0;
    if (!missedBoundary && waitedMs < STEER_PENDING_MAX_MS) {
      const heldMs = deferSteerBatch(st, key, unread);
      log(`[steer] ${key} 合并注入：这 ${unread.length} 条**不在半路单独注入**，攒到本步边界（step/end 或 turn-hold 钩子）一次带走（turn-hold 托管，最早一条已等 ${heldMs}ms）`);
      return true;
    }
    log(`[steer] ${key} 兜底即时注入：这批攒了 ${waitedMs}ms 仍未被步边界带走（错过步边界=${missedBoundary}，上限 ${STEER_PENDING_MAX_MS}ms）→ 本次直接投，绝不静默卡住`);
  }
  // ② 周期闸：本周期（= 上一个模型步）已经注入过一次了 —— 主人明确要求"两条消息只保留第一次注入"。
  //    返回 true 而不是 false：语义是"**不用你再投了**"（调用方若拿到 false 会落回完整唤醒流程 → 又是一次注入）。
  //    这批消息**不标已给**（不进 turnSteeredSeqs / 不推 lastDeliveredSeq），所以：
  //      · turn-hold 会话：保持循环下一次被调用（下一个模型步结束）就会把它们带走；
  //      · 非保持会话：留在 unread 里，投递看门狗 25s 内兜住（比"再注入一次"便宜：少一整步上下文重发）。
  //    ⚠️ 非保持会话把窗口收紧到 SHORT：那种回合很快就结束，拖 5 秒不如让它照旧多注入一次。
  const cycAt = Number(steerCycleAt.get(key)) || 0;
  const cycleWindow = holdActiveKeys.has(key) ? STEER_CYCLE_MS : STEER_CYCLE_SHORT_MS;
  if (cycAt && Date.now() - cycAt < cycleWindow) {
    const agoMs = Date.now() - cycAt;
    // 记下"被推迟交付"的 seq：mark_read 在**没有展示水位**时会全清 unread，那会把这批一起吞掉
    // （§2026-09-11 20:03:46 同类）。记在这里 = 告诉 mark_read"这几条别动，它们还在等下一个周期"。
    deferSteerBatch(st, key, unread);
    log(`[steer] ${key} 本周期已注入过（${agoMs}ms 前，窗口 ${cycleWindow}ms，保持中=${holdActiveKeys.has(key)}）→ 这 ${unread.length} 条不再注入，留在未读等下一个周期（一次连发只注入一次）`);
    return true;
  }
  // ① 收集窗：等一下再发车，把"连发两条"合并成同一次注入（主人报的正是这个：第二条被留到下一次唤醒）。
  //    等待期间可能又来新消息 —— 所以等完**重算**候选，新消息自然并入同一条 [Mid-turn]。
  let unreadFinal = unread;
  const skipCollect = opts?.noCollect === true;
  if (skipCollect) {
    // 【2026-09-15 合并注入】步边界发车（turn-hold.js:flushStepBatch）专用：那一批已经攒了**一整步**，
    // 再等"对方停止输入"只会把这批拖过最近的 step 边界，白多一步推理。直接发车。
    log(`[steer] ${key} 步边界注入：跳过收集窗（整步的批次已是最优合并，再等只会错过最近的 step 边界）`);
  } else {
    const collectStart = Date.now();
    for (;;) {
      const newestAt = (Array.isArray(st.unread) ? st.unread : [])
        .reduce((mx, m) => Math.max(mx, Number(m.time) || 0), 0);
      // 「这口气说完」= 最后一条消息之后 + 对方停止输入（peerTypingUntil 由 typing 事件维护）。
      // 用打字信号是关键：主人"哈哈"发完还会接着打字，而打字事件能告诉我们他还没说完 ——
      // 等他停下再注入，既把连发合并成一次，又正好是他期待看到回复的时刻（比先回一半再补一句更快也更省）。
      const typingUntil = Number(st.peerTypingUntil) || 0;
      const quietFrom = Math.max(newestAt, typingUntil);
      const quietFor = Date.now() - quietFrom;
      const waited = Date.now() - collectStart;
      if (quietFor >= STEER_COLLECT_MS || waited >= STEER_COLLECT_MAX_MS) break;
      await sleep(Math.min(150, Math.max(50, STEER_COLLECT_MS - quietFor)));
    }
    const waitedMs = Date.now() - collectStart;
    if (waitedMs >= 150) {
      // 等完**重算**候选：等待期间新到的消息自然并入同一条 [Mid-turn]（判据仍走 collectMidTurnBatch，一份规则）。
      unreadFinal = collectMidTurnBatch(st);
      if (unreadFinal.length > unread.length) {
        log(`[steer] ${key} 收集窗等了 ${waitedMs}ms，把连发的 ${unreadFinal.length} 条合并进同一次注入（原本只有 ${unread.length} 条）`);
      }
      if (!unreadFinal.length) {
        log(`[steer] ${key} 收集窗期间这批已被别的路径交付，无需再投`);
        return true;
      }
    }
  }
  const unreadToSend = unreadFinal;
  steerInFlight.set(key, true);
  lastSteerAt.set(key, Date.now());
  if (lastSteerAt.size > 200) {
    for (const [k, t] of lastSteerAt) if (Date.now() - t > 600000) lastSteerAt.delete(k);
  }
  const lines = unreadToSend.map((m) => {
    const who = m.isOwner ? 'owner' : (m.sender || (m.userId ? `uid:${m.userId}` : '?'));
    const body = String(m.plain || m.text || '').slice(0, STEER_TEXT_CAP);
    return `${who}${m.messageId ? `(id:${m.messageId})` : ''}${m.atSelf ? ' @me' : ''}: ${body}${m.hasMedia ? ' [image]' : ''}`;
  });
  // 【2026-09-12 二次精简（主人要求）】这段文本会**留在上下文里**：注入一次，之后本回合每一步都要
  // 连它一起重发。上一轮已从 1.6KB 压到 0.69KB；这一轮把**规则散文整段搬进系统提示词**
  // （agent.cordis.yml 的 [WAKE TYPES] 第 1 条：ONE-AND-DONE / 一条气泡覆盖全部 / 不复读 / 第一次看到
  // 当普通唤醒 / 真没内容才不发 / 主人私聊收尾方式），注入这边只留主人要求的那种数据形态：
  //     [Token] xxx
  //     [Mid-turn] N new message(s) after your last bubble - not answered yet.
  //     owner(id:xxx): ……
  // 实测同批 2 条时正文 690 → 约 230 字符；规则一条没丢，只是不再随每次注入重复。
  const text = `[Token] ${st.agentToken}\n[Mid-turn] ${unreadToSend.length} new message(s) after your last bubble - not answered yet.\n${lines.join('\n')}`;
  const mySeq = (steerSeq += 1);
  try {
    const res = await withTimeout(
      apiRef.sessions.prompt({ sessionId, mode: 'steer', content: [{ type: 'text', text }] }),
      15000,
      `steer ${key}`
    );
    if (res?.result?.ok) {
      // 本周期封口：直到下一个模型步结束（turn-hold 钩子再次被调用）之前，不再注入第二次。
      steerCycleAt.set(key, Date.now());
      if (steerCycleAt.size > 200) {
        for (const [k, t] of steerCycleAt) if (Date.now() - t > 600000) steerCycleAt.delete(k);
      }
      log(`[steer] ${key} 已把 ${unreadToSend.length} 条新消息塞进在途回合（第 ${mySeq} 次，session=${sessionId.slice(0, 20)}…）`);
      // 记下"这一回合接管了哪些 seq"（turn-hold 地基①）。回合结束时 mux 会把它们并入
      // "本回合负责的消息"集合，于是：①被回复后能进 answeredMessageIds（不进 → 下一轮重复回复）；
      // ②能从 unread 里清掉（不清 → 永久未读 → 下一轮又展示一遍 → 又重复回复）。
      // 只存内存（不落盘）：steer 与回合结束在同一个进程里、相隔几秒，重启时回合本身也死了。
      try {
        const seqs = unreadToSend.map((m) => Number(m.seq)).filter((n) => Number.isFinite(n) && n > 0);
        const prev = Array.isArray(st.turnSteeredSeqs) ? st.turnSteeredSeqs : [];
        st.turnSteeredSeqs = [...new Set([...prev, ...seqs])].slice(-50);
        // 同步推进"已交给模型"的水位线（steer 也是一次投递）
        for (const n of seqs) st.lastDeliveredSeq = Math.max(Number(st.lastDeliveredSeq) || 0, Number(n) || 0);
      } catch (_) {}
      // 【2026-09-15 合并注入】这一批已经投出去了 → 收掉"攒着"的记账：
      //   · `pendingSteerSince`：本步这一批到此结束，下一次攒从之后到达的新消息重新计时；
      //   · `_steerDeferredSeqs`：**只留还没投出去的**。留着的会被 mark_read 当成"还在等下一次注入"
      //     保护起来（console-server.js:1604），已投出去的若继续留着 = 它们永远清不掉 →
      //     下一轮又被当新未读展示 → 重复回复。
      pendingSteerSince.delete(key);
      try {
        const done = new Set(unreadToSend.map((m) => Number(m.seq)).filter((n) => Number.isFinite(n) && n > 0));
        const prevDeferred = Array.isArray(st._steerDeferredSeqs) ? st._steerDeferredSeqs : [];
        const left = prevDeferred.map(Number).filter((n) => !done.has(n));
        if (left.length !== prevDeferred.length) st._steerDeferredSeqs = left;
      } catch (_) {}
      log(`[steer] ${key} 合并注入：本块 ${unreadToSend.length} 条（这一步攒下的消息全在这一个 [Mid-turn] 里，seq=${unreadToSend.map((m) => Number(m.seq)).join(',')}）`);
      return true;
    }
    log(`[steer] ${key} 被拒：${res?.result?.error?.message ?? res?.result?.error?.code ?? '未知'}（退回排队补发）`);
    return false;
  } catch (error) {
    log(`[steer] ${key} 失败：${error?.message ?? error}（退回排队补发）`);
    return false;
  } finally {
    steerInFlight.delete(key);
  }
}

/** 预热请求文本：只用于命中 provider 前缀缓存，禁止任何动作。
 *  ⚠️【2026-09-11 修】这条文本会成为该会话的**第一条 user 消息**，并且长期留在上下文里。
 *  实测后果：模型每轮结尾都吐一个 "OK"、而且真的不调发送工具（主人看到的是"读了不说话、只回 OK"）
 *  —— 它在服从一条早就该失效的指令。所以现在**显式声明它一次性失效**。 */
const STAND_WARM_TEXT = (key) => `[Preheat] Session ${key} context preload round (this session will activate soon). Reply with exactly "OK" and nothing else - do NOT call any tool, send any QQ message, or set wake conditions.`
  + `\n[END OF PREHEAT] The line above is a ONE-OFF cache warm-up and it is VOID from the moment any real message arrives. It is NOT a standing instruction: never reply "OK" to a real person, never let it stop you from calling the send tool, and treat every real round normally. If you notice yourself about to end a real round with just "OK", that is this expired line talking - ignore it and reply properly instead.`;

/**
 * 向“预热会话”发起一次廉价请求：模型只回 OK，不发任何消息；
 * 目的仅是让 provider 把 persona/system 前缀与首轮结构写入缓存，
 * 后续首个真实唤醒回合直接命中缓存（省掉首轮慢推理/冷启动）。
 */
async function fireStandbyWarm(key, sessionId) {
  try {
    // 预热请求需要真正跑完一次模型推理（让 provider 缓存 persona/system 前缀），
    // 因此等待放宽到 60s，避免 DSH 忙时 15s 超时误判失败、预热白建。
    const result = await withTimeout(
      apiRef.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: STAND_WARM_TEXT(key) }]
      }),
      60000,
      `standby warm ${sessionId}`
    );
    if (!result?.result?.ok) {
      log(`[prewarm] ${key} 预热请求未接受: ${result?.result?.error?.message ?? result?.result?.error ?? '未知'}`);
      // 预热失败：清掉 standby 标记，让后续轮次可重新预建（而不是卡一个失效会话）
      try {
        const stW = getSocialState(key);
        stW._standbySessionId = null;
        saveSocialState();
      } catch (_) {}
    } else {
      log(`[prewarm] ${key} 预热请求已受理（${sessionId}）`);
    }
  } catch (error) {
    log(`[prewarm] ${key} 预热失败（不影响主流程）: ${error?.message ?? error}`);
    try {
      const stW = getSocialState(key);
      stW._standbySessionId = null;
      saveSocialState();
    } catch (_) {}
  }
}

export async function sendWakePrompt(key, reason) {
  if (cfgRef.social?.enabled === false) return;
  if (currentMode !== 'default' || social.paused) return;
  if (!isSessionAllowedInCurrentMode(key)) {
    log(`[default] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
    return;
  }
  const st = getSocialState(key);
  // 提前确认/创建 DSH 会话映射（幂等，投递时还会复用），得到"本轮将投递的真实 sessionId"。
  // 用途：检测 DSH 会话重建/切换——若 sessionId 与上次注入完整 prompt 时不同（桥重启、DSH 重启、
  // reset、归档后重建），新会话里模型没有任何协议/规则/令牌记忆，必须重新全量注入，否则直接发 ➤
  // 哨兵会让模型变成"无令牌→工具全 403→看不到消息→空唤醒乱回"。
  let liveSid = state.sessions[key] || null;
  try { await ensureSession(key); liveSid = state.sessions[key] || liveSid; } catch (eSid) {
    log(`[default] ${key} 预取会话失败（继续按现有映射投递）: ${eSid?.message ?? eSid}`);
  }
  // 会话一致性校验：若模型上下文应已有完整协议（_promptInjected）但当前 DSH 会话与
  // 记录不一致（桥重启后 DSH 侧会话重建、归档重建、或旧状态从未记录过 _promptSessionId），
  // 必须重新全量注入——否则新会话里模型没有任何协议/规则/令牌记忆，直接发 ➤ 哨兵只会让
  // 模型"无令牌→工具全 403→看不到消息→空唤醒乱回/重复回复"。
  if (st._promptInjected && liveSid && (!st._promptSessionId || st._promptSessionId !== liveSid)) {
    log(`[default] ${key} DSH 会话与记录不一致（记录=${st._promptSessionId ?? '无'}，当前=${liveSid}），重置为完整注入`);
    st._promptInjected = false;
    st._promptSessionId = liveSid;
    saveSocialState();
  }
  // 【2026-09-12】人设 / 发言规则文件变了 → 也重置为完整注入（人设保存后下一条消息即生效）。
  // 判据是文件的 mtime:size 版本号，桥不做任何解析；主人保存人设时管理端写的就是这两个文件。
  const ovStamp = runtimeOverrideStamp();
  if (st._promptInjected && ovStamp !== (st._promptOverrideStamp || '')) {
    log(`[default] ${key} 人设/发言规则已更新 → 重新注入完整 prompt（新人设立即生效）`);
    st._promptInjected = false;
    saveSocialState();
  }
  // 重启后未读恢复：内存 unread 为空但 SQLite chat_messages 里存在晚于“最近已读水位”的新入向消息时，
  // 补入未读/最近窗口，避免进程重启丢消息（read_at 由 qq_mark_read 落库维护）。
  if (key && Array.isArray(st.unread) && st.unread.length === 0) {
    try {
      const minTs = Number(st.lastAiSeenAt) || 0;
      const unreadLimit = Math.max(1, Number(cfgRef.social?.context?.unreadLimit) || 30);
      const dbUnread = fetchUnreadChatMessages(key, unreadLimit, minTs);
      if (dbUnread.length) {
        const knownSeqs = new Set((Array.isArray(st.recentMessages) ? st.recentMessages : []).map((m) => Number(m.seq)).filter((n) => Number.isFinite(n) && n > 0));
        const fresh = dbUnread.filter((m) => !knownSeqs.has(Number(m.seq)) && Number(m.time) > minTs);
        if (fresh.length) {
          st.unread = fresh;
          st.lastUnreadSeq = Math.max(...fresh.map((m) => Number(m.seq) || 0), Number(st.lastUnreadSeq) || 0);
          if (!Array.isArray(st.recentMessages)) st.recentMessages = [];
          for (const m of fresh) {
            if (!st.recentMessages.some((x) => Number(x.seq) === Number(m.seq))) st.recentMessages.push(m);
          }
          const recentLimit = Math.max(10, Number(cfgRef.social?.context?.recentLimit) || 100);
          if (st.recentMessages.length > recentLimit) st.recentMessages = st.recentMessages.slice(-recentLimit);
          saveSocialState();
          log(`[chat-history] 重启恢复未读 ${key}: ${fresh.length} 条（来自 SQLite read_at 水位）`);
        }
        // 水位对账：DB 里 read_at 仍为 0、但早已在本会话滚动窗口(recentMessages)里的行——本唤醒路径
        // 不会把它们当新未读投喂（上面 knownSeqs 过滤），可 /api/social/unread 的 read_at 回退没有这层
        // 过滤（unread 为空时直接按 lastAiSeenAt 时间水位取 read_at=0 的行），会把几天前的旧消息重新
        // 当未读展示给模型。实例：某个群有 9 条 2026-09-09 的消息一直 read_at=0，内存 unread
        // 已被重启清空、lastAiSeenAt 却停在 09-08。这里把已见过行推进到已读，让两条水位重新一致。
        // 仅在"取回的就是全部未读（未触发 limit 截断）且全部已见过、本轮没有恢复出新未读"时才推进，
        // 宁可不动也不误标真未读。
        if (!fresh.length && dbUnread.length < unreadLimit) {
          const knownRows = dbUnread.filter((m) => knownSeqs.has(Number(m.seq)));
          if (knownRows.length === dbUnread.length) {
            const maxKnownSeq = Math.max(...knownRows.map((m) => Number(m.seq) || 0));
            if (maxKnownSeq > 0) {
              try {
                const reconciled = markMessagesRead(key, maxKnownSeq);
                if (reconciled.ok && reconciled.updated > 0) {
                  log(`[chat-history] 未读水位对账 ${key}: 已见过 ${knownRows.length} 条旧行推进到 seq${maxKnownSeq}（避免旧消息再被当新未读投喂）`);
                }
              } catch (eRec2) {
                log(`[chat-history] 未读水位对账失败 ${key}: ${eRec2?.message ?? eRec2}`);
              }
            }
          }
        }
      }
    } catch (eRec) {
      log(`[chat-history] 未读恢复失败: ${eRec?.message ?? eRec}`);
    }
  }
  // 卡死/异常隔离后新会话首轮会注入完整历史，容易把早已回应过的旧话题（情绪/玩笑等）
  // 又翻出来重复长篇回应。重建后 5 分钟内抑制 replyCheck/proactive/概率/timeout 这类
  // “无新消息也触发”的内部唤醒，只保留用户真实触发（私聊/@/提问/拍一拍/关键词等）。
  const qRebuiltAt = Number(st._quarantineRebuiltAt) || 0;
  const qBaseReason = String(reason ?? '').split(':')[0];
  if (qRebuiltAt > 0 && Date.now() - qRebuiltAt < 5 * 60 * 1000 && /^(replyCheck|proactiveCheck|probability|timeout|topic)$/.test(qBaseReason)) {
    log(`[default] 隔离重建缓冲期内跳过内部唤醒 ${key}（${reason}），避免翻旧账重复回复`);
    return;
  }
  // 复读循环冷却期：自动重启已达上限后 30 分钟内同样抑制内部唤醒，避免每轮继续烧 token（用户真实触发不受影响）
  const loopHoldUntil = Number(st._loopHoldUntil) || 0;
  if (loopHoldUntil > Date.now() && /^(replyCheck|proactiveCheck|probability|timeout|topic)$/.test(qBaseReason)) {
    log(`[default] 复读冷却期内跳过内部唤醒 ${key}（${reason}）`);
    return;
  }
  // 空会话守卫：群聊没有可回应内容（无未读、无近期他人发言、无待办）时，自发的定时类唤醒
  // （replyCheck/proactive/probability/timeout/activityStart/topic）直接放弃，绝不向空会话注入
  // 整段系统/首轮提示词——否则每次 DSH 重启后会话重建，这类唤醒都会往“没有一句话”的会话里
  // 再灌一次全量提示，DSH 侧就表现为“空会话一直被注入系统提示词”。私聊与用户真实触发不受影响。
  if (key.startsWith('group:') && /^(replyCheck|proactiveCheck|probability|timeout|activityStart|topic)$/.test(qBaseReason)) {
    const hasUnread = Array.isArray(st.unread) && st.unread.length > 0;
    const hasThoughts = Array.isArray(st.pendingThoughts) && st.pendingThoughts.some((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    const hasPeerTalk = Array.isArray(st.recentMessages) && st.recentMessages.some((m) => m && !m.isSelf && (Date.now() - Number(m.time || 0)) < 24 * 3600 * 1000);
    if (!hasUnread && !hasThoughts && !hasPeerTalk) {
      log(`[default] 空会话守卫：跳过 ${key} 内部唤醒(${reason})——无内容可回应，不注入提示词`);
      return;
    }
  }
  // 夜间静默规则（硬性，AI 无法通过 set_wake_config 覆盖）：北京时间凌晨 1:00-5:00，
  // 静谧群聊（30 分钟内无人发言）禁止概率/主动冒泡类唤醒，避免深夜打扰；@/提问/名字/拍一拍等用户触发的唤醒不受影响。
  if (key.startsWith('group:')) {
    const bjHour = new Date(Date.now() + 8 * 3600 * 1000).getHours();
    if (bjHour >= 1 && bjHour < 5) {
      const base = String(reason ?? '').split(':')[0];
      if (base === 'probability' || base === 'proactiveCheck') {
        const lastMsg = (st?.recentMessages || []).filter((m) => m && !m.isSelf).pop();
        const lastT = lastMsg ? Number(lastMsg.time || 0) : 0;
        const silent = !lastT || Date.now() - lastT > 30 * 60 * 1000;
        if (silent) {
          log(`[default] 夜间静默规则：${key}（${reason}）凌晨静谧群聊不主动唤醒`);
          return;
        }
      }
    }
  }
  // 每次唤醒都是一个新回合：清空上一轮可能残留的“沉睡前已观察/已等待”标记，
  // 确保 AI 这一轮想再次潜水时，必须重新走 5 分钟沉睡前观察。
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  st.preSleepWaitAccumMs = 0;
  saveSocialState();
  // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
  // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免"思维链进行中又塞入一个 question 唤醒"。
  //
  // ⚠️ 这里是**真正的投递路径**上的忙判定（`sendWakePrompt` 内），social-state.js 的 `scheduleWake`
  //    里还有一份同样的判定。**两处都要塞 steer**：只改后者的话，先经过 1s 合并窗、再到这里的
  //    消息就会走这条没有 steer 的分支——第一次上线就是这么失效的（日志里只有"会话繁忙"，没有 [steer]）。
  if (isConversationBusy(key, st)) {
    // 【2026-09-12 架构收敛（这条是主人 2026-09-11 23:58 报的故障的正解）】
    // 能走到这里，说明会话忙、**但模型并没有挂在 qq_wait_for_messages 里**
    //（否则 social-state.js 顶部那道 activeWaits 守卫已经 return 了）。
    // 忙的成因有四种：合并窗待发 / 投递在途 / 桥内队列在跑 / **真的有一个回合在跑**。
    // 前三种下把消息交给"正常唤醒"是对的；第四种（真实在跑）下老路径会把消息送进
    // `mode:'queue'` → next-turn → **要等这个回合结束**，而新架构下那个回合可能永不结束
    //（模型常驻等待 / 被重启打断后僵在 running）→ **消息永久停在队列里**，实测 23:44/23:47/23:49 三条这么卡死。
    // 处理顺序：**先试着塞进在途回合**（steer → next-step，本回合下一个 step 边界就交给模型）；
    // 塞成功就到此为止——**不暂存、不补发、也不走下面的完整唤醒流程**。
    // 为什么不走完整唤醒：下面那段里有会话轮换 / 预热 / `_promptInjected` 落账，它们都假设
    // "这是新回合的开头"；在途回合中途执行会把 `state.sessions[key]` 换掉，把正在跑的回合连根拔了。
    // 塞失败（没有映射会话 / 桥没观测到回合 / DSH 拒绝）→ 落回正常唤醒流程，
    // 而那条路现在也是 steer 投递（见 prompt-deliver.js），**绝不会再卡在 next-turn**。
    let steeredNow = false;
    try {
      steeredNow = await steerIntoRunningTurn(key, reason);
    } catch (error) {
      log(`[steer] ${key} 即时注入抛出异常：${error?.message ?? error}（退回正常唤醒流程）`);
    }
    if (steeredNow) {
      // 【2026-09-15 合并注入】"true" 现在有三种含义，措辞里都要能看出来，否则排查时分不清：
      //   ① 刚塞进去；② 本回合已经给过它；③ 保持托管 → 已攒进本步这一批，等步边界一次注入（[steer] 那一行会说明）。
      log(`[default] 会话繁忙：新消息已在在途回合里（刚塞进去 / 本回合已经给过它 / 已攒进本步批次等步边界合并注入）${key}（${reason}），不另起一轮、不暂存、不补发`);
      return;
    }
    log(`[default] ${key} 会话繁忙且即时注入未成功 → 走正常唤醒流程（steer 投递，不会再卡 next-turn）`);
    // ⚠️ 故意不 return：继续走下面的正常唤醒流程（两份 busy 分支必须保持一致）
  }
  // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控。
  // 私聊（尤其主人）放宽上限：连续消息不能被限频吞掉；群聊维持原限制。
  const now = Date.now();
  const isPrivateKey = key.startsWith('private:');
  const maxPerMinute = Number(isPrivateKey ? (cfgRef.social?.wake?.maxWakePerMinutePrivate ?? 12) : (cfgRef.social?.wake?.maxWakePerMinute ?? 0));
  const maxPerHour = Number(isPrivateKey ? (cfgRef.social?.wake?.maxWakePerHourPrivate ?? 0) : (cfgRef.social?.wake?.maxWakePerHour ?? 0));
  const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
  const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
  if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
    log(`[default] 唤醒频率超限，跳过 ${key}（${reason}）`);
    // 私聊消息不能因限频被静默吞掉：挂一次性重试，频率窗口过后再投递一次
    if (isPrivateKey && !st.wakeRetryTimer) {
      st.wakeRetryTimer = setTimeout(() => {
        st.wakeRetryTimer = null;
        void sendWakePrompt(key, reason).catch((error) => log(`[default] 唤醒重试异常 ${key}:`, error?.message ?? error));
      }, 20000);
      log(`[retry] ${key} 私聊唤醒被限频，20s 后重试（${reason}）`);
    }
    return;
  }
  // 本次唤醒成功接管：清掉可能存在的限频重试，避免重复唤醒
  if (st.wakeRetryTimer) {
    clearTimeout(st.wakeRetryTimer);
    st.wakeRetryTimer = null;
  }
  cancelReplyCheck(key); // 本次唤醒已接管，清理仍在排队的回复检查
  const wakeTime = now;
  st.wakeTimes.push(wakeTime);
  if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
  // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
  const prevSleepUntil = st.wakeConfig.sleepUntil;
  const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
  if (st.sleepTimer) {
    clearTimeout(st.sleepTimer);
    st.sleepTimer = null;
  }
  st.wakeConfig.sleepUntil = null;
  st.wakeConfig.lastWakeAt = now;
  st.lastWakeReason = reason;
  // 记录本轮展示给 AI 的未读消息 seq：AI 一旦成功回复，这些消息视为已处理（防止补发/重复回复同一批旧消息）
  st.turnSeenUnread = (Array.isArray(st.unread) ? st.unread : []).map((m) => m && Number(m.seq)).filter((n) => Number.isFinite(n) && n > 0);
  // 【2026-09-11 23:05 修「等待期间吞消息」】维护"已经交给模型的最高 seq"水位线。
  // qq_wait_for_messages 用它当基线（而不是"调用时刻的 lastUnreadSeq"），
  // 这样**凡是没给过模型的都会一并返回** —— 包括"它正在跑一步时到达、因而被暂存"的那批。
  for (const n of st.turnSeenUnread) {
    const sq = Number(n);
    if (Number.isFinite(sq) && sq > 0) st.lastDeliveredSeq = Math.max(Number(st.lastDeliveredSeq) || 0, sq);
  }
  // 会话轮换：用户触发回合数达到阈值（默认 12 轮）时切到下一代 DSH 会话，
  // 避免单会话上下文无限膨胀。提前 prewarmAhead 轮预建并预热新会话（首轮提示词命中缓存），
  // 阈值到达后直接转移，不再现场创建（消除新会话首轮卡顿）。
  // 只在“用户主动触发”的唤醒（私聊/@/提问/名字/拍一拍/关键词/引导）时执行——
  // 回复检查/概率/主动冒泡等内部唤醒不轮换，避免刚回复完就把上下文清掉、新会话重复回复同一批消息。
  const rotateThreshold = Math.max(5, Number(cfgRef.social?.autoReset?.wakeThreshold) || 12);
  const prewarmAhead = Math.max(1, Number(cfgRef.social?.autoReset?.prewarmAhead) ?? 3);
  const isUserTriggeredWake = /^(private|atMention|question|speaker|nameMention|poke|keyword|bootstrap)$/.test(String(reason).split(':')[0]);
  if (isUserTriggeredWake) {
    const sidNow = state.sessions[key];
    const wc = st.wakeConfig;
    // wakeCount 语义收紧为"用户触发唤醒次数"（原来所有唤醒都 +1，会把 replyCheck/主动/概率
    // 等内部唤醒也算进去 → 1-2 小时内上下文就被切 12 次，AI 频繁失忆、重复回复）。
    wc.wakeCount = (wc.wakeCount || 0) + 1;
    // 用户触发回合计数（内部唤醒不计入——replyCheck/主动/概率类唤醒若是计入，
    // 会把单次对话的上下文 1-2 小时内就被切走 12 次，AI 频繁失忆、重复回复）：
    // 这是轮换的唯一依据，语义清晰且与“12 轮真实对话”吻合。
    st.rotateTurns = (Number(st.rotateTurns) || 0) + 1;
    const count = Number(st.rotateTurns) || 0;
    // ① 提前预热：进入阈值前 prewarmAhead 轮，建好下一代会话并发一次廉价预热请求
    if (sidNow && st._promptInjected && !st._standbySessionId && !st._standbyWarming
        && count >= rotateThreshold - prewarmAhead && count < rotateThreshold) {
      st._standbyWarming = true;
      saveSocialState();
      try {
        const standby = await createStandbySession(key);
        if (standby) {
          st._standbySessionId = standby;
          saveSocialState();
          void fireStandbyWarm(key, standby);
          log(`[prewarm] ${key} 提前 ${prewarmAhead} 轮预建并预热新会话（${count}/${rotateThreshold}）：${standby}`);
        }
      } catch (error) {
        log(`[prewarm] ${key} 预热准备失败: ${error?.message ?? error}`);
      } finally {
        st._standbyWarming = false;
        saveSocialState();
      }
    }
    // ② 阈值到达：转移到已预热的会话；无可用预热会话时回退“归档旧会话 + 现场重建”老路径
    if (count >= rotateThreshold && sidNow && st._promptInjected) {
      const standby = st._standbySessionId;
      try {
        if (standby && state.sessions[key] !== standby) {
          queueArchiveSession(sidNow); // 异步归档旧会话，不阻塞本次唤醒
          reverse.delete(sidNow);
          state.sessions[key] = standby;
          reverse.set(standby, key);
          saveState();
          st._standbySessionId = null;
          log(`[rotate] ${key} 第 ${count} 次唤醒：切换到已预热会话 ${standby}（旧会话 ${sidNow} 已入队归档）`);
        } else {
          // 老路径兜底：未预热到就现场归档置空，下次投递自动新建
          queueArchiveSession(sidNow); // 异步归档旧会话，不阻塞本次唤醒
          reverse.delete(sidNow);
          delete state.sessions[key];
          state.sessions[key] = null;
          log(`[autoReset] ${key} 已软重置 DSH 上下文（第 ${rotateThreshold} 次唤醒，无预热会话，下次现建），记忆保留`);
        }
        wc.wakeCount = 0;
        wc.noActionCount = 0;
        st.sessionToolCalls = 0;
        st.rotateTurns = 0;
        wakeConfigMissCount.delete(key); // 重置后给新会话留足缓冲，避免“防遗忘”兜底立刻把用户设的活跃模式冲成默认潜水
        st._promptInjected = false; // 下次唤醒重新注入完整 prompt（含最近消息窗口，替代摘要总结）
        st._promptSessionId = state.sessions[key] || null; // 轮换后以新映射为准（standby 或 null=待现建）
        st._justAutoReset = true;   // 首个回合提示 AI：上下文已切换，别重复回复旧消息
      } catch (error) {
        log(`[rotate] ${key} 会话轮换失败（保留现状）: ${error?.message ?? error}`);
      }
    }
  }
  saveSocialState();
  // 首次唤醒注入完整 prompt，后续只注入精简摘要（省 token）
  let promptText;
  // 投递失败时要回滚的"已注入/已附图"落账：这两个水位都在投递之前就被推进，
  // 一旦本轮投递被拒，下一轮会按"协议已注入"只发 ➤ 哨兵到一个从没收过协议/令牌的会话里
  // （模型看不到规则与令牌 → 工具 403 → 空唤醒乱回），附图水位也会让这批图再也不被附上。
  const prevPromptInjected = st._promptInjected;
  const prevPromptSessionId = st._promptSessionId;
  const prevMediaAttachedSeq = Number(st._mediaAttachedSeq) || 0;
  // 【2026-09-12】投递水位也要回滚：`turnSeenUnread` 与 `lastDeliveredSeq` 在**投递之前**就被推进
  //（语义是"本回合已经给过模型"）。投递被拒时如果不回滚，"已交付"就成了谎话——
  //  ① 投递看门狗（social-state.js 的 sweepUndelivered）会永远认为这条消息已经交付过 → 不再兜；
  //  ② `steerIntoRunningTurn` 的去重也会把它当成"本回合已展示过" → 再也不注入。
  // 两个一起回滚，才能让"重新排一次唤醒"这条路真的把消息再送一次。
  const prevTurnSeenUnread = Array.isArray(st.turnSeenUnread) ? [...st.turnSeenUnread] : [];
  const prevLastDeliveredSeq = Number(st.lastDeliveredSeq) || 0;
  const rollbackPromptMarks = () => {
    st._promptInjected = prevPromptInjected;
    st._promptSessionId = prevPromptSessionId;
    st._mediaAttachedSeq = prevMediaAttachedSeq;
    st.turnSeenUnread = prevTurnSeenUnread;
    st.lastDeliveredSeq = prevLastDeliveredSeq;
  };
  // 上下文刚重置后的首个回合：别重复回复旧消息，但**也绝不许装失忆**。
  // 下面注入的 [Recent messages] 只是旧对话的**尾巴**（且每行截断到 120 字），
  // 用户一提更早的事，模型必须用工具去翻——原来的提示只写了"只回最新那条、马上收尾"，
  // 等于在暗示它忽略历史，于是换会话后经常出现"我看不到之前的消息 / 我不知道"。
  const justReset = st._justAutoReset === true;
  // 【2026-09-12 规则搬家】这些一次性提示里的"该怎么做"（不许装失忆、要主动翻历史、不要重答、
  // [Preheat] 已作废、别改唤醒模式）统统写进系统提示词 [WAKE TYPES] 第 10/12 条；
  // 这里只留**数据**：发生了什么 + 当前的唤醒模式值（值必须随轮次给，规则不必）。
  const autoResetNote = justReset
    ? `\n[Note] Context rotated to a fresh session - the earlier chat is archived, not lost (the [Recent messages] tail is below). Wake mode now: ${st.wakeConfig?.mode === 'active' ? 'active' : 'diving'}.`
    : '';
  if (autoResetNote) st._justAutoReset = false;
  // 复读循环自动恢复后的提示（一次性）：解释新上下文来源，防止 AI 把旧话再复读一遍（2026-09-03）
  const loopResetNote = st._loopRestarted
    ? '\n[Note] Repeat-loop recovered: the old session was archived and a fresh context opened (the recent messages below are the inherited backstory).'
    : '';
  if (loopResetNote) { st._loopRestarted = false; try { saveSocialState(); } catch {} }
  // 【2026-09-12 去硬编码 + [OWNER] 标记】主人私聊的判定一律走 `cfgRef.ownerQQ`，不写死 QQ 号。
  // 为什么顺带加标记：persona 的 [OWNER MODE] 必须**只在主人私聊**生效，而它是一段静态文本，
  // 里面原来写着 `key private:<主人QQ>` —— 打包给别人就会夹带主人的 QQ，而且别人换了 ownerQQ 之后
  // 那段作用域就不成立了。现在改成行为式：**每轮正文里带 `[OWNER]` 的私聊才是主人**，
  // persona 只引用这个标记（见 agent.cordis.yml 的 [OWNER MODE] / [OWNER - memorize]）。
  const ownerWakeBranch = !!cfgRef?.ownerQQ && key === `private:${cfgRef.ownerQQ}`;
  if (st._promptInjected) {
    // —— 架构：后续轮一律「哨兵轮」，正文只留"令牌 + 唤醒原因 + 数据"，规则全在系统提示词里。 ——
    // 被 @ 时给一句定位（unread 返回不保证带 at 标记），避免隔得远瞎猜；此句仅 @ 场景出现。
    let atLine = '';
    if (String(reason).split(':')[0] === 'atMention') {
      const atMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf && (m.atSelf || m.quoteTargetIsSelf));
      if (atMsg) {
        const atSender = atMsg.isOwner ? 'owner' : (atMsg.sender || '?');
        atLine = `\n[The @ to me] ${atSender}${atMsg.messageId ? '(id:' + atMsg.messageId + ')' : ''}: ${String(atMsg.text || atMsg.plain || '').slice(0, 120)}`;
      }
    }
    const typingLine = (key.startsWith('private:') && st.peerTypingUntil && Date.now() < st.peerTypingUntil)
      ? '\n(peer may still be typing)'
      : '';
    // 哨兵轮**直接带上未读正文**（私聊 + 群聊）：省掉一整次模型往返（≈4 秒、以及那一次
    // 会把整个 8 万字符的 prompt 再发一遍的开销），这是「第一条回复」快不快的最大变量。
    // 既然带上了，就必须明说「这一步不用再读」，否则模型照旧先读一遍，白花一次往返。
    // 体积控制：只带最近 UNC_MAX 条、每条截断 UNC_TEXT，超出的部分提示用工具按需取。
    const UNC_MAX = key.startsWith('private:') ? 10 : 15;
    const UNC_TEXT = key.startsWith('private:') ? 200 : 120;
    const unreadAll = Array.isArray(st.unread) ? st.unread : [];
    const unreadMsgs = unreadAll.slice(-UNC_MAX);
    let unreadLine = '';
    if (unreadMsgs.length) {
      const lines = unreadMsgs.map((m) => {
        const who = m.isOwner ? 'owner' : (m.sender || (m.userId ? `uid:${m.userId}` : '?'));
        const id = m.messageId ? `(id:${m.messageId})` : '';
        const body = String(m.plain || m.text || '').slice(0, UNC_TEXT);
        const extra = m.hasMedia ? ' [image]' : (m.hasFile ? ' [file]' : '');
        const at = m.atSelf ? ' @me' : '';
        return `${who}${id}${at}: ${body}${extra}`;
      });
      const omitted = unreadAll.length - unreadMsgs.length;
      // 【2026-09-12 规则搬家】原来这段还跟着一长串"回完就在同一步收尾 / 别用等待工具 / 旧消息要用
      // qq_get_recent_messages 翻"的规则散文（每轮都注入、步步重发，主人会话实测 47 次注入≈48KB）。
      // 现在这些规则都在系统提示词 [WAKE TYPES] 第 1/9/10 条，这里只留数据：未读正文 + 省略条数。
      unreadLine = `\n[Unread ${unreadAll.length}] ${lines.join('\n')}`
        + (omitted > 0 ? `\n(${omitted} older unread not shown)` : '');
    } else if (key.startsWith('private:')) {
      unreadLine = '\n[Unread 0] nothing new to answer - close with qq_mark_read unless you deliberately want to open a topic.';
    }
    const nagRe = /(何意味|啥意思|什么意思|回复我|回我|说话啊|理我|快点|快回|人呢|别装死|这?智能|你读读|没回(复|应)?|怎么不(回|理|说)|没看到|还没回)/;
    let nagLine = '';
    if ((st.unread || []).length >= 1 && [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().filter((m) => m && !m.isSelf).slice(0, 6).some((m) => nagRe.test(String(m.plain || m.text || '')))) {
      nagLine = '\n[Nag] Peer is pressing/questioning your last reply.';
    }
    const rbWake = Number(st._rebroadcastWake) || 0;
    let rbNote = '';
    if (rbWake > 0 && Date.now() - rbWake < 120000) {
      // 【2026-09-11 加硬】原来只有一句笼统的 "DO NOT repeat or restate"，实测拦不住重复回复
      // （主人连续两次反馈"你重复回复了"）。现在把**已经回过的那批消息 id 明确列出来**，
      // 指名道姓禁止重答——补发轮只允许答"确实没被回过的"。
      const answeredSet = new Set(Array.isArray(st.answeredMessageIds) ? st.answeredMessageIds.map(String) : []);
      const doneIds = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])]
        .filter((m) => m && m.messageId && answeredSet.has(String(m.messageId)))
        .slice(-8)
        .map((m) => `id:${m.messageId}`);
      // 【2026-09-11 修「补发轮也吞」】两个坑：
      //  ① 以前收尾写的是 "If nothing new is left, just qq_mark_read and end - do not send anything."
      //     —— 在**鼓励模型不回**，补发轮注定失败（实测 22:03:52 / 22:04:32 连续两轮只写正文不调工具）。
      //  ② 更要命的是唤醒正文里根本没有原文（那条消息早被标读、从 unread 摘掉了）——
      //     模型看到的是 `[Unread 0]`，压根不知道要回什么。
      //     ②已在 mux.js 侧修掉（补发前把该条塞回 unread）。这里只负责把基调摆正。
      // ⚠️ 措辞刻意**不强制必须回**：主人明确说过他的话不必每条都回，潜水是他的自由。
      // 这条补发的目的只是"确认你真的看到了"，而不是逼它说点什么。
      rbNote = '\n[Rebroadcast] Make-up wake: the message(s) above were marked read but never answered.'
        + (doneIds.length ? ` Already answered: ${doneIds.join(', ')}.` : '');
      st._rebroadcastWake = 0;
      saveSocialState();
    }
    // 工具全关的兜底（几乎不会发生）：没有 unread 工具就回退到两行说明版，避免哨兵悬空。
    const tools = cfgRef.social?.tools;
    const hasAnyTool = !!tools && typeof tools === 'object' && Object.values(tools).some((v) => v !== false);
    if (!hasAnyTool) {
      const unread = (st.unread || []).length;
      const rMap = { private: 'private', atMention: '@', poke: 'poke', probability: 'probability', proactiveCheck: 'proactive', replyCheck: 'replyCheck' };
      promptText = `[Token] ${st.agentToken}\n[Wake ${rMap[reason] || reason}] ${unread} unread${atLine}${typingLine}${unreadLine}${nagLine}${rbNote}${autoResetNote}`;
    } else {
      // 哨兵轮 prompt 每轮都带当前令牌：模型不必凭记忆/跨轮次查找 token，
      // 杜绝"上下文轮换后 token 抄错 → 工具全 403 → 模型看不到消息 → 空唤醒乱回"链路。
      // 令牌只占一行，成本可忽略。
      // 【2026-09-12】主人要求：① 去掉正文里的 ➤ 哨兵符号；② 规则散文一律不进正文
      //   （每一种唤醒该怎么处理都写在系统提示词 [WAKE TYPES] 里），正文只留
      //   「[Token] + [OWNER]? + [Wake <原因>] + 数据行」。
      const reasonTag = String(reason ?? '').split(':')[0];
      // `[OWNER]` = 权威的"这就是主人本人"标记（见上面 ownerWakeBranch 的说明）。persona 的 [OWNER MODE]
      // 只认这个标记，所以在主人私聊里它必须出现，其它任何会话里都必须缺席。
      const ownerTag = ownerWakeBranch ? '[OWNER]\n' : '';
      promptText = `[Token] ${st.agentToken}\n${ownerTag}[Wake ${reasonTag}]${atLine}${typingLine}${unreadLine}${nagLine}${rbNote}${autoResetNote}`;
    }
  } else {
    // 首次唤醒（或轮换到新会话后的首个真实回合）：完整 base + 最近消息滑动窗口 + 重置提示。
    // 开局即带最近 N 条历史（N = social.context.contextWindow），新会话不再依赖"摘要总结"——
    // 历史记录桥接直接查（state/social-state.json + SQLite），更早内容模型可用 qq_get_recent_messages 继续翻。
    // ⚠️ 轮换后的首轮单独给**更长**的窗口：只此一次，摊到十几轮里成本可忽略；
    //    而如果轮换后也只给十几条，用户一提旧事就像失忆（而且原来 ctxN 被硬顶在 24，
    //    config 里把 contextWindow 调到 24 以上也没用 —— 这个上限已放开到 60）。
    // 【2026-09-11 主人要求：滑动窗口优先，压制"常驻注入量"】
    // 这个窗口块**每个会话只注入一次**，但它之后会被**每一步重新读一遍**（缓存读计价）。
    // 新架构下单会话能活几十轮（`autoReset.wakeThreshold` 已从 8 提到 60），
    // 于是一个 48 条的大窗口会在上下文里被反复重读上百次 —— 是"缓存读"账单里最没价值的一块。
    // 所以：正常首轮 12 条、轮换首轮 24 条（都能用 config 调）；更早的历史交给
    // `qq_get_recent_messages` 按需从 SQLite 翻（唤醒正文里已明确允许且鼓励这么做）。
    // 依据见交接文档 §4.9 的 token 经济账：缓存读约占账单 61%，且随步数线性放大。
    const ctxBase = Math.max(6, Number(cfgRef.social?.context?.contextWindow) || 12);
    const resetBase = Math.max(ctxBase, Number(cfgRef.social?.context?.resetWindow) || 24);
    const ctxN = justReset ? Math.min(60, resetBase) : Math.min(24, ctxBase);
    const recentBlock = formatRecentWindow(st, key, ctxN);
    promptText = buildWakePrompt(key, reason) + recentBlock + autoResetNote;
    st._promptInjected = true;
    st._promptSessionId = state.sessions[key] || liveSid || null;
    st._promptOverrideStamp = ovStamp;   // 记住注入时的人设版本（文件一变就重新注入）
    log(`[default] ${key} ${justReset ? '轮换后首轮' : '首次'}唤醒，注入完整 prompt${recentBlock ? '（含最近 ' + ctxN + ' 条窗口' + (justReset ? '，轮换加长' : '') + '）' : '（窗口为空！）'}`);
  }
  if (loopResetNote) promptText = promptText + loopResetNote;
  // 上轮"正文写了但没调发送工具"的补发提示：仅真实触发的唤醒才注入（内部唤醒不翻旧账），
  // 且只提示一次后即清除，避免每轮重复纠缠；模型可自行决定补发或收尾。
  const isRealTrigger = /^(private|atMention|question|speaker|nameMention|poke|keyword|bootstrap)$/.test(String(reason).split(':')[0]);
  if (isRealTrigger && st.pendingUndeliveredText) {
    const udSnippet = String(st.pendingUndeliveredText ?? '').slice(0, 60);
    // 【2026-09-12 规则搬家】"正文只是草稿、要不要补发"的处置规则进了系统提示词 [WAKE TYPES] 第 11 条，
    // 这里只留数据：上一轮写了但没发出去的草稿片段。
    promptText += `\n[Undelivered draft] Last round ended with drafted text ("${udSnippet}…") but no send tool was called.`;
    st.pendingUndeliveredText = '';
    st._undeliveredAt = 0;
    saveSocialState();
  }
  // 跨会话：有留言/被问到别处时注入他处动态（无则空，不增加固定开销）
  const crossBlock = buildCrossChatBlock(key);
  if (crossBlock) promptText = promptText + crossBlock;
  log(`[default] 唤醒 ${key}（${reason}）`);
  const rollbackWakeTime = () => {
    const idx = st.wakeTimes.lastIndexOf(wakeTime);
    if (idx >= 0) st.wakeTimes.splice(idx, 1);
    saveSocialState();
  };
  try {
    pendingWakeKeys.add(key);
    armPendingWakeLease(key);
    // 视觉附件：把最近未处理消息里的图片/表情直接附进唤醒 prompt（绕过 MCP 压缩层，
    // 以图像内容投递给视觉模型，任何尺寸都能看清）。取最近消息里非自己发的、新鲜的
    // 图片/表情，最多 MAX_MEDIA_COUNT 个；没有就不带。
    const wakeMedia = collectFreshWakeMedia(key, st);
    // 注入活跃时段状态行：群且配了活跃时段时，提示当前在/不在活跃窗口，指导收尾潜水时长。
    // 已全活跃（mode=active / anyMessage）的会话不再注入——时段约束在“转活跃”后不应继续生效。
    const fullActive = st?.wakeConfig?.mode === 'active' || st?.wakeConfig?.triggers?.anyMessage === true;
    const actLine = key.startsWith('group:') ? activityStatusLine(key, fullActive) : '';
    if (actLine) promptText = `${promptText}\n${actLine}`;
    let result = await deliverRef(key, promptText, { media: wakeMedia });
    if (!result.ok && wakeMedia.length > 0) {
      // 视觉投递失败（模型/网关不接受图像内容）时回退纯文本，避免丢失这次唤醒
      log(`[default] 带图唤醒投递失败 ${key}（${result.error || '未知'}），回退纯文本重试`);
      result = await deliverRef(key, promptText);
    }
    const restoreFiniteSleep = () => {
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialState();
        setupSleepTimer(key);
      }
    };
    if (result && result.ok === false) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackPromptMarks();
      rollbackWakeTime();
      restoreFiniteSleep();
      log(`[default] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
    } else if (result && result.queued === true) {
      // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
      // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
      log(`[default] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
    }
  } catch (error) {
    pendingWakeKeys.delete(key);
    disarmPendingWakeLease(key);
    rollbackPromptMarks();
    rollbackWakeTime();
    if (hadFiniteSleep) {
      st.wakeConfig.sleepUntil = prevSleepUntil;
      st.wakeConfig.infinite = false;
      saveSocialState();
      setupSleepTimer(key);
    }
    log(`[default] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
  }
}
