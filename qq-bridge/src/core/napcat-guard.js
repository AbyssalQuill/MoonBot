// NapCat 会话守护：主动探活 + 会话假死自愈。
//
// 为什么需要它｜2026-09-16 亲历：
// QQ 客户端会出现"静默死"：客户端自己仍然认为在线（NapCat 日志里一条错误都没有、
// WebUI 的 isLogin/online 也还是 true），但发消息被 QQ 内核拒绝
// （EventChecker Failed: NodeIKernelMsgService/sendMsg / {"result":1006514,"errMsg":"网络连接异常!"}），
// 收消息也一起停。当天 16:33 发生后一直没人知道，直到 17:22 才发现 —— 静默 50 分钟。
// 真正的原因在腾讯服务端：它把这次登录态作废了（近 72 小时 10 次），客户端没收到任何通知。
//
// 做法：
//   1) 探针：定期调 NapCat 的 get_rkey。它每次都真的请求 QQ 服务器（实测两次返回的 rkey
//      不同），失败就说明"会话/网络这条路不通了"；而且对别人完全不可见——不像"发条消息试试"
//      那样会打扰群里任何人。
//   2) 判定：连续 failThreshold 次（默认 2 次 ≈ 2 分钟）失败 = 会话已死。
//   3) 自愈：docker restart 容器。容器里若配了 NAPCAT_QUICK_PASSWORD(_MD5)（免扫码回退登录），
//      起来后会自动用密码登回来（实测 17:49 那次："密码回退登录成功"，全程不需要扫码）。
//      未配置回退登录时默认不自动重启：那种情况下重启可能会把它推到"必须扫码"的状态，
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

/** 把当前二维码抓一份出来给管理端看/下载（人不在服务器边上时，这是唯一的救命路径）。
 *
 *  2026-09-23：只读现成的那张，绝不换码 —— 换码的能力已整体删除（见下面 refreshQrViaWebui 的说明）。
 *  以前它 60 秒没换过就换一张，于是用户"打开图片 → 拿起手机扫"这几秒里码正好被换掉，手机报登录失败。 */
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


/* 2026-09-23：按需求「去除探针与状态检测」，这一大段整个删掉了。
 * 删除内容（全部都是"桥主动去戳 NapCat"的代码，删前已 grep 确认无任何调用方）：
 *   · passwordFallbackInfo()  —— docker inspect 探"免扫码回退"是否配置
 *   · containerInfo()        —— docker inspect 探容器状态/启动时间
 *   · probeNapcatOnce()      —— 探活本体：调 get_rkey / get_status 判 NapCat 掉没掉线
 *   · probeStatusFallback()  —— get_rkey 结构性故障时的 get_status 兜底
 *   · rkeyProbeDead / rkeyProbeCycles / RKEY_RETRY_EVERY / README_WHY_STATUS —— 只服务于上面那些探针的长期状态
 * 连它的调用方一起删（见下面 restartContainer 那一段的说明）：桥不再探活、不再重启 NapCat。
 * 现在桥对 NapCat 只做两件不花登录额度的事：读盘上现成的那张二维码、走 OneBot HTTP 问一句登没登录。
 * 要看 NapCat 是否正常，请直接开 NapCat 界面。 */
function exportQr() {
  try {
    const r = spawnSync('docker', ['cp', `${containerName()}:/app/napcat/cache/qrcode.png`, QR_FILE], { encoding: 'utf8', timeout: 20000 });
    return r.status === 0 ? QR_FILE : null;
  } catch { return null; }
}

// 2026-09-16 实测：NapCat 在"等扫码"状态下不会自己换二维码：实测容器里那张码挂了 40 分钟没变。
// 当时的对策是"导出前先让 NapCat 换一张新的"，2026-09-23 这个对策已整体删除：
// 换码会把上一张立刻作废，谁在轮询谁就在毁用户手上那张码；而且换码要先登 WebUI，
// 那份额度是 WebUI 页面自己要在用的。现在只把盘上现成的那张码原样读出来。
/* 2026-09-23：已删除 refreshQrViaWebui()。
 * 它是桥侧最后一处调 NapCat WebUI 登录接口（POST /api/auth/login）的代码：拿 Credential 后
 * 再 POST /api/QQLogin/RefreshQRCode 让 NapCat 换一张新码。两件事都去掉了：
 *   ① 登录接口按 IP 限流，那份额度 WebUI 页面自己要用，桥不该去抢（抢了页面就 Unauthorized）；
 *   ② 换码会把上一张立刻作废 —— 谁在轮询谁就在毁用户手上那张码。
 * 桥现在只把 NapCat 已经写在盘上的二维码原样读出来给人看。
 * 要一张全新的码：去 NapCat 自己的界面点，或让 QQ 那边重新出码。 */

