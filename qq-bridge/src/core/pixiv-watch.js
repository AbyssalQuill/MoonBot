// Pixiv 登录态自检 + 失效提醒（2026-09-19 建，2026-09-20 扩）。
//
// 背景：登录态是「按名字搜画师」的唯一前提，而它过去**只能靠主人手贴 PHPSESSID**，掉了就得回头找人。
// 2026-09-20 起改成两层，这个看护循环也要跟着认两种情况：
//   ① 长期令牌（state/pixiv-token.json 里的 refresh_token / config.json 的 pixiv.refreshToken）：
//      桥每 50 分钟自己换 access_token（core 里 startPixivTokenRefresh）。所以这里看到的"过期"，
//      只可能是**轮换一直失败**（令牌被吊销、网络不通、时钟漂太远）—— 那才是要给主人报的事。
//   ② 旧的一次性 cookie（config.json 的 pixiv.cookie）：仍然是"掉了就掉"，用试纸自检（pixivLoginState）。
//
// 做三件事：① 顺带把"名字→画师号"的解析结果落盘缓存（见 lib/pixiv.js 的 ARTIST_CACHE）——
// 登录态掉了，已经查过的名字照样能用；② 桥定期自检，失效时**主动在 QQ 里告诉主人**；
// ③ 提醒里说清"只需要给一次 PHPSESSID"（换长期令牌），并给出一次性命令，免得主人以为要反复贴。
//
// 自检判据不是"配置里有没有 cookie"，而是 lib/pixiv.js 的 pixivLoginState()：
// 拿一个"匿名时原图地址被抹掉"的作品当试纸，**能拿到原图地址**才算登录态真的生效。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixivLoggedIn, pixivLoginState, artistCacheSize } from '../lib/pixiv.js';
import { pixivAuthState } from '../lib/pixiv-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '..', '..', 'state', 'pixiv-cookie-state.json');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 每 6 小时自检一次
const FIRST_DELAY_MS = 90 * 1000;               // 启动后 90 秒首检（不和启动流程抢资源）
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 仍失效时，最多每 24 小时提醒一次
/** 一次性命令：主人自己上手时照抄；提醒里也带上（只含占位符，绝不含真凭证）。 */
const LOGIN_CMD = 'node tools/pixiv-login.mjs --cookie "PHPSESSID=..."';

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) ?? {}; } catch { return {}; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch { /* 状态写不进去不影响主流程 */ }
}

/**
 * 启动自检循环。**两种登录态都没有时完全静默**（不吵人、不发消息）。
 * @param {{logger?:Function, ownerKey?:()=>string, send?:(key:string,text:string)=>Promise<any>}} opts
 * @returns {() => void} 停止函数
 */
export function startPixivCookieWatch({ logger = () => {}, ownerKey = () => '', send = null } = {}) {
  let stopped = false;

  const push = async (text, evidence) => {
    const key = ownerKey();
    if (!key || typeof send !== 'function') {
      logger(`[pixiv] ${evidence}，但没有可用的主人会话，跳过提醒`);
      return false;
    }
    try {
      await send(key, text);
      logger(`[pixiv] 已提醒主人：${evidence}`);
      return true;
    } catch (e) {
      logger(`[pixiv] 失效提醒发送失败: ${e?.message ?? e}`);
      return false;
    }
  };

  const tick = async () => {
    if (stopped) return;
    const auth = pixivAuthState();
    const hasCookie = pixivLoggedIn();
    if (!auth.hasRefreshToken && !hasCookie) return;   // 都没配：静默（这不算故障）

    /* ── ① 有长期令牌：桥自己在轮换，所以"过期"= 轮换一直没成功 ────────────────────────── */
    if (auth.hasRefreshToken) {
      if (!auth.expired) {
        if (readState().refreshInvalid) {
          writeState({ ...readState(), refreshInvalid: false, recoveredAt: Date.now(), lastEvidence: '' });
          logger('[pixiv] 令牌轮换恢复正常');
        }
        return;
      }
      const stNow = readState();
      if (Date.now() - (Number(stNow.refreshNotifyAt) || 0) < NOTIFY_COOLDOWN_MS) return;
      const reason = auth.lastError || 'access_token 已过期，且最近一次自动轮换没有成功';
      const cached = artistCacheSize();
      const sent = await push(
        `Pixiv 的长期令牌轮换失败了（${reason}）。影响：按名字搜画师可能用不了；按画师号/作品号发图不受影响，已经查过的 ${cached} 个画师名字也有本地缓存。`
        + `要恢复的话，把浏览器登录态里的 PHPSESSID 发我**一次**就够了 —— 我拿它换一个新的长期令牌，之后桥自己续期，不用再给。`
        + `（也可以直接在服务器上跑一次：${LOGIN_CMD}）`,
        `令牌轮换失败（${reason}）`,
      );
      if (sent) writeState({ ...stNow, refreshInvalid: true, refreshNotifyAt: Date.now(), lastEvidence: reason });
      return;
    }

    /* ── ② 只有一次性 cookie（旧安装/应急路径）：照旧用试纸自检 ────────────────────────── */
    const st = readState();
    let state;
    try { state = await pixivLoginState(); } catch (e) { logger(`[pixiv] 自检异常: ${e?.message ?? e}`); return; }
    if (state.loggedIn) {
      if (st.invalid) {
        writeState({ ...st, invalid: false, recoveredAt: Date.now(), lastEvidence: state.evidence });
        logger('[pixiv] 登录态恢复正常');
      }
      return;
    }
    const lastNotify = Number(st.lastNotifyAt) || 0;
    if (Date.now() - lastNotify < NOTIFY_COOLDOWN_MS) return;   // 提醒过就别刷屏
    const cached = artistCacheSize();
    const sent = await push(
      `Pixiv 的一次性登录态过期了，按名字搜画师暂时不能用（已经查过的 ${cached} 个画师名字有本地缓存，照旧能用；按画师号发作品也不受影响）。`
      + `要恢复：在浏览器登录 pixiv 后把新的 PHPSESSID 发我**一次**就行 —— 我拿它换长期令牌，之后桥自己续期，不用再给。`
      + `（也可以直接在服务器上跑一次：${LOGIN_CMD}）`,
      `登录态失效（${state.evidence}）`,
    );
    if (sent) writeState({ ...st, invalid: true, lastNotifyAt: Date.now(), lastEvidence: state.evidence });
  };

  const firstTimer = setTimeout(() => { void tick(); }, FIRST_DELAY_MS);
  const timer = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  try { timer.unref?.(); firstTimer.unref?.(); } catch { /* 忽略 */ }
  return () => { stopped = true; clearInterval(timer); clearTimeout(firstTimer); };
}
