// src/core/token-meter.js — token 用量计量模块（学习/用量重构，规格「token 计量(meter)」单钩子版；自包含）
//
// 数据文件：state/token-usage.jsonl，每行一条：
//   {"tsMs":<epoch ms>,"sessionId":"...","convKey":"group:123|..."|null,
//    "prompt":n,"completion":n,"total":n,"est":false,"promptChars":0,"completionChars":0}
//   {"tsMs":...,"sessionId":"...","convKey":...,"prompt":n,"completion":n,"total":n,
//    "est":true,"promptChars":pc,"completionChars":cc}
// est=false = 帧内真实 usage（LLM 上报）；est=true = 无真实 usage 时按帧 transcript 字符估算。
//
// 单钩子用法：集成方（mux）在事件环每帧只调一次 meterTokenFrame(frame)，其余全在本模块内完成：
//   (a) 深度扫描（≤6 层、数组元素>200 跳过）整帧 usage 键（snake/camel 命名 + usage 对象内含键），
//       命中且 sessionId 存在 → 写 est:false 行；
//   (b) 未命中真实 usage 时统计帧携带的文本并暂存进该会话当前回合：
//       - frame.type==='session/queue'（或 event.type 同名）→ 逐 item 取 message.content[] 的 text 块，
//         role user→prompt 侧、assistant/system→completion 侧；
//       - session/event 的 tool/call → frame.event.data.arguments 字符串计入 prompt 侧附加；
//   (c) 回合边界（session/event turn/end）时若该回合未出现过真实 usage → 汇出单条 est:true 行：
//       prompt=round(promptChars/1.8)、completion=round(completionChars/2.2)、
//       total=round(promptChars/1.8+completionChars/2.2)，行内保留原始 chars 便于日后校准。
// convKey 解析顺序：frame.convKey/frame.key → cfg.convKeyResolver(sessionId)（集成方可用 mux reverse 映射）
//   → null；拿不到会话 id 的帧不产生记录。
//
// 导出：
//   initTokenMeter(cfg?)           惰性初始化；cfg.stateDir 覆盖目录（测试用）；cfg.convKeyResolver 设置会话→会话键解析
//   setConvKeyResolver(fn)         单独设置 convKey 解析器（bridge main 里 initTokenMeter(cfg) 后调用，传 reverse.get）
//   meterTokenFrame(frame)         每帧一次 → { recorded, kind:'usage'|'estimate'|'none'|'reset', usage? }
//   meterActivityEstimate(p)       （可选工具，单钩子方案下集成方不需要它）按外部给定 chars 写一条 est:true 行
//   getTokenReport(days?, opts?)   计费日聚合 → { dates, today, todayEstimatedTotal, todayHourly, note }
//
// ── 计费日（day window）口径：默认与提供方控制台一致 ────────────────────────────────
// 提供方（小米 MiMo 开放平台 / Token Plan）用量控制台按 **UTC 自然日** 结算，即北京时每天
// 08:00 换日；本模块原先按北京自然日聚合，于是 00:00-08:00 的用量被算进「今日」，而控制台
// 把它算在昨天 —— 面板数字必然高于控制台。实测（2026-09-12 的 state/token-usage.jsonl）：
//   北京自然日合计 13,809,552；把 00:00-07:59 的 3,426,760 划归前一天后为 10,382,792，
//   与控制台当日 10,383,812 相差 1,020（0.0098%）。
// 因此 days/today/dates 一律按「计费日」= tsMs - dayOffsetMin 所在日期聚合（dayOffsetMin=480
// 即 UTC 日；设 0 退回北京自然日口径）。可用环境变量 QQ_TOKEN_DAY_OFFSET_MIN 覆盖。
// 注意：todayHourly 仍按 **北京自然日** 的分时（GUI 标题写死「今日分时（北京时）」且按 hour
// 绝对值定位，改成计费日会让跨 08:00 的小时序列错位），它与 today 的窗口在 00:00-08:00
// 段不同，属已知差异。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beijingDateKey, bjMinutes } from '../lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = path.resolve(__dirname, '..', '..', 'state'); // qq-bridge/state
const TOKEN_USAGE_FILE = 'token-usage.jsonl';
const MAX_LINES = 50000;      // 行数上限（截旧触发点）
const PRUNE_TO_LINES = 45000; // 截旧后保留行数（留缓冲，避免每写一行都整文件重写）
const MAX_DEPTH = 6;          // usage 递归扫描深度上限
const MAX_ARRAY_ITEMS = 200;  // 超过该元素数的数组整体跳过
const EST_PROMPT_CHARS_PER_TOKEN = 1.8;   // 估算系数（规格给定）
const EST_COMPLETION_CHARS_PER_TOKEN = 2.2;
const ACC_CHARS_CAP = 5000000;            // 单回合暂存字符上限（防异常流撑爆内存，超限先落一条再续）
const ACC_IDLE_FLUSH_MS = 90 * 1000;      // 暂存超过该时长无回合边界 → 主动落一条防丢失
const REAL_SIG_KEEP_MS = 24 * 60 * 60 * 1000; // 真实 usage 签名保留窗口（跨重启去重有效时长）
const REAL_SIG_MAX_PER_SESSION = 64;          // 每会话最多保留的签名条数（防无界增长）

