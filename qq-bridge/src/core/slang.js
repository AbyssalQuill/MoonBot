// 群聊黑话/网络用语学习引擎
// cfg 静态注入（initSlangCore），api 注入（setSlangApi），DSH 可用性读 dsh-session.dshReady。
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';
import { log } from '../lib/log.js';
import { STATE_DIR, SLANG_FILE, SLANG_SESSION_FILE } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { bjMinutes, beijingDateKey, parseClockMin } from '../lib/time.js';
import {
  loadSlang, saveSlang, upsertSlangEntry, buildSlangContext,
  buildExtractionPrompt, buildResearchPrompt, parseExtractionJson, parseResearchJson, SLANG_STATUS,
  buildSlangTaskBrief, buildSlangRunCue, SLANG_BRIEF_VERSION,
} from '../slang-learner.js';
import { dshReady } from './dsh-session.js';

export let slangEntries = loadSlang(SLANG_FILE);
export const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
export const slangExtractionCooldowns = new Map(); // key -> timestamp
export const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
export const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
export const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
export const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
export const learnerCollectors = new Map();  // sessionId -> turn collector
export const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
export const lastSendDedup = new Map();      // key -> {text, at}：最近一次工具发送文本（防循环回复）
export const sendCallTimes = new Map();      // key -> [timestamp]：工具发送调用时间戳（防单回合循环连发）
export let slangLearnerSessionId = null;
/** 本进程内是否已注入过「首轮任务说明」（持久化标记见 SLANG_SESSION_FILE.briefed） */
let slangBriefSent = false;
let slangTaskChain = Promise.resolve();

// 常驻学习会话：turn 结束后不从 learnerSessions 移除，跨 turn 继续被 pumpMux 消费。
// 黑话学习会话天然常驻（slangLearnerSessionId）；人格学习会话由 persona-learn.js 主动登记，
// 否则「首轮任务说明」turn 一结束就被清理，后续真正的学习命令收不到 turn/end → 必然超时。
const persistentLearnerSessions = new Set();
export function markPersistentLearner(sessionId) {
  const id = sessionId ? String(sessionId) : '';
  if (id) persistentLearnerSessions.add(id);
}
export function unmarkPersistentLearner(sessionId) {
  const id = sessionId ? String(sessionId) : '';
  if (id) persistentLearnerSessions.delete(id);
}
export function isPersistentLearner(sessionId) {
  return sessionId === slangLearnerSessionId || persistentLearnerSessions.has(sessionId);
}

/**
 * 判断一个错误是不是「DSH 侧这条学习会话真的没了」（才值得把会话登记丢掉、下轮重建）。
 *
 * 踩过的坑（2026-09-11 实测）：旧写法是 `/会话|session|not found|404/i`，而桥**自己**的等待超时
 * 文案是「等待人格学习会话 turn 超时(300000ms)」——里面带「会话」二字，于是每次超时都被
 * 误判成会话失效 → 删掉 persona-agent.json / slang-session.json 里的登记 → 下轮重建会话、
 * 再吃一次 300s 的说明注入。表现为「学习偶发失败且每次都要重来」，很难查。
 * 现在明确：超时一律不算会话失效；只认真实的 not found / 无效会话。
 */
export function isLearnerSessionGone(message) {
  const msg = String(message ?? '').trim();
  if (!msg) return false;
  if (/超时|timeout|timed\s*out/i.test(msg)) return false;
  return /not[\s._-]*found|no such session|unknown session|invalid session|404|会话(不存在|已失效|无效)/i.test(msg);
}

/** main 侧整体替换（console 批量操作后） */
export function setSlangEntries(next) { slangEntries = next; }
export function setSlangLearnerSessionId(v) { slangLearnerSessionId = v; }

let cfgRef = null;
let apiRef = null;
export function initSlangCore(cfg) { cfgRef = cfg; }
export function setSlangApi(api) { apiRef = api; }

export function saveSlangStore() {
  try { saveSlang(SLANG_FILE, slangEntries); } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
}

export function queueSlangTask(fn) {
  slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
  return slangTaskChain;
}

export async function ensureSlangLearnerSession() {
  if (slangLearnerSessionId) {
    learnerSessions.add(slangLearnerSessionId);
    return slangLearnerSessionId;
  }
  const saved = readJsonSafe(SLANG_SESSION_FILE, null);
  if (saved?.sessionId) {
    slangLearnerSessionId = String(saved.sessionId);
    learnerSessions.add(slangLearnerSessionId);
    return slangLearnerSessionId;
  }
  const dir = path.join(STATE_DIR, 'slang-agent');
  fs.mkdirSync(dir, { recursive: true });
  const wsValue = unwrap(await apiRef.workspace.create({ path: dir }), 'slang workspace.create');
  const workspaceTitle = cfgRef.slang?.workspaceTitle || 'QQ 黑话学习';
  if (wsValue.created && workspaceTitle) {
    try { await apiRef.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
  }
  const params = { workspaceId: wsValue.workspace.workspaceId };
  const preset = cfgRef.slang?.learnerPreset || cfgRef.agentPreset || undefined;
  if (preset) params.agentPreset = preset;
  const value = unwrap(await apiRef.sessions.create(params), 'slang session.create');
  slangLearnerSessionId = value.sessionId;
  learnerSessions.add(slangLearnerSessionId);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId });
  log(`黑话学习会话已创建：${slangLearnerSessionId}`);
  return slangLearnerSessionId;
}

