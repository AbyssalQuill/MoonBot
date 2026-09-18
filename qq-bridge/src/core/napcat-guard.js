// NapCat 会话守护：主动探活 + 会话假死自愈。
//
// 【为什么需要它｜2026-09-16 亲历】
// QQ 客户端会出现"静默死"：客户端自己仍然认为在线（NapCat 日志里一条错误都没有、
// WebUI 的 isLogin/online 也还是 true），但发消息被 QQ 内核拒绝
// （EventChecker Failed: NodeIKernelMsgService/sendMsg / {"result":1006514,"errMsg":"网络连接异常!"}），
// 收消息也一起停。当天 16:33 发生后一直没人知道，直到 17:22 才发现 —— **静默 50 分钟**。
// 真正的原因在腾讯服务端：它把这次登录态作废了（近 72 小时 10 次），客户端没收到任何通知。
//
// 【做法】
//   1) 探针：定期调 NapCat 的 get_rkey。它每次都真的请求 QQ 服务器（实测两次返回的 rkey
//      不同），失败就说明"会话/网络这条路不通了"；而且对别人完全不可见——不像"发条消息试试"
//      那样会打扰群里任何人。
//   2) 判定：连续 failThreshold 次（默认 2 次 ≈ 2 分钟）失败 = 会话已死。
//   3) 自愈：docker restart 容器。容器里若配了 NAPCAT_QUICK_PASSWORD(_MD5)（免扫码回退登录），
//      起来后会自动用密码登回来（实测 17:49 那次："密码回退登录成功"，全程不需要扫码）。
//      未配置回退登录时**默认不自动重启**：那种情况下重启可能会把它推到"必须扫码"的状态，
//      宁可只报警不出手（可用 autoHeal 显式打开）。
//   4) 兜底：自愈后仍探不通 → 导出最新二维码到 state/napcat-qr.png 并写 alert，管理端显示红条。
//   5) 安全阀：自愈冷却（默认 10 分钟）、每小时上限（默认 3 次），避免疯狂重启打转。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { backupLoginTickets, napcatConfigDir, probeQqLoginState } from './napcat-tokens.js';

const GUARD_FILE = path.join(STATE_DIR, 'napcat-guard.json');
const QR_FILE = path.join(STATE_DIR, 'napcat-qr.png');
const SPEC_DIR = path.join(STATE_DIR, 'napcat-container-spec');

const DEFAULTS = {
  enabled: true,
  probeIntervalMs: 60000,
  failThreshold: 2,
  cooldownMs: 600000,
  maxHealsPerHour: 3,
  restartGraceSec: 60,
  recoverWaitMs: 150000,
  autoHeal: null // null = 自动（配了免扫码回退登录才默认开启）
};

let cfgRef = null;
let timer = null;
let ticking = false;
let callAction = null;

export function initNapcatGuard(cfg, opts = {}) {
  cfgRef = cfg;
  if (typeof opts.callAction === 'function') callAction = opts.callAction;
}

function nap() { return cfgRef?.napcat ?? {}; }
function guardCfg() { return { ...DEFAULTS, ...(cfgRef?.guard ?? {}) }; }
function containerName() { return String(nap().containerName ?? '').trim() || 'napcat'; }
function nowIso() { return new Date().toISOString(); }

function readState() {
  const s = readJsonSafe(GUARD_FILE, null);
  return {
    lastProbeAt: 0,
    lastProbeOk: false,
    lastProbeDetail: '',
    consecutiveFails: 0,
    heals: [],
    lastHealAt: 0,
    lastHealResult: '',
    alert: null,
    autoHealOverride: null,
    ...(s && typeof s === 'object' ? s : {})
  };
}
function writeState(s) {
  try { atomicWriteJson(GUARD_FILE, s); } catch (error) { log(`[napcat-guard] 状态写盘失败（忽略）: ${error?.message ?? error}`); }
}

/** 把当前二维码抓一份出来给管理端看/下载（人不在服务器边上时，这是唯一的救命路径）。 */
export async function qrSnapshot() {
  const p = await exportQrFresh();
  if (!p) return { ok: false, error: '容器里暂时没有二维码（没在等登录，或 docker cp 失败）' };
  try {
    const buf = fs.readFileSync(p);
    return { ok: true, path: p, bytes: buf.length, dataUrl: `data:image/png;base64,${buf.toString('base64')}` };
  } catch (error) {
    return { ok: false, error: `读取二维码失败：${error?.message ?? error}` };
  }
}

