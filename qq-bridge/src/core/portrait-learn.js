// 群友画像学习引擎：把「人格学习」那套触发方式（立即 / 间隔 / 每日定时 / 文本指令）套用到群成员画像上。
//
// 和 persona-learn.js 的唯一区别是目标怎么来：人格学习用 learning-config.json 里手填的
// persona.targetQQ，画像学习从聊天记录里自动筛活跃群成员
// （非自己、有正文、近 N 天发言数 ≥ minMessages、单轮上限 maxTargets）。
//
// 落库复用 persona 的 persistPersonaResult → profiles 表，而「群友画像」页读的就是 profiles，
// 所以学完立刻可见，不需要改动画像页。
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.js';
import { STATE_DIR } from '../lib/paths.js';
import { initMemoryDb } from './memory.js';
import { personaLearnTargets, personaLearnStop, personaLearnStatus } from './persona-learn.js';

export const LEARNING_CONFIG_FILE = path.join(STATE_DIR, 'learning-config.json');

export const PORTRAIT_DEFAULTS = {
  enabled: true,            // 关闭后桥侧拒绝画像学习请求
  minMessages: 10,          // 近窗口内发言数下限（低于此值不编画像，避免瞎猜）
  maxTargets: 20,           // 单轮最多学几个目标（每个目标一次模型会话）
  windowHours: 720,         // 取样窗口（小时），默认 30 天
  autoIntervalEnabled: false,
  autoIntervalHours: 24,
  timeHHMM: '',             // 每日定时（北京时 HH:MM）；空 = 不定时
  lastRunAtMs: 0,
};

const PORTRAIT_TICK_MS = 60 * 1000;
const FAIL_BACKOFF_MS = 30 * 60 * 1000;

let tickTimer = null;
let learnInFlight = false;
let failBackoffUntil = 0;
let lastNightlyAttemptAt = 0;
let lastTargets = [];        // 最近一轮实际学过的 uid（status 只回这些人）

function readLearningConfig() {
  try {
    let text = fs.readFileSync(LEARNING_CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writePortraitFields(patch) {
  const base = readLearningConfig();
  const cur = (base.portrait && typeof base.portrait === 'object' && !Array.isArray(base.portrait)) ? { ...base.portrait } : {};
  const next = { ...base, portrait: { ...cur, ...patch } };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${LEARNING_CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, LEARNING_CONFIG_FILE);
  } catch (error) {
    log('[portrait] 写 learning-config.json 失败:', error?.message ?? error);
  }
  return next.portrait;
}

/** 读画像配置（类型兜底 + 范围夹紧） */
export function resolvePortraitCfg() {
  const p = readLearningConfig().portrait;
  const o = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  const int = (v, d, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: o.enabled !== false,
    minMessages: int(o.minMessages, PORTRAIT_DEFAULTS.minMessages, 1, 5000),
    maxTargets: int(o.maxTargets, PORTRAIT_DEFAULTS.maxTargets, 1, 200),
    windowHours: int(o.windowHours, PORTRAIT_DEFAULTS.windowHours, 1, 8760),
    autoIntervalEnabled: o.autoIntervalEnabled === true,
    autoIntervalHours: int(o.autoIntervalHours, PORTRAIT_DEFAULTS.autoIntervalHours, 1, 720),
    timeHHMM: typeof o.timeHHMM === 'string' ? o.timeHHMM.trim() : '',
    lastRunAtMs: Math.max(0, Number(o.lastRunAtMs) || 0),
  };
}

/** 从聊天记录里筛出符合条件的群成员 uid（按发言数降序） */
export function eligiblePortraitTargets(cfg = resolvePortraitCfg()) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用', targets: [] };
  const since = Date.now() - cfg.windowHours * 3600000;
  try {
    const rows = db.prepare(
      `SELECT sender_uid AS uid, COUNT(*) AS n, MAX(ts_ms) AS last
         FROM chat_messages
        WHERE is_self = 0
          AND sender_uid <> ''
          AND (recalled_at IS NULL OR recalled_at = 0)
          AND ts_ms >= ?
          AND TRIM(COALESCE(content, '')) <> ''
        GROUP BY sender_uid
       HAVING n >= ?
        ORDER BY n DESC
        LIMIT ?`
    ).all(since, cfg.minMessages, cfg.maxTargets);
    return {
      ok: true,
      targets: rows.map((r) => ({ uid: String(r.uid), messages: Number(r.n) || 0, lastMs: Number(r.last) || 0 })),
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), targets: [] };
  }
}