export function invalidateSlangLearnerSession() {
  // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
  // 没有等待/收集中的旧会话才从集合移除。
  slangBriefSent = false;
  const oldId = slangLearnerSessionId;
  slangLearnerSessionId = null;
  if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
    learnerSessions.delete(oldId);
  }
  try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
}

/** 首轮任务说明注入（每个学习会话只一次；持久化标记，DSH 会话重建后自动重注）。
 *  之后每轮只发 buildSlangRunCue 的小提醒，语料由 AI 自己查库。
 *  briefVersion 变了（提示词改写）→ 即使会话文件里已标记 briefed 也重新注入，
 *  否则老会话会一直揣着旧格式的说明，和新提醒的标记/产出约定对不上。 */
export async function ensureSlangBrief(sessionId) {
  if (slangBriefSent) return;
  const saved = readJsonSafe(SLANG_SESSION_FILE, null);
  if (saved?.sessionId === sessionId && saved?.briefed && Number(saved?.briefVersion) === SLANG_BRIEF_VERSION) { slangBriefSent = true; return; }
  const accepted = await apiRef.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: buildSlangTaskBrief() }] });
  if (!accepted?.result?.ok) throw new Error(`首轮任务说明被拒: ${accepted?.result?.error?.message ?? 'unknown'}`);
  await waitLearnerTurn(sessionId).catch((eW) => {
    // 同 persona：不阻塞但留痕（说明 turn 不闭合会让后续提醒一直等不到 turn）
    log(`黑话学习首轮任务说明等待超时（继续发本轮提醒）：${eW?.message ?? eW}`);
  }); // 让说明被读完；其输出忽略
  slangBriefSent = true;
  atomicWriteJson(SLANG_SESSION_FILE, { sessionId, briefed: true, briefVersion: SLANG_BRIEF_VERSION });
  log(`黑话学习首轮任务说明已注入：${sessionId}`);
}

export function waitLearnerTurn(sessionId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const arr = learnerWaiters.get(sessionId) ?? [];
      const idx = arr.findIndex((w) => w.timer === timer);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) learnerWaiters.delete(sessionId);
      reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
    }, timeoutMs);
    const waiter = { resolve, reject, timer };
    const arr = learnerWaiters.get(sessionId) ?? [];
    arr.push(waiter);
    learnerWaiters.set(sessionId, arr);
  });
}

export async function runSlangExtraction(key) {
  if (cfgRef.slang?.enabled === false) return;
  if (!dshReady) return;
  const messages = slangWindows.get(key) ?? [];
  const min = Math.max(1, Number(cfgRef.slang?.extractMinMessages ?? 10));
  if (messages.length < min) return;

  let sessionId;
  try {
    sessionId = await ensureSlangLearnerSession();
  } catch (error) {
    log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
    return;
  }

  try { await ensureSlangBrief(sessionId); } catch (eB) { log(`黑话学习任务说明注入失败 (${key}):`, eB?.message ?? eB); return; }
  const times = messages.map((m) => Number(m.time) || Number(m.tsMs) || 0).filter((n) => n > 0);
  const cueSince = times.length ? Math.min(...times) : Date.now() - 3600 * 1000;
  const promptText = buildSlangRunCue({
    sinceMs: cueSince, untilMs: Date.now(),
    sinceIso: new Date(cueSince).toISOString(), untilIso: new Date().toISOString(),
    convKeys: [key]
  });
  try {
    const accepted = await apiRef.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    if (!accepted.result.ok) {
      log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
      return;
    }
    const output = await waitLearnerTurn(sessionId);
    const items = parseExtractionJson(output);
    if (!items.length) {
      log(`黑话提取：${key} 未发现候选`);
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      return;
    }
    let added = 0;
    let updated = 0;
    const researchCandidates = [];
    const thresholds = Array.isArray(cfgRef.slang?.inferenceThresholds) ? cfgRef.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
    const seenContents = new Set();
    for (const item of items) {
      if (seenContents.has(item.content)) continue;
      seenContents.add(item.content);
      const evidence = item.evidence
        ? [{ key, sender: '', text: String(item.evidence).slice(0, 200), time: 0 }]
        : [];
      const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
      if (result.created) added += 1; else updated += 1;
      if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
        researchCandidates.push(result.entry);
      }
    }
    const win = slangWindows.get(key) ?? [];
    slangWindows.set(key, win.slice(messages.length));
    saveSlangStore();
    log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
    if (researchCandidates.length && cfgRef.slang?.autoResearch !== false) {
      queueSlangTask(() => runSlangResearch(researchCandidates));
    }
  } catch (error) {
    if (isLearnerSessionGone(error?.message ?? error)) {
      invalidateSlangLearnerSession();
    }
    log(`黑话提取失败 (${key}):`, error?.message ?? error);
  }
}