/** 容器里有没有配"免扫码回退登录"（NAPCAT_QUICK_PASSWORD / NAPCAT_QUICK_PASSWORD_MD5）。不回传值本身。 */
export function passwordFallbackInfo() {
  const r = spawnSync('docker', ['inspect', containerName(), '--format', '{{json .Config.Env}}'], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return { configured: false, source: 'none', error: 'docker inspect 失败（容器不存在或没权限）' };
  let env = [];
  try { env = JSON.parse(String(r.stdout).trim()); } catch { env = []; }
  const hit = env.find((e) => /^NAPCAT_QUICK_PASSWORD(_MD5)?=/.test(String(e)) && String(e).split('=')[1]);
  return hit ? { configured: true, source: 'env' } : { configured: false, source: 'none' };
}

function containerInfo() {
  const r = spawnSync('docker', ['inspect', containerName(), '--format', '{{.State.Status}}|{{.State.StartedAt}}'], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return { name: containerName(), status: 'unknown', startedAt: '' };
  const [status, startedAt] = String(r.stdout).trim().split('|');
  return { name: containerName(), status: status || 'unknown', startedAt: startedAt || '' };
}

/* 【2026-09-19 修「napcat.log 被同一条堆栈刷满」】
 * 上一版加了 `get_status` 回退，误重启是没了，但**每轮探活仍然先调一次 `get_rkey`** ——
 * 而这台机器上它是**结构性故障**（NapCat 侧取 rkey 的实现直接抛，不是网络问题、也不代表掉线），
 * 于是每 60 秒就往 NapCat 自己的日志里灌一段
 *   `TypeError: Cannot read properties of undefined (reading 'rkeyList')` + 4 行栈。
 * 主人桌面那份 napcat.log 496 行里几乎全是它 —— 真正的故障反而被淹没。
 *
 * 所以：**一旦确认它是结构性故障，就不再调用它**（省掉一次白跑 QQ 服务的往返，也不再刷日志），
 * 只走 `get_status`。同时留一个低频重试窗口（每 RKEY_RETRY_EVERY 个周期放行一次）——
 * 万一哪天 NapCat 升级把它修好了，我们能自动捡回来，而不是永久把这个信号丢掉。 */
let rkeyProbeDead = false;
let rkeyProbeCycles = 0;
const RKEY_RETRY_EVERY = 30;
/** 固定改用 get_status 之后，传给 probeStatusFallback 的"前因"只用于**兜底也探不通**时的 detail
 *  （那时候人需要知道这不是 rkey 的锅）；探通时不再把它写进 detail —— 前因是长期状态，见 guardStatus().probeMode。 */
const README_WHY_STATUS = '本平台 rkey 接口不可用（已知结构性故障），守护已固定改用 get_status';

/**
 * 探针：get_rkey。优先走 NapCat HTTP（3000），没配 httpUrl 时退回已连上的 OneBot WS。
 * 返回 { ok, detail }。ok=false 只代表"这一次没探通"，判定交给调用方做连续失败计数。
 *
 * 【2026-09-18 线上实测 · 必须加这道回退，否则会误重启 NapCat】
 * 这台（QQ Linux 3.2.33-52892 + NapCat 4.18.28）上 `get_rkey` **恒定失败**：
 *   {"status":"failed","retcode":200,"data":null,
 *    "message":"Cannot read properties of undefined (reading 'rkeyList')"}
 * 栈是 `pY.FetchRkey → y_e._handle → httpApiRequest` —— 是 NapCat 侧取 rkey 的实现炸了，
 * **不代表 QQ 掉线**：同一时刻 `get_status` 返回 `{"online":true,"good":true}`，
 * 收发消息、发表情、发卡片全部正常。
 * 后果（实测）：守护连着 20+ 次判"探针失败"，达到阈值就 `重启容器 napcat`，
 * 于是**一个假信号把好好的 QQ 反复重启** —— 而"掉线"正是主人最在意的问题。
 * 所以：get_rkey 失败时**再看一眼 get_status**，只要 NapCat 说自己 online && good，
 * 就当探针通过，只有 get_status 也说不在线才算真失败。
 * 上面那段"已知故障就不再调它"是这一版的进一步收敛（见 rkeyProbeDead 的说明）。
 *
 * 【2026-09-19 主人要求：别再把这件已成定局的事每轮都报一次】
 * 早先这里要求 detail 里写清楚"rkey 探针自身故障"，于是管理端「会话守护」卡长期挂着一行
 * "rkey 探针自身故障（…本轮跳过…）但 get_status 报 online&&good"，看起来像每 60 秒又出一次事。
 * 既然已经确认它是**结构性故障**、并且已经**永久跳过**对它的调用，那它就不是异常，
 * 而是本平台固定的长期降级状态。现在的口径：
 *   · 探通时 detail 只写**这次探到的结果**（`get_status：online=true good=true（未掉线）`）；
 *   · "本平台用不了 rkey、已固定改用 get_status" 由 guardStatus().probeMode='status' 带出去，
 *     在管理端**静态说明一次**（见 NapcatTokensCard 里那段固定说明），不跟着实时状态反复刷；
 *   · 只有**兜底也探不通**（真的异常）时，才把前因写进 detail 帮人定位。
 */
export async function probeNapcatOnce() {
  const { httpUrl = '', accessToken = '' } = nap();
  const base = String(httpUrl || '').trim().replace(/\/+$/, '');
  const rkeyFallback = /rkeyList/i;
  /* 已知结构性故障 → 本轮跳过对 get_rkey 的调用（每 RKEY_RETRY_EVERY 轮放行一次做复检）。
   * 注意：**只有当确实配了 HTTP 探针时**才有"跳过"这回事；没配就直接走下面的 WS 分支。 */
  rkeyProbeCycles += 1;
  const skipRkey = rkeyProbeDead && (rkeyProbeCycles % RKEY_RETRY_EVERY !== 0);
  if (base && !skipRkey) {
    try {
      const res = await fetch(`${base}/get_rkey`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ count: 1 }),
        signal: AbortSignal.timeout(12000)
      });
      const j = await res.json().catch(() => null);
      if (j && j.status === 'ok' && Array.isArray(j.data) && j.data.length) {
        if (rkeyProbeDead) log('[napcat-guard] get_rkey 恢复正常，重新启用 rkey 探针');
        rkeyProbeDead = false;
        return { ok: true, detail: `rkey ${j.data.length} 组` };
      }
      const detail = `HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}`;
      // rkey 探针自身故障 → 标记为结构性故障并走 get_status 兜底判定登录态
      if (rkeyFallback.test(detail)) {
        if (!rkeyProbeDead) log(`[napcat-guard] get_rkey 存在结构性故障（${detail.slice(0, 90)}）→ 之后不再每轮调用它，避免把 NapCat 日志刷满；改为只探 get_status，每 ${RKEY_RETRY_EVERY} 轮复检一次`);
        rkeyProbeDead = true;
        return await probeStatusFallback(base, accessToken, README_WHY_STATUS);
      }
      return { ok: false, detail };
    } catch (error) {
      const detail = `HTTP 探针异常：${error?.message ?? error}`;
      if (rkeyFallback.test(detail)) {
        rkeyProbeDead = true;
        return await probeStatusFallback(base, accessToken, README_WHY_STATUS);
      }
      return { ok: false, detail };
    }
  }
  if (base && skipRkey) {
    // 已知故障期：不再白调 get_rkey，直接看 get_status
    return await probeStatusFallback(base, accessToken, README_WHY_STATUS);
  }
  if (typeof callAction === 'function') {
    // 已知结构性故障期：WS 这条路同样不再白调 get_rkey（它会以异常形式回来，同样刷日志）
    if (skipRkey) return await probeStatusFallback('', accessToken, README_WHY_STATUS, true);
    try {
      const r = await callAction('get_rkey', { count: 1 }, 12000);
      const data = r?.data ?? r;
      if (Array.isArray(data) && data.length) return { ok: true, detail: `rkey ${data.length} 组（WS）` };
      const detail = `WS 返回：${JSON.stringify(r).slice(0, 160)}`;
      if (rkeyFallback.test(detail)) { rkeyProbeDead = true; return await probeStatusFallback('', accessToken, README_WHY_STATUS, true); }
      return { ok: false, detail };
    } catch (error) {
      const detail = `WS 探针异常：${error?.message ?? error}`;
      if (rkeyFallback.test(detail)) { rkeyProbeDead = true; return await probeStatusFallback('', accessToken, README_WHY_STATUS, true); }
      return { ok: false, detail };
    }
  }
  return { ok: false, detail: '没配 napcat.httpUrl，也没有可用的 OneBot 连接，无法探活' };
}

