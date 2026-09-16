// 社交运行时状态容器
// social = default default（唯一模式）状态（conversations/paused/sleepWindow）。
// cfg 静态注入（initSocialCore）。访问器（getSocialState/saveSocialState）本模块。
import crypto from 'node:crypto';
import { normalizeSpeakerIds, hasExplicitEnd } from '../lib/sleep-guard.js';
import { SOCIAL_STATE_FILE } from '../lib/paths.js';
import { atomicWriteJson, readJsonSafe } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { canonicalKey } from '../lib/keys.js';
import { KNOWN_AGENT_TOKENS } from '../lib/text-safe.js';
import { sanitizeForwardId } from '../forward.js';
import { collectors, TurnStartAt, pendingWakeKeys, promptQueues, MAX_MEDIA_COUNT, activeAiTurns, wakeConfigUpdatedKeys, markReadCalledKeys, wakeConfigMissCount, messageMediaStore, activeWaits, queued, turnHasBubble } from './session-state.js';
import { state } from './config.js';
import { isSessionAllowedInCurrentMode } from './mode.js';
// 私聊「不抢话」的等待/插话决策（纯函数，见 typing-hold.js）
import { typingHoldDecision, typingHoldText, STEER_IN_TURN_DEFER_MAX_MS } from './typing-hold.js';
import { isDirectedAtAi } from '../lib/social-timeline.js';
import { looksLikeUnfinished } from '../wait.js';
import { readRoleState } from '../lib/role-access.js';
import { bjMinutes, parseClockMin } from '../lib/time.js';
// 会话重置时"必须跨着重置活下来"的已回复账本（真机事故见本文件 resetConversationKeepingLedger 注释）
import { carryReplyLedger } from './send-idempotency.js';

let cfgRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initSocialCore(cfg) {
  cfgRef = cfg;
}

// 固定会话令牌：对 `'qqbridge-tk-v2:' + key + ':' + ownerQQ` 求 SHA-256 并取 hex 前 32 位。
// 同一 QQ/群（会话 key）在重启与会话轮换后令牌不变，模型上下文稳定；派生异常时回退随机 32 hex。
// 会话令牌 = 会话本体身份(短、可读、无加密映射): group:N -> N(群号), private:N -> N(QQ号)
export function fixedTokenForKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? ''));
  return m ? m[2] : String(key ?? '');
}

// ── default模式（default）运行时状态与唤醒配置 ────────────────────────
export const social = {
  conversations: new Map(), // key -> state
  paused: false, // 控制台可暂停整个default AI 活动（停止唤醒/等待）
  sleepWindow: null, // { start: '01:00', end: '06:00' }：群聊睡眠时间段（北京时间），窗口内只响应 @，其余不投递省 token
};

export function defaultWakeConfig() {
  const w = cfgRef.social?.wake ?? {};
  const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
  const defaultInfinite = w.recommendedDefaultInfinite !== false;
  const recMin = Number(w.recommendedSleepMinMs) || 300000;
  const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
  let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
  const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
  const hardMax = Number(w.sleepMaxMs) || 0;
  if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
  if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
  return {
    mode: defaultMode,
    infinite: defaultInfinite,
    sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
    triggers: {
      atMention: w.recommendedAtMention !== false,
      nameMention: w.recommendedNameMention !== false,
      speakerIds: [],
      keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
      question: w.recommendedQuestion !== false,
      poke: w.recommendedPoke !== false,
      anyMessage: defaultMode === 'active',
      probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
    },
    batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
    lastWakeAt: 0,
    wakeCount: 0,
    noActionCount: 0,
    confirmedAt: 0,
    confirmedBy: 'default'
  };
}

// 软重置唤醒配置：保留当前"模式"（活跃/潜水）与关键触发条件（指定成员/关键词/概率），
// 只把其余参数回归推荐默认——用于"无行动/连续未设置唤醒"等兜底场景，
// 避免把用户或管理员显式设置的活跃模式冲成默认潜水（默认潜水会让人以为机器人突然失联）。
export function softResetWakeConfig(st) {
  const old = st.wakeConfig || {};
  const oldTr = (old.triggers && typeof old.triggers === 'object') ? old.triggers : {};
  const def = defaultWakeConfig();
  const prevMode = old.mode === 'active' ? 'active' : 'diving';
  const prevProb = Number(oldTr.probability);
  const next = {
    ...def,
    mode: prevMode,
    infinite: old.infinite === false ? false : def.infinite,
    triggers: {
      ...def.triggers,
      anyMessage: prevMode === 'active' || oldTr.anyMessage === true,
      atMention: oldTr.atMention === true || def.triggers.atMention,
      nameMention: oldTr.nameMention === true || def.triggers.nameMention,
      question: oldTr.question === true || def.triggers.question,
      poke: oldTr.poke === true || def.triggers.poke,
      speakerIds: normalizeSpeakerIds(oldTr.speakerIds),
      keywords: Array.isArray(oldTr.keywords) ? oldTr.keywords.map((k) => String(k).slice(0, 100)).filter(Boolean).slice(0, 50) : def.triggers.keywords,
      probability: Number.isFinite(prevProb) && prevProb > 0 ? Math.min(1, Math.max(0, prevProb)) : def.triggers.probability
    },
    wakeCount: old.wakeCount || 0,
    noActionCount: 0,
    confirmedAt: old.confirmedAt || 0,
    confirmedBy: old.confirmedBy || 'default'
  };
  if (prevMode === 'active') {
    next.infinite = true;
    next.sleepUntil = null;
    next.triggers.anyMessage = true;
  }
  st.wakeConfig = next;
  return st.wakeConfig;
}

// ── M8 叶子纯判断 ────────────────

// 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。返回 true = 当前应阻止直接设置潜水。
export function preSleepWaitBlocked(st) {
  if (!st) return false;
  const w = cfgRef.social?.wake ?? {};
  if (w.preSleepWaitEnabled === false) return false;
  if (hasExplicitEnd(st)) return false;
  // AI 已回应过最新消息（最后发言不早于最后收到消息）：说明它没有逃避话题，
  // 想收尾/潜水时直接放行，不再强制等满观察窗口——避免每轮回复后卡 5 分钟导致新 @ 全部排队。
  if (st.lastAiReplyAt && (st.lastIncomingAt || 0) && st.lastAiReplyAt >= st.lastIncomingAt) return false;
  const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 30000);
  const now = Date.now();
  // 已经连续安静满观察窗口：可以直接设置潜水。
  if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
  // 已经完整等过观察窗口且之后没有新消息：放行。
  if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
  // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
  if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
  return true;
}

// 唤醒安全判定：按触发条件把唤醒分成 hard/timed/soft 三类并给出 guaranteed/stale 结论
export function computeWakeSafety(wc) {
  const tr = wc?.triggers || {};
  const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
    normalizeSpeakerIds(tr.speakerIds).length > 0;
  const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
  const soft = Number(tr.probability) > 0;
  const guaranteed = hard || timed || soft;
  const confirmedNum = Number(wc?.confirmedAt);
  const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
  return { hard, timed, soft, guaranteed, stale };
}

// 当前北京时间是否落在睡眠时间段窗口内（支持跨午夜，如 start 23:00 end 06:00）。
export function isInSleepWindow() {
  const w = social.sleepWindow;
  if (!w || !w.start || !w.end) return false;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const cur = now.getHours() * 60 + now.getMinutes();
  const sm = /^(\d{1,2}):(\d{2})$/;
  const mf = w.start.match(sm), me = w.end.match(sm);
  if (!mf || !me) return false;
  const startMin = parseInt(mf[1], 10) * 60 + parseInt(mf[2], 10);
  const endMin = parseInt(me[1], 10) * 60 + parseInt(me[2], 10);
  if (startMin === endMin) return false;
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin; // 跨午夜
}