export async function runSlangResearch(candidates) {
  if (slangStopRequested) { // /slang stop 后排队的后续研究任务直接跳过（不清队列，逐个提前退出）
    slangStopRequested = false;
    log('[slang] 研究任务已因停止请求跳过');
    return;
  }
  if (!candidates || !candidates.length) return;
  if (cfgRef.slang?.enabled === false) return;
  if (!dshReady) return;
  // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
  const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
  if (!targets.length) return;
  for (const e of targets) slangResearchingIds.add(e.id);
  let sessionId;
  try {
    sessionId = await ensureSlangLearnerSession();
  } catch (error) {
    for (const e of targets) slangResearchingIds.delete(e.id);
    log('黑话研究会话创建失败:', error?.message ?? error);
    return;
  }
  const promptText = buildResearchPrompt(targets);
  try {
    const accepted = await apiRef.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    if (!accepted.result.ok) {
      log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
      return;
    }
    const output = await waitLearnerTurn(sessionId);
    const results = parseResearchJson(output);
    for (const r of results) {
      const entry = slangEntries.find((e) => e.content === r.content);
      if (!entry) continue;
      // 只有明确确认（confirmed: true）的结果才写入解释字段；
      // 不确定/未确认的结果保留原状，允许后续再次研究。
      if (r.confirmed !== true) {
        log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
        continue;
      }
      if (r.meaning) entry.meaning = r.meaning;
      if (r.usage) entry.usage = r.usage;
      if (r.example) entry.example = r.example;
      if (r.risk) entry.risk = r.risk;
      if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
      // 自动审核：研究会话已明确确认（confirmed:true）且给出含义解释、未标风险（r.risk !== 'high'）的词条
      // 自动进入 confirmed 状态，直接成为 AI 可用的黑话，不再需要管理员逐个批量确认；
      // 拿不准/带风险/纯噪音的仍停留 candidate，留待管理员复核。
      if (cfgRef.slang?.autoConfirm !== false && r.meaning && String(r.risk ?? '').toLowerCase() !== 'high') {
        if (entry.status === SLANG_STATUS.CANDIDATE) {
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.confirmedAt = new Date().toISOString();
          entry.autoConfirmed = true;
          log(`黑话自动审核通过：「${entry.content}」-> confirmed（研究确认，含义：${String(r.meaning).slice(0, 40)}）`);
        }
      }
      entry.lastInferenceCount = entry.count;
      entry.updatedAt = new Date().toISOString();
    }
    saveSlangStore();
    log(`黑话研究：已更新 ${results.length} 条候选解释`);
  } catch (error) {
    if (isLearnerSessionGone(error?.message ?? error)) {
      invalidateSlangLearnerSession();
    }
    log('黑话研究失败:', error?.message ?? error);
  } finally {
    for (const e of targets) slangResearchingIds.delete(e.id);
  }
}

export function maybeQueueSlangExtraction(key) {
  if (cfgRef.slang?.enabled === false) return;
  if (!dshReady) return;
  // 共享配置(learning-config.json)未开启实时窗口提取（liveWindowExtract !== true，读失败按 false）时：
  // feedSlangWindow 只入窗不触发提取，学习统一交给夜间定时 / /slang learn（省额度核心目标）。
  // 旧 cfg.slang.extractMinMessages/extractCooldownMs 等字段仍继续兼容读取。
  const liveCfg = readLearningConfig();
  if (!resolveLiveWindowExtract(liveCfg)) return;
  const cooldown = Number(cfgRef.slang?.extractCooldownMs ?? 300000);
  const last = slangExtractionCooldowns.get(key) ?? 0;
  if (Date.now() - last < cooldown) return;
  const messages = slangWindows.get(key) ?? [];
  const min = Math.max(1, Number(cfgRef.slang?.extractMinMessages ?? 10));
  if (messages.length < min) return;
  slangExtractionCooldowns.set(key, Date.now());
  queueSlangTask(() => runSlangExtraction(key));
}

export function feedSlangWindow(key, sender, plainContent) {
  if (cfgRef.slang?.enabled === false) return;
  if (!key || !plainContent || typeof plainContent !== 'string') return;
  const text = plainContent.trim();
  if (!text || text.startsWith('/')) return;
  if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
  if (!slangWindows.has(key)) slangWindows.set(key, []);
  const win = slangWindows.get(key);
  win.push({ sender: String(sender || '未知'), text: text.slice(0, 200), time: Date.now() });
  if (win.length > 80) win.splice(0, win.length - 80);
  maybeQueueSlangExtraction(key);
}

