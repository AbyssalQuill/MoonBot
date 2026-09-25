// src/core/context-savings.js — 「上下文剪枝省了多少」的实测计量（2026-09-19）
//
// 为什么要有这个模块：需求是「永久会话 + 工具历史剪枝到底省了多少 token，用实测数据量化对比」。
// 面板里的用量是实测的（提供方 usage 帧），所以节省量也必须是实测的，不能拿字符数估。
//
// ── 数据从哪来（为什么不走事件流）──────────────────────────────────────────────
// 第一版走桥的 mux 事件流（compaction/prune 帧 + step/start 帧）。真机验证发现不可行：
// 官方 rc.1 没有全局广播，桥是逐会话 open session/follow（见 dsh-client.js 顶部注释），
// 只 follow 自己映射的会话；而且这种"仅日志事件"能不能经 follow 投递没有保证。
// 现在改成读会话日志（DSH 自己落的权威记录）：<dshHome>/sessions/<slug>/<sessionId>/session.jsonl.zstd。
// 每条 compaction/prune 都带 shadowedSeqs + shadowedTokenCount，日志里还完整留着每个 step/start
// （= 一次模型请求）的 seq 与时间 —— 于是两个量都能精确算出来：
//   ① prunedTokens = Σ shadowedTokenCount（被从上下文里剪掉多少 token）
//   ② rereadSaved  = Σ(某条被剪掉的量 × 它之后同会话里还发生过多少次请求)
//      —— 那些请求本来都要把这些内容重读一遍（计费 cacheRead），剪掉就不再付。
//
// ── 工程约束（都是真机踩出来的）───────────────────────────────────────────────
//   · 会话日志是多帧 zstd（一帧一次 append），Node 的 zstdDecompressSync 只解第一帧 → 自己走帧结构拼；
//   · 全量扫一遍很贵（几百 MB），所以按 (mtime, size) 增量：只重读变过的日志，其余用上次的结果；
//   · 结果是从日志重算出来的（幂等、可回填），不是累加器 —— 重复跑不会翻倍；
//   · 每份日志只保留"最近 N 天有活动"的（默认 7 天），老的清出内存也清出状态文件。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { beijingDateKey } from '../lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = path.resolve(__dirname, '..', '..', 'state');
const STATE_FILE = 'context-savings.json';
const DAY_OFFSET_ENV = 'QQ_TOKEN_DAY_OFFSET_MIN';
const DEFAULT_DAY_OFFSET_MIN = 480;
const DEFAULT_WINDOW_DAYS = 7;
/* 状态文件格式版本：统计字段一变就 +1。
 * 缓存按 (mtime,size) 判"文件没变就复用"，不改版本号的话，新加的字段对已缓存的老日志永远是 0
 * —— 真机踩过：加完 retryEvents，扫了 40 份日志全是"复用"，那个字段一直是 0。 */
const STATE_VERSION = 3;
const ZSTD_MAGIC_LE = 0xfd2fb528;

const live = {
  stateDir: DEFAULT_STATE_DIR,
  file: path.join(DEFAULT_STATE_DIR, STATE_FILE),
  dshHome: '',
  dayOffsetMin: DEFAULT_DAY_OFFSET_MIN,
  windowDays: DEFAULT_WINDOW_DAYS,
  files: new Map(),      // logPath -> { mtimeMs, size, days: {dayKey:{prunedTokens,pruneEvents,rereadSaved}}, sessions, prunes, lastAt }
  scanning: null,
  lastScanMs: 0,
  scanTtlMs: 30000,      // 面板轮询很密：30 秒内不重复扫（增量扫描本身很便宜，但别每 10 秒都走一遍目录）
};