/**
 * 立即学习。uids 为空 → 按配置自动筛目标。
 * 返回 { started, targets, skipped, reason }，非阻塞（目标排队后由 persona 串行链跑）。
 */
export function portraitLearnStart(uids) {
  const cfg = resolvePortraitCfg();
  if (!cfg.enabled) return { started: [], disabled: true, targets: [] };
  if (learnInFlight) return { started: [], busy: true, targets: lastTargets, reason: '上一轮画像学习还在进行中' };

  let list = Array.isArray(uids) ? uids.map((v) => String(v).trim()).filter((v) => /^\d{5,11}$/.test(v)) : [];
  let picked = [];
  if (!list.length) {
    const found = eligiblePortraitTargets(cfg);
    if (!found.ok) return { started: [], error: found.error, targets: [] };
    picked = found.targets;
    list = found.targets.map((t) => t.uid);
  }
  if (!list.length) {
    return { started: [], targets: [], reason: `近 ${Math.round(cfg.windowHours / 24)} 天没有发言数 ≥ ${cfg.minMessages} 的群成员` };
  }
  if (list.length > cfg.maxTargets) list = list.slice(0, cfg.maxTargets);

  lastTargets = [...list];
  learnInFlight = true;
  try {
    // auto:false → 走「手工即时全量」路径：用 windowHours 当取样窗口，且不写 persona.lastRunAtMs
    const res = personaLearnTargets(list, { days: Math.max(1, Math.round(cfg.windowHours / 24)) });
    log(`[portrait] 立即学习已受理 ${res?.started?.length ?? 0} 个目标：${(res?.started ?? []).join('、')}`);
    return { started: res?.started ?? [], targets: picked, disabled: res?.disabled === true };
  } catch (error) {
    return { started: [], error: error?.message ?? String(error), targets: picked };
  } finally {
    // personaLearnTargets 是排队的，这里只是受理完成；真正跑完由 status 反映
    setTimeout(() => { learnInFlight = false; }, 2000);
  }
}

export function portraitLearnStop(uids) {
  try { return personaLearnStop(uids); } catch (error) { return { stopped: [], error: error?.message ?? String(error) }; }
}

export function portraitLearnStatus() {
  const cfg = resolvePortraitCfg();
  let status = [];
  try {
    const r = personaLearnStatus(lastTargets.length ? lastTargets : undefined);
    status = Array.isArray(r?.status) ? r.status : [];
  } catch { /* 忽略 */ }
  return { config: cfg, lastTargets, status, running: learnInFlight };
}

// ── 定时 / 间隔自动触发 ──────────────────────────────────────────────────────
/** 'HH:MM' → 北京时间当天该时刻的 epoch ms；非法返回 null */
function todayTargetMs(hhmm, nowMs = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return null;
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), h, min) - 8 * 3600 * 1000;
}

export function checkPortraitAutoTick() {
  const cfg = resolvePortraitCfg();
  if (!cfg.enabled) return;
  const nowMs = Date.now();
  if (nowMs < failBackoffUntil) return;

  const nightlyAt = todayTargetMs(cfg.timeHHMM, nowMs);
  const dueNightly = nightlyAt !== null && nowMs >= nightlyAt && cfg.lastRunAtMs < nightlyAt;
  const dueInterval = cfg.autoIntervalEnabled && (cfg.lastRunAtMs === 0 || nowMs - cfg.lastRunAtMs >= cfg.autoIntervalHours * 3600000);
  if (!dueNightly && !dueInterval) return;
  if (dueNightly && nowMs - lastNightlyAttemptAt < 5 * 60 * 1000) return; // 定时失败重试节流 5 分钟

  const res = portraitLearnStart();
  if (dueNightly) lastNightlyAttemptAt = nowMs;
  if (!res.started?.length) {
    if (res.error || res.reason) {
      failBackoffUntil = nowMs + FAIL_BACKOFF_MS;
      log(`[portrait] 自动学习未受理（${res.error || res.reason}），${Math.round(FAIL_BACKOFF_MS / 60000)} 分钟后重试`);
    }
    return;
  }
  writePortraitFields({ lastRunAtMs: nowMs });
  failBackoffUntil = 0;
  log(`[portrait] ${dueNightly ? '每日定时' : '间隔'}学习已受理 ${res.started.length} 个目标（窗口 ${Math.round(cfg.windowHours / 24)} 天，阈值 ${cfg.minMessages} 条）`);
}