export function allowSlangSubmit(key) {
  const now = Date.now();
  const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
  const MAX_PER_MINUTE = 2;
  const MAX_PER_HOUR = 10;
  if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
  arr.push(now);
  slangSubmitTimes.set(key, arr);
  return true;
}

export function publicSlangEntry(e) {
  return {
    id: e?.id ?? '',
    content: e?.content ?? '',
    meaning: e?.meaning ?? '',
    usage: e?.usage ?? '',
    example: e?.example ?? '',
    risk: e?.risk ?? '',
    status: e?.status ?? SLANG_STATUS.CANDIDATE,
    source: e?.source ?? 'ai',
    count: Number(e?.count) || 0,
    evidence: Array.isArray(e?.evidence) ? e.evidence.slice(-5) : [],
    updatedAt: e?.updatedAt ?? ''
  };
}

export function confirmedSlangList() {
  const max = Math.max(1, Math.min(30, Number(cfgRef.slang?.injectMax) || 8));
  return slangEntries
    .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, max)
    .map(publicSlangEntry);
}

export function withSlangContext(promptText) {
  const parts = [];
  if (cfgRef.slang?.enabled !== false) {
    const block = buildSlangContext(slangEntries, cfgRef.slang?.injectMax ?? 5);
    if (block) parts.push(block);
  }
  return parts.length ? parts.join('\n\n') + '\n\n' + promptText : promptText;
}

// ────────────────────────────────────────────────────────────────────────────
// 夜间定时批量学习 / /slang learn / /slang stop（M6，按共享规格 learning-spec v1）
// 省额度核心：不再“每个群攒窗口实时唤醒 DSH”，改为每晚北京时一次从 SQLite 拉
// 一整天增量（≤3 块大 prompt 顺序学完），并支持立即学习与停止。
// 运行期配置 state/learning-config.json 每次现读，写回先读后合并（不覆盖 persona 等字段）。
// ────────────────────────────────────────────────────────────────────────────

const LEARNING_CONFIG_FILE = path.join(STATE_DIR, 'learning-config.json');
const NIGHTLY_TICK_MS = 60 * 1000;           // 定时器每分钟校验一次北京时间
const MAX_LEARN_BLOCKS = 3;                  // 整晚最多 3 大块 prompt（1~3 次 learner turn）
const MAX_LEARN_MSGS = 2400;                 // 单轮学习拉取消息总数上限（多群均分 + 群内均匀抽样）
const MAX_BLOCK_MSGS = 800;                  // 单块最多消息数（配合 2400/3 上限）
const LEARN_TURN_TIMEOUT_MS = 5 * 60 * 1000; // 大块 prompt 的 turn 等待放宽到 5 分钟
const NIGHTLY_RETRY_MS = 5 * 60 * 1000;      // 定时失败后的重试节流间隔

let nightlyTimer = null;              // initSlangNightly 注册的北京时定时器
let lastFiredNightlyDate = '';        // 本进程已触发过定时学习的北京日期（当天去重）
let nightlyPendingDay = '';           // 目标分钟错过（进程晚启/DSH 未就绪/忙）时的待补跑日期
let lastNightlyAttemptAt = 0;         // 最近一次真正发起定时学习的时刻（重试节流）
let learnInFlight = false;            // 同一时刻全局只允许一个学习任务在跑
let queuedSlangOps = 0;               // 已排队未开始执行的 learn/research 任务数
let slangStopRequested = false;       // /slang stop：停止请求标志（模块级）