function normalizeDayOffset(v, fallback = DEFAULT_DAY_OFFSET_MIN) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1440, Math.max(-1440, Math.round(n)));
}
function billingKey(tsMs) {
  try { return beijingDateKey(new Date(Number(tsMs) - live.dayOffsetMin * 60000)); } catch { return ''; }
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/* ── 多帧 zstd 解码（照抄 DSH 的写入方式：一帧一次 append） ───────────────────── */
function frameEnd(buf, off) {
  let p = off + 4;
  const fhd = buf[p]; p += 1;
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const ck = (fhd >> 2) & 1;
  if (!single) p += 1;
  p += [0, 1, 2, 4][fhd & 3];
  p += (fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]);
  for (;;) {
    const h = buf.readUIntLE(p, 3); p += 3;
    const last = h & 1; const type = (h >> 1) & 3; const size = h >>> 3;
    p += (type === 1) ? 1 : size;
    if (last) break;
    if (p > buf.length) throw new Error('zstd 帧结构解析越界');
  }
  if (ck) p += 4;
  return p;
}
/** 解出整份多帧 jsonl.zstd 的文本 */
export function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  const parts = [];
  let off = 0;
  while (off < buf.length - 3 && buf.readUInt32LE(off) === ZSTD_MAGIC_LE) {
    const end = frameEnd(buf, off);
    parts.push(zlib.zstdDecompressSync(buf.subarray(off, end)));
    off = end;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 一份会话日志 → 按计费日分桶的 {prunedTokens, pruneEvents, rereadSaved}（纯函数，可单测） */
export function summarizeSessionLog(text) {
  const evs = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { evs.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  const steps = evs.filter((e) => e?.type === 'step/start').map((e) => ({ seq: Number(e.seq) || 0, time: Number(e.time) || 0 }));
  const prunes = evs.filter((e) => e?.type === 'compaction/prune');
  /* 2026-09-19 问"永久会话真的没问题吗，对话也会压缩吗"：摘要压缩（把最老一段聊天换成
   * <compacted-summary>）是另一条路径，事件是 compaction/summary（同样带 shadowedTokenCount）——
   * 单独统计出来，面板就能如实说明"聊天被摘要过几次、盖掉了多少 token"。 */
  const summaries = evs.filter((e) => e?.type === 'compaction/summary');
  /* 2026-09-19 拿控制台对数：`llm/retry` = 一次尝试失败后重试：失败的尝试提供方照计费、
   * 但 DSH 不给 usage，所以面板会低这一块（真机：控制台 48,063,224 / 面板 47,919,388，差 143,836，
   * 同一天正好 2 条 llm/retry）。这里从日志里把次数数出来（可回填历史，不依赖"功能上线之后"）。 */
  const retries = evs.filter((e) => e?.type === 'llm/retry');
  const buckets = new Map();
  const bump = (day, field, v) => {
    if (!day) return;
    const b = buckets.get(day) || { prunedTokens: 0, pruneEvents: 0, rereadSaved: 0, summarizedTokens: 0, summaryEvents: 0 };
    b[field] = (b[field] || 0) + v;
    buckets.set(day, b);
  };
  let prunedTotal = 0;
  let summarizedTotal = 0;
  for (const p of prunes) {
    const tokens = num(p?.data?.shadowedTokenCount);
    if (!tokens) continue;
    const seq = Number(p.seq) || 0;
    const time = Number(p.time) || Date.now();
    prunedTotal += tokens;
    bump(billingKey(time), 'prunedTokens', tokens);
    bump(billingKey(time), 'pruneEvents', 1);
    // 之后同会话的每一次请求都少读这么多；按那次请求发生的那天记账
    for (const s of steps) {
      if (s.seq <= seq) continue;
      bump(billingKey(s.time), 'rereadSaved', tokens);
    }
  }
  for (const s of summaries) {
    const tokens = num(s?.data?.shadowedTokenCount);
    const time = Number(s.time) || Date.now();
    if (tokens) summarizedTotal += tokens;
    bump(billingKey(time), 'summaryEvents', 1);
    if (tokens) bump(billingKey(time), 'summarizedTokens', tokens);
  }
  for (const r of retries) {
    bump(billingKey(Number(r.time) || Date.now()), 'retryEvents', 1);
  }
  return { buckets, pruneEvents: prunes.length, prunedTotal, summaryEvents: summaries.length, summarizedTotal, retryEvents: retries.length, steps: steps.length };
}

function listSessionLogs(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.jsonl.zstd') out.push(p);
    }
  };
  walk(root);
  return out;
}

