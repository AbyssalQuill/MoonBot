// DSH 空闲会话自动归档（2026-09-11 新增）
//
// 背景：桥每约 12 轮用户触发对话就轮换一次 DSH 会话，卡死/隔离/复读恢复也会重建会话，
// 于是「QQ 聊天」工作区里的 session-* 目录会持续堆积（DSH Web 侧也会列出一长串旧会话）。
// 本模块定时巡检该工作区，把**已闲置**（不再被任何 QQ 会话引用、也没有在跑回合）的旧会话
// 调 DSH 的 workspace/archiveSession 归档掉，避免堆积。
//
// 安全边界（硬性，不可配）：
//   - 绝不归档 `state.sessions` 里任何当前映射中的会话；
//   - 绝不归档预热待用的 standby 会话（st._standbySessionId）；
//   - 绝不归档当前有回合在跑（TurnStartAt / collectors）或正在执行发送工具链的会话；
//   - 只处理「QQ 聊天」工作区目录（cfg.sessionCwd，缺省 state/agents）下 `session-*` 目录；
//   - 闲置时间不达标（默认 30 分钟）不动。
// 归档是 DSH 侧的隐藏标记，不删数据；需要连同磁盘一起清理时把 pruneDays 设为 >0（默认 0=不清理）。
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.js';
import { STATE_DIR } from '../lib/paths.js';
import { atomicWriteJson, readJsonSafe } from '../lib/json-fs.js';
import { state } from './config.js';
import { social } from './social-state.js';
import { reverse, collectors, TurnStartAt } from './session-state.js';
import { learnerSessions } from './slang.js';

const ARCHIVE_STATE_FILE = path.join(STATE_DIR, 'session-archive.json');

const DEFAULTS = {
  enabled: true,
  intervalMs: 10 * 60 * 1000, // 巡检间隔：10 分钟
  idleMinutes: 30,            // 闲置多久算“用过的旧会话”
  batchMax: 20,               // 单轮最多归档几个，避免一次性打爆 DSH
  pruneDays: 0                // >0：把已归档且超过 N 天没动过的会话目录一起删掉（0 = 只归档不删）
};

let cfgRef = null;
let apiRef = null;
let tickTimer = null;
let running = false;
const archivedLocally = new Set(); // 已归档会话（本地缓存，避免每次都打 DSH）

export function initSessionArchiveCore(cfg) { cfgRef = cfg; }
export function setSessionArchiveApi(api) { apiRef = api; }

/** 合并配置：社交配置里的 sessionArchive 段覆盖默认值。 */
export function sessionArchiveOptions() {
  const raw = cfgRef?.social?.sessionArchive;
  const o = (raw && typeof raw === 'object') ? raw : {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: o.enabled !== false,
    intervalMs: Math.max(60000, num(o.intervalMs, DEFAULTS.intervalMs)),
    idleMinutes: Math.max(0, num(o.idleMinutes, DEFAULTS.idleMinutes)),
    batchMax: Math.max(1, num(o.batchMax, DEFAULTS.batchMax)),
    pruneDays: Math.max(0, num(o.pruneDays, DEFAULTS.pruneDays))
  };
}

/** 「QQ 聊天」工作区目录：会话的业务 cwd（DSH 用它给会话分组）。 */
export function sessionWorkspaceDir() {
  if (cfgRef?.sessionCwd) return String(cfgRef.sessionCwd);
  return path.join(STATE_DIR, 'agents');
}

/** 归一化：只留字母数字并小写。用于把 DSH 的目录 slug 与真实路径对齐。 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 该 sessions 根下是否存在「本桥工作区」对应的 slug 目录（只留字母数字后比较）。 */
function hasWorkspaceSlug(sessionsRoot, wanted = norm(sessionWorkspaceDir())) {
  if (!sessionsRoot || !wanted) return false;
  try {
    for (const e of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (e.isDirectory() && norm(e.name) === wanted) return true;
    }
  } catch { /* 读不到就当没有 */ }
  return false;
}

/**
 * 列出候选 sessions 根目录（去重、只留存在的），按可信度排序。
 *
 * 顺序很关键：**管理器里配置的隔离 home 必须排在 `DSH_HOME` 前面**。
 * 2026-09-11 实测踩坑：本机桌面版 DSH 会把 `DSH_HOME` 设成
 * `%APPDATA%\DeepSeek Harness\dsh-home`，桥进程继承了这个环境变量。
 * 旧实现把 `DSH_HOME` 排在 managers 配置之前 → 归档器一直在看**桌面版**的
 * sessions 目录，真正的隔离实例 home 下 23 个 `session-*` 一个都没归档，
 * 功能整体是空转（表象和「豁免面太大」一样，其实根因完全不同）。
 */