/**
 * 导出二维码 —— 只读现成的那张。
 *
 * 2026-09-23：根治「首次鉴权失败」+「获取QQ列表失败: Unauthorized」。
 * 以前这里是自动换码：只要距上次刷新超过 60 秒，就
 *   ① `POST /api/auth/login` 花掉 NapCat 一发登录额度（它是每 IP 每 60 秒最多 loginRate 次的限量桶），
 *   ② 调 `POST /api/QQLogin/RefreshQRCode` —— 让上一张码立刻作废。
 * 而 `qrSnapshot()` 会被管理端卡片/脚本轮询，于是：
 *   · 用户"打开二维码图片 → 拿起手机扫"这几秒里码被换掉 → 手机上提示登录失败（首次鉴权失败）；
 *   · 登录额度被后台探针吃光 → WebUI 页面自己登不进去、拿不到 Credential →
 *     页面报「获取QQ列表失败: Unauthorized」「获取二维码失败: Unauthorized」。
 * 现在整个换码能力都删掉了，这个函数就是"把文件读出来"。
 */
export async function exportQrFresh() {
  return exportQr();
}


/* 2026-09-23：已删除 restartContainer() / waitRecover() / healNapcatSession() / healsLastHour()。
 * 「探活失败 → 连续 N 次 → docker restart napcat → 等它回来 → 导出二维码」这条自动自愈链整体删除。
 * 桥不再重启 NapCat：NapCat 的启停由 NapCat 自己的界面和管理器的启动按钮负责。
 * 对应的管理端接口 /api/napcat/guard/heal 现在固定回 410（"该能力已去除"）。 */
export function guardStatus() {
  /* 2026-09-23：去除探针与状态检测。
   * 这里以前会把探针结果（lastProbeAt / consecutiveFails / verdict / 容器状态…）算出来给界面看。
   * 探针已经整体去掉，所以现在只回一个骨架：字段还在（老前端不会因为缺字段而崩），
   * 但每个字段都是"没有探针"的诚实值 —— 界面据此显示"已去除"，而不是显示一个假的"正常"。 */
  return {
    removed: true,
    enabled: false,
    autoHeal: false,
    autoHealSource: 'auto',
    verdict: 'removed',
    probeMode: 'none',
    lastProbeAt: 0,
    lastProbeOk: false,
    lastProbeDetail: '探针与状态检测已去除：桥不再主动戳 NapCat（要看是否正常请直接开 NapCat 界面）',
    consecutiveFails: 0,
    failThreshold: 0,
    probeIntervalMs: 0,
    heals: [],
    lastHealAt: 0,
    lastHealResult: '',
    alert: null,
    passwordFallback: { configured: false, source: 'none' },
    container: { name: 'napcat', status: 'unknown', startedAt: '' }
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

/** 心跳：已空转。探针与状态检测整体去除，保留这个函数只为兼容老调用方。 */
export async function guardTick(force = false) {
  /* 2026-09-23：去除探针与状态检测。探活 + 自动重启自愈整体停用，什么都不做。 */
  void force;
  return guardStatus();
}


export function startNapcatGuard() {
  /* 2026-09-23：去除探针与状态检测。
   * 原来这里每分钟探活一次 NapCat、连续失败就重启容器自愈。现在不启动任何定时器：
   * 桥不会主动去戳 NapCat，周期性网络请求一个都不发。 */
  if (timer) { clearInterval(timer); timer = null; }
  log('[napcat-guard] 探针与状态检测已去除：不启动探活定时器（桥不会主动戳 NapCat）');
}

/**
 * 配置"免扫码回退登录"：把密码算成 md5 写进容器环境变量 NAPCAT_QUICK_PASSWORD_MD5（明文不落盘），
 * 需要重建容器才能加环境变量 —— 所以这里：备份登录票据 → 存一份容器规格 → 停旧容器改名保留 →
 * 用同一套挂载/端口/环境重建并多带这一条 → 等它自动登录；成功才删旧容器，失败保留现场并导出二维码。
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