function persist() {
  try {
    fs.mkdirSync(live.stateDir, { recursive: true });
    const payload = {
      version: STATE_VERSION,
      dshHome: live.dshHome,
      at: Date.now(),
      files: Object.fromEntries([...live.files.entries()].map(([k, v]) => [k, {
        mtimeMs: v.mtimeMs, size: v.size,
        days: v.days, pruneEvents: v.pruneEvents,
      }])),
    };
    const tmp = `${live.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, live.file);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

function load() {
  try {
    if (!fs.existsSync(live.file)) return { ok: true, fresh: true };
    const j = JSON.parse(fs.readFileSync(live.file, 'utf8'));
    if (j?.version !== STATE_VERSION) return { ok: true, migrated: true };   // 旧版（累加器）格式：丢弃，等下一次扫描重算
    for (const [k, v] of Object.entries(j?.files ?? {})) {
      live.files.set(k, { mtimeMs: Number(v?.mtimeMs) || 0, size: Number(v?.size) || 0, days: v?.days ?? {}, pruneEvents: num(v?.pruneEvents) });
    }
    return { ok: true, files: live.files.size };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/** 初始化：stateDir（缓存）、dshHome（要扫哪个 DSH）、windowDays（只看最近几天有活动的日志） */
export function initContextSavings(cfg = {}) {
  const opt = cfg && typeof cfg === 'object' ? cfg : {};
  live.stateDir = String(opt.stateDir || DEFAULT_STATE_DIR);
  live.file = path.join(live.stateDir, STATE_FILE);
  /* dshHome：显式传了就按显式值（哪怕是空串 = "这次确实没有 home"），没传才退回上次/环境变量 */
  const explicitHome = Object.prototype.hasOwnProperty.call(opt, 'dshHome');
  live.dshHome = explicitHome ? String(opt.dshHome || '') : String(live.dshHome || process.env.QQB_DSH_HOME || '');
  live.dayOffsetMin = normalizeDayOffset(opt.dayOffsetMinutes ?? process.env[DAY_OFFSET_ENV], DEFAULT_DAY_OFFSET_MIN);
  live.windowDays = Math.max(1, Math.min(90, Number(opt.windowDays) || DEFAULT_WINDOW_DAYS));
  live.files = new Map();
  live.lastScanMs = 0;
  const r = load();
  return { ...r, dshHome: live.dshHome, windowDays: live.windowDays };
}

/** 允许运行期补上 DSH home（桥启动顺序里 cfg 与 home 不一定同时就绪） */
export function setContextSavingsDshHome(home) {
  const h = String(home || '').trim();
  if (h && h !== live.dshHome) { live.dshHome = h; live.files.clear(); live.lastScanMs = 0; }
}

/**
 * 增量扫描：只重读 (mtime,size) 变过的会话日志，其余沿用缓存；结果按计费日重新汇总（幂等）。
 * @returns {Promise<{ok:boolean, scanned:number, reused:number, sessions:number, skipped?:string, error?:string}>}
 */
export async function reconcileContextSavings(opts = {}) {
  const force = opts.force === true;
  const now = Date.now();
  if (!force && now - live.lastScanMs < live.scanTtlMs) return { ok: true, skipped: 'ttl', scanned: 0, reused: live.files.size, sessions: live.files.size };
  if (live.scanning) return live.scanning;
  const task = (async () => {
    const home = live.dshHome;
    if (!home) return { ok: false, skipped: 'no-dsh-home', scanned: 0, reused: 0, sessions: 0 };
    const root = path.join(home, 'sessions');
    if (!fs.existsSync(root)) return { ok: false, skipped: 'no-sessions-dir', scanned: 0, reused: 0, sessions: 0 };
    const cutoff = now - live.windowDays * 24 * 3600 * 1000;
    let scanned = 0;
    let reused = 0;
    const seen = new Set();
    for (const file of listSessionLogs(root)) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      seen.add(file);
      const prev = live.files.get(file);
      /* 增量：文件没变就沿用上次结果。注意这里不看 force —— force 只用来跳过 TTL，
       * 跳过文件缓存会让"面板每次刷新都把所有会话日志重读一遍"。 */
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) { reused += 1; continue; }
      try {
        const sum = summarizeSessionLog(decodeSessionLog(file));
        live.files.set(file, {
          mtimeMs: st.mtimeMs,
          size: st.size,
          days: Object.fromEntries(sum.buckets),
          pruneEvents: sum.pruneEvents,
          summaryEvents: sum.summaryEvents,
        });
        scanned += 1;
      } catch (e) {
        // 读坏一份日志不该让整次扫描失败：保留旧结果，记一行原因
        reuseOrMark(prev, st);
        reused += 1;
        if (typeof opts.log === 'function') opts.log(`会话日志解析失败（沿用上次结果）：${path.basename(path.dirname(file))} ${e?.message ?? e}`);
      }
    }
    // 掉出窗口/已被删掉的日志：从缓存里去掉，避免旧数据一直挂在面板上
    for (const k of [...live.files.keys()]) if (!seen.has(k)) live.files.delete(k);
    live.lastScanMs = Date.now();
    persist();
    return { ok: true, scanned, reused, sessions: live.files.size, windowDays: live.windowDays, home };
  })();
  live.scanning = task;
  try { return await task; } finally { live.scanning = null; }
}
function reuseOrMark(prev, st) {
  // 解析失败：保留旧桶但把 mtime 更新成"已尝试过"，避免每次扫描都重试同一份坏文件
  if (prev) { prev.mtimeMs = st.mtimeMs; prev.size = st.size; }
}

/** 汇总（同步，纯内存）：today + 最近 days 天 + 终身 */
export function getContextSavings(days = 7) {
  const todayKey = billingKey(Date.now());
  const byDay = new Map();
  let lifetime = { prunedTokens: 0, pruneEvents: 0, rereadSaved: 0, summarizedTokens: 0, summaryEvents: 0, retryEvents: 0 };
  for (const rec of live.files.values()) {
    for (const [day, b] of Object.entries(rec.days ?? {})) {
      const cur = byDay.get(day) || { prunedTokens: 0, pruneEvents: 0, rereadSaved: 0, summarizedTokens: 0, summaryEvents: 0, retryEvents: 0 };
      cur.prunedTokens += num(b?.prunedTokens);
      cur.pruneEvents += num(b?.pruneEvents);
      cur.rereadSaved += num(b?.rereadSaved);
      cur.summarizedTokens += num(b?.summarizedTokens);
      cur.summaryEvents += num(b?.summaryEvents);
      cur.retryEvents += num(b?.retryEvents);
      byDay.set(day, cur);
    }
  }
  for (const b of byDay.values()) {
    lifetime.prunedTokens += b.prunedTokens;
    lifetime.pruneEvents += b.pruneEvents;
    lifetime.rereadSaved += b.rereadSaved;
    lifetime.summarizedTokens += b.summarizedTokens;
    lifetime.summaryEvents += b.summaryEvents;
    lifetime.retryEvents += b.retryEvents;
  }
  const today = byDay.get(todayKey) || { prunedTokens: 0, pruneEvents: 0, rereadSaved: 0, summarizedTokens: 0, summaryEvents: 0, retryEvents: 0 };
  const list = [...byDay.entries()]
    .filter(([k]) => k && k !== todayKey)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, Math.max(0, Number(days) - 1))
    .map(([date, v]) => ({ date, ...v }));
  const withPrune = [...live.files.values()].filter((r) => (Number(r.pruneEvents) || 0) > 0).length;
  return {
    today: { ...today },
    days: list,
    lifetime,
    /** 有剪枝记录的会话日志数（含今天） */
    sessions: withPrune,
    scannedFiles: live.files.size,
    windowDays: live.windowDays,
    lastScanMs: live.lastScanMs,
    dayWindow: { offsetMinutes: live.dayOffsetMin, startBjMinutes: ((live.dayOffsetMin % 1440) + 1440) % 1440 },
    note: '实测口径：直接读 DSH 自己落的会话日志（sessions/**/session.jsonl.zstd）。'
      + 'prunedTokens = Σ compaction/prune 的 shadowedTokenCount（被从上下文里剪掉的 token）；'
      + 'rereadSaved = Σ(被剪掉的量 × 它之后同会话里还发生过多少次请求) —— 那些请求本来都要把这些内容重读一遍（计费 cacheRead）。'
      + '从日志重算，幂等；只统计最近 ' + live.windowDays + ' 天有活动的会话。',
  };
}

/** 测试用 */
export function __resetContextSavingsForTest() {
  live.files = new Map();
  live.lastScanMs = 0;
  live.scanning = null;
}
export function __contextSavingsInternals() {
  return { live };
}