// 计费日偏移（分钟）：480 = UTC 自然日 = 北京时每天 08:00 换日（对齐提供方控制台）。
// 设 0 则退回北京自然日口径；环境变量 QQ_TOKEN_DAY_OFFSET_MIN 可覆盖（便于现场比对/回退）。
const DAY_OFFSET_ENV = 'QQ_TOKEN_DAY_OFFSET_MIN';
const DEFAULT_DAY_OFFSET_MIN = 480;
function normalizeDayOffset(v, fallback = DEFAULT_DAY_OFFSET_MIN) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n >= 1440) return fallback;
  return Math.round(n);
}
const ENV_DAY_OFFSET_MIN = normalizeDayOffset(process.env[DAY_OFFSET_ENV], DEFAULT_DAY_OFFSET_MIN);

// usage 字段名（不同 provider/框架的命名）→ 语义字段
const NAME_LOOKUP = new Map();
for (const [field, names] of Object.entries({
  prompt: ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens'],
  completion: ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens'],
  total: ['total_tokens', 'totalTokens'],
  // 缓存命中（服务端读取的已缓存输入）。DSH 的 TokenUsage 把它与未命中分开上报：
  // inputTokens = 未命中（计费的新鲜输入），cacheReadTokens = 命中。DeepSeek 原生字段是
  // prompt_cache_hit_tokens；OpenAI 兼容层是 prompt_tokens_details.cached_tokens。
  cacheRead: ['cacheReadTokens', 'cache_read_tokens', 'prompt_cache_hit_tokens', 'cachedTokens', 'cached_tokens'],
  // 缓存写入（billed input 的第三项，DSH TokenUsage.cacheWriteTokens）。只认 DSH 原生名，
  // 不映射各家的 *_miss_* 字段（那些语义是「未命中」= inputTokens，映射过来会双计）。
  cacheWrite: ['cacheWriteTokens', 'cache_write_tokens']
})) {
  for (const n of names) NAME_LOOKUP.set(n, field);
}

// 模块状态（日/小时聚合 + 回合暂存 + 文件游标）
const meter = {
  stateDir: DEFAULT_STATE_DIR,
  file: path.join(DEFAULT_STATE_DIR, TOKEN_USAGE_FILE),
  inited: false,
  lineCount: 0,
  convKeyResolver: null,
  dayOffsetMin: ENV_DAY_OFFSET_MIN, // 计费日偏移（分钟）：480=UTC 日，0=北京自然日
  days: new Map(),      // 计费日 'YYYY-MM-DD' -> {prompt,completion,total,estTotal,samples}
  hours: new Map(),     // 今日北京小时 0..23 -> 同上（分时图仍按北京自然日）
  hoursDate: '',
  // 回合估算暂存：sessionId -> {promptChars, completionChars, startedMs}
  turnAcc: new Map(),
  realSeen: new Set(),  // 本回合出现过真实 usage 的 sessionId（抑制回合末估算，防双计）
  lastReal: new Map(),  // 会话 -> 最近已落行的真实 usage 签名 [{ts,sig}]（防多帧/快照回放/重启回放重复计数）
  lastErr: null
};

function emptyAgg() {
  return { prompt: 0, completion: 0, total: 0, estTotal: 0, cacheRead: 0, cacheWrite: 0, cachePrompt: 0, cacheCompletion: 0, cacheSamples: 0, samples: 0 };
}