/** get_rkey 自身故障时的兜底探针：只看 NapCat 自己报的 online/good。
 *
 *  【2026-09-19 主人要求：这段不该每轮都当异常展示】
 *  上一版把"rkey 探针自身故障"写进了**每次探活的 detail**，于是管理端「NapCat 会话守护」卡里
 *  长期挂着这么一条：
 *    rkey 探针自身故障（get_rkey 已知结构性故障，本轮跳过（不再刷日志）），但 get_status 报 online&&good
 *      —— 判为未掉线，不重启 / 连续失败：0 / 2 次
 *  可它不是"这一轮出了问题"，而是**本平台固定的长期降级**：既然已经确认 get_rkey 是结构性故障
 *  并永久跳过它（见 rkeyProbeDead），"rkey 探针坏了"就不再是异常，而是一个已经处理完的既定事实。
 *  把它塞进实时状态里，只会让主人每次点开都以为又出事了。
 *  改法：detail 只报**这次真正探到的结果**（谁、看到什么）；"本平台用不了 rkey、固定改用 get_status"
 *  这件事由 guardStatus().probeMode 带出去，在界面上**静态说明一次**。
 *
 *  why 参数保留：只在**这次兜底也没探通**（真的异常）时才能塞进 detail —— 那时候人需要知道
 *  "这不是 rkey 的锅、是登录态/连接的问题"。 */