// ── DND 免打扰时段（cfg 层 social.dndWindows，北京时间实时判定） ─────────
// 解析免打扰配置 v（三形态）：
//   undefined  -> 默认 [{ start:'23:00', end:'08:00' }]（整夜免打扰）
//   字符串      -> "23:00-08:00"，多段用逗号分隔："23:00-08:00,13:00-14:00"
//   数组        -> [{start:'HH:MM', end:'HH:MM'}, ...]（空数组=关闭）
// 规则：start>end 视为跨午夜（wrap）；end==start 整天免打扰；空串/空对象=关闭。
// 返回归一化窗口 [{ start: 北京分钟, end: 北京分钟, allDay: bool }, ...]，无法解析的段忽略。
export function parseDndWindows(v) {
  const norm = (m) => m === null ? null : ((m % 1440) + 1440) % 1440;
  let raw;
  if (v === undefined) {
    raw = [{ start: '23:00', end: '08:00' }];
  } else if (typeof v === 'string') {
    raw = [];
    for (const seg of String(v).split(',').map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = seg.split(/[-~—至到]/).map((s) => s.trim());
      if (a || b) raw.push({ start: a, end: b });
    }
  } else if (Array.isArray(v)) {
    raw = v;
  } else if (v && typeof v === 'object') {
    raw = [v]; // 单对象形态也兼容
  } else {
    return []; // null/数字等不可用形态 = 关闭
  }
  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const sRaw = String(it.start ?? '').trim();
    const eRaw = String(it.end ?? '').trim();
    if (!sRaw && !eRaw) continue; // 空对象段 = 关闭该段
    const s = norm(parseClockMin(sRaw));
    const e = norm(parseClockMin(eRaw));
    if (s === null || e === null) continue; // 单段解析失败则忽略该段
    out.push({ start: s, end: e, allDay: s === e });
  }
  return out;
}

// 距当前免打扰窗口结束还有多久（分钟→ms；已过所有窗口或整天免打扰返回 null）。
// 用于 DND 期间仍保持主动链：到点后自动重排一次 scheduleProactiveCheck。
function nextDndResumeMs() {
  if (!cfgRef || !cfgRef.social) return null;
  const now = bjMinutes();
  let best = null;
  for (const w of parseDndWindows(cfgRef.social.dndWindows)) {
    if (w.allDay) return null; // 整天免打扰：不自动恢复
    let remain = null;
    if (w.start < w.end) {
      if (now >= w.start && now < w.end) remain = w.end - now;
    } else { // 跨午夜 wrap
      if (now >= w.start) remain = (1440 - now) + w.end;
      else if (now < w.end) remain = w.end - now;
    }
    if (remain !== null && (best === null || remain < best)) best = remain;
  }
  return best === null ? null : Math.max(1, best) * 60000;
}

// 当前北京时间是否处于任一免打扰窗口内（nowMin 可显式传入分钟，默认 bjMinutes()）。
// cfgRef 尚未注入（initSocialCore 前）时按无窗口处理。
export function inDndWindow(nowMin) {
  if (!cfgRef || !cfgRef.social) return false;
  const now = Number.isFinite(Number(nowMin)) ? ((Number(nowMin) % 1440) + 1440) % 1440 : bjMinutes();
  for (const w of parseDndWindows(cfgRef.social.dndWindows)) {
    if (w.allDay) return true; // 整天免打扰
    if (w.start < w.end) {
      if (now >= w.start && now < w.end) return true;
    } else if (now >= w.start || now < w.end) { // 跨午夜 wrap
      return true;
    }
  }
  return false;
}

// 唤醒原因优先级表（子类型取冒号前基名）
const WAKE_PRIORITY = {
  private: 100,
  atMention: 90,
  question: 80,
  speaker: 75,
  nameMention: 70,
  topic: 65,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  timeout: 30,
  proactiveCheck: 20
};

// 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
export function wakePriority(reason) {
  const base = String(reason ?? '').split(':')[0];
  return WAKE_PRIORITY[base] ?? 0;
}

// default会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
export const seenForwardIds = new Map(); // key -> Set<string>

// default social 状态持久化
export function saveSocialState() {
  try {
    const obj = { paused: social.paused, conversations: Object.create(null) };
    for (const [key, st] of social.conversations) {
      obj.conversations[key] = {
        wakeConfig: st.wakeConfig,
        recentMessages: st.recentMessages.slice(-200),
        unread: st.unread.slice(-100),
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt,
        lastActionAt: st.lastActionAt,
        agentToken: st.agentToken,
        bootstrapSent: st.bootstrapSent,
        wakeTimes: st.wakeTimes.slice(-200),
        sendTimes: st.sendTimes.slice(-500),
        stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
        lastIncomingAt: st.lastIncomingAt || 0,
        lastAiSeenAt: Number(st.lastAiSeenAt) || 0,
        // 「确实被回复过」的消息 id 集合（按 QQ messageId，跨会话轮换也稳定）。
        // 用途：回合结束判断"某条被暂存的唤醒到底有没有被吞"时**按 id 查集合**，
        // 而不是像以前那样比时间戳——时间戳判不出"看过但没回"，也分不清"回过但又被重播"。
        answeredMessageIds: Array.isArray(st.answeredMessageIds) ? st.answeredMessageIds.slice(-300) : [],
        pendingUndeliveredText: String(st.pendingUndeliveredText ?? ''),
        _undeliveredAt: Number(st._undeliveredAt) || 0,
        sessionToolCalls: Number(st.sessionToolCalls) || 0,
        _promptInjected: st._promptInjected === true,
        _standbySessionId: st._standbySessionId || null,
        _standbyWarming: st._standbyWarming === true,
        _mediaAttachedSeq: Number(st._mediaAttachedSeq) || 0,
        rotateTurns: Number(st.rotateTurns) || 0,
        _promptSessionId: (typeof st._promptSessionId === 'string' && st._promptSessionId) ? st._promptSessionId : null,
        preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
        preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
        preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
        lastUnreadSeq: st.lastUnreadSeq || 0,
        // 【2026-09-11 23:08】"已交给模型的最高 seq"**必须落盘**：它只在内存里的话，
        // 每次桥重启都会归零 → 等待工具的基线退回 lastUnreadSeq → 重启前被暂存、还没交付的消息
        // 就再也交付不了了（实测 15:04 被暂存的 seq12/seq13 就是这样被我自己的重启弄丢的）。
        lastDeliveredSeq: Number(st.lastDeliveredSeq) || 0,
        // 投递看门狗的"意图水位"：桥**打算交付**过的最高 seq（scheduleWake 每次被调用就推进）。
        // 必须落盘：否则桥一重启，重启前"已经决定要交付、但还没交出去"的那批就再也兜不到了。
        _wakeIntendedSeq: Number(st._wakeIntendedSeq) || 0,
        activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
        pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
        memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
        seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
      };
    }
    atomicWriteJson(SOCIAL_STATE_FILE, obj);
  } catch (error) {
    log('保存 social 状态失败:', error?.message ?? error);
  }
}

// 把"仍使用默认唤醒配置"的会话刷新为当前推荐/默认参数。
// 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
export function refreshDefaultWakeConfig(st) {
  if (!st || !st.wakeConfig) return false;
  if (st.wakeConfig.confirmedBy !== 'default') return false;
  const def = defaultWakeConfig();
  const old = st.wakeConfig;
  st.wakeConfig = {
    ...def,
    lastWakeAt: old.lastWakeAt || 0,
    wakeCount: old.wakeCount || 0,
    noActionCount: old.noActionCount || 0,
    confirmedAt: old.confirmedAt || 0,
    confirmedBy: 'default'
  };
  return true;
}

// 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
export function refreshAllDefaultWakeConfigs() {
  let changed = false;
  for (const st of social.conversations.values()) {
    if (refreshDefaultWakeConfig(st)) changed = true;
  }
  if (changed) saveSocialState();
  return changed;
}