/** 每次现读 state/learning-config.json（fs.readFileSync+JSON.parse，容 BOM）。读失败 {ok:false}。 */
function readLearningConfig() {
  try {
    let text = fs.readFileSync(LEARNING_CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const data = JSON.parse(text);
    return { ok: true, data: data && typeof data === 'object' ? data : {} };
  } catch {
    return { ok: false, data: {} };
  }
}

/** 学习总开关：learning-config.json 的 slang.enabled 优先；文件读失败回退旧 cfg.slang.enabled。 */
function resolveNightlyEnabled(live) {
  if (live.ok) return live.data?.slang?.enabled !== false;
  return cfgRef?.slang?.enabled !== false;
}

/** 实时窗口提取开关：仅当 learning-config slang.liveWindowExtract===true 才开；读失败按 false（停用实时，省额度）。 */
function resolveLiveWindowExtract(live) {
  return live.ok ? live.data?.slang?.liveWindowExtract === true : false;
}

/** 定时时刻：HH:MM → 北京当日分钟；缺省/非法 → 0（00:00）。 */
function resolveNightlyTimeMinute(live) {
  const raw = live.ok ? String(live.data?.slang?.timeHHMM ?? '').trim() : '';
  const min = raw ? parseClockMin(raw) : null;
  return min === null || Number.isNaN(min) ? 0 : min;
}

/** 研究确认开关：learning-config 优先，缺省/读失败回退旧 cfg.slang.autoResearch。 */
function resolveAutoResearch(live) {
  if (live.ok) return live.data?.slang?.autoResearch !== false;
  return cfgRef?.slang?.autoResearch !== false;
}

/** 已学水位 lastLearnAtMs（learning-config slang.lastLearnAtMs，缺省 0）。 */
function resolveLastLearnAtMs(live) {
  return Math.max(0, Number(live.data?.slang?.lastLearnAtMs) || 0);
}

/** 自动间隔时长：取整并夹在 1~720 小时；非法/缺省 → 24。 */
function resolveAutoIntervalHours(live) {
  const n = Number(live.data?.slang?.autoIntervalHours);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(720, Math.max(1, Math.round(n)));
}

/** 今天北京时间 00:00 对应的 epoch ms */
function todayStartBjMs(nowMs = Date.now()) {
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600 * 1000;
}

/** 先读后合并写回 learning-config.json 的 slang 字段（atomicWriteJson；不覆盖 persona 等其它字段）。 */
function writeLearningSlangFields(patch) {
  let data = {};
  try {
    let text = fs.readFileSync(LEARNING_CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch { /* 文件缺失/损坏：按新建处理 */ }
  if (!data || typeof data !== 'object') data = {};
  const slang = data.slang && typeof data.slang === 'object' ? data.slang : {};
  Object.assign(slang, patch);
  data.slang = slang;
  try { atomicWriteJson(LEARNING_CONFIG_FILE, data); } catch (error) { log('[slang] 写回 learning-config.json 失败:', error?.message ?? error); }
}

/** 排队包装：计入“排队中未开始”的学习/研究任务，供 /slang stop 提前取消未开始的排队项。 */
function queueSlangOp(fn) {
  queuedSlangOps += 1;
  return queueSlangTask(async () => {
    try { return await fn(); } finally { queuedSlangOps -= 1; }
  });
}

/** 每分钟校验一次：命中 timeHHMM 且当天未跑（lastLearnAtMs < 今日目标时刻）→ 触发夜间学习。
 *  错过的目标分钟（进程晚启 / DSH 未就绪 / 忙）会记入 nightlyPendingDay 稍后补跑，不静默丢弃。
 *  learning-config slang.autoIntervalEnabled===true 时停用每日定时（二者互斥，间隔模式优先），
 *  改按「距上次成功学习 lastLearnAtMs ≥ autoIntervalHours」触发自动间隔学习。 */
function checkSlangNightlyTick() {
  const live = readLearningConfig();
  if (!resolveNightlyEnabled(live)) { nightlyPendingDay = ''; return; }
  const nowMs = Date.now();
  if (live.ok && live.data?.slang?.autoIntervalEnabled === true) {
    checkSlangAutoIntervalTick(live, nowMs);
    return;
  }
  const today = beijingDateKey(new Date(nowMs));
  const targetMin = resolveNightlyTimeMinute(live);
  const targetInstant = todayStartBjMs(nowMs) + targetMin * 60000;
  // 今天定时内容已被跑过 / 被更晚的 /slang learn 覆盖（lastLearnAtMs ≥ 今日目标时刻）
  const coveredToday = resolveLastLearnAtMs(live) >= targetInstant;
  if (coveredToday) { nightlyPendingDay = ''; return; }
  if (lastFiredNightlyDate === today && nightlyPendingDay !== today) return; // 本进程当天已触发且无补跑
  const atTargetMinute = bjMinutes(nowMs) === targetMin;
  const missedTarget = nowMs >= targetInstant + 60 * 1000; // 今日目标分钟已过（补跑窗口，仅一次）
  if (!atTargetMinute && !missedTarget && nightlyPendingDay !== today) return;
  if (learnInFlight) { nightlyPendingDay = today; return; } // 已有任务在跑：下个 tick 再试
  if (!dshReady) { nightlyPendingDay = today; return; }     // DSH 未就绪：记录待补跑，不静默丢
  if (nowMs - lastNightlyAttemptAt < NIGHTLY_RETRY_MS) return; // 失败重试节流（默认 5 分钟一次），避免每分钟空打
  lastNightlyAttemptAt = nowMs;
  nightlyPendingDay = '';
  lastFiredNightlyDate = today;
  log(`[slang] 触发定时黑话学习（北京时 ${live.ok ? String(live.data?.slang?.timeHHMM ?? '00:00') : '00:00'}）`);
  void runSlangNightlyLearn().then((s) => {
    if (!s || !s.ok) lastFiredNightlyDate = ''; // 运行失败且未打标：允许今天稍后补跑
  }).catch(() => { lastFiredNightlyDate = ''; });
}

/** 自动间隔分支（autoIntervalEnabled===true 时由 checkSlangNightlyTick 转入）：
 *  距上次成功学习（lastLearnAtMs，0=从未学过视为已到期）≥ autoIntervalHours 即跑 runSlangNightlyLearn()；
 *  增量窗口/打标沿用 runSlangNightlyLearn→runSlangLearnFrom 现逻辑（成功写回 lastLearnAtMs）。
 *  不做 DND 判断：slang 学习会话不打扰人，夜间也可学。 */
function checkSlangAutoIntervalTick(live, nowMs) {
  nightlyPendingDay = '';      // 间隔模式与每日补跑互斥：清掉每日态，避免切回定时模式时误触发
  lastFiredNightlyDate = '';
  const hours = resolveAutoIntervalHours(live);
  const marker = resolveLastLearnAtMs(live);
  if (marker > 0 && nowMs - marker < hours * 3600000) return; // 未到下次间隔
  if (learnInFlight) return;                                   // 已有任务在跑：下个 tick 再试
  if (!dshReady) return;                                       // DSH 未就绪：等就绪后下个 tick 再试
  if (nowMs - lastNightlyAttemptAt < NIGHTLY_RETRY_MS) return; // 失败重试节流（默认 5 分钟一次）
  lastNightlyAttemptAt = nowMs;
  const gapH = Math.max(0, Math.round((nowMs - marker) / 3600000));
  log(`[slang] 自动间隔学习触发(每${hours}h，距上次 ${gapH}h)`);
  void runSlangNightlyLearn().then((s) => {
    if (s && s.ok) log(`[slang] 自动间隔学习完成(每${hours}h)`);
    // 失败/被停：lastLearnAtMs 未前进，受 NIGHTLY_RETRY_MS 节流后下个 tick 重试
  }).catch(() => {});
}

/** A. 启动夜间定时（bridge.js main() 在 setSlangApi 之后调用）。内部每分钟校验北京时；
 *  错误只记日志，不影响主流程。幂等：重复调用只保留一个定时器。 */
export function initSlangNightly(cfg) {
  if (cfg) cfgRef = cfg;
  if (nightlyTimer) return;
  nightlyTimer = setInterval(() => {
    try { checkSlangNightlyTick(); } catch (error) { log('[slang] 夜间定时检查异常（不影响主流程）:', error?.message ?? error); }
  }, NIGHTLY_TICK_MS);
  try { checkSlangNightlyTick(); } catch (error) { log('[slang] 夜间定时初检异常（不影响主流程）:', error?.message ?? error); }
}

/** 空摘要（各入口统一返回形状）。 */
function emptyLearnSummary(mode, reason = '') {
  return { ok: false, mode, reason, stopped: false, blocks: 0, added: 0, updated: 0, candidates: 0, msgs: 0 };
}

/** B. 夜间定时学习入口：读取 learning-config 水位后走串行链跑核心（整晚 1 次，内部 ≤3 块大 prompt）。 */
export function runSlangNightlyLearn() {
  const live = readLearningConfig();
  if (!resolveNightlyEnabled(live)) return Promise.resolve({ ...emptyLearnSummary('nightly'), reason: 'disabled' });
  const marker = resolveLastLearnAtMs(live);
  const sinceTsMs = marker > 0 ? marker + 1 : todayStartBjMs(); // 无标记 → 今天北京 0 点起
  return queueSlangOp(() => runSlangLearnFrom(sinceTsMs, 'nightly'));
}

/** C. /slang learn / console 按钮用：忽略定时直接按“lastLearnAtMs 或当天 0 点”增量学习（走串行链），成功即打标。
 *  force=true 时即使 learning-config slang.enabled=false 也强制执行（主人强推）。 */
export function slangLearnNow(force = false) {
  const live = readLearningConfig();
  if (!resolveNightlyEnabled(live) && !force) return Promise.resolve({ ...emptyLearnSummary('manual'), reason: 'disabled' });
  const marker = resolveLastLearnAtMs(live);
  const sinceTsMs = marker > 0 ? marker + 1 : todayStartBjMs();
  return queueSlangOp(() => runSlangLearnFrom(sinceTsMs, 'manual'));
}

/** D. /slang stop：请求停止进行中/排队中的学习与后续研究；进行中的任务在下一个分块前退出并保存已学部分。 */
export function slangStopNow() {
  const cancels = learnInFlight || queuedSlangOps > 0;
  if (cancels) {
    slangStopRequested = true;
    log('[slang] 收到 /slang stop 停止请求');
  }
  return { stopped: true, cancelled: cancels };
}

/**
 * 核心批量学习（B/C 共用，参数带 sinceTsMs；必须在 queueSlangTask 串行链内执行）：
 * 1) 新架构：桥不再拉群消息；每次触发只确保「首轮任务说明」已注入，然后发一句本轮提醒，
 *    由学习会话自行调用 qq_learning_corpus（读 SQLite chat_messages）拉取 (since, now] 语料并统一分析
 * 2) 切成 ≤MAX_LEARN_BLOCKS 块大 prompt，每块复用同一 learner 会话
 *    ensureSlangLearnerSession → prompt(queue) → waitLearnerTurn → parseExtractionJson → upsert；
 * 3) 结束 saveSlangStore()，候选按 autoResearch 全部一批排队研究；
 * 4) lastLearnAtMs 原子写回：正常=本次起点 now；被 stop/出错=已学到的最大 ts_ms（未学部分下次继续）。
 */
async function runSlangLearnFrom(sinceTsMs, mode) {
  if (!dshReady) return { ...emptyLearnSummary(mode), reason: 'dsh-unready' };
  if (slangStopRequested) { // 排队期间收到 /slang stop → 直接取消本任务（不打标）
    slangStopRequested = false;
    log('[slang] 学习任务开始前收到停止请求，已取消');
    return { ok: true, stopped: true, reason: 'stopped', mode, blocks: 0, added: 0, updated: 0, candidates: 0, msgs: 0 };
  }
  if (learnInFlight) return { ...emptyLearnSummary(mode), reason: 'busy' };
  learnInFlight = true;
  const runStartMs = Date.now();
  const stats = { ok: false, mode, reason: '', stopped: false, blocks: 0, added: 0, updated: 0, candidates: 0, msgs: 0 };
  const researchCandidates = [];
  let progressed = false;    // 是否至少完整学完一个分块
  let processedUpToMs = 0;   // 已学完消息的最大 ts_ms（stop/出错时据此打标，避免下次漏学）
  try {
    const toTsMs = Math.max(sinceTsMs, runStartMs);
    // 群范围：cfg.allow.groups（排除 deny.groups）；白名单为空=全部群聊
    const allowGroups = Array.isArray(cfgRef?.allow?.groups) ? cfgRef.allow.groups.map(String) : [];
    const denyGroups = new Set((Array.isArray(cfgRef?.deny?.groups) ? cfgRef.deny.groups : []).map(String));
    const convKeys = allowGroups.filter((g) => /^\d+$/.test(g) && !denyGroups.has(g)).map((g) => `group:${g}`);
    if (slangStopRequested) { stats.stopped = true; return stats; }
    // 新架构：桥不再拉消息/灌对话；只保证「首轮任务说明」已注入，然后发一句本轮提醒，
    // 由学习会话自己调用 qq_learning_corpus 查 SQLite 聊天库做统一分析。
    const sessionId = await ensureSlangLearnerSession();
    await ensureSlangBrief(sessionId);
    const cue = buildSlangRunCue({
      sinceMs: sinceTsMs, untilMs: toTsMs,
      sinceIso: new Date(sinceTsMs).toISOString(), untilIso: new Date(toTsMs).toISOString(),
      convKeys
    });
    log(`[slang] ${mode === 'nightly' ? '夜间学习' : '立即学习'}：本轮提醒已发出，语料由学习会话自查库（区间 ${sinceTsMs}~${toTsMs}${convKeys.length ? `，限定 ${convKeys.length} 群` : ''}）`);
    const okBlock = await runLearnExtractionBlock(sessionId, cue, stats, researchCandidates, mode);
    if (okBlock) { progressed = true; processedUpToMs = toTsMs; }
    saveSlangStore();
    stats.candidates = researchCandidates.length;
    if (researchCandidates.length && !stats.stopped && resolveAutoResearch(readLearningConfig())) {
      const targets = researchCandidates.filter((e) => e && !slangResearchingIds.has(e.id));
      if (targets.length) queueSlangOp(() => runSlangResearch(targets)); // 全部候选一批研究（串行链后执行）
    }
    // 打标：正常跑完（含 0 条）→ runStart；被 stop / 中途出错 → 已学到的最新 ts_ms
    let markerTs = null;
    if (stats.stopped || stats.reason) {
      if (progressed) markerTs = processedUpToMs;
    } else {
      markerTs = runStartMs;
    }
    if (markerTs !== null) writeLearningSlangFields({ lastLearnAtMs: markerTs });
    stats.ok = true;
    log(`[slang] ${mode === 'nightly' ? '夜间学习' : '立即学习'}完成：${stats.blocks} 块 / 新增 ${stats.added} / 更新 ${stats.updated} / 候选 ${stats.candidates}${stats.stopped ? '（已按停止请求提前结束）' : ''}`);
    return stats;
  } catch (error) {
    if (isLearnerSessionGone(error?.message ?? error)) invalidateSlangLearnerSession();
    stats.reason = String(error?.message ?? error);
    log(`[slang] ${mode} 学习异常:`, error?.message ?? error);
    return stats;
  } finally {
    learnInFlight = false;
    slangStopRequested = false;
  }
}

/** 把消息切成 ≤ MAX_LEARN_BLOCKS 块大 prompt：总量大时按条数均分，小量一次成块。 */
function packLearnBlocks(messages) {
  const total = messages.length;
  if (!total) return [];
  const perBlock = total > MAX_BLOCK_MSGS
    ? Math.min(MAX_BLOCK_MSGS, Math.ceil(total / MAX_LEARN_BLOCKS))
    : total;
  const blocks = [];
  for (let i = 0; i < total; i += perBlock) blocks.push(messages.slice(i, i + perBlock));
  return blocks;
}

/** 单轮提取（新架构：只发「本轮提醒」，语料由学习会话自己用 qq_learning_corpus 查库）。 */
async function runLearnExtractionBlock(sessionId, promptText, stats, researchCandidates, mode) {
  try {
    const accepted = await apiRef.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    if (!accepted?.result?.ok) {
      stats.reason = `prompt-rejected:${accepted?.result?.error?.code ?? '?'}:${accepted?.result?.error?.message ?? ''}`;
      log(`[slang] ${mode} 提取被拒: ${accepted?.result?.error?.code}: ${accepted?.result?.error?.message}`);
      return false;
    }
    const output = await waitLearnerTurn(sessionId, LEARN_TURN_TIMEOUT_MS);
    const items = parseExtractionJson(output);
    stats.blocks += 1;
    if (!items.length) {
      log(`[slang] ${mode} 第 ${stats.blocks} 块未发现候选`);
      return true;
    }
    const thresholds = Array.isArray(cfgRef?.slang?.inferenceThresholds) ? cfgRef.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
    const seen = new Set();
    for (const item of items) {
      if (!item || seen.has(item.content)) continue;
      seen.add(item.content);
      const evidence = item.evidence
        ? [{ key: '', sender: '', text: String(item.evidence).slice(0, 200), time: 0 }]
        : [];
      const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
      if (result.created) stats.added += 1; else stats.updated += 1;
      if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
        researchCandidates.push(result.entry);
      }
    }
    return true;
  } catch (error) {
    if (isLearnerSessionGone(error?.message ?? error)) invalidateSlangLearnerSession();
    stats.reason = String(error?.message ?? error);
    log(`[slang] ${mode} 分块提取失败:`, error?.message ?? error);
    return false;
  }
}

function slangHelpText() {
  // 【2026-09-12】主人要求中文子命令带空格显示（/slang 学习、/slang 停止）；
  // 解析侧一直是"先去掉所有空白再比对"，所以带不带空格都认，这里只是让人看着一致。
  return '黑话指令：/slang 学习（立即增量学习，也认 /slang learn）｜/slang 停止（停止在跑的学习/研究任务，也认 /slang stop）';
}

/** E. /slang 指令分发：只处理 owner 且 kind 为 group/private；reply 数组元素由集成方分条发送。
 *  非 owner 的 /slang* 一律拦截（不交给 AI）；其余文本返回 handled:false。 */
export async function handleSlangSlashCommand(text, ctx = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { handled: false };
  // 去掉所有空白后再比对：`/slang 学习`、`/slang学习`、`/slang learn`、`/SLANG Learn` 都是同一条指令
  const low = raw.toLowerCase().replace(/\s+/g, '');
  if (!low.startsWith('/slang')) return { handled: false };
  if (!ctx.isOwner) return { handled: true, reply: ['仅主人可操作'] };
  const kind = ctx.kind;
  if (kind !== 'group' && kind !== 'private') return { handled: true, reply: [slangHelpText()] };
  if (low === '/slanglearn' || low === '/slang学习') {
    if (learnInFlight) return { handled: true, reply: ['已有黑话学习任务在跑，请稍候或先 /slang 停止'] };
    const summary = await slangLearnNow(false);
    if (!summary || summary.ok !== true) {
      const reason = summary?.reason === 'disabled' ? '黑话学习未开启（learning-config slang.enabled=false）'
        : summary?.reason === 'dsh-unready' ? 'DSH 尚未就绪，稍后再试'
        : summary?.reason === 'busy' ? '已有学习任务在跑'
        : summary?.stopped ? '学习已停止'
        : `学习未完成（${summary?.reason ?? '未知原因'}）`;
      return { handled: true, reply: [reason] };
    }
    const r = summary;
    return { handled: true, reply: [`已立即学习黑话：新增${r.added ?? 0} 更新${r.updated ?? 0} 候选${r.candidates ?? 0}${r.stopped ? '（已停止）' : ''}`] };
  }
  if (low === '/slangstop' || low === '/slang停止') {
    const r = slangStopNow();
    return { handled: true, reply: ['已停止当前黑话学习/研究任务' + (r.cancelled ? '' : '（当前没有在跑的任务）')] };
  }
  return { handled: true, reply: [slangHelpText()] };
}