/** 把一条真实行并入聚合：cacheRead>0 的行单独再记一份「实测子集」，
 *  这样命中率 = cacheRead / (cacheRead + cachePrompt) 只由真正带缓存字段的请求决定，
 *  不会被历史行（无该字段、prompt 全算未命中）稀释——即用户要的「真实值就按真实值算」。
 *  计费输入三项（未命中 prompt / 命中 cacheRead / 写入 cacheWrite）+ 输出 completion 才是
 *  提供方 total_tokens 的口径；cacheWrite 以前完全没被采集，会漏计缓存写入的输入。 */
function addReal(agg, rec) {
  const cr = rec.cacheRead || 0;
  agg.prompt += rec.prompt;
  agg.completion += rec.completion;
  agg.total += rec.total;
  agg.cacheRead += cr;
  agg.cacheWrite += rec.cacheWrite || 0;
  if (cr > 0) {
    agg.cachePrompt += rec.prompt;
    agg.cacheCompletion += rec.completion;
    agg.cacheSamples += 1;
  }
}

function bjKey(tsMs) {
  try { return beijingDateKey(new Date(Number(tsMs))); } catch { return ''; }
}

/** 计费日键：把 tsMs 先减去 dayOffsetMin 再取北京日期。
 *  dayOffsetMin=480（默认）→ 键=该时刻的 **UTC 日期**（= 北京时 08:00 换日），与提供方控制台一致；
 *  dayOffsetMin=0 → 键=北京日期（旧口径）。 */
function billingKey(tsMs, offsetMin = meter.dayOffsetMin) {
  try { return beijingDateKey(new Date(Number(tsMs) - offsetMin * 60000)); } catch { return ''; }
}