// 会话繁忙判定（P4-16 迁入）：有待发唤醒 / 队列中投递 / 在途 DSH turn 都算忙，防止重复唤醒
export function isConversationBusy(key, st) {
  if (st && st.pendingWakeTimer) return true;
  if (pendingWakeKeys.has(key)) return true;
  const q = promptQueues.get(key);
  if (q && (q.running || q.queue.length > 0)) return true;
  const sid = state.sessions[key];
  if (sid && (TurnStartAt.has(sid) || collectors.has(sid))) return true;
  return false;
}

// ── M8 内层 SCC（P4-17 迁入）：访问器 + 调度器。sendWakePrompt 仍驻 main，
//    经 setWakeSender/dispatchWake 注入解耦。 ──────────────────────────────────

let wakeSender = null;
/** main 侧注册实际发送函数（sendWakePrompt） */
export function setWakeSender(fn) {
  wakeSender = fn;
}
function dispatchWake(key, reason) {
  return wakeSender ? wakeSender(key, reason) : Promise.resolve();
}

/**
 * 「会话忙期间把新消息直接塞进正在跑的那一轮」的注入口（实现在 wake-send.js 的 steerIntoRunningTurn）。
 *
 * 为什么要它：DSH 的 `session/prompt` 支持 `mode:'steer'` → `agent.steer()` → inbox 投到
 * **'next-step'**（本回合的下一个 step 边界就交给模型）；而 `mode:'queue'` 投的是
 * **'next-turn'**，那必然多出一整轮。原来的 `pendingWakeReasons` 补发走的就是 queue 这条路：
 * 用户在你思考时补一句话 → 你回一次 → 结束后又被唤醒回一次，多花一整轮模型往返
 * （那一轮还会把那 8 万字符的 prompt 再重发一遍）。
 * 塞进去以后模型在**同一条回复里**就把新消息一起考虑掉了。
 *
 * 返回 Promise<boolean>：true = 已塞进在途回合（那条消息**仍然**照常入队做审计，
 * 回合结束时的补发逻辑会看到"已被本轮处理"而跳过，不会重复唤醒）。
 */
let steerSender = null;