async function probeStatusFallback(base, accessToken, why, viaWs = false) {
  try {
    const call = viaWs
      ? () => callAction('get_status', {}, 12000)
      : async () => {
          const r = await fetch(`${base}/get_status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
            body: '{}',
            signal: AbortSignal.timeout(12000)
          });
          return r.json().catch(() => null);
        };
    const j = await call();
    const d = j?.data ?? j;
    if (d && d.online === true && d.good === true) {
      // 正常路径：只报探到的事实，不提前因（前因是长期状态，见 guardStatus().probeMode / 界面静态说明）
      return { ok: true, detail: 'get_status：online=true good=true（未掉线）' };
    }
    return { ok: false, detail: `get_status 未报在线：${JSON.stringify(j).slice(0, 160)}` };
  } catch (error) {
    return { ok: false, detail: `get_status 探活失败（${String(why).slice(0, 40)}）：${error?.message ?? error}` };
  }
}

function exportQr() {
  try {
    const r = spawnSync('docker', ['cp', `${containerName()}:/app/napcat/cache/qrcode.png`, QR_FILE], { encoding: 'utf8', timeout: 20000 });
    return r.status === 0 ? QR_FILE : null;
  } catch { return null; }
}

// 【2026-09-16 实测】NapCat 在"等扫码"状态下**不会**自己换二维码：实测容器里那张码挂了 40 分钟没变，
// 而 QQ 的登录码大约两分钟就失效 —— 也就是说"直接把现有文件拷出来给人扫"，很可能给的是一张废码。
// NapCat 的 WebUI 有 RefreshQRCode 接口可以主动要一张新的，这里在导出前先要一次（带频率限制）。
async function refreshQrViaWebui() {
  const dir = napcatConfigDir();
  if (!dir) return { ok: false, error: '找不到 NapCat 配置目录' };
  const w = readJsonSafe(path.join(dir, 'webui.json'), null);
  const token = String(w?.token ?? '');
  const port = String(w?.port ?? 6099);
  if (!token) return { ok: false, error: '读不到 webui.json 的 token' };
  const hash = crypto.createHash('sha256').update(`${token}.napcat`).digest('hex');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash }), signal: AbortSignal.timeout(8000)
    });
    const j = await res.json().catch(() => null);
    const cred = String(j?.data?.Credential ?? '');
    if (!cred) return { ok: false, error: 'WebUI 登录没返回 Credential' };
    const r2 = await fetch(`http://127.0.0.1:${port}/api/QQLogin/RefreshQRCode`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cred}` }, body: '{}', signal: AbortSignal.timeout(10000)
    });
    const j2 = await r2.json().catch(() => null);
    const ok = Number(j2?.code) === 0;
    return { ok, error: ok ? '' : JSON.stringify(j2).slice(0, 160) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 导出二维码：先尝试让 NapCat 换一张新的（60 秒内不重复要），拿不到就退回现有文件。 */
export async function exportQrFresh() {
  const st = readState();
  const since = Date.now() - (Number(st.lastQrRefreshAt) || 0);
  if (since > 60000) {
    const r = await refreshQrViaWebui();
    st.lastQrRefreshAt = Date.now();
    writeState(st);
    if (!r.ok) log(`[napcat-guard] 让 NapCat 换新二维码失败（继续用现有那张）：${r.error}`);
  }
  return exportQr();
}

function restartContainer(reason) {
  const grace = Number(guardCfg().restartGraceSec) || 60;
  log(`[napcat-guard] 重启容器 ${containerName()}（-t ${grace}）：${reason}`);
  const t0 = Date.now();
  const r = spawnSync('docker', ['restart', '-t', String(grace), containerName()], { timeout: 300000, encoding: 'utf8' });
  const ms = Date.now() - t0;
  if (r.status !== 0) return { ok: false, ms, detail: String(r.stderr || r.stdout || `exit=${r.status}`).trim().slice(0, 200) };
  return { ok: true, ms, detail: String(r.stdout || '').trim().slice(0, 120) };
}

async function waitRecover(deadlineMs) {
  const step = 5000;
  let last = '';
  while (Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, step));
    const p = await probeNapcatOnce();
    last = p.detail;
    if (p.ok) return { ok: true, detail: p.detail };
  }
  return { ok: false, detail: last };
}

/**
 * 自愈：重启容器并等它登回来。返回 { healed, detail, waitedMs }。
 * 手动触发（管理端按钮）与自动触发共用这一条路径。
 */
export async function healNapcatSession(reason = '手动触发') {
  const cfg = guardCfg();
  const t0 = Date.now();
  restartContainer(reason);
  const rec = await waitRecover(t0 + (Number(cfg.recoverWaitMs) || 150000));
  const waitedMs = Date.now() - t0;
  let login = null;
  try { login = await probeQqLoginState(); } catch { /* 登录态只是补充信息 */ }
  if (rec.ok) {
    log(`[napcat-guard] 自愈成功（${Math.round(waitedMs / 1000)}s）：${rec.detail}`);
    return { healed: true, detail: `探针恢复（${rec.detail}）`, waitedMs, login };
  }
  const qr = await exportQrFresh();
  log(`[napcat-guard] 自愈未能恢复（${Math.round(waitedMs / 1000)}s）：${rec.detail}；二维码 ${qr ? '已导出到 ' + qr : '导出失败'}`);
  return { healed: false, detail: `重启后仍探不通：${rec.detail}${qr ? '（二维码已导出，可在管理端查看/下载）' : ''}`, waitedMs, login, qrPath: qr };
}

function healsLastHour(state) {
  const cut = Date.now() - 3600 * 1000;
  return (state.heals || []).filter((t) => Number(t) > cut).length;
}

export function guardStatus() {
  const cfg = guardCfg();
  const st = readState();
  const pw = passwordFallbackInfo();
  const autoHeal = st.autoHealOverride === null || st.autoHealOverride === undefined ? (cfg.autoHeal === null ? pw.configured : cfg.autoHeal === true) : st.autoHealOverride === true;
  let verdict = 'unknown';
  if (!cfg.enabled) verdict = 'disabled';
  else if (!st.lastProbeAt) verdict = 'unknown';
  else if (st.consecutiveFails >= Number(cfg.failThreshold)) verdict = 'dead';
  else if (st.consecutiveFails > 0) verdict = 'suspect';
  else verdict = 'ok';
  return {
    enabled: cfg.enabled,
    autoHeal: Boolean(autoHeal),
    autoHealSource: st.autoHealOverride === null || st.autoHealOverride === undefined ? 'auto' : 'manual',
    verdict,
    /** 【2026-09-19】当前探活口径：'rkey' = 走 NapCat 的 get_rkey；'status' = 本平台 rkey 结构性故障、
     *  已**固定**改用 get_status（见 rkeyProbeDead）。这是"已知的长期降级"，不是本轮异常：
     *  管理端据此在守护卡里**静态说明一次**，而不是把这句话塞进每次探活的 detail 反复刷。 */
    probeMode: rkeyProbeDead ? 'status' : 'rkey',
    lastProbeAt: st.lastProbeAt,
    lastProbeOk: st.lastProbeOk,
    lastProbeDetail: st.lastProbeDetail,
    consecutiveFails: st.consecutiveFails,
    failThreshold: Number(cfg.failThreshold),
    probeIntervalMs: Number(cfg.probeIntervalMs),
    heals: st.heals || [],
    lastHealAt: st.lastHealAt,
    lastHealResult: st.lastHealResult,
    alert: st.alert,
    passwordFallback: pw,
    container: containerInfo()
  };
}

/** 管理端开关：{ enabled?, autoHeal? } */
export function setGuardConfig(patch = {}) {
  const st = readState();
  if (patch.autoHeal === true || patch.autoHeal === false) st.autoHealOverride = patch.autoHeal;
  if (patch.autoHeal === null) st.autoHealOverride = null;
  if (patch.enabled === true || patch.enabled === false) {
    if (!cfgRef.guard || typeof cfgRef.guard !== 'object') cfgRef.guard = {};
    cfgRef.guard.enabled = patch.enabled;
  }
  writeState(st);
  return guardStatus();
}

/** 一次心跳：探活 → 计数 → 必要时自愈。由定时器与手动接口共用。 */
export async function guardTick(force = false) {
  if (ticking) return guardStatus();
  const cfg = guardCfg();
  if (!cfg.enabled && !force) return guardStatus();
  ticking = true;
  try {
    const st = readState();
    const p = await probeNapcatOnce();
    st.lastProbeAt = Date.now();
    st.lastProbeOk = p.ok;
    st.lastProbeDetail = p.detail;
    if (p.ok) {
      if (st.consecutiveFails >= Number(cfg.failThreshold) || st.alert) {
        log(`[napcat-guard] 会话恢复正常（此前连续失败 ${st.consecutiveFails} 次）`);
      }
      st.consecutiveFails = 0;
      st.alert = null;
      writeState(st);
      return guardStatus();
    }
    st.consecutiveFails = (Number(st.consecutiveFails) || 0) + 1;
    log(`[napcat-guard] 探针失败 ${st.consecutiveFails}/${cfg.failThreshold}：${p.detail}`);
    writeState(st);

    if (st.consecutiveFails < Number(cfg.failThreshold)) return guardStatus();

    // 【2026-09-16 实测补丁】重启前先问一句"QQ 到底还登着没"：
    //   · 还登着但发不出去 = 典型的"假死"，重启+自动回退登录通常能救回来（值得动手）；
    //   · 已经显示未登录（waiting_qrcode 等）= 需要人扫码/过验证码，**重启救不了**，
    //     硬重启只会把验证流程打断、还可能把人推到必须重新验证的状态 —— 只报警不动手。
    // 这一条是踩出来的：当天 17:58 会话先死，守护按"探针失败"重启，结果撞上
    // "快速登录：用户身份已失效 → 密码回退需短信验证 → 扫码"，恢复花了 6 分钟且要人盯着。
    let loginNow = null;
    try { loginNow = await probeQqLoginState(); } catch { loginNow = null; }
    if (loginNow && loginNow.ok && loginNow.isLogin === false) {
      const reason = `探针连续 ${st.consecutiveFails} 次失败，且 NapCat 显示未登录（${loginNow.loginPhase || '未知阶段'}）：需要人工扫码/完成验证`;
      log(`[napcat-guard] ${reason} —— 重启救不了，只报警不出手`);
      // 【2026-09-16 踩坑】这里**只在刚进入 needs-login 状态时换一次二维码**，之后保持不动。
      // 原因：QQ 的登录码约两分钟失效，而每换一张上一张立刻作废 —— 守护每分钟重导一张的话，
      // 用户"打开图片→拿起手机扫"这几秒里码已经作废，手机上只会提示登录失败。
      // 所以：进来时给一张新的，之后不再动它；要新码由用户显式点（管理端按钮 / 桌面脚本）。
      const alreadyAlerted = st.alert?.level === 'needs-login' && st.alert?.qrPath;
      st.alert = {
        ts: alreadyAlerted ? st.alert.ts : nowIso(),
        level: 'needs-login',
        reason,
        qrPath: alreadyAlerted ? st.alert.qrPath : await exportQrFresh()
      };
      writeState(st);
      return guardStatus();
    }

    const status = guardStatus();
    if (!status.autoHeal && !force) {
      const reason = `探针连续 ${st.consecutiveFails} 次失败：${p.detail}`;
      log('[napcat-guard] 判定会话异常，但未开启自动自愈（且容器未配置免扫码回退登录）——只报警不出手');
      st.alert = { ts: nowIso(), level: 'manual', reason, qrPath: null };
      writeState(st);
      return guardStatus();
    }
    const since = Date.now() - (Number(st.lastHealAt) || 0);
    if (since < Number(cfg.cooldownMs) && !force) {
      log(`[napcat-guard] 自愈冷却中（还剩 ${Math.round((Number(cfg.cooldownMs) - since) / 1000)}s），本次不重启`);
      st.alert = { ts: nowIso(), level: 'cooldown', reason: `探针连续 ${st.consecutiveFails} 次失败：${p.detail}`, qrPath: null };
      writeState(st);
      return guardStatus();
    }
    if (healsLastHour(st) >= Number(cfg.maxHealsPerHour) && !force) {
      const reason = `一小时内已自愈 ${healsLastHour(st)} 次，停止自动重启以免打转`;
      log(`[napcat-guard] ${reason}`);
      const qr = await exportQrFresh();
      st.alert = { ts: nowIso(), level: 'giveup', reason, qrPath: qr };
      writeState(st);
      return guardStatus();
    }

    st.heals = [...(st.heals || []), Date.now()].slice(-20);
    st.lastHealAt = Date.now();
    writeState(st);

    const res = await healNapcatSession(`探针连续 ${st.consecutiveFails} 次失败：${p.detail}`);
    const st2 = readState();
    st2.lastHealResult = res.healed ? 'success' : 'failed';
    if (res.healed) {
      st2.consecutiveFails = 0;
      st2.alert = null;
    } else {
      // 重启后仍不通：多数是撞上"需要人扫码/过验证"，按 needs-login 提示，别再自动重启打转
      let after = null;
      try { after = await probeQqLoginState(); } catch { after = null; }
      const needsHuman = Boolean(after && after.ok && after.isLogin === false);
      st2.alert = {
        ts: nowIso(),
        level: needsHuman ? 'needs-login' : 'failed',
        reason: needsHuman ? `${res.detail}；NapCat 当前未登录（${after?.loginPhase || '未知'}），需要人工扫码/完成验证` : res.detail,
        qrPath: res.qrPath ?? await exportQrFresh()
      };
    }
    writeState(st2);
    return guardStatus();
  } finally {
    ticking = false;
  }
}

export function startNapcatGuard() {
  const cfg = guardCfg();
  if (timer) { clearInterval(timer); timer = null; }
  if (!cfg.enabled) { log('[napcat-guard] 已关闭（guard.enabled=false），不启动探针'); return; }
  const ms = Math.max(15000, Number(cfg.probeIntervalMs) || 60000);
  timer = setInterval(() => { guardTick().catch((error) => log(`[napcat-guard] 心跳异常：${error?.message ?? error}`)); }, ms);
  timer.unref?.();
  const pw = passwordFallbackInfo();
  log(`[napcat-guard] 已启动：每 ${Math.round(ms / 1000)}s 探活一次，连续 ${cfg.failThreshold} 次失败判定会话异常；探针先试 get_rkey，本平台该接口结构性故障时会固定改用 get_status（见状态里的 probeMode）；免扫码回退登录=${pw.configured ? '已配置' : '未配置（默认不自动重启）'}`);
  // 启动先探一次，免得要等一个周期
  guardTick().catch(() => {});
}

/**
 * 配置"免扫码回退登录"：把密码算成 md5 写进容器环境变量 NAPCAT_QUICK_PASSWORD_MD5（明文不落盘），
 * 需要重建容器才能加环境变量 —— 所以这里：备份登录票据 → 存一份容器规格 → 停旧容器改名保留 →
 * 用**同一套挂载/端口/环境**重建并多带这一条 → 等它自动登录；成功才删旧容器，失败保留现场并导出二维码。
 */
export async function applyQuickPassword(password) {
  const pw = String(password ?? '');
  if (!pw.trim()) return { ok: false, error: '密码不能为空' };
  if (pw.length > 64) return { ok: false, error: '密码过长（>64 字符）' };
  const md5 = crypto.createHash('md5').update(pw, 'utf8').digest('hex');
  const name = containerName();
  const insp = spawnSync('docker', ['inspect', name], { encoding: 'utf8', timeout: 20000 });
  if (insp.status !== 0) return { ok: false, error: `docker inspect 失败：${String(insp.stderr || '').trim().slice(0, 200)}` };
  let info = null;
  try { info = JSON.parse(insp.stdout)[0]; } catch { return { ok: false, error: '解析容器规格失败' }; }

  try { fs.mkdirSync(SPEC_DIR, { recursive: true }); } catch { /* 忽略 */ }
  const stamp = nowIso().replace(/[:.]/g, '-');
  try { fs.writeFileSync(path.join(SPEC_DIR, `${stamp}.json`), insp.stdout); } catch { /* 忽略 */ }
  const cfgDir = napcatConfigDir();
  if (cfgDir) { try { fs.writeFileSync(path.join(cfgDir, `container-spec-${stamp}.json`), insp.stdout); } catch { /* 忽略 */ } }
  try { backupLoginTickets(); } catch { /* 忽略 */ }

  const args = ['run', '-d', '--name', name, '--restart', String(info?.HostConfig?.RestartPolicy?.Name || 'unless-stopped')];
  for (const b of (info?.HostConfig?.Binds ?? [])) args.push('-v', String(b));
  const binds = (info?.HostConfig?.Binds ?? []).map((b) => String(b).split(':').slice(1).join(':'));
  for (const m of (info?.Mounts ?? [])) {
    if (m?.Type === 'volume' && m?.Name && !binds.some((d) => d && d.split(':')[0] === m.Destination)) args.push('-v', `${m.Name}:${m.Destination}`);
  }
  const ports = info?.HostConfig?.PortBindings ?? {};
  for (const [containerPort, arr] of Object.entries(ports)) {
    for (const p of (Array.isArray(arr) ? arr : [])) {
      const host = p?.HostIp ? `${p.HostIp}:${p.HostPort}` : String(p?.HostPort ?? '');
      if (host) args.push('-p', `${host}:${containerPort}`);
    }
  }
  const envs = (info?.Config?.Env ?? []).filter((e) => !/^NAPCAT_QUICK_PASSWORD(_MD5)?=/.test(String(e)));
  for (const e of envs) args.push('-e', String(e));
  args.push('-e', `NAPCAT_QUICK_PASSWORD_MD5=${md5}`);
  args.push(String(info?.Config?.Image ?? 'mlikiowa/napcat-docker:latest'));

  log(`[napcat-guard] 配置免扫码回退登录：重建容器 ${name}（挂载/端口/环境照抄，只多一条 NAPCAT_QUICK_PASSWORD_MD5）`);
  spawnSync('docker', ['stop', '-t', '30', name], { encoding: 'utf8', timeout: 120000 });
  spawnSync('docker', ['rename', name, `${name}-old`], { encoding: 'utf8', timeout: 30000 });
  const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000 });
  if (run.status !== 0) {
    log(`[napcat-guard] 重建失败，回滚到旧容器：${String(run.stderr || '').trim().slice(0, 200)}`);
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 60000 });
    spawnSync('docker', ['rename', `${name}-old`, name], { encoding: 'utf8', timeout: 30000 });
    spawnSync('docker', ['start', name], { encoding: 'utf8', timeout: 120000 });
    return { ok: false, error: `重建容器失败，已回滚旧容器：${String(run.stderr || run.stdout || '').trim().slice(0, 300)}` };
  }

  const deadline = Date.now() + 180000;
  let login = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    try { login = await probeQqLoginState(); } catch { login = null; }
    if (login?.ok && login.isLogin) break;
  }
  if (login?.ok && login.isLogin) {
    spawnSync('docker', ['rm', '-f', `${name}-old`], { encoding: 'utf8', timeout: 60000 });
    log('[napcat-guard] 免扫码回退登录配置成功，容器已重建并登录');
    return { ok: true, detail: '已重建容器并登录成功（以后票据失效会自动用密码登回来，不用扫码）', loginState: login };
  }
  const qr = exportQr();
  log('[napcat-guard] 重建后未能自动登录，请扫码；旧容器已保留为 ' + `${name}-old`);
  return {
    ok: false,
    error: `容器已重建，但没能自动登录（${login?.error ?? '登录态未知'}）。旧容器保留为 ${name}-old，二维码已导出${qr ? ` 到 ${qr}` : ''}，扫码后即可恢复`,
    loginState: login,
    qrPath: qr
  };
}