function bjHourOf(tsMs) {
  return new Date(Number(tsMs) + 8 * 3600 * 1000).getUTCHours();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** 解析一行记录（非法行返回 null） */
function parseLine(line) {
  if (!line) return null;
  try {
    const rec = JSON.parse(line);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const tsMs = Number(rec.tsMs);
    if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
    return {
      tsMs: Math.round(tsMs),
      sessionId: rec.sessionId != null ? String(rec.sessionId) : null,
      convKey: rec.convKey != null ? String(rec.convKey) : null,
      prompt: num(rec.prompt),
      completion: num(rec.completion),
      total: num(rec.total),
      cacheRead: num(rec.cacheRead),
      cacheWrite: num(rec.cacheWrite),
      est: rec.est === true
    };
  } catch { return null; }
}

/** 真实 usage 签名：同一请求在多帧（usage/step-end/turn-end）与快照回放里数值完全相同。 */
function usageSig(prompt, completion, total) {
  return `${prompt}|${completion}|${total}`;
}

/** 记住一条已落行的真实 usage 签名（按会话，限窗 + 限量，防无界增长）。 */
function rememberReal(sessionId, tsMs, sig) {
  if (!sessionId || !sig) return;
  let arr = meter.lastReal.get(sessionId);
  if (!arr) { arr = []; meter.lastReal.set(sessionId, arr); }
  const cutoff = tsMs - REAL_SIG_KEEP_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  arr.push({ ts: tsMs, sig });
  if (arr.length > REAL_SIG_MAX_PER_SESSION) arr.splice(0, arr.length - REAL_SIG_MAX_PER_SESSION);
}

/** 该会话最近（REAL_SIG_KEEP_MS 内）是否已记过同一签名 → 视为同一请求，不再重复计数。 */
function realSigSeen(sessionId, tsMs, sig) {
  const arr = meter.lastReal.get(sessionId);
  if (!arr || !arr.length) return false;
  const cutoff = tsMs - REAL_SIG_KEEP_MS;
  for (const e of arr) if (e.ts >= cutoff && e.sig === sig) return true;
  return false;
}

/** 把一行聚合进内存（窗口 today-7..today；YYYY-MM-DD 字典序=时间序）
 *  日维度按「计费日」（默认 UTC 日 / 北京 08:00 换日，与提供方控制台一致）；
 *  小时维度仍按北京自然日（GUI 分时图标题即「今日分时（北京时）」，按 hour 绝对定位）。 */
function applyToMemory(rec) {
  const key = billingKey(rec.tsMs);
  if (!key) return;
  const todayKey = billingKey(Date.now());
  if (key < shiftDateKey(todayKey, -7)) return;
  // 真实 usage 签名登记：ensureInit 回填历史行 + 每次落行都登记，使去重在桥重启后依然生效
  // （follow 快照在重启后会整段回放旧事件，仅靠内存 2.5s 窗口会把这批 usage 全部重记一遍）。
  if (!rec.est) rememberReal(rec.sessionId, rec.tsMs, usageSig(rec.prompt, rec.completion, rec.total));
  const agg = meter.days.get(key) ?? emptyAgg();
  agg.samples += 1;
  if (rec.est) agg.estTotal += rec.total;
  else addReal(agg, rec);
  meter.days.set(key, agg);
  const bjK = bjKey(rec.tsMs);
  if (bjK && bjK === bjKey(Date.now())) {
    if (meter.hoursDate !== bjK) { meter.hoursDate = bjK; meter.hours.clear(); }
    const h = bjHourOf(rec.tsMs);
    const ha = meter.hours.get(h) ?? emptyAgg();
    ha.samples += 1;
    if (rec.est) ha.estTotal += rec.total;
    else addReal(ha, rec);
    meter.hours.set(h, ha);
  }
}

/** 'YYYY-MM-DD' + 偏移天数 → 'YYYY-MM-DD'（用北京日正午避免时区边界误差） */
function shiftDateKey(key, deltaDays) {
  const [y, m, d] = key.split('-').map((v) => Number(v));
  if (!y || !m || !d) return key;
  const noonBJTicks = Date.UTC(y, m - 1, d, 4, 0, 0);
  return beijingDateKey(new Date(noonBJTicks + deltaDays * 86400000));
}

function pruneFile() {
  try {
    const text = fs.readFileSync(meter.file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    if (lines.length <= MAX_LINES) return;
    const keep = lines.slice(lines.length - PRUNE_TO_LINES);
    fs.writeFileSync(meter.file, keep.join('\n') + (keep.length ? '\n' : ''));
    meter.lineCount = keep.length;
  } catch (error) { meter.lastErr = error; }
}

function ensureInit() {
  if (meter.inited) return;
  fs.mkdirSync(meter.stateDir, { recursive: true });
  let text = '';
  try { text = fs.readFileSync(meter.file, 'utf8'); } catch { text = ''; }
  let lines = text ? text.split('\n').filter((l) => l.trim() !== '') : [];
  if (lines.length > MAX_LINES) {
    lines = lines.slice(lines.length - MAX_LINES);
    try { fs.writeFileSync(meter.file, lines.join('\n') + (lines.length ? '\n' : '')); } catch (error) { meter.lastErr = error; }
  }
  meter.lineCount = lines.length;
  meter.days.clear();
  meter.hours.clear();
  meter.hoursDate = '';
  meter.lastReal.clear();
  for (const line of lines) {
    const rec = parseLine(line);
    if (rec) applyToMemory(rec);
  }
  meter.inited = true;
}

/**
 * 惰性初始化（幂等可重入，会重读文件）。
 * cfg 可选：{ stateDir, convKeyResolver }；另有独立 setConvKeyResolver() 可随时更换解析器。
 */
export function initTokenMeter(cfg) {
  const opt = cfg && typeof cfg === 'object' ? cfg : {};
  meter.stateDir = String(opt.stateDir || DEFAULT_STATE_DIR);
  meter.file = path.join(meter.stateDir, TOKEN_USAGE_FILE);
  // 计费日偏移：显式 cfg.dayOffsetMinutes 优先，其次环境变量，最后默认 480（UTC 日）
  meter.dayOffsetMin = normalizeDayOffset(opt.dayOffsetMinutes, ENV_DAY_OFFSET_MIN);
  meter.inited = false;
  if (typeof opt.convKeyResolver === 'function') meter.convKeyResolver = opt.convKeyResolver;
  ensureInit();
  return { file: meter.file, inited: true };
}

/** 单独设置 sessionId→convKey 解析器（bridge main：initTokenMeter(cfg) 后 setConvKeyResolver((sid)=>reverse.get(sid)??null)） */
export function setConvKeyResolver(fn) {
  meter.convKeyResolver = typeof fn === 'function' ? fn : null;
}

// ── 落行订阅：给控制台的 SSE（/api/token-stream）用，落一条推一次，免轮询 ──────────
const recordSubscribers = new Set();
/** 订阅「真实用量落行」事件；返回取消订阅函数。订阅者异常不影响计量主流程。 */
export function onTokenRecord(fn) {
  if (typeof fn !== 'function') return () => {};
  recordSubscribers.add(fn);
  return () => recordSubscribers.delete(fn);
}
function notifyRecord(rec) {
  if (!recordSubscribers.size) return;
  for (const fn of recordSubscribers) {
    try { fn(rec); } catch { /* 订阅者异常不影响写入 */ }
  }
}

function writeRecord(rec) {
  ensureInit();
  try {
    fs.appendFileSync(meter.file, JSON.stringify(rec) + '\n');
  } catch (error) {
    meter.lastErr = error;
    return false;
  }
  meter.lineCount += 1;
  applyToMemory(rec);
  if (meter.lineCount > MAX_LINES) pruneFile();
  notifyRecord(rec);
  return true;
}

// ── usage 深度扫描 ────────────────────────────────────────────────────────────
function collectUsageFields(frame) {
  const out = {};
  const walk = (value, depth) => {
    if (depth > MAX_DEPTH) return;
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) return; // 大数组整体跳过
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const k of Object.keys(value)) {
      const v = value[k];
      const vt = typeof v;
      if (vt === 'number') {
        const field = NAME_LOOKUP.get(k);
        if (field && Number.isFinite(v) && v >= 0) out[field] = Math.round(v);
      } else if (vt === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(frame, 0);
  return out;
}

function resolveConvKey(sessionId, frame) {
  if (frame && frame.convKey != null) return String(frame.convKey);
  if (frame && frame.key != null) return String(frame.key);
  if (sessionId && typeof meter.convKeyResolver === 'function') {
    try {
      const k = meter.convKeyResolver(sessionId);
      return k != null ? String(k) : null;
    } catch { return null; }
  }
  return null;
}

// ── transcript 文本统计（无真实 usage 时） ────────────────────────────────────
/** 取一条 message 的 text 段数组（content 可能是 string / [{type:'text',text}...] / {text:...}） */
function textBlocksOf(message) {
  const out = [];
  if (!message || typeof message !== 'object') return out;
  const c = message.content;
  if (typeof c === 'string') { if (c) out.push(c); return out; }
  if (Array.isArray(c)) {
    for (const b of c) {
      if (!b) continue;
      if (typeof b === 'string') { if (b) out.push(b); }
      else if (typeof b === 'object' && typeof b.text === 'string' && b.text) out.push(b.text);
    }
    return out;
  }
  if (c && typeof c === 'object' && typeof c.text === 'string' && c.text) out.push(c.text);
  return out;
}

function roleSide(role) {
  const r = String(role ?? '').toLowerCase();
  if (r === 'user' || r === 'input') return 'prompt';
  if (r === 'assistant' || r === 'system' || r === 'output' || r === 'developer') return 'completion';
  return null; // tool/unknown 不归类（文本通常不可见）
}

/** 从 session/queue 帧收集 items（兼容 items / data.items / data.messages 摆放） */
function queueItemsOf(frame) {
  if (frame && Array.isArray(frame.items) && frame.items.length) return frame.items;
  const d = frame && frame.data && typeof frame.data === 'object' ? frame.data : null;
  if (!d) return null;
  if (Array.isArray(d.items) && d.items.length) return d.items;
  if (Array.isArray(d.messages) && d.messages.length) return d.messages;
  return null;
}

function accFor(sessionId, now) {
  let acc = meter.turnAcc.get(sessionId);
  if (acc && now - acc.startedMs > ACC_IDLE_FLUSH_MS) {
    // 长时间没有回合边界：先把旧暂存落一条，避免丢失
    flushEstimate(sessionId, now);
    acc = null;
  }
  if (!acc) {
    acc = { promptChars: 0, completionChars: 0, startedMs: now };
    meter.turnAcc.set(sessionId, acc);
  }
  return acc;
}

/** 回合末汇出一条 est:true 行（该回合未出现真实 usage 且确有文本）；成功后清暂存 */
function flushEstimate(sessionId, now) {
  const acc = meter.turnAcc.get(sessionId);
  meter.turnAcc.delete(sessionId);
  const real = meter.realSeen.delete(sessionId);
  if (!acc || real) return { recorded: false, reason: real ? 'real-usage-seen' : 'empty' };
  if (acc.promptChars + acc.completionChars <= 0) return { recorded: false, reason: 'empty' };
  const prompt = Math.round(acc.promptChars / EST_PROMPT_CHARS_PER_TOKEN);
  const completion = Math.round(acc.completionChars / EST_COMPLETION_CHARS_PER_TOKEN);
  const total = Math.round(acc.promptChars / EST_PROMPT_CHARS_PER_TOKEN + acc.completionChars / EST_COMPLETION_CHARS_PER_TOKEN);
  const rec = {
    tsMs: Math.round(now),
    sessionId,
    convKey: resolveConvKey(sessionId, null),
    prompt,
    completion,
    total,
    est: true,
    promptChars: Math.round(acc.promptChars),
    completionChars: Math.round(acc.completionChars)
  };
  const ok = writeRecord(rec);
  return ok
    ? { recorded: true, kind: 'estimate', usage: { prompt, completion, total }, est: true }
    : { recorded: false, reason: 'io-error' };
}

/**
 * 单钩子计量：集成方每帧调用一次。
 * 按规格做三件事：真实 usage → est:false 行；无真实时统计帧内文本入回合暂存
 * （session/queue 逐 item 按 role 累加；tool/call 的 data.arguments 计入 prompt 侧）；
 * 回合边界 turn/end 汇出 est:true 行。任何异常不外抛，绝不阻塞事件环。
 */
export function meterTokenFrame(frame) {
  try {
    if (!frame || typeof frame !== 'object') return { recorded: false, reason: 'not-object' };
    const event = frame.event && typeof frame.event === 'object' ? frame.event : null;
    const sessionId = frame.sessionId != null ? String(frame.sessionId)
      : (event && event.sessionId != null ? String(event.sessionId) : null);
    if (!sessionId) return { recorded: false, reason: 'no-sessionId' };
    const now = Date.now();

    // (a) 真实 usage 优先：整帧深扫
    const u = collectUsageFields(frame);
    if (u.completion !== undefined || u.total !== undefined) {
      const prompt = u.prompt !== undefined ? u.prompt : 0;
      const completion = u.completion !== undefined ? u.completion : 0;
      const total = u.total !== undefined ? u.total : prompt + completion;
      const cacheRead = u.cacheRead !== undefined ? u.cacheRead : 0;
      const cacheWrite = u.cacheWrite !== undefined ? u.cacheWrite : 0;
      // 同一请求的 usage 会出现在多个帧（usage/step-end/turn-end 等），且 follow 快照在重连/重启后会整段
      // 回放旧事件：按 (prompt,completion,total) 签名去重（签名集合由文件回填 → 桥重启后仍生效），只落一次。
      const sig = usageSig(prompt, completion, total);
      if (realSigSeen(sessionId, now, sig)) return { recorded: false, kind: 'dedup' };
      const rec = {
        tsMs: now,
        sessionId,
        convKey: resolveConvKey(sessionId, frame),
        prompt,
        completion,
        total,
        cacheRead,
        cacheWrite,
        est: false,
        promptChars: 0,
        completionChars: 0
      };
      meter.realSeen.add(sessionId);       // 本回合已有真实计量，回合末不再出估算行
      meter.turnAcc.delete(sessionId);     // 释放暂存
      const ok = writeRecord(rec);
      return ok ? { recorded: true, kind: 'usage', usage: { prompt, completion, total, cacheRead, cacheWrite } } : { recorded: false, reason: 'io-error' };
    }

    const evType = event ? event.type : null;
    const frameType = String(frame.type || '');

    // 回合开始：复位本会话的估算暂存
    if (evType === 'turn/start') {
      meter.turnAcc.delete(sessionId);
      meter.realSeen.delete(sessionId);
      return { recorded: false, kind: 'reset' };
    }

    // 回合结束：真实 usage 缺席 → 汇出估算行（单钩子，无需集成方在收尾再调第二次）
    if (evType === 'turn/end' || frameType === 'turn/end') {
      return flushEstimate(sessionId, now);
    }

    // (b)+(c) transcript 文本统计入暂存
    let promptChars = 0;
    let completionChars = 0;

    // session/queue 帧：逐 item 取 message.content[] 的 text 块，按 role 累加
    if (frameType === 'session/queue' || evType === 'session/queue') {
      const items = queueItemsOf(frame);
      if (items) {
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const role = item.role != null ? item.role : (item.message && item.message.role);
          const side = roleSide(role);
          const msg = item.message && typeof item.message === 'object' ? item.message : item;
          for (const t of textBlocksOf(msg)) {
            if (side === 'prompt') promptChars += t.length;
            else if (side === 'completion') completionChars += t.length;
          }
        }
      }
    }
    // tool/call：arguments 字符串计入 prompt 侧附加
    if (evType === 'tool/call' && event.data && typeof event.data.arguments === 'string') {
      promptChars += event.data.arguments.length;
    }

    if (promptChars > 0 || completionChars > 0) {
      const acc = accFor(sessionId, now);
      acc.promptChars += promptChars;
      acc.completionChars += completionChars;
      if (acc.promptChars + acc.completionChars >= ACC_CHARS_CAP) {
        // 超上限：先落一条防内存失控（该回合后续文本继续计入新一轮暂存）
        return flushEstimate(sessionId, now);
      }
      return { recorded: false, kind: 'accumulated' };
    }
    return { recorded: false, kind: 'none' };
  } catch (error) {
    meter.lastErr = error;
    return { recorded: false, reason: 'exception' };
  }
}

/**
 * 可选工具（单钩子方案下集成方不需要调用）：按外部给定字符数落一条 est:true 行。
 * 旧接口保留以兼容：至少给 convKey 或 sessionId 之一；chars 缺省 0。
 */
export function meterActivityEstimate(params) {
  const p = params && typeof params === 'object' ? params : {};
  const convKey = p.convKey != null ? String(p.convKey) : null;
  const sessionId = p.sessionId != null ? String(p.sessionId) : null;
  if (!convKey && !sessionId) return { recorded: false, reason: 'no-identity' };
  const promptChars = Math.max(0, Math.round(Number(p.promptChars) || 0));
  const completionChars = Math.max(0, Math.round(Number(p.completionChars) || 0));
  if (!promptChars && !completionChars) return { recorded: false, reason: 'empty' };
  const prompt = Math.round(promptChars / EST_PROMPT_CHARS_PER_TOKEN);
  const completion = Math.round(completionChars / EST_COMPLETION_CHARS_PER_TOKEN);
  const total = Math.round(promptChars / EST_PROMPT_CHARS_PER_TOKEN + completionChars / EST_COMPLETION_CHARS_PER_TOKEN);
  const rec = {
    tsMs: p.tsMs ? Math.round(Number(p.tsMs)) : Date.now(),
    sessionId,
    convKey,
    prompt,
    completion,
    total,
    est: true,
    promptChars,
    completionChars
  };
  const ok = writeRecord(rec);
  return ok ? { recorded: true, usage: { prompt, completion, total }, est: true } : { recorded: false, reason: 'io-error' };
}

function dateKeyList(days, nowTs) {
  const out = [];
  const todayKey = billingKey(nowTs);
  let cursor = shiftDateKey(todayKey, -(days - 1));
  for (let i = 0; i < days; i++) {
    out.push(cursor);
    cursor = shiftDateKey(cursor, 1);
  }
  return out;
}

/**
 * 按「计费日」聚合报告（默认近 7 日；计费日默认 = UTC 自然日 = 北京时 08:00 换日，对齐提供方控制台）：
 *   dates: [{date, prompt, completion, total, estTotal, cacheRead, cacheWrite, ...}]  （est:false 与 est:true 分列）
 *   today: {total, estTotal, prompt, completion, cacheRead, cacheWrite, billedTotal, ...}
 *          billedTotal = 未命中 + 命中 + 缓存写 + 输出（= 提供方 total_tokens 口径，仅真实行）
 *   todayEstimatedTotal: 今日至今(真实+估算)按「计费日已过比例」外推；≤5% 时间直接返回当前值
 *   todayHourly: [{hour, prompt, completion, total, estTotal, cacheRead, cacheWrite, ...}]（**北京自然日** 0..当前时，零填充，GUI 小时图用）
 *   dayWindow: { offsetMinutes, startBjMinutes, key } 说明 today 的口径
 *   note: 说明
 */
export function getTokenReport(days = 7, opts) {
  ensureInit();
  const o = opts && typeof opts === 'object' ? opts : {};
  let n = Math.round(Number(days) || 7);
  if (!Number.isFinite(n)) n = 7;
  n = Math.max(1, Math.min(60, n));
  const nowTs = o.nowMs != null ? Number(o.nowMs) : Date.now();
  const todayKey = billingKey(nowTs);

  const zero = () => ({ prompt: 0, completion: 0, total: 0, estTotal: 0, cacheRead: 0, cacheWrite: 0, cachePrompt: 0, cacheCompletion: 0, cacheSamples: 0, samples: 0 });
  const dates = [];
  for (const key of dateKeyList(n, nowTs)) {
    const agg = meter.days.get(key) ?? zero();
    dates.push({ date: key, prompt: agg.prompt, completion: agg.completion, total: agg.total, estTotal: agg.estTotal, cacheRead: agg.cacheRead, cacheWrite: agg.cacheWrite, cachePrompt: agg.cachePrompt, cacheCompletion: agg.cacheCompletion, cacheSamples: agg.cacheSamples, samples: agg.samples });
  }
  const tAgg = meter.days.get(todayKey) ?? zero();
  const today = {
    total: tAgg.total, estTotal: tAgg.estTotal, prompt: tAgg.prompt, completion: tAgg.completion,
    cacheRead: tAgg.cacheRead, cacheWrite: tAgg.cacheWrite, cachePrompt: tAgg.cachePrompt, cacheCompletion: tAgg.cacheCompletion, cacheSamples: tAgg.cacheSamples, samples: tAgg.samples,
    // 提供方 total_tokens 口径（四项相加），并把估算单独留在 estTotal —— 估算绝不并入计费数
    billedTotal: tAgg.prompt + tAgg.completion + tAgg.cacheRead + tAgg.cacheWrite,
  };

  // 计费日已过比例：计费日从北京时 startBjMinutes 开始（默认 08:00）
  const startBjMinutes = ((meter.dayOffsetMin % 1440) + 1440) % 1440;
  const sinceStart = (((bjMinutes(nowTs) - startBjMinutes) % 1440) + 1440) % 1440;
  const elapsedFraction = Math.max(0, Math.min(1, sinceStart / 1440));
  const base = today.total + today.estTotal;
  const todayEstimatedTotal = elapsedFraction <= 0.05 ? base : Math.round(base / elapsedFraction);

  const nowHour = bjHourOf(nowTs);
  const todayHourly = [];
  for (let h = 0; h <= nowHour; h++) {
    const ha = meter.hours.get(h);
    todayHourly.push(ha
      ? { hour: h, prompt: ha.prompt, completion: ha.completion, total: ha.total, estTotal: ha.estTotal, cacheRead: ha.cacheRead, cacheWrite: ha.cacheWrite, cachePrompt: ha.cachePrompt, cacheCompletion: ha.cacheCompletion, cacheSamples: ha.cacheSamples }
      : { hour: h, prompt: 0, completion: 0, total: 0, estTotal: 0, cacheRead: 0, cacheWrite: 0, cachePrompt: 0, cacheCompletion: 0, cacheSamples: 0 });
  }

  const pad2 = (v) => String(v).padStart(2, '0');
  const dayWindow = {
    offsetMinutes: meter.dayOffsetMin,
    startBjMinutes,
    startBj: `${pad2(Math.floor(startBjMinutes / 60))}:${pad2(startBjMinutes % 60)}`,
    key: todayKey,
  };
  const windowText = `计费日口径：北京时 ${dayWindow.startBj} 换日（对齐提供方控制台${meter.dayOffsetMin === 480 ? '，即 UTC 自然日' : ''}）；分时图仍按北京自然日`;
  const note = base > 0
    ? `${windowText}。${elapsedFraction <= 0.05 ? '今日记录尚少（<5% 时间），暂不外推，直接显示当前值' : '按当前速率外推,仅供参考'}`
    : `${windowText}。今日暂无用量记录（尚未收到 usage 帧或可估算的 transcript）`;

  return { dates, today, todayEstimatedTotal, todayHourly, note, dayWindow };
}

/** 数据文件绝对路径（诊断/展示用） */
export function tokenUsageFile() {
  ensureInit();
  return meter.file;
}