/** main 侧注册实际执行函数（steerIntoRunningTurn） */
export function setSteerSender(fn) {
  steerSender = fn;
}
function trySteerRunningTurn(key, reason) {
  if (!steerSender) return Promise.resolve(false);
  try {
    return Promise.resolve(steerSender(key, reason)).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

// 会话状态访问器：只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，
// 防止同一会话分裂成多个状态。
export function getSocialState(key) {
  const canonical = canonicalKey(key);
  if (!canonical) {
    const err = new Error(`无效的会话 key：${String(key ?? '')}`);
    err.statusCode = 400;
    throw err;
  }
  key = canonical;
  let st = social.conversations.get(key);
  if (!st) {
    st = {
      wakeConfig: defaultWakeConfig(),
      recentMessages: [],
      unread: [],
      lastWakeReason: '',
      lastAiReplyAt: 0,
      lastAiSeenAt: 0, // AI 最后一次"看过消息并收尾"（mark_read/设潜水）的时间；用于区分"真被吞"与"看过选择不接"，根治重复补发唤醒
      answeredMessageIds: [], // 「确实被回复过」的消息 id（见 §4.7e.4）：被暂存唤醒的吞/未吞判定改用它，不再比时间戳
      pendingUndeliveredText: '', // 模型写了正文但没调发送工具（桥接不再自动转发）；暂存并提示模型自行补发
      _undeliveredAt: 0,
      sessionToolCalls: 0, // 会话内实际工具调用轮数（会话轮换阈值计数，与 wakeCount 取大）
      rotateTurns: 0, // 用户真实触发回合数（会话轮换的唯一依据；replyCheck/主动等内部唤醒不计）
      _mediaAttachedSeq: 0, // 最近一次唤醒已附图覆盖到的最高消息 seq（防同一批图反复附）
      _promptSessionId: null, // 最近一次完整 prompt 注入时对应的 DSH sessionId（会话重建/DSH 重启后强制重新注入）
      _promptInjected: false, // 首次完整 prompt 是否已注入（持久化：避免桥重启后对同一长驻会话重复全量注入）
      _standbySessionId: null, // 已预建并预热的"下一代会话"id（轮换时直接切换）
      _standbyWarming: false, // 预热创建/请求进行中标记（防重入）
      lastActionAt: 0,
      agentToken: fixedTokenForKey(key),
      bootstrapSent: false,
      wakeTimes: [],
      sendTimes: [],
      stickerCollectTimes: [],
      pendingWakeTimer: null,
      sleepTimer: null,
      replyCheckTimer: null,
      proactiveTimer: null,
      lastIncomingAt: 0,
      preSleepWaitSatisfiedAt: 0,
      preSleepWaitObservedAt: 0,
      preSleepWaitAccumMs: 0,
      lastUnreadSeq: 0,
      lastDeliveredSeq: 0,   // 已交给模型的最高 seq（wake-send.js 投递水位 / console-server 等待工具水位）
      _wakeIntendedSeq: 0,   // 桥**打算交付**的最高 seq（投递看门狗的意图水位，见 sweepUndelivered）
      activeTopics: [],
      pendingThoughts: [],
      memberImpressions: {}
    };
    KNOWN_AGENT_TOKENS.add(st.agentToken);
    social.conversations.set(key, st);
    scheduleProactiveCheck(key);
    setupSleepTimer(key);
  }
  return st;
}

// ── 会话重置：清会话状态，但**保住「已回复账本」** ────────────────────────────────
// 【2026-09-16 真机事故「reset 之后会重复回复一次」】
//   所有 reset 路径（控制台 /api/session/reset、/api/social/reset、/api/workspace/reset、
//   聊天里发 /reset 或 /new、卡死隔离）原来都是 `social.conversations.delete(key)` 一刀切。
//   被删掉的**不只是**会话上下文，还有四样"这个会话已经处理到哪了"的账：
//     · answeredMessageIds  「确实被回复过」的消息 id 集合
//     · lastDeliveredSeq   已交给模型的最高 seq（投递水位 / 等待工具基线）
//     · _wakeIntendedSeq   桥打算交付的最高 seq（投递看门狗水位）
//     · lastUnreadSeq      本地 seq 计数器（appendSocialMessage 用它 +1）
//   现场证据：private 会话 reset 前 hold 记的是 baselineSeq=63，reset 后立刻变成 baselineSeq=1；
//   group 会话 reset 前 steer 记的是 seq=1756，reset 后 social-state.json 里只剩 lastDeliveredSeq=5。
//   账本一没，同一个会话在重置后就成了"白纸"：旧消息的分发水位归零、已回复过的 id 也不认识了，
//   于是新会话可能把刚回过的内容再回一遍（重复回复）。同时 `_justAutoReset` 提示也随对象一起没了，
//   模型连"刚换上下文、别重答旧话题"这句都没有。
//
//   修法：换成"先快照账本 → 删旧状态 → 立刻把账本写回新状态"。
//   ⚠️ 踩过的坑（必须同生同死）：**只保水位不保 seq 计数器是更严重的误杀**——重置后新消息的 seq
//   会从 1 重新数，而 lastDeliveredSeq 还停在 63，看门狗/注入去重会把这些新消息全判成"已交付"，
//   机器人从此装死不回。所以这四项永远一起搬（见 send-idempotency.js 的 REPLY_LEDGER_FIELDS）。
export function resetConversationKeepingLedger(key) {
  const canonical = canonicalKey(key);
  if (!canonical) return null;
  const prev = social.conversations.get(canonical) || null;
  social.conversations.delete(canonical);
  if (!prev) return null;
  const carried = carryReplyLedger(prev);
  if (!carried || !carried.carried.length) return null;
  // 重建一份干净的会话状态，只把账本写回去（其余 wakeConfig/unread/令牌全部按全新会话走）。
  const st = getSocialState(canonical);
  Object.assign(st, carried.patch);
  saveSocialState();
  log(`[reset] ${canonical} 会话已重置，保留已回复账本（${carried.carried.join('、')}）`
    + `——重置前后同一批消息不会因为账本丢失被重新唤醒重复回复`);
  return carried;
}

// 从持久化文件加载 social 状态（重启恢复）
export function loadSocialState() {
  try {
    const raw = readJsonSafe(SOCIAL_STATE_FILE, null);
    social.paused = raw?.paused === true;
    if (raw && typeof raw.conversations === 'object') {
      for (const [key, val] of Object.entries(raw.conversations)) {
        if (!val || typeof val !== 'object') continue;
        if (!/^(group|private):\d+$/.test(key)) continue;
        const defaultWc = defaultWakeConfig();
        // 固定令牌：由会话 key + ownerQQ 派生（跨重启/会话轮换不变，模型上下文稳定）。
        // 迁移说明：原持久化的随机/存储 token 一律替换为派生值，旧值不再被使用；
        // KNOWN_AGENT_TOKENS 会对新值 add；旧值若曾 add 仅残留在脱敏集合里（只增语义，无碍）。
        const agentToken = fixedTokenForKey(key);
        const st = {
          wakeConfig: {
            ...defaultWc,
            ...(val.wakeConfig ?? {}),
            triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
          },
          recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
          // 不恢复持久化的旧 unread(曾经导致几十条历史未读跨重启"复活"、反复重放造成挤压):
          // 重启后统一由唤醒路径按 lastAiSeenAt 水位从 DB 拉真正的"水位之后"新消息。
          unread: [],
          lastWakeReason: String(val.lastWakeReason ?? ''),
          lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
          answeredMessageIds: Array.isArray(val.answeredMessageIds)
            ? val.answeredMessageIds.map((x) => String(x ?? '')).filter(Boolean).slice(-300)
            : [],
          lastActionAt: Number(val.lastActionAt) || 0,
          agentToken,
          bootstrapSent: !!val.bootstrapSent,
          wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
          sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
          stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
          pendingWakeTimer: null,
          sleepTimer: null,
          replyCheckTimer: null,
          proactiveTimer: null,
          lastIncomingAt: Number(val.lastIncomingAt) || 0,
          lastAiSeenAt: Number(val.lastAiSeenAt) || 0,
          pendingUndeliveredText: String(val.pendingUndeliveredText ?? ''),
          _undeliveredAt: Number(val._undeliveredAt) || 0,
          sessionToolCalls: Number(val.sessionToolCalls) || 0,
          _promptInjected: val._promptInjected === true,
          _standbySessionId: (typeof val._standbySessionId === 'string' && val._standbySessionId) ? val._standbySessionId : null,
          _standbyWarming: val._standbyWarming === true,
          _mediaAttachedSeq: Number(val._mediaAttachedSeq) || 0,
          rotateTurns: Number(val.rotateTurns) || 0,
          _promptSessionId: (typeof val._promptSessionId === 'string' && val._promptSessionId) ? val._promptSessionId : null,
          preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
          preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
          preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
          lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
          lastDeliveredSeq: Number(val.lastDeliveredSeq) || 0,
          _wakeIntendedSeq: Number(val._wakeIntendedSeq) || 0,
          activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
          pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
          memberImpressions: (() => {
            const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
            const clean = {};
            for (const [k, v] of Object.entries(rawImp)) {
              if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
              clean[k] = v;
            }
            return clean;
          })()
        };
        // 旧状态/异常状态里的指定成员名单也统一归一化，防止"null"/非法值污染。
        if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
          st.wakeConfig.triggers.speakerIds = normalizeSpeakerIds(st.wakeConfig.triggers.speakerIds);
          if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
        }
        // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
        refreshDefaultWakeConfig(st);
        KNOWN_AGENT_TOKENS.add(st.agentToken);
        social.conversations.set(key, st);
        // 重启后从已持久化的消息与 seenForwardIds 字段重建"本会话见过的 forward id"
        {
          const rebuilt = new Set();
          if (Array.isArray(val.seenForwardIds)) {
            for (const fid of val.seenForwardIds) {
              const safe = sanitizeForwardId(fid);
              if (safe) rebuilt.add(safe);
            }
          }
          for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
            if (Array.isArray(m?.forwardIds)) {
              for (const fid of m.forwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
          }
          if (rebuilt.size) seenForwardIds.set(key, rebuilt);
        }
        ensureWakeable(st, { skipSave: true, key });
        scheduleProactiveCheck(key);
      }
      // 加载阶段统一落盘一次，避免 ensureWakeable 中途写盘覆盖未加载会话。
      saveSocialState();
    }
  } catch (error) {
    log('读取 social 状态失败:', error?.message ?? error);
  }
}

// 防"永眠"：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
// opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
export function ensureWakeable(st, opts = {}) {
  if (!st || !st.wakeConfig) return;
  const key = opts.key || st.key;
  const wc = st.wakeConfig;
  if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
  const tr = wc.triggers;
  // 掉垃圾数据只留有效 QQ 号，避免"null"/对象等脏值被当成可唤醒条件绕过防永眠。
  tr.speakerIds = normalizeSpeakerIds(tr.speakerIds);
  const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
  const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
    (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
    tr.speakerIds.length > 0 || timed;
  if (!wakeable) {
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig = defaultWakeConfig();
    if (!opts.skipSave) saveSocialState();
    if (key) setupSleepTimer(key);
    log(`[default] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
  }
}

export function cancelReplyCheck(key) {
  const st = social.conversations.get(key);
  if (!st || !st.replyCheckTimer) return;
  clearTimeout(st.replyCheckTimer);
  st.replyCheckTimer = null;
}

export function cancelProactiveCheck(key) {
  const st = social.conversations.get(key);
  if (!st || !st.proactiveTimer) return;
  clearTimeout(st.proactiveTimer);
  st.proactiveTimer = null;
}

// 有限睡眠到期后唤醒
export function setupSleepTimer(key) {
  if (cfgRef.social?.enabled === false) return;
  if (!isSessionAllowedInCurrentMode(key)) return;
  const st = getSocialState(key);
  cancelReplyCheck(key); // 有限睡眠配置已接管，取消回复检查
  if (st.sleepTimer) {
    clearTimeout(st.sleepTimer);
    st.sleepTimer = null;
  }
  if (social.paused) return;
  const wc = st.wakeConfig;
  if (!wc || wc.infinite || !wc.sleepUntil) return;
  const until = Date.parse(wc.sleepUntil);
  if (!Number.isFinite(until)) return;
  const delay = until - Date.now();
  if (delay <= 0) {
    void dispatchWake(key, 'timeout').catch((error) => log(`[default] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    return;
  }
  // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
  const MAX_TIMEOUT_MS = 2147483647;
  if (delay > MAX_TIMEOUT_MS) {
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      setupSleepTimer(key);
    }, MAX_TIMEOUT_MS);
    st.sleepTimer.unref?.();
    log(`[default] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
    return;
  }
  st.sleepTimer = setTimeout(() => {
    st.sleepTimer = null;
    void dispatchWake(key, 'timeout').catch((error) => log(`[default] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
  }, delay);
  st.sleepTimer.unref?.();
  log(`[default] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
}

// 主动机会检查（群/私聊独立参数，低概率开口）
export function scheduleProactiveCheck(key) {
  if (cfgRef.social?.proactive?.enabled === false) return;
  if (social.paused) return;
  if (!isSessionAllowedInCurrentMode(key)) return;
  if (inDndWindow()) {
    // 免打扰时段不排主动机会；但保留链条：到窗口结束时自动重排一次（每小时兜底重检）。
    const resumeMs = nextDndResumeMs();
    if (!resumeMs) return; // 整天免打扰/解析异常：不排
    const st0 = social.conversations.get(key);
    if (st0 && !st0.proactiveTimer) {
      st0.proactiveTimer = setTimeout(() => {
        st0.proactiveTimer = null;
        scheduleProactiveCheck(key);
      }, Math.min(resumeMs, 60 * 60 * 1000));
      st0.proactiveTimer.unref?.();
      log(`[default] 免打扰中 ${key}：${Math.round(Math.min(resumeMs, 3600000) / 60000)}min 后恢复主动机会检查`);
    }
    return; // 免打扰时段不排主动机会（@/私聊等真实触发仍走 scheduleWake）
  }
  // deepsleep 与「单群静默名单」都**只针对群聊**（私聊照常）：静默群不主动冒泡。
  if (String(key).startsWith('group:')) {
    const gpId = String(key).split(':')[1] || '';
    const silentGroups = Array.isArray(cfgRef.social?.deepsleepGroups) ? cfgRef.social.deepsleepGroups.map(String) : [];
    if (cfgRef.social?.deepsleep || silentGroups.includes(gpId)) return;
  }
  const st = getSocialState(key);
  if (st.proactiveTimer) return;
  const p = cfgRef.social?.proactive ?? {};
  // 私聊用独立更主动的参数（privateCheckIntervalMinMs/MaxMs/privateProbability），群聊用常规参数。
  const isPrivate = String(key).startsWith('private:');
  const min = Math.max(60 * 1000, Number(isPrivate ? p.privateCheckIntervalMinMs : p.checkIntervalMinMs) || (isPrivate ? 15 * 60 * 1000 : 30 * 60 * 1000));
  const max = Math.max(min, Number(isPrivate ? p.privateCheckIntervalMaxMs : p.checkIntervalMaxMs) || (isPrivate ? 40 * 60 * 1000 : 90 * 60 * 1000));
  const delay = Math.floor(min + Math.random() * (max - min));
  st.proactiveTimer = setTimeout(() => {
    st.proactiveTimer = null;
    ensureWakeable(st, { key });
    const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
    const idle = Date.now() - (st.lastIncomingAt || 0);
    const probBase = Number(isPrivate ? p.privateProbability : p.probability);
    let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
    const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
    if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
    if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 8) prob *= 0.3;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
    if (aiCount >= 5) prob *= 0.3;
    // 有话题才开口（默认开启 freshContextOnly）：未读/待办想法/近 2h 他人发言都没有就只重排下一轮，
    // 不触发 LLM——配合 DND 与冷场概率衰减，避免凌晨/无话题空转。
    const fresh = (Array.isArray(st.unread) && st.unread.length > 0)
      || pendingThoughts > 0
      || recent.some((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 2 * 60 * 60 * 1000);
    const freshOnly = cfgRef.social?.proactive?.freshContextOnly !== false;
    if (freshOnly && !fresh) {
      log(`[default] proactive 无话题可开,跳过本轮 ${key}`);
    } else if (idle >= idleThreshold && Math.random() < prob && !isConversationBusy(key, st)) {
      void dispatchWake(key, 'proactiveCheck').catch((error) => log(`[default] proactive 唤醒异常 ${key}:`, error?.message ?? error));
    }
    scheduleProactiveCheck(key);
  }, delay);
  st.proactiveTimer.unref?.();
  log(`[default] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
}

// 对方持续输入时，唤醒最多再顺延的总上限（P4-22 迁入）
// 私聊「等对方打完字」的硬上限（ms）。2026-09-11 从 15000 收到 2500：
// 原来对方只要还在输入，私聊唤醒窗口最多顺延到 15 秒，加上「停止输入」还有 2 秒合并窗，
// 再叠加模型两次往返 ≈ 8 秒 —— 体感就是「发完消息它半天不动，突然回一大段」，很割裂。
// 现在最多等 2.5 秒就开始回：对方要是还有后半句，发出来会再唤醒一次，比干等更顺。
export const PEER_TYPING_HOLD_MAX_MS = 2500;

// 计划唤醒：合并窗口 + 优先级升级 + busy 暂存 + 定时投递（P4-22 迁入，sendWakePrompt 走 dispatchWake）
export function scheduleWake(key, reason) {
  if (cfgRef.social?.enabled === false) return;
  if (social.paused) return;
  if (!isSessionAllowedInCurrentMode(key)) {
    log(`[default] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
    return;
  }
  // 免打扰时段拦截内部低价值唤醒（reason 可能带 ':分组' 后缀，取冒号前基名）；
  // timeout/@/提问/私聊/拍一拍/点名等真实触发不拦（免打扰≠失联，被直接叫到仍回）。
  const baseReason = String(reason ?? '').split(':')[0];
  if (inDndWindow() && /^(proactiveCheck|replyCheck|probability|anyMessage|keyword)$/.test(baseReason)) {
    log(`[default] 免打扰窗口，跳过内部唤醒 ${key}（${reason}）`);
    return;
  }
  const st = getSocialState(key);
  // 【2026-09-12 投递看门狗的"意图水位"】只要 scheduleWake 被调用，就说明**桥已经决定把这条消息交给模型**，
  // 于是把水位推进到"此刻 unread 的最高 seq"。看门狗（sweepUndelivered）只兜这一类：
  //   `seq <= _wakeIntendedSeq（桥打算交付） && seq > lastDeliveredSeq（但没交出去）`。
  // ⚠️ 为什么必须有这个水位：**"有未读"和"决定唤醒"是两回事**。
  //   群聊在潜水模式下按概率/关键词决定接不接话，绝大多数普通消息**根本不会触发唤醒**——
  //   那是功能，不是故障。看门狗如果只按 `seq > lastDeliveredSeq` 判，就会把这些安静略过的消息
  //   在 25 秒后全部强制唤醒：**潜水模式被废掉、还白烧一大堆 token**。
  //   （这个坑实测踩到过：2026-09-12 00:14 群 某群的一条普通消息被误判成"收下没交付"。）
  try {
    const maxUnreadSeq = (Array.isArray(st.unread) ? st.unread : [])
      .reduce((m, x) => Math.max(m, Number(x && x.seq) || 0), 0);
    if (maxUnreadSeq > 0) st._wakeIntendedSeq = Math.max(Number(st._wakeIntendedSeq) || 0, maxUnreadSeq);
  } catch (_) {}
  // 【2026-09-11 主人要求：除了首轮，不要再往对话窗口注入任何消息 —— 要注入到"思考"里】
  // 该会话此刻正挂着一个 `qq_wait_for_messages` 长轮询：新消息会作为**工具结果**直接回到模型手里。
  // 所以这里**什么都不做**：不 steer（steer 在 DSH 里必然产生一条 user/message → 会出现在对话窗口）、
  // 不暂存、不补发、不唤醒。这才是"注入到思考里"—— 消息从工具调用返回，而不是被推成一条聊天消息。
  // 依据：DSH 的 sessionPromptRequestSchema 只有 sessionId/mode/content/clientTimeZone，
  // 没有任何"不可见"字段；additionalContexts 的类型也是 UserMessage[]。**桥推送必然可见。**
  if (activeWaits.has(key)) {
    log(`[default] ${key} 正在 qq_wait_for_messages 长轮询中，新消息随工具结果交回模型（不注入对话、不唤醒）`);
    return;
  }
  if (st.pendingWakeTimer) {
    // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
    const cur = st.pendingWakeReason || reason;
    if (wakePriority(reason) > wakePriority(cur)) {
      st.pendingWakeReason = reason;
      log(`[default] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
    }
    return;
  }
  if (isConversationBusy(key, st)) {
    // 【2026-09-12 架构收敛】这里**故意不做任何投递**，只放行到下面的合并窗。
    // 与 wake-send.js 的 busy 分支（真正投递那一刻的判定）分工如下：
    //   · 这里 = "合并窗之前"的判定。此刻刚到的消息还没攒够，**必须**先走合并窗
    //     （主人 2026-09-11 的实测教训：为了压延迟把合并窗压到 800ms，两条隔 2 秒的消息被拆成两批，
    //      "正常人肯定一起回"的话被甩成两条回复）。在这里 steer 会绕过合并窗，等于把那个坑再踩一次。
    //   · wake-send.js 那份 = "投递那一刻"的判定。那时批已经攒好，才该决定"塞进在途回合"还是"正常唤醒"。
    // 所以：**忙时不暂存、不丢消息，只是等合并窗**；到点后由 wake-send 优先 steer 进在途回合，
    // 塞不进去则走正常唤醒——而正常唤醒现在也是 steer 投递（prompt-deliver.js），
    // 因此无论哪条路都**不可能再卡在 DSH 的 next-turn 队列里**（主人 2026-09-11 23:58 报的故障）。
    log(`[default] ${key} 会话繁忙但模型未在等待工具里 → 先攒合并窗，到点后优先塞进在途回合（不暂存，避免永久卡死）`);
    // ⚠️ 故意不 return：继续走下面的合并窗 + 正常唤醒流程
  }
  cancelReplyCheck(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
  if (st.sleepTimer) {
    clearTimeout(st.sleepTimer);
    st.sleepTimer = null;
  }
  st.pendingWakeReason = reason;
  // 交互型唤醒（@/提问/名字/拍一拍/私聊）用短合并窗口尽快响应；概率/主动/回复检查类保持合并窗口省 token。
  // 秒唤醒（主人 2026-09-06 要求）：私聊合并窗 1s；群聊 @/提问 0.8s；概率/anyMessage 类 3s 上限。
  //
  // 【2026-09-11 再提速】补发轮（`_rebroadcastWake`，也就是"会话忙期间被暂存、回合结束后补发"的那批，
  // 唤醒正文里的 `[Unread n] owner(id:xxx): …` 就是它们）**不再攒合并窗**：
  //   · 合并窗的意义是"把刚到的连发攒成一轮"，而这批消息已经在"会话忙"期间等过了，再攒 1s 纯属重复等待；
  //   · 同理**也不再因为"对方还在输入"顺延**（最多 2.5s）——他早就在等了。
  // 于是这批消息从"回合结束 → 再等 1s(+最多2.5s) → 投递"变成"回合结束 → 0.2s → 投递"。
  // 【防泄漏】标志由 wake-send 在出 prompt 时清 0，且只在 120s 内有效（见 wake-send.js rbNote）。
  // 这里必须用**同一个** TTL 判定：否则补发轮若被拖过 120s，这一行读到的仍是 >0，
  // 该会话之后的每一轮普通唤醒都会被误判成补发轮 → 永久 200ms 且永久失去"对方正在输入"等待。
  const rbAt = Number(st._rebroadcastWake) || 0;
  const isReplayWake = rbAt > 0 && Date.now() - rbAt < 120000;
  if (rbAt > 0 && !isReplayWake) st._rebroadcastWake = 0; // 过期即清，杜绝泄漏成“永久提速”
  const interactiveReasons = /^(atMention|question|nameMention|poke|private)$/;
  const isPrivateWake = key.startsWith('private:') && /^(private|poke|nameMention|question)$/.test(String(reason).split(':')[0]);
  let batchMs = isReplayWake
    ? 200
    : (interactiveReasons.test(String(reason))
      ? (isPrivateWake ? 1000 : 800)
      : Math.min(3000, Math.max(400, Number(st.wakeConfig?.batchWindowMs) || 2000)));
  // 私聊智能等待（2026-09-15 主人要求：看对方打字状态、等打完再回，并用概率骰子决定要不要插话）：
  //   · 命中"等"→ 把唤醒窗口拉长（上限 social.typing.holdMaxMs），期间到的消息全进 unread → 合并成一次注入；
  //   · 命中"插话"（骰子命中 / 等太久到上限）→ 按正常节奏回，不抢话也不干等。
  // 补发轮跳过这一条：那批消息早在"会话忙"期间就等着了，再等他打完字只是二次延迟。
  if (!isReplayWake && key.startsWith('private:')) {
    const decision = typingHoldDecision({ typingUntil: st.peerTypingUntil, since: st.peerTypingSince, cfg: cfgRef });
    if (decision.wait) {
      // 【2026-09-16 晚 修「思考期间到的消息被塞进下一个唤醒」】会话**正忙（有回合在跑）**时，
      // 绝不许把唤醒窗口拉过这一轮：一旦拖到回合结束，投递就只能走"完整唤醒"= 下一个唤醒/下一轮。
      // 线上实测 13:39:59 那条消息就是这么被拖出当前轮的（窗口被拉到 5.2s → 13:40:05 投递时
      // `[steer] 跳过：没有正在跑的模型回合` → `唤醒 private:***（private）`）。
      // 有回合在跑时窗口最多顺延 STEER_IN_TURN_DEFER_MAX_MS（在途注入那条路才是正解）；
      // 模型本回合**一条都还没发出去**时一秒都不等（等下去只是把它拖出这一轮，见 wake-send.js 的 noReplyYet）。
      const busyNow = isConversationBusy(key, st);
      const hasBubble = turnHasBubble(key, state.sessions[key], st);
      const remainMs = decision.remainMs + 500;
      const waitMs = busyNow
        ? (hasBubble ? Math.min(remainMs, STEER_IN_TURN_DEFER_MAX_MS) : 0)
        : Math.min(decision.cfg.holdMaxMs, remainMs);
      if (waitMs > 0) batchMs = Math.max(batchMs, waitMs);
      log(`[typing] ${typingHoldText(decision, key)}${busyNow
        ? `；会话正忙（有回合在跑）→ 唤醒窗口最多顺延 ${(STEER_IN_TURN_DEFER_MAX_MS / 1000).toFixed(1)}s，` +
          (hasBubble ? '本回合已发过气泡，允许短暂延迟' : '本回合一条都还没发出去，一秒不等、立刻投给在途回合')
        : ''}；唤醒窗口 ${(batchMs / 1000).toFixed(1)}s`);
    } else if (decision.breakIn) {
      log(`[typing] ${typingHoldText(decision, key)}`);
    }
  }
  if (isReplayWake) log(`[default] ${key} 补发轮提速：合并窗 ${batchMs}ms（这批消息已在忙期间等过，不再攒窗/不再等对方输入）`);
  st.pendingWakeTimerStartedAt = Date.now();
  st.pendingWakeTimer = setTimeout(() => {
    st.pendingWakeTimer = null;
    st.pendingWakeTimerStartedAt = 0;
    const finalReason = st.pendingWakeReason || reason;
    st.pendingWakeReason = null;
    void dispatchWake(key, finalReason).catch((error) => log(`[default] 计划唤醒异常 ${key}:`, error?.message ?? error));
  }, batchMs);
  log(`[default] 计划唤醒 ${key}（${reason}），${batchMs >= 1000 ? Math.round(batchMs / 1000) + 's' : batchMs + 'ms'} 后发送`);
}

// ── 投递看门狗：把"绝不吞消息"从"应该不会"变成"不可能" ─────────────────────────────
// 【2026-09-12】只做一件事：找出**桥已经决定要交付、却一直没有交出去**的消息，重新排一次唤醒。
//
// 判据是两段水位（两个都必须满足）：
//   ① `seq <= _wakeIntendedSeq` —— 桥**打算**交付它（每次 scheduleWake 就会推进这个水位）；
//   ② `seq > lastDeliveredSeq`  —— 但**还没**交出去。
// ⚠️ 为什么必须有①：**"有未读"和"决定唤醒"是两回事**。群聊在潜水模式下按概率/关键词决定接不接话，
//    绝大多数普通消息根本不触发唤醒 —— 那是功能，不是故障。只看②的话，这些被安静略过的消息
//    会在 25 秒后被全部强制唤醒：**潜水模式废掉 + 白烧一堆 token**。
//    （实测踩到：2026-09-12 00:14 某群的一条普通消息被误判成"收下没交付"。）
// 另一条判据的取舍：交付 = 模型看到了 → 它选择不回是**有意识的决定**（主人 2026-09-11 选的 B），不该重发；
//    未交付 = 桥这边某条链路静默失败了 → 必须重试。所以这里兜的是**投递**，不是"有没有被回复"。
//
// 触发条件刻意卡得很紧（正常路径下一次都不会触发——投递在 1~3 秒内完成）：
//   ① 会话不在 `activeWaits`（等待工具在跑时，消息随工具结果回去，不需要唤醒）；
//   ② 没有待发合并窗、没有投递在途、没有桥内队列、没有 DSH 断连期间的待补投队列；
//   ③ 该条 seq 既没有被唤醒正文展示过（turnSeenUnread），也没有被 steer 注入过（turnSteeredSeqs）；
//   ④ 已经等了 `overdueMs`（默认 25s）——远大于任何正常路径的投递耗时；
//   ⑤ 同一会话两次兜底至少隔 `minRetryMs`（默认 60s），避免失败时刷屏/刷 token。
const WATCHDOG_DEFAULT_INTERVAL_MS = 20000;
const WATCHDOG_DEFAULT_OVERDUE_MS = 25000;
const WATCHDOG_DEFAULT_MIN_RETRY_MS = 60000;

export function sweepUndelivered(overdueMs = WATCHDOG_DEFAULT_OVERDUE_MS, minRetryMs = WATCHDOG_DEFAULT_MIN_RETRY_MS) {
  const now = Date.now();
  let fired = 0;
  for (const [key, st] of social.conversations) {
    if (!st) continue;
    if (cfgRef?.social?.enabled === false) return fired;
    if (social.paused) return fired;
    if (activeWaits.has(key)) continue;
    if (st.pendingWakeTimer) continue;
    if (pendingWakeKeys.has(key)) continue;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) continue;
    // DSH 不可用期间排进 `queued` 的唤醒会在 DSH 恢复后自动补投，别在这里重复排一次。
    const dshQ = queued.get(key);
    if (Array.isArray(dshQ) && dshQ.length > 0) continue;
    // 【必须有的前提】只兜"桥**打算交付**却没交出去"的消息（见 scheduleWake 里 `_wakeIntendedSeq` 的说明）。
    // 没有意图水位的消息 = 桥根本没打算唤醒它（群聊潜水模式下按概率略过的那些）→ 绝不能兜，
    // 否则等于把潜水模式废掉。
    const intended = Number(st._wakeIntendedSeq) || 0;
    if (intended <= 0) continue;
    const seen = new Set([
      ...(Array.isArray(st.turnSeenUnread) ? st.turnSeenUnread : []),
      ...(Array.isArray(st.turnSteeredSeqs) ? st.turnSteeredSeqs : []),
    ].map(Number));
    const delivered = Number(st.lastDeliveredSeq) || 0;
    const backlog = (Array.isArray(st.unread) ? st.unread : []).filter((m) => {
      const seq = Number(m && m.seq);
      if (!Number.isFinite(seq) || seq <= 0) return false;
      if (seq > intended) return false;      // 桥没打算交付它 → 不是本看门狗的事
      if (seq <= delivered) return false;
      if (seen.has(seq)) return false;
      // 时间戳缺失时保守放行（宁可多兜一次，也不要静默丢掉）
      const t = Number(m && m.time) || 0;
      return !t || now - t > overdueMs;
    });
    if (!backlog.length) continue;
    if (now - (Number(st._watchdogAt) || 0) < minRetryMs) continue;
    st._watchdogAt = now;
    const seqs = backlog.map((m) => Number(m.seq)).slice(-8).join(',');
    log(`[watchdog] ${key} 有 ${backlog.length} 条"已决定交付却没交出去"的消息（超过 ${Math.round(overdueMs / 1000)}s）：seq ${seqs}，已交付水位 ${delivered}/意图水位 ${intended} → 重新排一次唤醒`);
    try { scheduleWake(key, 'deliveryWatchdog'); fired += 1; } catch (error) {
      log(`[watchdog] ${key} 重新排唤醒失败：${error?.message ?? error}`);
    }
  }
  return fired;
}

/** 启动投递看门狗（bridge.js 在社交层初始化后调用一次）。 */
export function startDeliveryWatchdog(intervalMs = WATCHDOG_DEFAULT_INTERVAL_MS) {
  const timer = setInterval(() => {
    try { sweepUndelivered(); } catch (error) {
      log(`[watchdog] 巡检异常：${error?.message ?? error}`);
    }
  }, intervalMs);
  timer.unref?.();
  log(`[watchdog] 投递看门狗已启动：每 ${Math.round(intervalMs / 1000)}s 巡检一次，发现"收下却没交给模型"的消息就重排唤醒`);
  return timer;
}

// 参与度提示行（P4-18 迁入）：近 1 小时发言统计 + 何时该接话/潜水的话术建议
export function formatParticipation(st) {
  if (!st) return '';
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const fiveMin = 5 * 60 * 1000;
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
  const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
  if (!aiCount && !otherCount) return '';
  const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
  const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
  const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
  const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
  const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
  let hint = '';
  if (directUnread > 0) {
    hint = 'Someone addressed you directly - answer first; join other buzz at will.';
  } else if (recentAi2m >= 2) {
    hint = 'You replied several times just now - speak less this round, but do not vanish; join in naturally when worth it.';
  } else if (lastAiGap < 120000) {
    hint = 'You just spoke - listen for a bit first; join when something is catchable, no need to wait for your name.';
  } else if (aiCount >= 5) {
    hint = 'You talked a lot recently - say less this round, but speak up when something really matters.';
  } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
    hint = `Chat is hot (${fiveMinOthers.length} msgs${activeSenders ? `/${activeSenders} people` : ''} in 5 min) - do not follow every line; join the one worth answering, dive if no opening.`;
  } else if (otherCount >= 10 && aiCount === 0) {
    hint = 'Group is busy but nothing is addressed to you - a witty line is fine, or just watch.';
  } else if (otherCount < 3 && aiCount > 0) {
    hint = 'Group is a bit cold - do not carry it alone; throw in a line when you have one.';
  } else if (aiCount <= 1 && otherCount >= 10) {
    hint = 'Briefly join this round instead of diving - pick one point.';
  }
  const burstText = fiveMinOthers.length ? `; ${fiveMinOthers.length} msgs${activeSenders ? `/${activeSenders} people` : ''} in last 5 min` : '';
  return `Participation: you spoke ${aiCount} times, members sent ${otherCount} msgs in the last hour${burstText}. ${hint}`;
}

// 推荐 qq_wait_for_messages 的静默时长（P4-18b 迁入）
// 【2026-09-11 主人质疑"之前不是说这样很慢吗" —— 属实，这里是根源】
// 旧版三个时长是**写死的** 8000 / 12000 / 12000，于是"让模型用等待工具取消息"这条路
// 每个来回都要白等 8~12 秒，正是当初被我判为"比 1 秒合并窗还慢"的原因。
// 现在全部改成可配（`social.wait.defaultQuietMs / unfinishedQuietMs / burstQuietMs`），
// 默认调到 1.5~3 秒：既能合并"连发几条"，又不会让每个来回卡十秒。
export function suggestQuietMs(st) {
  // ⚠️ 别用 `Number(x) || 默认值`：配置里写 0（=不要静默窗）会被 `||` 吃掉、退回默认值 ——
  //    这正是"配置里明明写了 defaultQuietMs: 0，实际还是等 8 秒"的原因（2026-09-11 查出）。
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const defaultMs = num(cfgRef.social?.wait?.defaultQuietMs, 8000);
  const unfinishedMs = num(cfgRef.social?.wait?.unfinishedQuietMs, 12000);
  const burstMs = num(cfgRef.social?.wait?.burstQuietMs, 12000);
  if (!st) return defaultMs;
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const last = [...recent].reverse().find((m) => m && !m.isSelf);
  if (!last) return defaultMs;
  const text = String(last.tail || last.plain || last.text || '').trim();
  if (looksLikeUnfinished(text)) return unfinishedMs;
  const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
  if (burst >= 3) return burstMs;
  return defaultMs;
}

// ── P4-23：唤醒附图/回复检查/收尾提醒 ──────────────────────────────────────

// 收集最近"新鲜"消息里的图片/表情 media，用于唤醒时直接附图（视觉投递，绕过 MCP 压缩层）。
// 新鲜 = 消息还在未读里，或晚于自己最后一次回复/已读水位——已经看过的旧图绝不重复附上，
// 避免"哨兵轮每次都把前面发过的图再带一遍、模型没读新文本就抢先看图回复"。
// 额外水位 _mediaAttachedSeq：记录最近一次已附图的最高消息 seq——若模型附图后没 mark_read/没回复
// （比如判断无需回直接收尾），同批图不会在下一次唤醒里再次附上，杜绝"每轮都带同一张旧图"循环；
// 模型仍可用 qq_get_message_images 主动取图。
export function collectFreshWakeMedia(key, st) {
  if (!st || !Array.isArray(st.recentMessages)) return [];
  const unreadSeqs = new Set((Array.isArray(st.unread) ? st.unread : []).map((m) => m && Number(m.seq)).filter((n) => Number.isFinite(n) && n > 0));
  const lastAiT = Math.max(Number(st.lastAiReplyAt) || 0, Number(st.lastAiSeenAt) || 0);
  const attachedFloor = Number(st._mediaAttachedSeq) || 0;
  const out = [];
  let maxSeqSeen = attachedFloor;
  const start = Math.max(0, st.recentMessages.length - 8);
  for (let i = st.recentMessages.length - 1; i >= start && out.length < MAX_MEDIA_COUNT; i--) {
    const m = st.recentMessages[i];
    if (!m || m.isSelf) continue;
    const seqN = Number(m.seq) || 0;
    if (!(unreadSeqs.has(seqN) || Number(m.time) > lastAiT)) continue;
    if (seqN > 0 && seqN <= attachedFloor) continue; // 已经附图过的消息不再重复附
    if (!Array.isArray(m.media) || m.media.length === 0) continue;
    let added = false;
    for (const md of m.media) {
      if (out.length >= MAX_MEDIA_COUNT) break;
      if (md && typeof md === 'object' && (md.kind === 'image' || md.kind === 'face')) { out.push(md); added = true; }
    }
    if (added && seqN > maxSeqSeen) maxSeqSeen = seqN;
  }
  if (maxSeqSeen > attachedFloor && st._mediaAttachedSeq !== maxSeqSeen) {
    st._mediaAttachedSeq = maxSeqSeen;
    saveSocialState();
  }
  return out;
}

// 回复检查兜底：AI 收尾后延迟检查一次，未收尾则提醒
export function scheduleReplyCheck(key) {
  if (cfgRef.social?.enabled === false) return;
  if (social.paused) return;
  if (inDndWindow()) return; // 免打扰时段不安排回复兜底检查（被@等真实唤醒接管）
  // 私聊不需要「回复检查」——因为私聊**不可能漏回**，这个兜底在这里是纯重复回合：
  //   1) evaluateWakeTrigger() 第一行就是 `if (kind === 'private') return 'private';`
  //      —— 私聊每条消息都无条件唤醒，与 mode/probability/关键词都无关；
  //   2) 会话忙时私聊消息进 pendingWakeReasons 排队、事后「合并补发」，不会被吞；
  //   3) 被唤醒频率限制时私聊会挂 20s 一次性重试，也不会被静默吞掉；
  //   4) 任何一次真实唤醒接管时都会 cancelReplyCheck(key)，把排队的回复检查清掉。
  //   于是私聊里这个定时器只有两种结局：被真实唤醒取消，或到点时「无未读,跳过」。
  // 唯一会真跑起来的场合反而是有害的：正好卡在「主人刚发消息、唤醒还没派发」的窗口里，
  // 抢先占住会话 → 主人的消息被判「会话繁忙」排队几十秒。
  // 群聊不一样：群唤醒是条件式的（关键词/概率/@），普通消息可能永远不触发，那边的兜底要保留。
  // 想恢复旧行为（私聊也检查）就把 config.json 的 social.autoReplyCheckPrivateChats 设为 true。
  if (key.startsWith('private:') && cfgRef.social?.autoReplyCheckPrivateChats !== true) return;
  const st = getSocialState(key);
  // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
  if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
  let delay = Math.max(800, Number(cfgRef.social?.autoReplyCheckMs) || 8000);
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
  const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
  if (askedQuestion) delay = Math.round(delay * 1.5);
  if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
  st.replyCheckTimer = setTimeout(() => {
    st.replyCheckTimer = null;
    // 无未读不空转：上一轮已收尾，无需再兜底唤醒。
    if (Array.isArray(st.unread) && st.unread.length === 0) {
      log(`[replyCheck] 无未读,跳过 ${key}`);
      return;
    }
    // 同一轮对话只兜底检查一次：AI 最后回复后 90s 内已做过 replyCheck 则跳过
    // （轻量字段 _lastReplyCheckAt，不持久化）。
    const lastAi = Number(st.lastAiReplyAt) || 0;
    const lastCheck = Number(st._lastReplyCheckAt) || 0;
    if (lastAi > 0 && lastCheck > lastAi && lastCheck - lastAi <= 90 * 1000) {
      log(`[replyCheck] AI 回复后 90s 内已检查过,跳过 ${key}`);
      return;
    }
    st._lastReplyCheckAt = Date.now();
    void dispatchWake(key, 'replyCheck').catch((error) => log(`[default] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
  }, delay);
  st.replyCheckTimer.unref?.();
  log(`[default] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
}

// 回合收尾提醒 prompt（防"忘记收尾进入永眠"的兜底注入）
// 【2026-09-12】令牌标签改英文括号：[Token]（主人要求）；提示正文里只留"发生了什么 + 动态数值"
// （观察时长），具体该怎么做在系统提示词 [WAKE TYPES] 第 13 条。
export function buildWakeReminderPrompt(key) {
  const roleState = readRoleState();
  const roleLine = roleState.role ? `Role: ${roleState.role} (full persona card: qq_get_prompt)\n\n` : '';
  const st = getSocialState(key);
  const tokenLine = `[Token] ${st.agentToken} (include in every tool call)\n\n`;
  const preSleepMs = Math.max(0, Number(cfgRef.social?.wake?.preSleepWaitMs) || 300000);
  return `${roleLine}${tokenLine}[Reminder] Round not closed: pick the next wake with qq_set_wake_config, or close with qq_mark_read if you saw the messages and decide not to answer. If you mean to dive, observe first via qq_wait_for_messages(timeoutMs=${preSleepMs}), then wind down when nothing needs you.`;
}

// P5-9 追加：default 定时器清理

export function clearSocialTimers(key) {
  const st = social.conversations.get(key);
  if (!st) return;
  if (st.pendingWakeTimer) {
    clearTimeout(st.pendingWakeTimer);
    st.pendingWakeTimer = null;
  }
  st.pendingWakeTimerStartedAt = 0;
  if (st.wakeRetryTimer) {
    clearTimeout(st.wakeRetryTimer);
    st.wakeRetryTimer = null;
  }
  st.pendingWakeReason = null;
  if (st.sleepTimer) {
    clearTimeout(st.sleepTimer);
    st.sleepTimer = null;
  }
  if (st.replyCheckTimer) {
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }
  if (st.proactiveTimer) {
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }
  if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
}

export function clearAllSocialTimers() {
  for (const key of social.conversations.keys()) clearSocialTimers(key);
  pendingWakeKeys.clear();
  wakeConfigUpdatedKeys.clear();
  markReadCalledKeys.clear();
  wakeConfigMissCount.clear();
  messageMediaStore.clear();
}