/** bridge.js 在 setPersonaLearnApi 之后调用；幂等 */
export function initPortraitLearn() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    try { checkPortraitAutoTick(); } catch (error) { log('[portrait] 自动学习检查异常（不影响主流程）:', error?.message ?? error); }
  }, PORTRAIT_TICK_MS);
  if (typeof tickTimer.unref === 'function') tickTimer.unref();
  try { checkPortraitAutoTick(); } catch { /* 忽略 */ }
  log('群友画像学习引擎已就绪（立即 / 间隔 / 每日定时）');
}

/** 用法文案：只列英文规范写法（子命令一律英文，见下面的归一化说明）。 */
function portraitHelpText() {
  return '画像指令：/portrait learn（立即学习群友画像）｜/portrait stop（停止在跑的学习任务）｜/portrait status（查看当前状态）';
}

/** 用户文本指令：只认英文 `/portrait learn|stop|status`（大小写不敏感，连续空白按一个空格归一化）。 */
export async function handlePortraitLearnCommand(text, ctx = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { handled: false };
  /* 归一化：转小写 + 把连续空白压成一个空格，与 /slang 的归一化风格一致（见 slang.js）。
   * 这里不能把空格删掉，否则 `/portrait learn` 会被当成 `/portraitlearn` 这类历史简写而失去区分。
   * 2026-09-24：斜杠指令只支持英文，删掉中文别名与历史简写 ——
   *   ① 中文别名 `画像学习` / `群友画像学习`：直接从正则里去掉，不再有任何分支；
   *   ② 中文子命令 `学习` / `停止` / `状态`：同上，已删除；
   *   ③ `start` 简写（`/portrait start`）：删除，只保留 learn|stop|status 三个规范子命令。
   * 子命令缺失或不是这三个（含中文写法）：只回用法文案，不猜意图、不落到 status。 */
  const low = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/^\/portrait(\s|$)/.test(low)) return { handled: false };
  if (!ctx.isOwner) return { handled: true, reply: ['画像学习只有主人能指挥。'] };
  const act = low.slice('/portrait'.length).trim();

  if (!act || act === 'status') {
    const s = portraitLearnStatus();
    const c = s.config;
    const lines = [
      `群友画像学习：${c.enabled ? '启用' : '停用'}`,
      `自动间隔：${c.autoIntervalEnabled ? `每 ${c.autoIntervalHours} 小时` : '关'}`,
      `每日定时：${c.timeHHMM || '关'}（北京时）`,
      `筛选条件：近 ${Math.round(c.windowHours / 24)} 天发言 ≥ ${c.minMessages} 条，单轮最多 ${c.maxTargets} 人`,
      s.lastTargets.length ? `最近一轮目标 ${s.lastTargets.length} 个：${s.lastTargets.slice(0, 8).join('、')}${s.lastTargets.length > 8 ? '…' : ''}` : '还没有跑过。',
    ];
    return { handled: true, reply: lines };
  }
  if (act === 'stop') {
    const r = portraitLearnStop();
    return { handled: true, reply: [r.stopped?.length ? `已请求停止 ${r.stopped.length} 个目标的画像学习` : '当前没有进行中的画像学习'] };
  }
  // learn [QQ号…]：只认英文子命令 learn（`start` 简写已按 2026-09-24 的决定删除）
  if (act === 'learn' || act.startsWith('learn ')) {
    const explicit = act.slice('learn'.length).split(/[\s,，、]+/).filter((v) => /^\d{5,11}$/.test(v));
    const r = portraitLearnStart(explicit.length ? explicit : undefined);
    if (r.disabled) return { handled: true, reply: ['画像学习已在控制台停用，先打开开关。'] };
    if (r.busy) return { handled: true, reply: ['上一轮画像学习还在进行中，稍等。'] };
    if (!r.started?.length) return { handled: true, reply: [`没跑起来：${r.error || r.reason || '未知原因'}`] };
    return { handled: true, reply: [`已受理画像学习 ${r.started.length} 个目标：${r.started.slice(0, 8).join('、')}${r.started.length > 8 ? '…' : ''}`] };
  }
  // 未知子命令（含中文写法 /portrait 学习、历史简写 /portrait start）：只回用法
  return { handled: true, reply: [portraitHelpText()] };
}
