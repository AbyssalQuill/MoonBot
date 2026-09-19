// Pixiv 登录 cookie 自检 + 失效提醒（2026-09-19）。
//
// 背景：主人只肯填一次 cookie，但 cookie 没法自动续（续期要账号密码，不能拿）。
// 所以做两件能做的：
//   ① 每次按名字解出画师号都落盘缓存（见 lib/pixiv.js 的 ARTIST_CACHE）——cookie 掉了，
//      已经查过的名字照样能用，而"按号发作品 / 取原图"本来就不需要登录态；
//   ② 桥定期自检，cookie 失效时**主动在 QQ 里告诉主人**（同一个失效期最多提醒一次/天，恢复后重置），
//      别让主人自己去猜为什么名字搜不好使了。
//
// 自检判据不是"配置里有没有 cookie"，而是 lib/pixiv.js 的 pixivLoginState()：
// 拿一个"匿名时原图地址被抹掉"的作品当试纸，**能拿到原图地址**才算登录态真的生效。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixivLoggedIn, pixivLoginState, artistCacheSize } from '../lib/pixiv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '..', '..', 'state', 'pixiv-cookie-state.json');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 每 6 小时自检一次
const FIRST_DELAY_MS = 90 * 1000;               // 启动后 90 秒首检（不和启动流程抢资源）
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 仍失效时，最多每 24 小时提醒一次

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
 * 启动自检循环。**没配 cookie 时完全静默**（不吵人、不发消息）。
 * @param {{logger?:Function, ownerKey?:()=>string, send?:(key:string,text:string)=>Promise<any>}} opts
 * @returns {() => void} 停止函数
 */
export function startPixivCookieWatch({ logger = () => {}, ownerKey = () => '', send = null } = {}) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if (!pixivLoggedIn()) return;                 // 没配 cookie：静默（这不算故障）
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
    const key = ownerKey();
    if (!key || typeof send !== 'function') {
      logger(`[pixiv] 登录态失效（${state.evidence}），但没有可用的主人会话，跳过提醒`);
      return;
    }
    const cached = artistCacheSize();
    try {
      await send(key, `Pixiv 的登录态过期了，按名字搜画师暂时不能用（已经查过的 ${cached} 个画师名字有本地缓存，照旧能用；按画师号发作品也不受影响）。`
        + '要恢复的话，在浏览器登录 pixiv 后把新的 PHPSESSID 发我一次就行。');
      logger(`[pixiv] 已提醒主人 cookie 失效（${state.evidence}）`);
    } catch (e) {
      logger(`[pixiv] 失效提醒发送失败: ${e?.message ?? e}`);
    }
    writeState({ ...st, invalid: true, lastNotifyAt: Date.now(), lastEvidence: state.evidence });
  };

  const firstTimer = setTimeout(() => { void tick(); }, FIRST_DELAY_MS);
  const timer = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  try { timer.unref?.(); firstTimer.unref?.(); } catch { /* 忽略 */ }
  return () => { stopped = true; clearInterval(timer); clearTimeout(firstTimer); };
}