export function dshSessionsCandidates() {
  const out = [];
  const push = (p) => {
    const s = String(p ?? '').trim();
    if (!s || !fs.existsSync(s) || out.includes(s)) return;
    out.push(s);
  };
  const managerDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.qq-bridge-manager');
  // 1) 管理器 config.json 里记录的隔离 home：桥正是跟这个实例说话，最权威
  try {
    const mgrCfg = JSON.parse(fs.readFileSync(path.join(managerDir, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const home = mgrCfg?.instances?.dshIsolated?.isolatedHome;
    if (home) push(path.join(String(home), 'sessions'));
  } catch {}
  // 2) DSH_HOME：可能是桌面版的 home（见上方注释），所以只能当候选，不能当权威
  if (process.env.DSH_HOME) push(path.join(String(process.env.DSH_HOME), 'sessions'));
  // 3) 兜底：管理器目录下形如 dsh-isolated-home* 的目录
  try {
    for (const e of fs.readdirSync(managerDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^dsh-isolated-home/i.test(e.name)) continue;
      push(path.join(managerDir, e.name, 'sessions'));
    }
  } catch {}
  return out;
}

/**
 * 定位 DSH 隔离实例的 sessions 根目录。
 * 优先级：显式配置 → 候选里**确实含本桥工作区 slug** 的那个 → 第一个存在的候选。
 * 「含本桥工作区」这一条让它在 home 挪位置、DSH_HOME 指错时都能自愈，
 * 而不是安静地扫一堆永远匹配不上的目录。
 * 找不到时返回 null（宁可不归档，也不去猜一个可能误伤别的实例的目录）。
 */
export function dshSessionsDir() {
  const explicit = cfgRef?.social?.sessionArchive?.sessionsDir || cfgRef?.social?.sessionArchive?.dshHome;
  if (explicit) {
    const p = String(explicit);
    const cand = /sessions$/i.test(p) ? p : path.join(p, 'sessions');
    if (fs.existsSync(cand)) return cand;
  }
  const candidates = dshSessionsCandidates();
  const wanted = norm(sessionWorkspaceDir());
  for (const root of candidates) {
    if (hasWorkspaceSlug(root, wanted)) return root;
  }
  return candidates[0] ?? null;
}

/**
 * 匹配「QQ 聊天」工作区对应的会话目录集合。
 * DSH 把工作区路径编码成 `--D-MoonBot-resources-...-agents--` 这种 slug，
 * 这里用「只留字母数字」的归一化比较，避免复刻它的编码规则（规则一变就失效）。
 * @param {string} sessionsRoot
 * @param {{all?: boolean}} [opts] all=true 时返回 sessions 下**全部**工作区目录（一次性清理用）
 */
export function workspaceSessionDirs(sessionsRoot, opts = {}) {
  if (!sessionsRoot) return [];
  const wanted = norm(sessionWorkspaceDir());
  const out = [];
  try {
    for (const e of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (!opts.all && (!wanted || norm(e.name) !== wanted)) continue;
      out.push(path.join(sessionsRoot, e.name));
    }
  } catch {}
  return out;
}

export function loadArchivedCache() {
  const data = readJsonSafe(ARCHIVE_STATE_FILE, null);
  archivedLocally.clear();
  for (const id of Array.isArray(data?.archived) ? data.archived : []) {
    if (typeof id === 'string' && id) archivedLocally.add(id);
  }
}

function saveArchivedCache() {
  try {
    atomicWriteJson(ARCHIVE_STATE_FILE, { archived: [...archivedLocally], updatedAt: Date.now() });
  } catch (error) {
    log('[archive] 归档缓存保存失败:', error?.message ?? error);
  }
}

/** 受保护会话集合：当前映射 / 预热待用 / 回合在跑 / 黑话+人格学习会话。 */
export function protectedSessionIds() {
  const set = new Set();
  try {
    for (const sid of Object.values(state?.sessions ?? {})) if (sid) set.add(String(sid));
  } catch {}
  try {
    for (const st of social?.conversations?.values?.() ?? []) {
      if (st && st._standbySessionId) set.add(String(st._standbySessionId));
    }
  } catch {}
  try {
    for (const key of reverse.keys()) if (key) set.add(String(key));
  } catch {}
  for (const sid of collectors.keys()) set.add(String(sid));
  for (const sid of TurnStartAt.keys()) set.add(String(sid));
  // 黑话/人格学习会话不在 state.sessions 里，但被 learnerSessions 持有；
  // 归档它们会打断正在跑的学习回合，必须保护。
  try {
    for (const sid of learnerSessions ?? []) if (sid) set.add(String(sid));
  } catch {}
  // 兜底：从持久化文件里读学习会话 id（进程刚起、learnerSessions 还没装载时）
  for (const file of ['slang-session.json', 'persona-session.json']) {
    try {
      const saved = readJsonSafe(path.join(STATE_DIR, file), null);
      if (saved?.sessionId) set.add(String(saved.sessionId));
    } catch {}
  }
  return set;
}

/**
 * 巡检一次：归档工作区里闲置的 DSH 会话。
 * @param {{force?: boolean, dryRun?: boolean, allWorkspaces?: boolean,
 *          idleMinutes?: number, batchMax?: number}} opts
 *   force        忽略 enabled=false 强制跑
 *   dryRun       只列出待归档，不真的归档
 *   allWorkspaces 扫 sessions 下全部工作区（一次性大扫除用；定时任务不传）
 *   idleMinutes  覆盖配置的闲置阈值（0 = 不看闲置时间）
 *   batchMax     覆盖单轮归档上限
 */
export async function archiveIdleSessions(opts = {}) {
  const o = sessionArchiveOptions();
  if (!o.enabled && !opts.force) return { ok: true, skipped: 'disabled' };
  if (!apiRef) return { ok: false, error: 'DSH client 未就绪' };
  if (running) return { ok: true, skipped: 'busy' };
  running = true;
  const startedAt = Date.now();
  const report = {
    ok: true, sessionsRoot: null, workspaceDirs: [], scanned: 0, candidates: 0,
    archived: [], failed: [], pruned: [], skippedProtected: 0, dryRun: !!opts.dryRun
  };
  try {
    const sessionsRoot = dshSessionsDir();
    report.sessionsRoot = sessionsRoot;
    if (!sessionsRoot) {
      report.ok = false;
      report.error = '未找到 DSH 会话目录（可在 config.json 的 social.sessionArchive.sessionsDir/dshHome 显式指定）';
      return report;
    }
    const dirs = workspaceSessionDirs(sessionsRoot, { all: opts.allWorkspaces === true });
    report.workspaceDirs = dirs;
    report.allWorkspaces = opts.allWorkspaces === true;
    if (!dirs.length) {
      return { ...report, note: `DSH sessions 下找不到「${sessionWorkspaceDir()}」对应的工作区目录，本次跳过` };
    }
    const protectedIds = protectedSessionIds();
    const now = Date.now();
    // idleMinutes / batchMax 可被单次调用覆盖（一次性大扫除时用 0 / 大值），否则用配置值。
    const idleMinutes = Number.isFinite(Number(opts.idleMinutes)) ? Math.max(0, Number(opts.idleMinutes)) : o.idleMinutes;
    const batchMax = Number.isFinite(Number(opts.batchMax)) ? Math.max(1, Number(opts.batchMax)) : o.batchMax;
    report.idleMinutes = idleMinutes;
    const idleMsThreshold = idleMinutes * 60 * 1000;
    const stale = [];
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const sid = e.name;
        if (!/^session-/.test(sid)) continue;
        report.scanned += 1;
        const full = path.join(dir, sid);
        let stat = null;
        try { stat = fs.statSync(full); } catch { continue; }
        if (protectedIds.has(sid)) {
          report.skippedProtected += 1;
          continue;
        }
        const idleMs = now - Number(stat.mtimeMs || 0);
        // 已归档的：只在启用 pruneDays 时判断是否连磁盘一起清掉，否则完全跳过。
        if (archivedLocally.has(sid)) {
          if (o.pruneDays > 0 && idleMs > o.pruneDays * 86400000) stale.push({ sid, full, idleMs });
          continue;
        }
        if (idleMs < idleMsThreshold) continue;
        report.candidates += 1;
        stale.push({ sid, full, idleMs });
      }
    }

    // 最旧的先归档（对应用户感知的“堆积”）
    stale.sort((a, b) => b.idleMs - a.idleMs);
    for (const item of stale) {
      const { sid, full, idleMs } = item;
      const mins = Math.round(idleMs / 60000);
      if (archivedLocally.has(sid)) {
        // 已归档 + 超过保留期 → 清理磁盘（仅在 pruneDays > 0 时才会走到这里）
        if (opts.dryRun) { report.pruned.push(sid); continue; }
        try {
          fs.rmSync(full, { recursive: true, force: true });
          archivedLocally.delete(sid);
          report.pruned.push(sid);
          log(`[archive] 已清理过期会话目录 ${sid}（闲置 ${mins} 分钟，超过保留期 ${o.pruneDays} 天）`);
        } catch (error) {
          report.failed.push({ sessionId: sid, error: String(error?.message ?? error) });
        }
        continue;
      }
      if (report.archived.length + report.failed.length >= batchMax) break;
      if (opts.dryRun) { report.archived.push(sid); continue; }
      try {
        await apiRef.workspace.archiveSession({ sessionId: sid });
        archivedLocally.add(sid);
        report.archived.push(sid);
        log(`[archive] 已归档闲置会话 ${sid}（闲置 ${mins} 分钟）`);
      } catch (error) {
        const msg = String(error?.message ?? error);
        // session.not.found：DSH 侧已经没有这条会话（被删/未加载）——记为已归档，避免每轮重试刷日志。
        if (/not.?found|no such session/i.test(msg)) {
          archivedLocally.add(sid);
          report.archived.push(sid);
          log(`[archive] ${sid} 在 DSH 侧已不存在，标记跳过`);
        } else {
          report.failed.push({ sessionId: sid, error: msg });
          log(`[archive] 归档失败 ${sid}: ${msg}`);
        }
      }
    }
    if (report.archived.length || report.pruned.length) saveArchivedCache();
  } catch (error) {
    report.ok = false;
    report.error = String(error?.message ?? error);
    log('[archive] 巡检异常:', report.error);
  } finally {
    running = false;
    report.elapsedMs = Date.now() - startedAt;
    report.totalArchived = archivedLocally.size;
  }
  if (report.candidates > 0 || report.failed.length) {
    log(`[archive] ${report.dryRun ? '试运行' : '巡检'}完成：扫描 ${report.scanned}，保护 ${report.skippedProtected}，候选 ${report.candidates}，${report.dryRun ? '待归档' : '归档'} ${report.archived.length}，清理 ${report.pruned.length}，失败 ${report.failed.length}（本地已归档 ${archivedLocally.size}）`);
  }
  return report;
}

/** 定时巡检（启动时调用一次，之后每 intervalMs 一次；只在 DSH 就绪时真正执行）。 */
export function startSessionArchiveTicker() {
  if (tickTimer) clearInterval(tickTimer);
  loadArchivedCache();
  const o = sessionArchiveOptions();
  if (!o.enabled) {
    log('[archive] 空闲会话自动归档已关闭（social.sessionArchive.enabled=false）');
    return;
  }
  log(`[archive] 空闲会话自动归档已启用：每 ${Math.round(o.intervalMs / 60000)} 分钟巡检一次，闲置超过 ${o.idleMinutes} 分钟即归档（保留期 ${o.pruneDays > 0 ? o.pruneDays + ' 天' : '不清理'}）`);
  // 启动后延迟 90s 再首次巡检，避开启动瞬间的会话创建/预热。
  const kickoff = setTimeout(() => { void archiveIdleSessions().catch((e) => log('[archive] 首次巡检异常:', e?.message ?? e)); }, 90000);
  kickoff.unref?.();
  tickTimer = setInterval(() => {
    void archiveIdleSessions().catch((e) => log('[archive] 巡检异常:', e?.message ?? e));
  }, o.intervalMs);
  tickTimer.unref?.();
}

export function stopSessionArchiveTicker() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

/** 状态快照（控制台 /api/social/session-archive 用）。 */
export function sessionArchiveStatus() {
  const o = sessionArchiveOptions();
  const sessionsRoot = dshSessionsDir();
  return {
    ...o,
    workspaceDir: sessionWorkspaceDir(),
    sessionsRoot,
    workspaceSessionDirs: sessionsRoot ? workspaceSessionDirs(sessionsRoot) : [],
    archivedLocally: archivedLocally.size,
    running
  };
}
