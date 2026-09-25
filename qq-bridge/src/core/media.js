// 富媒体/卡片发送 + 音乐搜索
// 无跨域状态；cfg 由工厂参数静态注入。
import { sleep } from '../lib/async.js';
import { randInt } from '../lib/rand.js';
import { log } from '../lib/log.js';
import { enqueueSend } from './send-chain.js';
import { isDeliveredUnconfirmed, deliveredUnconfirmedResult, onebotErrText } from '../lib/onebot-delivery.js';
import { napcatImageFileArg } from '../lib/napcat-file.js';
import { safeFetchBuffer, MAX_IMAGE_FETCH_BYTES } from '../safe-fetch.js';
import fs from 'node:fs';
import path from 'node:path';

// 网易云接口统一请求头（这几个接口对 Referer 敏感，缺了会返回空 result）
const NETEASE_HEADERS = { Referer: 'https://music.163.com', 'User-Agent': 'Mozilla/5.0' };

/* 封面取图的统一请求头。
 * 先说清一个被实测否掉的猜测：线上那条 `y.gtimg.cn` 封面 404 不是缺 Referer/UA 造成的。
 * 本机实测同一个 URL 的 5 种组合（无头 / 只 UA / 只 Referer / 桌面 UA+Referer / 现状 UA+range）
 * 结果逐条完全一致：真 albummid 永远 200 image/jpeg，坏的那条永远 404。加头解决不了它（真因见
 * ensureJpegCover / qqAlbumCoverBySongMid 上的注释）。这里仍然带上 Referer + 桌面 UA，是因为
 * 调用方传进来的 `image` 可能是别的图床（pximg 那类按 Referer 防盗链，safe-fetch 里已有同样的先例）。 */
const COVER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  referer: 'https://y.qq.com/',
  accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
};
/* 封面探活只读"头部若干字节"来判真伪，不落盘（正文由签名服务自己去取）——
 * 上限 64KB 是"读头部"的量级；整图下载走 safe-fetch 的 MAX_IMAGE_FETCH_BYTES(15MB)，两者分工不同。 */
const COVER_PROBE_MAX_BYTES = 64 * 1024;
const COVER_PROBE_TIMEOUT_MS = 6000;

/** 真图片字节白名单：JPEG / PNG / WebP（实测候选里只出现过 JPEG 与 PNG）。
 *  比 safe-fetch 的 looksLikeImageBuffer 更严（那个还放 GIF）—— 卡片封面槽只吃静态图。 */
export function isRealCoverBytes(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;                          // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;       // PNG
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true; // WebP
  return false;
}

/**
 * 封面 URL 归一化 —— 手机端"网易云卡片白框"的根因处理（2026-09-16 实测，非推测）。
 *
 * 实测（node 真实请求）：
 *   · 网易云封面同时有 http / https 两种形态（老接口给 http://p2.music.126.net/...）；
 *     手机 QQ 取卡片封面走的是它自己的图片管线，明文 http 更容易被拦（电脑端宽松）→ 一律升级 https
 *     （p1/p2.music.126.net 实测 https 返回 200 image/jpg）。
 *   · 同一首歌的原图可以非常大：现场那张 id=3381504830 的卡片封面实测 4,410,875 B ≈ 4.4MB，
 *     手机端大概率加载超时白框；补网易云自家的 `?param=300y300` 后实测 210,031 B（缩 20 倍），
 *     而 QQ 音乐自己分享歌曲用的也正是 300×300 缩略图（y.gtimg.cn/.../T002R300x300M000...jpg）。
 */
export function normalizeCoverUrl(raw, size = 300) {
  let u = String(raw ?? '').trim();
  if (!u) return '';
  if (/^http:\/\//i.test(u)) u = u.replace(/^http:\/\//i, 'https://');
  // 只给网易云图补缩略参数（别人家的 CDN 参数语义不同，不猜）
  /* 2026-09-19 修「手机端没封面」的核心一处：必须带 `type=jpg`。
   * 线上逐参数实测（头 3 字节魔数：ffd8ff=JPEG / 89504e=PNG）：
   *   （无参数）                                 89504e  4,410,875 字节  ← 原图是 4.4MB 的 PNG
   *   ?param=300y300                             89504e    210,146 字节  ← 缩了，但还是 PNG
   *   ?imageView=1&thumbnail=300x300             89504e    210,146 字节  ← 仍是 PNG
   *   ?imageView=1&thumbnail=300x300&type=jpg    ffd8ff       20,913 字节  ← 真 JPEG（只有这个形态）
   * 也就是说：网易云封面写着 .jpg、content-type 也报 image/jpg，字节其实是 PNG ——
   * 手机端按内容判格式、于是不渲染（电脑端宽容所以能看）。加 `type=jpg` 让网易云自己转成 JPEG 即可，
   * 不用第三方代理（第三方代理会让签名服务取图变慢，实测把卡片拖到超时降级）。 */
  if (/music\.126\.net\//i.test(u)) {
    if (/[?&]type=jpg/i.test(u)) {
      // 已经带着 type=jpg 了，别重复拼
    } else if (/[?&]imageView=/i.test(u)) {
      u += /[?&]thumbnail=/i.test(u) ? '&type=jpg' : `&thumbnail=${size}x${size}&type=jpg`;
    } else {
      u += `${u.includes('?') ? '&' : '?'}imageView=1&thumbnail=${size}x${size}&type=jpg`;
    }
    /* 2026-09-19：再把路径里那个 `==`（网易云图床的加密 id 末尾填充）百分号编码掉：
     * 手机端唯一验证过能显示的封面形态是 `https://y.qq.com/music/photo_new/T002R300x300M000<albummid>.jpg`
     * —— 干干净净一段路径 + 一个 .jpg，既没有 `=` 也没有查询串。而网易云这边
     * `fQOLZwjHwUqLAQs3b_yzUg==/109951173276565105.jpg?...` 路径里带着 `==`，
     * 是它与"已知能显示"的形状之间仅剩的结构差异（图本身没问题：实测是标准的
     * 基线 SOF0 / 300×300 / 3 分量 YCbCr JPEG，和腾讯那张逐字段一致）。
     * 编码后指向同一张图（实测 200 / JPEG / 23183 字节，字节数与编码前完全相同）。
     * 只动路径部分，查询串原样保留。 */
    const qi = u.indexOf('?');
    const pathPart = qi < 0 ? u : u.slice(0, qi);
    const queryPart = qi < 0 ? '' : u.slice(qi);
    u = pathPart.replace(/=/g, '%3D') + queryPart;
  }
  return u;
}

/** 媒体 URL 归一化：手机端同样不吃明文 http（网易云 m*.music.126.net 实测支持 https） */
export function normalizeMediaUrl(raw) {
  const u = String(raw ?? '').trim();
  if (!u) return '';
  return /^http:\/\//i.test(u) ? u.replace(/^http:\/\//i, 'https://') : u;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 音乐分享卡：照抄真机分享的形状（2026-09-19 定稿）
 *
 * 为什么推翻了之前所有写法：手机端一直"没出图"，而电脑端正常。真因不是封面 URL
 * —— 我前后试遍了原始 y.qq.com、wsrv 代理、qq.ugcimg.cn 转存、网易云 PNG/JPEG，
 * 全都一样没图。用户从手机 App 分享进来的两张真卡才给出答案（现场抓的原始 Ark）：
 *
 *   QQ音乐    分享 → app=com.tencent.tuwen.lua, view=news, meta.news,
 *                    jumpUrl=https://i.y.qq.com/v8/playsong.html?platform=11&appshare=android_qq…
 *                    preview=https://pic.ugcimg.cn/0210d0f2bd805547b519bce78eecf897/jpg1
 *   网易云音乐 分享 → app=com.tencent.tuwen.lua, view=news, meta.news,
 *                    jumpUrl=https://y.music.163.com/m/song?id=2041026502&…
 *                    preview=https://pic.ugcimg.cn/6534c6954eb16462f326c1e774db1002/jpg1
 *
 * 也就是说：真机分享根本不是 `com.tencent.music.lua`，而是 `com.tencent.tuwen.lua` +
 * `view=news` + `meta.news` 的"图文卡"。我们一直拼的 `music.lua` 那个版式，
 * 手机端就不画封面（电脑端宽容，所以你看到"电脑上都有"）。
 * 交叉印证：位置卡当初拼的就是这个 tuwen/news 形状，用户确认手机上正常显示；
 * 群里真人从 B 站分享的卡是 `com.tencent.miniapp_01`，同样能出图。
 * 三张真卡能出图、零张 music.lua 能出图 —— 差别是版式，不是图片。
 *
 * 顺带修掉的"将要访问"：真卡的 jumpUrl 用的是手机播放页
 * （`i.y.qq.com/v8/playsong.html?...songmid=…` / `y.music.163.com/m/song?id=…`），
 * 点开直接进播放器；我们之前用的是桌面歌页 `y.qq.com/n/ryqq/songDetail/…`，
 * 那才会被 QQ 盖上"将要访问"那层安全页。照抄真卡的 jumpUrl 就同时解决了这条。
 *
 * 但版式不能自己拼 —— 这张 Ark 必须由签名服务签：手写 Ark 的 `config.token` 是随机的，
 * QQ 服务端一律拒收 —— 消息只写进本地库、对方什么都收不到（判据：`real_seq` 不前进）。
 * 实测 4 个变体（补 `uin`、换 jumpUrl、去 `&`）全灭。
 * 正确的做法见下面 buildMusicCard 两条分支：仍然交给签名服务，只是 payload 里不带 `audio`
 * —— 它就会签出 `tuwen.lua` + `view:news`（真机分享的版式），且带合法签名所以能送达。
 *
 * 弃用的东西：以前这里有一个 `buildShareNewsCard()`，作用是"自己拼一张 tuwen Ark"。
 * 已删掉：那条路根本发不出去，留着只会被再捡起来用。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** QQ 音乐的手机播放页（真卡用的就是这个；桌面歌页会被"将要访问"拦一层）。 */
export function qqMobilePlayUrl(songmid) {
  const mid = String(songmid ?? '').trim();
  if (!mid) return '';
  return 'https://i.y.qq.com/v8/playsong.html?platform=11&appshare=android_qq&appversion=20080008'
    + `&hosteuin=null&songmid=${encodeURIComponent(mid)}&type=0&appsongtype=1&_wv=1&source=qq&ADTAG=qfshare`;
}

/** 网易云的手机歌曲页（同理，照抄真卡）。 */
export function neteaseMobileSongUrl(id) {
  const sid = String(id ?? '').trim();
  return sid ? `https://y.music.163.com/m/song?id=${encodeURIComponent(sid)}` : '';
}

/* 2026-09-24：网易云卡片的 `jumpUrl` 改成"真机分享那一串"。
 *
 * 现场：主人从网易云 App 分享《Anticipation (期予)》进 QQ（16:09:49），桥抓到了那张真卡：
 *   jumpUrl = https://y.music.163.com/m/song?id=<id>&uct2=…&fx-wechatnew=t1&fx-wxqd=&fx-wordtest=
 *             &fx-listentest=t3&ts-wakeup=&H5_DownloadVIPGift=&playerUIModeId=1379005
 *             &PlayerStyles_SynchronousSharing=t3&dlt=0846&app_version=9.5.81
 * 而我们签出来的卡里只有一个裸 `https://y.music.163.com/m/song?id=<id>` —— 主人点我们的卡会过
 * QQ 的「将要访问」中转页，点真卡不会。真卡那一串是 App 分享时带上的"应用内打开"标记（QQ 认它），
 * 所以照抄参数集就够了。
 *
 * 唯一的例外是 `uct2`：那是**分享者本人**的账号令牌（主人两次分享是同一个值），
 * 换个人发就等于把主人的令牌抄到别人的卡里 —— 所以默认**不带它**；只有配置里显式填了
 * `social.send.neteaseUct2`、**且这一条就是发给主人自己**（`private:<ownerQQ>`）时，才由
 * console-server 传进来（`opts.uct2`）。名字骗人：它其实只是网易云"网页转 App"的会话令牌，
 * 带上它只是为了跟真卡一字不差，用来验证"参数不全 → QQ 盖中转页"这条猜测。
 * 想彻底回退到裸链接：`social.send.neteaseShareUrl = 'bare'`。 */
export function neteaseShareUrl(id, uct2 = '') {
  const sid = String(id ?? '').trim();
  if (!sid) return '';
  const tok = String(uct2 ?? '').trim();
  return 'https://y.music.163.com/m/song?id=' + encodeURIComponent(sid)
    + (tok ? '&uct2=' + encodeURIComponent(tok) : '')
    + '&fx-wechatnew=t1&fx-wxqd=&fx-wordtest=&fx-listentest=t3&ts-wakeup='
    + '&H5_DownloadVIPGift=&playerUIModeId=1379005&PlayerStyles_SynchronousSharing=t3'
    + '&dlt=0846&app_version=9.5.81';
}

/* 2026-09-24 晚：jumpUrl 不再"硬抄主人那张卡的参数"，改成**现问网易云要**。
 *
 * 主人 00:2x 的现场反馈把结论钉死了：抄成同一串参数的卡是"真卡"，缺 `uct2` 的那几张"被（中转页）
 * 挡住"。而 `uct2` 是**分享者本人的网易云令牌**，不该跟着发给别人 —— 于是去问网易云自己：
 * 手机页 `https://y.music.163.com/m/song?id=<id>` 的 HTML 里本来就带着"在 App 中打开"的整串，
 * 其中 `uct2` 是**访客令牌**（不用登录、与主人账号无关；实测 `uct2=rNNpzs6BgjLZ+rQwDhG0Xg==`，
 * 而且页面里给的整串是 `…&fx-wxqd=&playerUIModeId=76001&app_version=9.5.90&ts-wakeup=&fx-wechatnew=t1…`）。
 * 也就是说：真机分享的那串就是这张网页自己给的链接 —— 直接用它的，比抄主人的更"真"。
 *
 * 取不到（超时/改版）就退回静态拼串 `neteaseShareUrl()`，整条链路绝不吃网络失败。 */
const NETEASE_WEB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const neteaseShareLinkCache = new Map(); // id → { url, at }（只缓存"从页面取到的"结果）

export async function neteaseShareLink(id, fallbackUct2 = '') {
  const sid = String(id ?? '').trim();
  if (!sid) return '';
  const hit = neteaseShareLinkCache.get(sid);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.url;
  let fromPage = '';
  try {
    const res = await fetch(`https://y.music.163.com/m/song?id=${encodeURIComponent(sid)}`, {
      headers: { 'User-Agent': NETEASE_WEB_UA, Referer: 'https://music.163.com/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000)
    });
    const html = await res.text();
    /* 页面里"在 App 中打开"的那一串。坑：同一种网页，有的把链接直接写成 URL，有的塞在 JSON 里
     * 用 `\u0026` 转义 `&` —— 后者会把整串截成只剩 `?id=…`（实测 id=1492604442 就是这样）。
     * 所以：先允许反斜杠、再把 `\u0026` 还原，最后**只认带上 uct2 的结果**，
     * 否则宁可退回静态拼串，绝不把裸链接塞进卡片（裸链接正是过中转页的那种）。 */
    const raw = html.match(new RegExp(`https://y\\.music\\.163\\.com/m/song\\?id=${sid}[^"'\\s<>]*`));
    const tok = html.match(/uct2=([^"'\s&,}<\\]+)/);
    let cand = raw ? raw[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&') : '';
    if (cand && tok && !/[?&]uct2=/.test(cand)) cand += '&uct2=' + encodeURIComponent(tok[1]);
    if (cand && /[?&]uct2=/.test(cand)) fromPage = cand;
    else if (tok) fromPage = neteaseShareUrl(sid, decodeURIComponent(tok[1]));
  } catch { /* 页面拿不到 → 静态兜底 */ }
  if (!fromPage) return neteaseShareUrl(sid, fallbackUct2);
  neteaseShareLinkCache.set(sid, { url: fromPage, at: Date.now() });
  return fromPage;
}

/* 2026-09-25：**照抄真卡的封面** —— 这一轮查到的最后一处可见差异。
 *
 * 主人自己分享的网易云真卡，封面 URL 是 QQ 自己的图床：
 *   https://pic.ugcimg.cn/b4e1059521b8acbe8bc26511029aeea6/jpg1
 * 那个 32 位 hex 是 QQ 的文件 id（**不是字节 md5**：实测真卡那张取到 200 / image/jpeg / 4641 字节，
 * 其 md5 = 178951988630399c84842b2acfafe196，与路径里的 b4e105… 对不上；随便编一个 hash 去取，
 * 会拿到一张 700 字节的占位 PNG）。这种 id 只有 QQ 客户端经自家 SDK 上传才有，桥造不出来
 * （桥把图先发到 QQ 再取到的是 `qq.ugcimg.cn/v1/<超长>`，正是"手机端不显示封面"的那个形态）。
 *
 * 但这里有个便宜可捡：**那个 URL 是公开可读的**，而桥本来就把收到的每张卡原样存进
 * `state/incoming-cards.jsonl` —— 于是只要这首歌被分享进来过一次，我们就能直接照抄真卡的封面 URL，
 * 封面与真卡逐字节同源（真卡显示得出来，我们这张就一定显示得出来）。命中不了才退回网易云原图。
 *
 * 只认 QQ 自家图床域名 + 网易云 appid（100495085）+ jumpUrl 里的歌曲 id，避免抄错别人的封面。 */
const QQ_COVER_HOST_RE = /^https?:\/\/([a-z0-9-]+\.)*(ugcimg\.cn|qq\.com)\//i;
const neteaseRealCovers = new Map(); // songId → preview URL
let neteaseRealCoversMtimeMs = -1;

function loadNeteaseRealCovers() {
  try {
    const file = path.join(process.cwd(), 'state', 'incoming-cards.jsonl');
    const st = fs.statSync(file);
    if (st.mtimeMs === neteaseRealCoversMtimeMs) return;
    neteaseRealCoversMtimeMs = st.mtimeMs;
    let added = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const rawData = row?.raw?.data;
      if (typeof rawData !== 'string' || !rawData.includes('100495085')) continue;
      let card; try { card = JSON.parse(rawData); } catch { continue; }
      for (const bucket of Object.values(card?.meta ?? {})) {
        const cover = String(bucket?.preview ?? '').trim();
        const jump = String(bucket?.jumpUrl ?? '').trim();
        const sid = (jump.match(/[?&]id=(\d+)/) ?? [])[1] ?? '';
        if (!sid || !cover || !QQ_COVER_HOST_RE.test(cover)) continue;
        if (neteaseRealCovers.get(sid) !== cover) { neteaseRealCovers.set(sid, cover); added += 1; }
      }
    }
    if (added) log(`[cover] 收录 ${added} 首"真卡封面"（照抄主人分享过的卡，封面与真卡同源）`);
  } catch { /* 没有这份记录就照旧用网易云原图 */ }
}

export function neteaseRealCover(id) {
  const sid = String(id ?? '').trim();
  if (!sid) return '';
  loadNeteaseRealCovers();
  return neteaseRealCovers.get(sid) ?? '';
}



/**
 * 音乐分享的发送梯子：卡片 → NapCat 原生卡片 → 纯链接。
 * 需求：卡片发不出去时分享动作不能整体失败，必须还能落到一条能点开的官方链接。
 *
 * 做成独立导出（发送器由调用方注入）是为了能离线单测这把梯子 —— 见 tools/test-music-card.mjs。
 * 返回 { ok, card: 'primary'|'native'|'link', seg, messageId, degradedFrom? }。
 */
export async function sendMusicCardWithFallback({ key, plan = null, seg = null, options = {}, sendRichFn, sendText }) {
  const sendLink = async () => {
    const sent = await sendText(plan.link);
    return {
      ok: true,
      card: 'link',
      seg: { type: '_shareText', data: { title: plan?.title ?? '', url: plan.link } },
      messageId: sent?.messageId ?? null
    };
  };
  if (seg) {
    try {
      const sent = await sendRichFn(key, seg, options);
      return { ok: true, card: 'primary', seg, messageId: sent?.messageId ?? null };
    } catch (primaryError) {
      // ① 退回 NapCat 原生 id 卡片（老行为）
      if (plan?.native) {
        try {
          const sent = await sendRichFn(key, plan.native, options);
          return { ok: true, card: 'native', seg: plan.native, messageId: sent?.messageId ?? null, degradedFrom: primaryError };
        } catch { /* 继续降级 */ }
      }
      // ② 退回纯链接
      if (plan?.link && typeof sendText === 'function') {
        const out = await sendLink();
        return { ...out, degradedFrom: primaryError };
      }
      throw primaryError;
    }
  }
  // 压根没有卡片段（例如 custom 卡片字段不全）：直接发链接
  if (plan?.link && typeof sendText === 'function') return sendLink();
  throw new Error('没有可发送的卡片段或兜底链接');
}

export function createMediaDomain(cfg) {

  /* 音乐分享卡的版式：默认 `share` —— 与真机分享卡同版式（tuwen/news），手机端画封面，
   * 点开行为也"和真卡一样"（连真卡都会被 QQ 的「将要访问」拦一层，这不是版式能解决的）。
   * 显式配置（`social.send.musicCardStyle` 或 `QQBRIDGE_MUSIC_CARD_STYLE`，值 share|music|native）
   * 一律优先；`music` 版式仍在（QQ 内播形态），但它既不省中转页、手机端又不画封面，故不当默认。 */
  const MUSIC_CARD_STYLE = String(
    process.env.QQBRIDGE_MUSIC_CARD_STYLE ?? cfg?.social?.send?.musicCardStyle ?? ''
  ).trim().toLowerCase();

  /* ── 同一张卡短时间内的重复发送防护（2026-09-19）───────────────────────────────
   * 现场：用户说"重发两个音乐"，结果每条都发了两遍（08:23:00/05 一次，08:23:23/34 又一次）。
   * 日志里的原因很清楚：
   *   08:22:42 [default] 回合卡死判定：session-16a704b5… 完全静默超过 180s（无任何事件），强制隔离
   *   08:22:42 [default] 卡死会话已隔离 → private:***（下次唤醒重建新会话）
   *   08:22:44 [default] private:*** 轮换后首轮唤醒，注入完整 prompt（含最近 24 条窗口，轮换加长）
   * 也就是：桥判定旧回合卡死 → 轮换成新会话 → 把最近 24 条（含那条"重发两个音乐"）重新喂给模型；
   * 而旧回合其实还活着，它也把卡片发完了 → 两条路各发一遍。
   *
   * 为什么在这里兜而不是去改隔离逻辑：隔离是必要的（真卡死的会话必须能救），
   * 而"救援时把同一批消息再喂一遍"是它的设计前提 —— 在 DSH 那边没有可靠办法确认
   * 旧回合是否真的停下。所以加一道幂等网：同一会话 + 同一段内容，短时间内只发一次。
   * 窗口 60s：线上这两次重复相隔 23s/29s；而"用户明确要求再发一遍"通常也远超过这个间隔。 */
  const RICH_DEDUPE_MS = Number(process.env.QQBRIDGE_RICH_DEDUPE_MS ?? 60000);
  const richRecent = new Map(); // `${key}|${JSON(seg)}` -> { at, messageId }

  // 发送富文本/卡片消息段（music/contact/location/json/xml/dice/rps），与文本/表情共用发送链。
  async function sendRich(key, seg, options = {}) {
    /* 去重只看内容本身（不含 replyTo/at —— 那些是每次调用的装饰，不影响"是不是同一张卡"）。
     * 被挡下来时返回上一次的结果与 messageId，调用方拿到的回执与真发出去那次一致，
     * 不会因为"跳过了"而误判成发送失败。 */
    const dedupeKey = `${key}|${JSON.stringify(seg)}`;
    if (RICH_DEDUPE_MS > 0) {
      const prev = richRecent.get(dedupeKey);
      if (prev && Date.now() - prev.at < RICH_DEDUPE_MS) {
        log(`[rich] 疑似重复发送，已跳过（${Math.round((Date.now() - prev.at) / 1000)}s 前刚发过同一张卡）${key}：${String(seg?.type)}`);
        return { messageId: prev.messageId ?? null, deduped: true };
      }
      // 顺手清掉过期项，避免这张表无限长
      for (const [k, v] of richRecent) if (Date.now() - v.at >= RICH_DEDUPE_MS) richRecent.delete(k);
    }
    const out = await sendRichOnce(key, seg, options);
    if (RICH_DEDUPE_MS > 0) richRecent.set(dedupeKey, { at: Date.now(), messageId: out?.messageId ?? null });
    return out;
  }

  async function sendRichOnce(key, seg, options = {}) {
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
      segments.push({ type: 'text', data: { text: ' ' } });
    }
    segments.push(seg);
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    let settled = false;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = (v) => { settled = true; resolve(v); };
      sendReject = (e) => { settled = true; reject(e); };
    });
    const sendRun = enqueueSend(async () => {
      try {
        await sleep(randInt(500, 1500));
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          /* 2026-09-19 修「网易云卡发成纯链接」：这个超时覆盖整条发送链（含 buildMusicCard 里的
           * 取歌详情 + 解析音频直链 + 封面探活）。原来 15s 太紧：网易云那条光解析就要十几秒
           * （neteaseSongDetails 8s + 音频直链候选），线上实测直接把卡片拖成 `card=link`
           * （日志 `music 卡片降级 card=link（The operation was aborted due to timeout）`）。
           * 放宽到 45s —— 宁可慢一点，也不要"默默降级成一条没有封面的链接"。 */
          signal: AbortSignal.timeout(45000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          // 已送达未确认（EventChecker Failed）：卡片其实已经发出去了，别报失败（见 lib/onebot-delivery.js）
          const errText = onebotErrText(body);
          if (isDeliveredUnconfirmed(errText)) {
            log(`[rich] ${action} 回执 EventChecker Failed —— 卡片已发出（只是事件确认失败），按已送达处理`);
            sendResolve(deliveredUnconfirmedResult());
            return;
          }
          const hint = res.status === 426 ? '（HTTP 426：napcat.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    }, key);
    // 会话重置/隔离（cancelKeyedSends）时 send-chain 会跳过已入链但未开始的任务——回调根本不会执行，
    // 上面的 sendResult 就永不 settle，调用方（qq_send_rich 等工具）会永久挂起。
    // 链上任务结算后仍未 settle，说明本任务被跳过，这里补一个明确失败。
    void sendRun.then(
      () => { if (!settled) sendReject(new Error('发送任务已被会话重置取消（未发出）')); },
      (e) => { if (!settled) sendReject(e); }
    );
    const data = await sendResult;
    return { messageId: data?.message_id ?? null };
  }

  /* ── 封面为什么要先搬到 QQ 图床 ───────────────────────────────────────────────
   * 2026-09-19 修「手机端音乐卡片封面空白、电脑端正常」
   * 实测对照（线上同一台机器，两条卡都发到账号所有者的私聊）：
   *
   *   对照A：直接把网易云的外部封面 URL 交给卡片
   *     → 卡里 preview = https://p2.music.126.net/…jpg?param=300y300   （外部域名）
   *     → 手机端空白、电脑端正常
   *   对照B：先把同一张图发一遍换成 QQ 图床 URL，再把那个 URL 交给卡片
   *     → 卡里 preview = https://qq.ugcimg.cn/v1/kgij0dgo…             （QQ 自己的 CDN）
   *     → 与用户从高德/腾讯地图分享进来的真卡同一个域名（真卡 preview 也是 qq.ugcimg.cn / qpic.cn）
   *
   * 也就是说：卡片里的图必须是 QQ 自己的图床地址，手机端才肯加载；外部 URL 电脑端能读、手机端不读。
   * NapCat 那个音乐签名服务（`musicSignUrl` 默认 http://106.55.0.102:10087/）对 QQ 域名的图会转存成
   * `qq.ugcimg.cn/v1/…`，对外部 URL 则原样透传 —— 所以桥这边得先把图送进 QQ。
   *
   * 怎么"安静地"把图送进 QQ：发给机器人自己的 QQ（user_id = 自己的 uin，就是"我的设备"那个会话）——
   * 实测 200 且能回读到 `https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=…` 的图床地址，
   * 不会在任何人（包括账号所有者）的聊天里留下气泡。拿到的地址缓存起来，同一张封面只搬一次。
   */
  const qqHostedCache = new Map();
  let botUin = 0;
  const NAPCAT_HTTP = () => String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const NAPCAT_HDR = () => ({ 'content-type': 'application/json', ...(cfg.napcat?.accessToken ? { authorization: `Bearer ${cfg.napcat.accessToken}` } : {}) });

  function isQqHosted(u) {
    try { return /(^|\.)(qpic\.cn|qq\.com|ugcimg\.cn)$/i.test(new URL(u).hostname); } catch { return false; }
  }

  /* 2026-09-19 定稿：封面一律原样交给签名服务，绝不过第三方代理
   *
   * 上一版我加了"腾讯封面先过 wsrv 代理"，那是错的，而且正是它把卡弄坏的。真相从真消息记录里读出来
   * （工具：`tools/dump-ark.mjs` / `dump-ark-raw.mjs`，直接查 NapCat 里存着的 Ark）：
   *
   *   [能用]（用户确认"正常"）  05:25:10 / 05:27:54
   *        preview = https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg   ← 原始封面，原样透传
   *   [没图]                    08:04:18
   *        preview = https://qq.ugcimg.cn/v1/hdlclgnmhd0qtck5dvkiruk667cqv5lprg0c9p2olq87udhofqc027i9nbp2clt3c6h28kgcl5i6dlu4a7ltrtusou3gsbf0m2dn0rdm6rq4gmonnhe7ld41boild85krpcu91jrlrdpi45fllreqclcq1d9cojdetr5ce4altd3i97lpb5m2d38er1s0dni20rsma4hhp5kplb1gtp5bgts930juiu77n5kkog/kroub78d5sj37lujbs3qjuiio0
   *
   * 也就是：图能被签名服务取到 → 它把图"转存"到 qq.ugcimg.cn → 那个转存链接手机端不渲染（还顺带
   * 把发送拖到 45s 超时、卡片降级成一条纯链接：线上 `music 卡片降级 card=link（The operation was aborted due to timeout）`）。
   * 而原始外部 URL（y.qq.com / y.gtimg.cn / p*.music.126.net）它会原样透传 —— 那条路才是对的。
   *
   * 我当初得出"腾讯封面取不到"的根据是一份读错返回的对照测试：签名服务的返回体是
   * 被 JSON 编码过一次的字符串，只 parse 一层就拿不到 `app`/`preview`，于是每一张卡都被误判成
   * "卡片构造失败（card=link）"。那个坑现在已在 tools/test-qq-card-sign.mjs 里处理掉。
   *
   * 所以这里不再改写 URL，只做把关 + 诊断（把封面的真实字节格式打到日志里，方便下次一眼看出
   * "是不是真图"）。网易云那种"字节是 PNG"的情况，由它自己的 CDN 参数解决（见 normalizeCoverUrl 的 `type=jpg`）。 */
  /* 2026-09-19 本机实测：封面 404 的真因不是请求头，而且 404 的东西以前照样被发出去了。
   *
   * ① 请求头不是原因（实测，不是推测）：把线上那条 404 的 URL 与一条好的 URL 放在一起，
   *    用 5 种组合各打一遍 —— 无头 / 只 UA=Mozilla/5.0 / 只 Referer / 桌面 UA+Referer / 现状 UA+range：
   *      好 albummid `004fXSyj3bWTMN` → 五种全是 200 image/jpeg、magic ffd8ff（36246 字节）
   *      坏的那条 `0047TsYA2meOa2`  → 五种全是 404（y.gtimg.cn 空体 text/plain；y.qq.com 102 字节
   *                                  text/html，magic 54686520 = "The " 的 ASCII）
   *    连尺寸模板（90x90/150x150/300x300/500x500/800x800）× 两个域（y.gtimg.cn / y.qq.com）交叉打了 20 次，
   *    坏的那些一次都没成功。所以加 Referer/UA 修不了它。
   * ② 真因：那个 mid 根本不是 albummid。拿 c.y.qq.com 官方搜索接口回查同一首歌
   *    （`w=夜空的寂静`）→ `songmid=0047TsYA2meOa2`、`albummid` 是空的；而封面模板
   *    `photo_new/T002R300x300M000<albummid>.jpg` 只认 albummid → 必然是 404。
   *    修法见 `qqAlbumCoverBySongMid()`：拿不到 albummid 就找官方接口补，补不到才走兜底。
   * ③ 真正让用户看见"卡片没封面"的是这一段旧代码：它探到 404 后照样把 URL 原样返回并打印
   *    "仍然原样发出去"。所以这里从"只诊断"改成"把关"：不是真图片字节就返回空串，
   *    由调用方走兜底（QQ 音乐 → 官方分享链接；网易云 → NapCat 原生卡），
   *    绝不把一个 404 页/空体当封面交给签名服务（否则 QQ 收到的就是"有卡无图"）。
   * 仍然绝不代理封面（见上一大段）：代理会让签名服务把它转存成手机不渲染的 qq.ugcimg.cn 链接。 */
  function ensureJpegCover(cover, ct = '', opts = {}, magic = '') {
    const raw = String(cover ?? '').trim();
    if (!raw) return '';
    /* magic 优先（探活时读到的真实首字节），没有 magic 才退回 content-type ——
     * 线上那个 404 的 content-type 是 text/plain，但换一个 CDN 完全可能是 200 image/jpeg 包着 HTML。 */
    const okMagic = /^(ffd8ff|89504e|524946)$/i.test(String(magic || ''));
    const isImage = magic ? okMagic : /^image\/(jpeg|jpg|png|webp)$/i.test(String(ct || ''));
    if (!isImage) {
      log(`[cover] 封面不是真图片（magic=${magic || '未知'} ct=${ct || '未知'}）—— **丢掉这张封面、走兜底**（绝不把 404 页/空体当封面发出去）：${raw.slice(0, 90)}`);
      return '';
    }
    if (/^(89504e|524946)$/i.test(String(magic || ''))) {
      log(`[cover] 封面是真图片但不是 JPEG（magic=${magic} ct=${ct}）—— 原样发（网易云那类 PNG 由它自己的 type=jpg 参数解决，绝不代理）`);
    }
    return raw;
  }

  /**
   * 封面候选逐个探活：返回第一个真能取到的（200 + `image/*`）。
   *
   * 2026-09-19 修「QQ音乐卡封面时好时坏」
   * 两个来源的封面都会坏，而且是间歇性的：
   *   · `qq_music_search` 按 albummid 拼的 `y.gtimg.cn/music/photo_new/T002R300x300M000<albummid>.jpg`
   *     —— 同一个 URL 实测前一次 404 text/plain、几分钟后 200 image/jpeg（CDN 边缘/防盗链级别的不稳定）；
   *   · 聚合站 secapi 返回的封面是同一个模板的另一个 albummid，同样会坏。
   * 所以"谁优先"这种规则没有意义 —— 必须探活：谁真能取到就用谁。
   * 全部探不到就等 800ms 再探一轮（抖动多半是瞬时的）；仍然探不到就不再拿封面，
   * 走调用方的兜底（这条在 2026-09-19 改掉：见 pickImage 末尾——旧代码"兜底用第一个候选"，
   * 结果把一张 404 页当封面发了出去，线上就是"卡片有、封面空白"）。
   */
  /* 2026-09-19 修「QQ音乐卡又没封面了」：封面域名 `y.gtimg.cn` → `y.qq.com`。
   *
   * 线索：用户手机上 `y.gtimg.cn` 的封面时有时无，而网易云真卡的封面是
   * `p1.music.126.net`（同样是外部域名）一直正常 —— 所以不是"外链就不能用"，
   * 而是 `y.gtimg.cn` 这个域在本机客户端上不可靠（它常做防盗链/限流）。
   * 实测同一个 albummid：`y.qq.com/music/photo_new/T002R300x300M000<albummid>.jpg`
   * 与 `y.gtimg.cn/…` 返回完全一样的图（都是 200 image/jpeg、11028 字节），
   * 而 `y.qq.com` 是腾讯主域、更稳。所以统一改写成 `y.qq.com`；别的域名（网易云、p.qpic.cn…）原样不动。 */
  const preferStableQqCover = (u) => String(u ?? '').trim().replace(/^https?:\/\/y\.gtimg\.cn\//i, 'https://y.qq.com/');

  /** 探一个图片 URL：{ ok, ct, magic, status, bytes }。
   *  magic = 头 3 字节的十六进制。为什么要它：线上实测网易云的封面 URL 写着 `.jpg`、
   *  content-type 也报 `image/jpg`，但字节是 PNG（magic `89504e`）—— 光看扩展名和 content-type
   *  分不出来，而手机端正是按内容判断、于是不渲染（这就是"电脑能看手机不行"的最后一个原因）。
   *
   *  2026-09-19 本机实测后改写的三处
   *   · 不能再只信 `content-type`：线上那条 404 是 `text/plain`（y.gtimg.cn）/`text/html`（y.qq.com），
   *     但别的 CDN 完全可能 200 + `image/jpeg` 包一段 HTML → 必须按首字节判（isRealCoverBytes）。
   *   · 丢掉 `range: bytes=0-16`：它让好 URL 返回 206 + 17 字节（本身没错，实测仍能判 magic），
   *     但正文被截成 17 字节后就没法校验 RIFF/WEBP 这种"要看到第 12 字节"的格式，也拿不到真实 content-length。
   *   · 明确 `redirect: 'follow'` + 6s 超时 + 只读 64KB 就掐断（实测这两个域都不跳转，
   *     `final` 与请求 URL 一致；留着是因为 CDN 换签名地址时会 302 到带 token 的图）。 */
  async function readBoundedBytes(res, maxBytes) {
    const reader = res?.body?.getReader?.();
    if (!reader) return Buffer.alloc(0);
    const chunks = [];
    let size = 0;
    try {
      while (size < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(Buffer.from(value)); size += value.length; }
      }
    } catch { /* 读一半被掐断没关系：只要够判格式 */ } finally { try { await reader.cancel(); } catch {} }
    return Buffer.concat(chunks).subarray(0, maxBytes);
  }

  async function probeImage(u) {
    try {
      const res = await fetch(u, { headers: COVER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(COVER_PROBE_TIMEOUT_MS) });
      const ct = String(res.headers.get('content-type') || '');
      const buf = await readBoundedBytes(res, COVER_PROBE_MAX_BYTES);
      const magic = buf.subarray(0, 3).toString('hex');
      return { ok: res.ok && isRealCoverBytes(buf), ct, magic, status: res.status, bytes: buf.length };
    } catch (error) {
      return { ok: false, ct: '', magic: '', status: 0, bytes: 0, err: String(error?.message ?? error) };
    }
  }

  /** 挑一个真能取到真图片的封面，并把它实际的 content-type 一并带回来。 */
  async function pickImage(candidates, rescue = null) {
    const list = [...new Set(candidates.map((u) => String(u ?? '').trim()).filter(Boolean))];
    const probeList = async (arr) => {
      for (const u of arr) {
        const p = await probeImage(u);
        if (p.ok) return { url: u, ct: p.ct, magic: p.magic };
        log(`[cover] 候选封面取不到（${p.status} ${String(p.ct).slice(0, 20)}${p.err ? ' ' + p.err : ''}），换下一个：${u.slice(0, 90)}`);
      }
      return null;
    };
    /* rescue() 可能调外网接口（QQ 官方 API），失败/超时都只当"补不到候选"，绝不让它把卡片拖挂。 */
    const safeRescue = async () => {
      try {
        const extra = await rescue();
        return (Array.isArray(extra) ? extra : []).map((u) => String(u ?? '').trim()).filter(Boolean);
      } catch (error) {
        log(`[cover] 补封面候选失败：${error?.message ?? error}`);
        return [];
      }
    };
    if (!list.length) {
      /* 候选被前面的规则剔干净了（例如"只给了 songmid 拼的封面"）——仍然要试一次 rescue：
       * 线上那条 0047TsYA2meOa2 就正好走这条（聚合站/调用方给的唯一候选是 songmid 拼的假封面）。 */
      const hit = typeof rescue === 'function' ? await probeList(await safeRescue()) : null;
      if (hit) return hit;
      log('[cover] 没有可用的封面候选（含补出来的候选），不拿封面，走兜底');
      return { url: '', ct: '', magic: '' };
    }
    for (let round = 0; round < 2; round += 1) {
      const hit = await probeList(list);
      if (hit) return hit;
      if (round === 0) await sleep(800);
    }
    /* 全部探不到时再试一次"补出来的候选"（QQ 音乐：用官方接口按 songmid 补 albummid，见下）。 */
    if (typeof rescue === 'function') {
      const fresh = [...new Set(await safeRescue())].filter((u) => !list.includes(u));
      if (fresh.length) log(`[cover] 换用官方接口补出来的封面候选再探：${fresh.map((u) => u.slice(0, 90)).join(' , ')}`);
      const hit = await probeList(fresh);
      if (hit) return hit;
    }
    /* 2026-09-19 关键改动：不再"兜底用第一个"。
     * 旧行为把探活失败的第一个候选当封面返回，于是一张 404 页/空体被当成封面发给签名服务
     * （线上症状：卡片有、封面空白，日志还写着"仍然原样发出去"）。
     * 现在统一返回空串，由调用方走已经写好的兜底：QQ 音乐 → 官方分享链接；网易云 → NapCat 原生卡。
     * 宁可少一张卡，也不发一张"有卡无图"的卡。 */
    log(`[cover] 所有候选封面都探不到真图片（含补出来的候选），本轮不拿任何一张当封面，走兜底：${list.map((u) => u.slice(0, 90)).join(' , ')}`);
    return { url: '', ct: '', magic: '' };
  }

  async function firstWorkingImage(candidates) {
    return (await pickImage(candidates)).url;
  }

  /**
   * 2026-09-19 新加·修「QQ音乐卡没封面」的真因：按 songmid 向 QQ 官方接口要真 albummid，
   * 再拼出封面候选。
   *
   * 线上那条永远 404 的 URL 是 `y.gtimg.cn/music/photo_new/T002R300x300M0000047TsYA2meOa2.jpg`：
   * 用 c.y.qq.com 官方搜索接口回查同一首歌（`w=夜空的寂静`）→ `songmid=0047TsYA2meOa2`、`albummid` 为空。
   * songmid（歌曲 id）被拼进了 albummid（专辑 id）的位置，所以无论带什么头、试什么尺寸都只能 404
   * （实测 5 尺寸 × 2 域 = 10 次全 404）。跟着聚合站/搜索接口给的空 albummid 走，这条路永远修不好。
   *
   * 官方接口实测可用（本机跑过）：
   *   POST https://u.y.qq.com/cgi-bin/musicu.fcg
   *     {req_1:{module:'music.pf_song_detail_svr',method:'get_song_detail',param:{song_mid}}}
   *   → data.track_info.album.mid
   *   001b3yxJ17AH7C → 003D4IPK14WX7e → 封面 `T002R300x300M000003D4IPK14WX7e.jpg` 实测 200 image/jpeg、10637 字节
   * （这个接口在线上一直通 —— 同一段注释里记着：取 vkey 那条被机房 IP 判无效，但歌名/封面这条是好的。）
   */
  async function qqAlbumCoverBySongMid(songmid) {
    const mid = String(songmid ?? '').trim();
    if (!mid) return [];
    try {
      const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { ...COVER_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ comm: { ct: 24, cv: 0 }, req_1: { module: 'music.pf_song_detail_svr', method: 'get_song_detail', param: { song_mid: mid } } }),
        signal: AbortSignal.timeout(8000)
      });
      const body = await res.json().catch(() => null);
      const albumMid = String(body?.req_1?.data?.track_info?.album?.mid ?? '').trim();
      if (!albumMid || albumMid === mid) {
        log(`[cover] 官方接口没给出可用的 albummid（songmid=${mid}，拿到「${albumMid}」），不猜、直接走兜底`);
        return [];
      }
      log(`[cover] QQ 音乐缺 albummid，已用官方接口按 songmid 补出 ${albumMid}（songmid=${mid}）`);
      return [`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`];
    } catch (error) {
      log(`[cover] 按 songmid 补 albummid 失败（songmid=${mid}）：${error?.message ?? error}`);
      return [];
    }
  }

  /** 外部图 → QQ 图床 URL（失败就原样返回，绝不让卡片因此发不出去）。
   *  2026-09-24 实测记录：把封面先发到 QQ 图床再进卡里，签名服务会把图**转存成**
   *  `https://qq.ugcimg.cn/v1/<超长串>` —— 正是历史上"手机端不显示封面"的那个形态，
   *  而且真机分享卡的封面域名是 `pic.ugcimg.cn/<32位>/jpg1`（网易云 App 经 QQ SDK 上传的产物），
   *  桥这两条路都造不出那个域名。结论：保持关闭，不再往外暴露按次开关。 */
  async function ensureQqHostedImage(url) {
    const src = String(url ?? '').trim();
    /* 2026-09-19 紧急回退：这套"封面先搬 QQ 图床"上线后用户反馈更糟了：
     * 网易云/QQ音乐卡封面变成都没有，网易云连播放都点不动。
     * 当初的对照实验只能证明"对照B 那条卡的 preview 字段是 qq.ugcimg.cn"，
     * 证明不了手机端就一定会显示 —— 我又拿"电脑端能看见"当了真，这次直接翻车。
     * 所以默认关掉，回到改动前"直接用外部封面 URL"的行为；要再试必须
     * `social.send.qqHostedCover = true` 显式打开，并且先在手机上验证过再谈默认。 */
    if (cfg?.social?.send?.qqHostedCover !== true) return src;
    if (!src || isQqHosted(src)) return src;
    if (qqHostedCache.has(src)) return qqHostedCache.get(src);
    try {
      /* 2026-09-19：改用 safe-fetch 的抓图助手：SSRF 校验 + 逐跳重定向重校验 + 统一体积上限
       * （MAX_IMAGE_FETCH_BYTES=15MB，全桥一个常量）+ 非图片字节直接拒。
       * 原来的裸 fetch 自带 4MB 上限，且对"返回的其实是 HTML/404 页"毫无察觉。 */
      const { buffer: buf } = await safeFetchBuffer(src, MAX_IMAGE_FETCH_BYTES, COVER_HEADERS);
      if (!buf.length) return src;
      const tmpDir = String(cfg.napcat?.tmpDir || '').trim() || path.join(process.cwd(), 'state', 'image-tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
      fs.writeFileSync(tmp, buf);
      if (!botUin) {
        const li = await fetch(`${NAPCAT_HTTP()}/get_login_info`, { method: 'POST', headers: NAPCAT_HDR(), body: '{}', signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null);
        botUin = Number(li?.data?.user_id) || 0;
      }
      if (!botUin) return src;
      const sent = await fetch(`${NAPCAT_HTTP()}/send_private_msg`, {
        method: 'POST', headers: NAPCAT_HDR(),
        body: JSON.stringify({ user_id: botUin, message: [{ type: 'image', data: { file: napcatImageFileArg(tmp, cfg) } }] }),
        signal: AbortSignal.timeout(20000)
      }).then((r) => r.json()).catch(() => null);
      const mid = sent?.data?.message_id;
      if (mid == null) { log(`[cover] 封面搬到 QQ 图床失败（send_private_msg 到自身没给 message_id），仍用外部 URL：${sent?.wording || sent?.message || ''}`); return src; }
      const got = await fetch(`${NAPCAT_HTTP()}/get_msg`, { method: 'POST', headers: NAPCAT_HDR(), body: JSON.stringify({ message_id: mid }), signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
      const seg = (got?.data?.message || []).find((s) => s?.type === 'image');
      const hosted = String(seg?.data?.url ?? '').trim();
      try { fs.unlinkSync(tmp); } catch {}
      if (!hosted) { log('[cover] 封面搬到 QQ 图床失败（get_msg 里没有 image.url），仍用外部 URL'); return src; }
      qqHostedCache.set(src, hosted);
      log(`[cover] 封面已搬到 QQ 图床（手机端才会显示）：${hosted.slice(0, 70)}…`);
      return hosted;
    } catch (error) {
      log(`[cover] 封面搬 QQ 图床异常（改用外部 URL）：${error?.message ?? error}`);
      return src;
    }
  }

  /**
   * 网易云单曲详情（封面/歌名/歌手/专辑/时长），一次最多 10 个 id。
   *
   * 为什么必须单独查一次：老接口 /api/search/get 已经不返回 album.picUrl（2026-09-16 实测只有 picId），
   * 旧代码于是回落到 album.artist.img1v1Url —— 那是歌手默认头像（每首歌返回同一张图），根本不是专辑封面。
   * 这里走 /api/song/detail（实测 https picUrl），顺带把封面归一化成 https + 300×300 缩略图。
   */
  async function neteaseSongDetails(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 10);
    const out = new Map();
    if (!list.length) return out;
    const url = `https://music.163.com/api/song/detail?ids=[${list.join(',')}]`;
    const res = await fetch(url, { headers: NETEASE_HEADERS, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    for (const s of (body?.songs || [])) {
      const id = String(s?.id ?? '');
      if (!id) continue;
      out.set(id, {
        title: String(s?.name || ''),
        artist: Array.isArray(s?.artists) ? s.artists.map((a) => a?.name || '').filter(Boolean).join('/') : '',
        album: String(s?.album?.name || ''),
        cover: normalizeCoverUrl(s?.album?.picUrl || ''),
        duration: Number(s?.duration) || 0
      });
    }
    return out;
  }

  /**
   * 音频直链：先走第三方聚合（meting），官方那个外链端点已经死了。
   *
   * 2026-09-19 修「模型发的网易云音乐点不动播放」
   * 线上实测：网易云官方的外链播放端点 `music.163.com/song/media/outer/url?id=<id>.mp3`
   * 现在对所有歌都恒返回 `302 → http://music.163.com/404`（连《晴天》这种老歌都一样），
   * 而旧代码是"拿到 Location 就直接用"，于是卡片里写进去的 `musicUrl` 就是那个 `/404` —— 播放按钮点了没反应。
   * （cookies/referer 都试过，无效；这不是我们代码写错，是对方把这条路关了。）
   *
   * 现在能用的：`https://api.injahow.cn/meting/?server=netease&type=url&id=<id>`
   * —— 实测 302 到 `https://m701.music.126.net/…/<hash>.mp3?vuutv=…` 的真 CDN 直链（跟到底 200 audio/mpeg）。
   *
   * 所以流程改成：逐个候选，只接受"看起来是真媒体"的 Location（不是 `/404`、不是 null），
   * 一个都拿不到就退回 meting 端点本身（https，客户端自己跟 302）—— 绝不再把 `/404` 写进卡片。
   */
  async function neteaseAudioUrl(id) {
    const official = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;
    const meting = `https://api.injahow.cn/meting/?server=netease&type=url&id=${encodeURIComponent(id)}`;
    const usable = (u) => /^https?:\/\//i.test(u) && !/music\.163\.com\/404/i.test(u) && !/\/404(\?|$)/i.test(u);
    for (const src of [meting, official]) {
      try {
        // 官方那个端点实测对所有歌都恒 302 到 /404（等于死的），给它短超时就行，
        // 别为了一个已知的坏候选再白等 8 秒（那 8 秒最终会算进卡片发送的总超时里）。
        const to = src === official ? 3500 : 8000;
        const res = await fetch(src, { redirect: 'manual', headers: NETEASE_HEADERS, signal: AbortSignal.timeout(to) });
        const loc = res.headers.get('location');
        try { await res.body?.cancel(); } catch {}
        if (loc && usable(loc)) {
          if (src === official) log('[music-resolve] 音频直链来自网易云官方外链端点（该端点对多数歌已返回 404，能用就用）');
          return normalizeMediaUrl(loc);
        }
        if (loc) log(`[music-resolve] ${src === official ? '官方外链端点' : 'meting'} 给的不是可用直链（${String(loc).slice(0, 60)}），换下一个候选`);
      } catch (error) {
        log(`[music-resolve] 音频直链候选失败（${src.slice(0, 40)}…）：${error?.message ?? error}`);
      }
    }
    return meting;
  }

  /** 单曲解析：卡片字段全部由桥侧拿到，模型只给 platform + id */
  async function musicResolve(platform, id) {
    const pid = String(id ?? '').trim();
    if (!pid) throw new Error('缺少歌曲 id（网易云=数字 song id，QQ 音乐=songmid）');
    if (platform === 'qq' || platform === 'qqmusic') {
      // QQ 音乐：卡片形态见 buildMusicCard 的 qq 分支（secapi 拿可播放直链）；这里只做兜底返回。
      return {
        platform: 'qqmusic',
        id: pid,
        title: '',
        artist: '',
        album: '',
        cover: '',
        audio: '',
        url: `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(pid)}`
      };
    }
    const detail = (await neteaseSongDetails([pid])).get(pid) || null;
    if (!detail) throw new Error(`网易云解析不到这首歌（id=${pid}）`);
    return {
      platform: 'netease',
      id: pid,
      title: detail.title,
      artist: detail.artist,
      album: detail.album,
      cover: detail.cover,
      audio: await neteaseAudioUrl(pid),
      url: `https://music.163.com/#/song?id=${pid}`
    };
  }

  /**
   * QQ 音乐解析：歌名/歌手/封面/可播放直链，不需要任何 key。
   *
   * 为什么不用 QQ 官方 vkey：2026-09-18 在线上这台 VPS 实测
   * `u.y.qq.com/cgi-bin/musicu.fcg` 的 `vkey.GetVkeyServer/CgiGetVkey` 直接被拒：
   *   `{"code":104009, ... "msg":"202.61.72.79;invalidq;", "purl":""}`
   * （歌名/封面的 `music.pf_song_detail_svr` 是通的，唯独取 vkey 这条把机房 IP 判成无效请求。）
   *
   * 可用的是 secapi.top 的聚合解析（2026-09-18 现场实测：不带 Authorization 也返回 200）：
   *   GET https://secapi.top/API/QQ音乐/?msg=<歌名 歌手>&list=2&n=2
   *   → {code:200, title, singer, cover, link, music_url}
   * 字段映射：title→title、singer→content(歌手)、cover→image、link→url、music_url→audio。
   *
   * 两个坑：
   *   ① `music_url` 里的 `vkey` 是带时效的直链 —— 绝不能进缓存 key，也不能存下来复用；
   *   ② 这个接口是关键词搜索，不是按 songmid 查（拿 songmid 当 msg 会返回一首完全无关的歌，
   *      实测 mid=004Fs2FP1EvZYc 返回了 "W O F"）。所以这里必须按 songmid 或歌名回检，
   *      对不上就宁可不发卡片（退官方分享链接），绝不把别人的歌当卡片发出去。
   */
  async function qqMusicResolve(mid, opts = {}) {
    const givenTitle = String(opts?.title ?? '').trim();
    const givenArtist = String(opts?.artist ?? '').trim();
    const fallbackUrl = `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(mid)}`;
    const out = {
      platform: 'qqmusic',
      id: mid,
      title: givenTitle,
      artist: givenArtist,
      /* 2026-09-19 关键修正：调用方传进来的封面不能放进 `cover`。
       * 原来 `cover` 一开始就等于 opts.image，于是 buildMusicCard 里"桥解析的优先"其实还是先拿到它，
       * 排序白做（实测故意传一张错的，卡片用的还是错的那张）。
       * 现在分开：`cover` = 聚合站按 songmid/歌名回检匹配出来的（可信），
       * `coverExplicit` = 调用方传的（只兜底）。 */
      cover: '',
      coverExplicit: normalizeCoverUrl(opts?.cover ?? opts?.image),
      audio: '',
      url: fallbackUrl,
      via: ''
    };
    const q = [givenTitle, givenArtist].filter(Boolean).join(' ').trim();
    if (!q) {
      log('[qqmusic] 没有歌名/歌手，无法解析可播放直链（模型应先调 qq_music_search 拿到 title/artist）');
      return out;
    }
    /* 关键词要先只用歌名：实测 `msg=晴天 周杰伦` 会被服务端回 404「歌曲信息获取失败」，
     * 而 `msg=晴天` 正常。两条候选依次试。 */
    const queries = [givenTitle, q].filter((v, i, a) => v && a.indexOf(v) === i);
    const headers = { 'user-agent': 'Mozilla/5.0' };
    const secapiKey = String(cfg?.social?.secapiKey ?? process.env.QQBRIDGE_SECAPI_KEY ?? '').trim();
    if (secapiKey) headers.authorization = `Bearer ${secapiKey}`;
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s（）()【】\[\]·\-—_·,，.。!！?？]/g, '');
    for (const query of queries) {
      let pick = null;
      // 这个聚合接口偶发返回 404「歌曲信息获取失败」（同一句话隔几秒再问就正常），所以重试一次。
      for (let attempt = 0; attempt < 2 && !pick; attempt += 1) {
        try {
          const url = `https://secapi.top/API/QQ%E9%9F%B3%E4%B9%90/?msg=${encodeURIComponent(query)}&list=2&n=2`;
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
          const body = await res.json().catch(() => null);
          // 接口可能返回单个对象，也可能返回数组 —— 两种形状都吃
          const raw = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : (body ? [body] : []));
          const ok = raw.filter((s) => Number(s?.code ?? 200) === 200 && s?.music_url);
          // ① 按 songmid 精确回检（最可靠）② 歌名归一化后相等 ③ 歌名互相包含且歌手对得上
          pick = ok.find((s) => String(s?.link ?? '').includes(mid))
            || ok.find((s) => norm(s?.title) === norm(givenTitle))
            || ok.find((s) => {
              const t = norm(s?.title); const g = norm(givenTitle);
              if (!t || !g || !(t.includes(g) || g.includes(t))) return false;
              if (!givenArtist) return true;
              const a1 = norm(s?.singer); const a2 = norm(givenArtist);
              return a1.includes(a2) || a2.includes(a1);
            });
          if (!pick) log(`[qqmusic] 查询「${query}」返回 ${raw.length} 条，没有一条对得上 mid=${mid}/${givenTitle}`);
        } catch (error) {
          log(`[qqmusic] secapi 请求失败（query=${query}）：${error?.message ?? error}`);
        }
        if (!pick && attempt === 0) await sleep(1200);
      }
      if (pick) {
        out.title = String(pick.title || givenTitle);
        out.artist = String(pick.singer || givenArtist);
        /* 2026-09-19 修「QQ音乐卡又不带封面」：调用方传了封面就别用聚合站返回的那个顶掉它。
         * 需求定的硬规则是"封面以传入的 image 为准"（实测传了才有封面），但这里原来无条件用
         * `pick.cover` 覆盖，而聚合站给的是 `y.gtimg.cn/music/photo_new/T002R300x300M000<albummid>.jpg`
         * —— 这个模板实测会 404（同一模板的 URL 取不到图），一旦它替换掉调用方那张好图，
         * 卡片的 preview 就指向一张不存在的图 → 没封面。
         * 所以：只有调用方没给封面时，才用聚合站的那张。 */
        if (!out.cover) out.cover = normalizeCoverUrl(pick.cover) || out.cover;
        out.url = String(pick.link || fallbackUrl);
        out.audio = normalizeMediaUrl(pick.music_url);
        out.via = `secapi/${String(pick.quality || '').trim()}`;
        return out;
      }
    }
    log(`[qqmusic] 试了 ${queries.length} 个关键词都解析不到可播放直链（id=${mid}），退回官方分享链接`);
    return out;
  }

  /**
   * 音乐卡片：桥内拼好，模型只给 musicType + musicId（不许模型手写卡片 JSON / 封面 URL）。
   *
   * 现场故障与实测结论（2026-09-16，D:\MoonBot 线上日志 + 真机请求）：
   *   · 线上模型三次都只传 {type:music, musicType:163, musicId:<id>}，桥发的是 NapCat 原生 music 段
   *     {type:'163', id}；NapCat 把这段 POST 给 musicSignUrl（线上为默认的 ss.xingzhige.com）换取整张卡片。
   *   · 带 id 时签名服务自己解析封面，给的是未缩尺寸的原图（实测其中一张 4.4MB，content-type
   *     image/jpg; charset=UTF-8），且 musicUrl 是明文 http + 带时间戳的会过期直链 —— 手机端白框、电脑端正常。
   *   · 不带 id、字段自己给时，签名服务原样采用我们给的 image（实测回传一字不差），返回的卡片
   *     tag 仍是"网易云音乐"、appid 仍是 100495085、view 仍是 music —— 与真人从网易云分享到 QQ 同款，
   *     只有封面/音频换成了我们归一化过的 https + 300×300。
   * 所以默认走"桥拼卡片"，并保留三段降级梯子（任何一段失败都不让"分享"整体失败）：
   *   primary（桥拼卡片）→ native（NapCat 原生 id 卡片，老行为）→ link（官方分享链接纯文本）
   */
  async function buildMusicCard(platform, id, opts = {}) {
    const mt = String(platform ?? '').trim() || '163';
    const pid = String(id ?? '').trim();
    const givenTitle = String(opts?.title ?? '').trim();
    const givenArtist = String(opts?.artist ?? '').trim();
    if (!pid) throw new Error('音乐卡片需要 musicId（qq_music_search 返回的 id）');
    /* 2026-09-24：版式可以按次指定（`opts.style`，来自 /api/social/rich 的 musicStyle）。
     * 起因：主人拿《起风了》实测三种形态，卡片的"点开去哪"和"有没有封面"是绑死的 ——
     *   share  = 签名服务的 tuwen/news 图文卡：手机端画封面，但点开是外链，QQ 盖一层「将要访问」中转页
     *   music  = music.lua + 可播放直链：点开在 QQ 里直接播（没有中转页），但手机端不画封面
     *   native = 平台原生 id 卡（163/qq）：老行为，卡片字段交给签名服务自己解析
     *
     * 2026-09-24 深夜定案（主人："和真卡一样好，但是你还没进去，被拦截在中转页了"）：
     * ——**连主人自己的真机分享卡都会被「将要访问」挡住**（她原话："主要是真卡它也拦住"），
     *   所以那一层不是我们卡片的毛病，而是 QQ 对"卡片里的外链"统一加的安全页。
     *   我又试了两条"绕过"的路，都死了：
     *     · music.lua 带可播放直链 → 点开照样进浏览器，一样被拦（主人实测）；
     *     · 干脆不带 url 想让它走播放器 → NapCat 的 music 段拒收（消息体无法解析），降级成链接。
     *   结论：**绕不过去**。既然 music 版式既不省中转页、又丢掉手机端封面，
     *   默认回到 `share`（与真机分享卡同版式、有封面、点开行为也"和真卡一样"）。
     *   （真正"点开不被拦"的只有 QQ 自家域名：QQ 音乐的 `i.y.qq.com` 播放页 —— 见 qq 分支。）
     * 想按次改仍然可以：`musicStyle` 参数 / `social.send.musicCardStyle` / `QQBRIDGE_MUSIC_CARD_STYLE`。 */
    const styleOverride = String(opts?.style ?? '').trim().toLowerCase();
    const cardStyle = ['share', 'music', 'native'].includes(styleOverride)
      ? styleOverride
      : (['share', 'music', 'native'].includes(MUSIC_CARD_STYLE) ? MUSIC_CARD_STYLE : 'share');

    if (mt === '163' || mt === 'netease') {
      let song = null;
      try {
        song = await musicResolve('netease', pid);
      } catch (error) {
        log(`[music-card] 网易云解析失败，退回 NapCat 原生卡片(id=${pid}): ${error?.message ?? error}`);
      }
      /* 2026-09-19 定稿：封面走调用方传进来的 `image`。
       * 现场实测：同一个 musicId，传了 image 封面就正常，没传就空白（手机端尤其明显）。
       * 所以这里把 `opts.image` 提到第一优先，桥自己解析出来的封面只当兜底 ——
       * 与旧注释里"不许模型手写封面 URL"相反，现在是硬规则：必须传 image（工具描述里已写死）。 */
      const explicitCover = String(opts?.image ?? '').trim();
      /* 2026-09-19 反馈「封面都有但都没对——点进去的封面不同」
       * 真因是模型把别的消息里的封面 URL 抄过来了（会话历史里堆着我发的测试卡，
       * 它就照着抄），于是卡片挂的是另一首歌的封面。
       * 所以优先级改回来：桥自己解析出来的封面优先，模型的 `image` 只当最后一档兜底。
       * 探测（firstWorkingImage）照旧 —— 它能同时解决"y.gtimg.cn 间歇性 404"。 */
      /* 2026-09-19：封面统一过 `ensureJpegCover` 把关：探活拿不到真图片字节时它返回空串，
       * 下面的 `!cover` 分支就会退到 NapCat 原生卡 —— 而不是把一张取不到的 URL 塞进卡片。 */
      /* 2026-09-25：封面第一优先是"真卡封面"（主人分享过这首歌时，我们照抄真卡的 QQ 图床 URL，
       * 见 neteaseRealCover 上面那段），其次才是桥自己解析出来的、最后才是调用方给的。 */
      const realCover = neteaseRealCover(pid);
      const coverPick = await pickImage([realCover, song.cover, explicitCover]);
      const cover = ensureJpegCover(coverPick.url, coverPick.ct, { w: 300, h: 300, fit: 'cover' }, coverPick.magic);
      const title = song?.title || givenTitle || '网易云音乐';
      const artist = song?.artist || givenArtist || '';
      /* 2026-09-24 定案：jumpUrl 现问网易云要（手机页 HTML 里那一串，含**访客** uct2），
       * 见 neteaseShareLink 上面那段现场记录。拿不到页面就退回静态拼串 —— 绝不吃网络失败。
       * `social.send.neteaseShareUrl = 'bare'` 可回退到只带 id 的裸链接（会过中转页）。 */
      const shareLink = String(cfg?.social?.send?.neteaseShareUrl ?? '').trim().toLowerCase() === 'bare'
        ? neteaseMobileSongUrl(pid)
        : await neteaseShareLink(pid, opts?.uct2);
      const link = `${title}${artist ? ' ' + artist : ''} ${shareLink}`;
      const native = { type: 'music', data: { type: '163', id: pid } };
      if (cardStyle === 'native') {
        /* 2026-09-24：主人说"之前点进去没有将要访问的中转页"—— 那正是原生 id 卡的形态
         * （卡片由签名服务按 id 签成 music.lua，点开在 QQ 内播放器里直接播）。代价是手机端不画封面。 */
        return { title, primary: native, native: null, link, style: cardStyle, note: '网易云原生 163 卡（点开在 QQ 里直接播，没有中转页；手机端不画封面）—— 但 2026-09-24 线上实测：签名服务对 163 id 卡会挂到超时（约 50s）再落到纯链接，这条形态目前多半发不出去，别指望它' };
      }
      if (!cover || !song?.audio) {
        return { title, primary: native, native: null, link, note: '解析不到封面/音频，退回 NapCat 原生 163 卡片' };
      }
      const data = {
        type: '163',
        /* 2026-09-19 定稿：url 用手机歌曲页（真卡用的就是这种；桌面页会被 QQ 盖上"将要访问"）。
         * 2026-09-24 晚：url 换成 `shareLink` —— 网易云手机页上现取的那一串（含访客 uct2），
         * 与真机分享逐字段同形。只带 id 的裸链接会被盖中转页（`neteaseShareUrl='bare'` 可回退）。
         *
         * 2026-09-24 深夜第二次定案（主人："和真卡一样好，但是你还没进去，被拦截在中转页了"）：
         * 连真卡都被拦 ⇒ **只要卡里带外链 jumpUrl，点开就必然过那层安全页**，
         * 而 `music` 版式本来有 "点了就播" 的另一条路 —— 靠的是 `musicUrl` 而不是 jumpUrl。
         * 所以 music 版式下**不塞 jumpUrl**（指望 QQ 走播放器那条路，而不是浏览器那条路）；
         * 什么时候网易云那串还需要，就什么时候回到 share 版式（`musicStyle:"share"`）。 */
        url: shareLink,
        /* 2026-09-24 深夜实测回滚：music 版式**不塞 url** 想躲开外链 → NapCat 直接拒收
         * （`send_private_msg 失败: 消息体无法解析`），卡片降级成纯链接（现场又发出一条链接，已说明）。
         * 所以两种版式都必须带 url；"不带外链就不会被拦"这条路走不通 —— NapCat 的 music 段本身就要求 url。 */
        title,
        image: await ensureQqHostedImage(cover)
      };
      if (artist) data.singer = artist;
      /* 2026-09-19 定稿·这是"手机端没封面"的最终答案
       * NapCat 会把这个 data 原样 POST 给签名服务换整张 Ark，而签名服务只看 payload 里有没有 `audio`
       * 来决定版式 —— 线上逐组实测：
       *     带 audio   → app=com.tencent.music.lua  view=music   ← 手机端不画封面（电脑端宽容，所以"电脑上有"）
       *     不带 audio → app=com.tencent.tuwen.lua  view=news    ← 真机分享的那种版式，手机端会画封面
       * 不带 audio 时签出来的是 `qqconnect.sdkshare` + 合法 `config.token`，所以能真正送达。
       *
       * 顺带作废一条弯路：我一度改成"自己手写 tuwen Ark"。那是发不出去的 ——
       * 手写卡的 token 是随机的，QQ 服务端一律拒收，消息只写进本地库、对方什么都收不到
       * （判据：消息的 `real_seq` 不前进；实测 4 张全灭，且改 `uin`、改 jumpUrl 里的 `&` 都无效）。
       * 结论：卡片必须由签名服务签，版式则由"带不带 audio"决定。 */
      if (cardStyle === 'music') data.audio = song.audio;
      return {
        title,
        primary: { type: 'music', data },
        native,
        link,
        style: cardStyle,
        note: cardStyle === 'music'
          ? '桥拼 163 卡片（music.lua 版式 —— 手机端不画封面、点开在 QQ 里直接播，没有中转页）'
          : '桥拼 163 图文卡（签名服务签的 tuwen/news，与网易云 App 分享同版式：手机端才画封面、点开进手机歌曲页，但 QQ 会盖一层「将要访问」中转页）'
      };
    }

    /* 2026-09-18：QQ 音乐：以前只会发"官方分享链接纯文本"（因为 ss.xingzhige 关闭了 qq id 解析、
     * 自造 Ark 又被 QQ 判"版本过低"）。现在 secapi.top 能直接给到可播放直链，所以改成真卡片：
     *   primary = 桥拼 music 卡（type=custom，url/audio/image/title/singer 全由桥解析填好）
     *   native  = 无（`type:'qq'` + id 那条路签名服务已知关闭，不值得占一格降级梯子）
     *   link    = 官方分享链接文本（与真人"分享歌曲到QQ"一致，客户端自己渲染）
     * 解析不到直链/封面时只发 link —— 宁可少一张卡，也不发一张点不开或配错歌的卡。
     * 想改回带平台身份的 `type:'qq'` 卡片：设 QQBRIDGE_QQMUSIC_CARD=qq。 */
    if (mt === 'qq' || mt === 'qqmusic') {
      let song = null;
      try {
        song = await qqMusicResolve(pid, { title: givenTitle, artist: givenArtist, cover: opts?.image });
      } catch (error) {
        log(`[music-card] QQ 音乐解析失败，退回官方分享链接(id=${pid}): ${error?.message ?? error}`);
      }
      const title = song?.title || givenTitle || 'QQ音乐';
      const artist = song?.artist || givenArtist || '';
      const url = song?.url || `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(pid)}`;
      const link = `${title}${artist ? ' ' + artist : ''} ${url}`;
      if (cardStyle === 'native') {
        /* 2026-09-24：原生 qq id 卡（type=qq + songmid）——注释里记着"签名服务已关闭 qq id 解析"，
         * 那条结论可能已经过期，所以留着这条按次可选的档：拿得到就是 QQ 内直接播、拿不到由
         * sendMusicCardWithFallback 落到官方分享链接文本。 */
        return {
          title,
          primary: { type: 'music', data: { type: 'qq', id: pid } },
          native: null,
          link,
          style: cardStyle,
          note: 'QQ 音乐原生卡（type=qq + songmid，交给签名服务解析：点开在 QQ 里直接播、没有中转页，手机端不画封面）—— 签名服务已关闭 qq id 解析，多半会落到官方分享链接文本'
        };
      }
      /* 卡片类型 = 走签名服务时要的"平台身份"。
       * 2026-09-19 实测：网易云（type=163）在手机端封面能显示，而 QQ 音乐用 type=custom 时
       * 封面（真 JPEG、magic ffd8ff）手机端仍不显示 —— 差别就在这个 type。
       * 所以做成可切换：`social.send.qqMusicCard = 'qq'|'custom'`（或环境变量 QQBRIDGE_QQMUSIC_CARD）。 */
      const cardType = String(opts?.cardType || process.env.QQBRIDGE_QQMUSIC_CARD || cfg?.social?.send?.qqMusicCard || '').trim() === 'qq' ? 'qq' : 'custom';
      const qqExplicitCover = String(opts?.image ?? '').trim();
      /* 桥自己解析的那张优先（聚合站按 songmid/歌名回检匹配过，肯定是这首歌的），
       * 调用方传的 `image` 只兜底 —— 它是从聊天记录里别的卡片抄来的话就gg了（现场实测"封面不对"就是这么来的）。
       * `song.coverExplicit` 是解析器专门留的"调用方传的那张"（不能和 song.cover 混）。 */
      /* 2026-09-19 本机实测：先剔掉"把 songmid 当 albummid"的候选：线上那条永远 404 的 URL
       * 是 `photo_new/T002R300x300M0000047TsYA2meOa2.jpg`，而 `0047TsYA2meOa2` 经官方搜索接口回查
       * 是这首歌的 songmid（同一首歌的 `albummid` 是空的）—— 拿它拼 albummid 模板必然 404，
       * 探活纯属浪费，还可能被当成"探不到也只能凑合用"的封面发出去。
       * 顺便把候选统一过 `preferStableQqCover`：探的就是要发出去的那条 URL（避免"探 y.gtimg.cn、
       * 发 y.qq.com"这种不一致）。 */
      const asAlbumCoverMid = (u) => {
        const m = /\/photo_new\/T002R\d+x\d+M000([A-Za-z0-9]+)\.jpg/i.exec(String(u || ''));
        return m ? m[1] : '';
      };
      const qqCoverCandidates = [song?.cover, song?.coverExplicit, qqExplicitCover]
        .map(preferStableQqCover)
        .filter((u) => {
          const mid = asAlbumCoverMid(u);
          if (mid && mid.toLowerCase() === pid.toLowerCase()) {
            log(`[cover] 丢掉把 songmid 当 albummid 拼出来的封面候选（实测必然 404）：${String(u).slice(0, 90)}`);
            return false;
          }
          return true;
        });
      /* 探活；全探不到时用官方接口按 songmid 补真 albummid 再探一轮（见 qqAlbumCoverBySongMid）。
       * 补出来的候选也过一遍 preferStableQqCover，保证"探的就是发出去的那条 URL"。 */
      const qqPick = await pickImage(qqCoverCandidates, async () => (await qqAlbumCoverBySongMid(pid)).map(preferStableQqCover));
      /* 把关：不是真图片字节（magic 不是 JPEG/PNG/WebP）就返回空串 → 下面走官方分享链接兜底。 */
      const qqCover = ensureJpegCover(qqPick.url, qqPick.ct, { w: 300, h: 300, fit: 'cover' }, qqPick.magic);
      /* 2026-09-19 修「QQ音乐又没封面」——真因是卡片根本没生成
       * 线上现场：请求 `musicId=0039MnYb0qxYhV`，聚合站返回的最佳匹配却是
       * `songDetail/004Fs2FP1EvZYc`（另一个版本，songmid 不同）→ 被"按 songmid 回检"判为对不上
       * → `song.audio`/`song.cover` 都是空 → 旧代码直接放弃卡片、退成一条纯链接
       *   （日志：`试了 2 个关键词都解析不到可播放直链…退回官方分享链接`）。
       * 而 `qq_music_search` 给的第一条与聚合站最佳匹配经常不是同一个版本，所以这条会稳定命中，
       * 表现就是用户说的"又没封面"——其实连卡片都没有。
       *
       * 现在改成：只要有封面就把卡片拼出来。可播放直链拿不到就不带 audio
       * （歌页链接照样能点、封面照样显示），实在连封面都没有才退纯链接。
       * 这样"对不对得上"只影响"能不能点播放"，不再影响"有没有卡片"。 */
      if (!qqCover) {
        return {
          title,
          primary: null,
          native: null,
          link,
          note: '连封面都拿不到，发官方分享链接（QQ 客户端自己渲染卡片）'
        };
      }
      const data = { type: cardType, url: cardStyle === 'music' ? url : qqMobilePlayUrl(pid), title, image: await ensureQqHostedImage(qqCover) };
      if (artist) data.singer = artist;
      if (cardType === 'custom' && cardStyle === 'music') data.content = artist || 'QQ音乐';
      /* 2026-09-19 定稿：不带 audio → 签名服务签出 `com.tencent.tuwen.lua` + `view:news`
       * （真机分享的版式，手机端会画封面），而且带合法签名所以真能送达；
       * 带 audio → 签成 `music.lua`，手机端不画封面。详见 163 分支上那段长注释。
       * url 同时换成手机播放页（真卡用的那种），点开直接进播放器，不再被"将要访问"拦一层。 */
      if (cardStyle === 'music' && song?.audio) data.audio = song.audio;
      return {
        title,
        primary: { type: 'music', data },
        native: null,
        link,
        style: cardStyle,
        note: cardStyle === 'music'
          ? 'QQ 音乐卡片（music.lua 版式，带可播放直链 —— 手机端不画封面、点开在 QQ 里直接播）'
          : (song?.audio
            ? 'QQ 音乐图文卡（签名服务签的 tuwen/news，与 QQ音乐 App 分享同版式：手机端才画封面、点开进手机播放页，QQ 可能盖一层「将要访问」）'
            : 'QQ 音乐图文卡（签名服务签的 tuwen/news；没解析到可播放直链，点开进手机播放页听）')
      };
    }

    // 其它平台（kugou/kuwo/migu/custom）：没有可用的解析接口，沿用调用方给的字段，
    // 但仍然做 https 归一化（封面再补缩略参数），并永远留一条链接兜底。
    const url = String(opts?.musicUrl ?? '').trim();
    const image = normalizeCoverUrl(opts?.image);
    const audio = normalizeMediaUrl(opts?.audio);
    const title = givenTitle;
    if (!url) throw new Error(`${mt} 音乐卡片需要 musicUrl（可点开的歌曲链接）`);
    if (!image) throw new Error(`${mt} 音乐卡片需要封面 URL（image）`);
    const data = { type: mt, url, image };
    if (audio) data.audio = audio;
    if (title) data.title = title;
    if (givenArtist) data.content = givenArtist;
    return {
      title,
      primary: { type: 'music', data },
      native: null,
      link: url,
      note: `${mt} 自定义卡片（封面已归一化 https + 缩略尺寸）`
    };
  }

  // 音乐搜索（网易云/QQ音乐网页版，海外可访问）：返回可直接分享的歌曲链接，供"封面图+链接"分享用。
  async function musicSearch(query, platform = 'all', limit = 5) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('搜索关键词不能为空');
    const max = Math.min(10, Math.max(1, Number(limit) || 5));
    const results = [];
    const platforms = platform === 'netease' ? ['netease'] : platform === 'qqmusic' ? ['qqmusic'] : ['netease', 'qqmusic'];
    if (platforms.includes('netease')) {
      try {
        const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&offset=0&limit=${max}`;
        const res = await fetch(url, { headers: NETEASE_HEADERS, signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        const songs = (body?.result?.songs || []).slice(0, max);
        // 封面单独查一次（老接口不返回 album.picUrl；且绝不回落"歌手默认头像"，那是错图不是封面）
        let details = new Map();
        try {
          details = await neteaseSongDetails(songs.map((s) => s?.id).filter(Boolean));
        } catch (error) {
          log(`[music-search] 网易云封面解析失败（仍返回搜索结果，cover 会为空）: ${error?.message ?? error}`);
        }
        for (const s of songs) {
          const d = details.get(String(s?.id ?? '')) || null;
          results.push({
            platform: 'netease',
            title: d?.title || String(s?.name || ''),
            artist: d?.artist || (Array.isArray(s?.artists) ? s.artists.map((a) => a?.name || '').filter(Boolean).join('/') : ''),
            album: d?.album || String(s?.album?.name || ''),
            id: String(s?.id || ''),
            url: s?.id ? `https://music.163.com/#/song?id=${s.id}` : '',
            cover: d?.cover || '',
            duration: d?.duration || Number(s?.duration) || 0
          });
        }
      } catch (error) {
        log(`[music-search] 网易云搜索失败: ${error?.message ?? error}`);
      }
    }
    if (platforms.includes('qqmusic')) {
      try {
        /* 2026-09-24 修「QQ音乐那边搜不到这首歌」（主人当场拿《起风了》复现）：
         * `client_search_cp` 现在从这台 VPS 上回来是 HTTP 200 + 空 body，解析不出来于是恒返回空数组。
         * 换成同族、同样返回 `data.song.list` 的 `search_for_qq_cp`（实测 curnum=3、songmid/albummid 齐全），
         * 老接口留作第二顺位兜底；两者都必须带 Referer/UA —— 不带同样是空 body。 */
        const qqSearchHeaders = { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' };
        const qqSearchUrls = [
          `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=${encodeURIComponent(q)}&format=json&n=${max}&p=1`,
          `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(q)}&format=json&n=${max}&cr=1&t=0`
        ];
        let qqList = [];
        for (const qqUrl of qqSearchUrls) {
          const res = await fetch(qqUrl, { headers: qqSearchHeaders, signal: AbortSignal.timeout(8000) });
          const text = await res.text();
          let body = null;
          try { body = JSON.parse(text); } catch { body = null; }
          qqList = body?.data?.song?.list || [];
          if (qqList.length) break;
          log(`[music-search] QQ音乐接口没给出结果（${qqUrl.slice(8, 56)}…）→ 试下一个`);
        }
        for (const s of qqList.slice(0, max)) {
          const mid = String(s?.songmid || s?.media_mid || '');
          results.push({
            platform: 'qqmusic',
            title: String(s?.songname || ''),
            artist: Array.isArray(s?.singer) ? s.singer.map((a) => a?.name || '').filter(Boolean).join('/') : '',
            album: String(s?.albumname || ''),
            id: mid,
            url: mid ? `https://y.qq.com/n/ryqq/songDetail/${mid}` : '',
            cover: preferStableQqCover(s?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : ''),
            duration: Number(s?.interval) || 0
          });
        }
      } catch (error) {
        log(`[music-search] QQ音乐搜索失败: ${error?.message ?? error}`);
      }
    }
    return { query: q, platform, results };
  }

  return { sendRich, musicSearch, musicResolve, buildMusicCard, qqMusicResolve };
}
