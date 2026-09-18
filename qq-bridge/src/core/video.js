// 视频平台解析 + 视频卡片（与 media.js 的"桥拼卡片"是同一套思路，故对称命名）。
//
// 为什么单独一个文件：media.js 是音乐域（网易云/QQ音乐），视频是另一批接口、另一套降级链，
// 混在一起两边都不好改。这里不引任何第三方依赖，只用 global fetch。
//
// ── 2026-09-17 实测结论（这台 VPS 出口 IP 在 bilibili 眼里是香港/机房，风控很敏感）──
//   · `x/web-interface/view`          → 频繁 -412 "request was banned"（IP 级风控）
//   · `x/web-interface/search/type`   → 时通时 -412
//   · `x/player/pagelist`             → 稳定可用（拿到 part=标题、duration、cid）
//   · `x/web-interface/archive/related` → 可用
//   · 视频页 HTML                      → 412（但**国内 IP**（主人家宽）能正常拿到 og: meta）
//   所以取信息做成**多路降级**：直连 API → 视频页 og: meta → 分P接口 → 公共只读代理 → 只剩链接。
//   任何一路成功就立刻返回，全失败也**永远**留一条能点开的链接，绝不让"分享"整体失败。
//
// 抖音那边：分享短链 v.douyin.com/xxx 能 302 解析出真实地址（含作品 id），
// 但详情接口要 X-Bogus 签名、页面是 SPA，所以走"分享页 HTML 里的 _ROUTER_DATA / og: meta"这条路，
// 拿不到就退化成"标题留空 + 链接"，至少卡片能点。

import { log } from '../lib/log.js';
import { extractReadableHtml, decodeEntities } from '../lib/html-text.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 取信息时最多等多久（每一路各自计时，不是总和） */
const PROBE_TIMEOUT_MS = 9000;

/**
 * 公共只读代理：**默认关掉**。
 * 2026-09-17 在线上机器逐个实测，四个全废：
 *   · api.allorigins.win  → Request Timeout
 *   · corsproxy.io        → 403 keyless_legacy_url（匿名用法已停）
 *   · api.codetabs.com    → 522
 *   · r.jina.ai           → Cloudflare "Just a moment..." 挑战页
 * 留着这个数组是为了：① 将来某个活了可以直接填进来；② 想走自建代理时用环境变量挂上去。
 * 用法：QQBRIDGE_VIDEO_PROXIES='https://my-proxy/?url={url}' （逗号分隔，{url} 会被替换）
 */
const PUBLIC_PROXIES = String(process.env.QQBRIDGE_VIDEO_PROXIES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((tpl) => (u) => tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(u)) : `${tpl}${encodeURIComponent(u)}`);

/* ============================ 链接识别 ============================ */

/**
 * 从一段文本里认出视频链接。返回按出现顺序去重的数组。
 * 支持：bilibili（BV/av/b23.tv/视频页）、抖音（v.douyin.com、douyin.com/video、iesdouyin）。
 */
export function extractVideoUrls(text) {
  const s = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (url, platform) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, platform });
  };
  // 裸 BV 号（群里常见：直接发个 BV1xx411c7mD）
  const bvRe = /\bBV[0-9A-Za-z]{10}\b/g;
  let m;
  while ((m = bvRe.exec(s))) push(`https://www.bilibili.com/video/${m[0]}`, 'bilibili');
  const avRe = /\bav(\d{1,12})\b/g;
  while ((m = avRe.exec(s))) push(`https://www.bilibili.com/video/av${m[1]}`, 'bilibili');
  const urlRe = /https?:\/\/[^\s<>"'()（）【】]+/g;
  while ((m = urlRe.exec(s))) {
    const u = m[0].replace(/[.,;:!?，。；：！？]+$/, '');
    const p = classifyVideoHost(u);
    if (p) push(u, p);
  }
  return out;
}

export function classifyVideoHost(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return null; }
  if (host === 'b23.tv' || host.endsWith('.b23.tv')) return 'bilibili';
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  if (host === 'v.douyin.com' || host.endsWith('.douyin.com') || host === 'douyin.com') return 'douyin';
  if (host.endsWith('.iesdouyin.com')) return 'douyin';
  if (host.endsWith('.kuaishou.com') || host === 'v.kuaishou.com') return 'kuaishou';
  if (host.endsWith('.xiaohongshu.com') || host === 'xhslink.com') return 'xiaohongshu';
  if (host.endsWith('.weibo.com') || host.endsWith('.weibo.cn')) return 'weibo';
  if (host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  // 【2026-09-18 扩容】X（原 Twitter）/ Telegram / Pixiv —— 这三家都在 QQ 的链接预览白名单里，
  // 直接发官方链接客户端就会渲染卡片，所以走和 B 站/YouTube 同一条"官方分享链接"路。
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
  if (host === 't.me' || host.endsWith('.t.me') || host === 'telegram.me' || host.endsWith('.telegram.me')) return 'telegram';
  if (host.endsWith('.pixiv.net') || host === 'pixiv.net' || host === 'pixiv.me') return 'pixiv';
  if (host.endsWith('.lofter.com')) return 'lofter';
  return null;
}

/** 把各种写法归一成 { platform, kind, id, url }；认不出返回 null */
export function parseVideoUrl(rawUrl) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return null;
  const platform = classifyVideoHost(raw);
  if (!platform) {
    // 可能直接给了个 BV 号
    const bv = /^(BV[0-9A-Za-z]{10})$/.exec(raw);
    if (bv) return { platform: 'bilibili', kind: 'bvid', id: bv[1], url: `https://www.bilibili.com/video/${bv[1]}` };
    return null;
  }
  let u;
  try { u = new URL(raw); } catch { return null; }
  const path = u.pathname;

  if (platform === 'bilibili') {
    const bv = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(path);
    if (bv) return { platform, kind: 'bvid', id: bv[1], url: `https://www.bilibili.com/video/${bv[1]}` };
    const av = /\/video\/av(\d+)/i.exec(path);
    if (av) return { platform, kind: 'aid', id: av[1], url: `https://www.bilibili.com/video/av${av[1]}` };
    const bvQ = u.searchParams.get('bvid');
    if (bvQ && /^BV[0-9A-Za-z]{10}$/i.test(bvQ)) return { platform, kind: 'bvid', id: bvQ, url: `https://www.bilibili.com/video/${bvQ}` };
    /* ── 2026-09-18 第十七批：b23.tv 的**路径位**必须原样留住 ──────────────────────
     * 官方 API 文档（bilibili-API-collect `docs/misc/b23tv.md`）写明 b23.tv 有三种形态：
     *   ① 任意短链：路径由 **7 位**数字/大小写字母组成，如 https://b23.tv/pigt3PQ（有时效性）
     *   ② 视频短链(av)：/av<aid>
     *   ③ 视频短链(BV)：/BV<bvid>
     * 真人从 B 站 App 分享进 QQ 的真卡，qqdocurl 用的就是 ①（同一台 NapCat 回读到 6 张，
     * 短码分别是 WZcddcS / WZVnINP / 0hEdnD1 / 9kFv2VX / w1c4DfM / 1ncmZVP，**全是 7 位字母数字**，
     * 见 tools/dump-real-cards-full.mjs 的回读）。老代码把 b23.tv 一律当"短链、id 空"，
     * 后面 resolveBilibili 跟完 302 就**只留 BV、把短码丢了** —— 用户给的短码本来可以直接用，
     * 丢掉之后只能拿 BV 去反推，等于我们自己把信息降级了。这里把短码单独带出来。 */
    if (u.hostname.toLowerCase() === 'b23.tv' || u.hostname.toLowerCase().endsWith('.b23.tv')) {
      const seg = path.replace(/^\/+/, '').split('/')[0] || '';
      if (/^BV[0-9A-Za-z]{10}$/.test(seg)) {
        // 官方文档承认的 BV 形态，直接认出来，不用多绕一次 302；url 保持 b23.tv 短域形态
        return { platform, kind: 'bvid', id: seg, url: `https://b23.tv/${seg}` };
      }
      if (/^[0-9A-Za-z]{5,12}$/.test(seg)) {
        return { platform, kind: 'short', id: '', shortCode: seg, url: raw };
      }
    }
    // 其它形态（旧短链 / 带 query 的分享链）：交给解析阶段跟随重定向
    return { platform, kind: 'short', id: '', url: raw };
  }

  if (platform === 'douyin') {
    const m = /\/(?:video|note|share\/video)\/(\d{6,})/.exec(path);
    if (m) return { platform, kind: 'aweme', id: m[1], url: `https://www.douyin.com/video/${m[1]}` };
    // 短链：先原样带着，解析阶段靠 302 拿真实地址
    return { platform, kind: 'short', id: '', url: raw };
  }

  if (platform === 'youtube') {
    const short = /^\/([A-Za-z0-9_-]{6,})/.exec(path);
    if (u.hostname.toLowerCase() === 'youtu.be' && short) return { platform, kind: 'video', id: short[1], url: `https://youtu.be/${short[1]}` };
    const v = u.searchParams.get('v');
    if (v) return { platform, kind: 'video', id: v, url: `https://youtu.be/${v}` };
    const em = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/.exec(path);
    if (em) return { platform, kind: 'video', id: em[1], url: `https://youtu.be/${em[1]}` };
    return { platform, kind: 'short', id: '', url: raw };
  }

  if (platform === 'x') {
    const m = /\/status(?:es)?\/(\d{6,})/.exec(path);
    if (m) return { platform, kind: 'status', id: m[1], url: raw.replace(/^https?:\/\/(?:www\.)?twitter\.com/i, 'https://x.com') };
    return { platform, kind: 'short', id: '', url: raw };
  }

  if (platform === 'telegram') {
    // t.me/<channel>/<id> 或 t.me/<channel>（频道/群）；私有邀请 t.me/+xxx 也认
    const m = /^\/([A-Za-z0-9_]+)\/(\d+)/.exec(path);
    if (m) return { platform, kind: 'post', id: m[2], channel: m[1], url: `https://t.me/${m[1]}/${m[2]}` };
    const ch = /^\/([A-Za-z0-9_]{4,})/.exec(path);
    if (ch) return { platform, kind: 'channel', id: ch[1], url: `https://t.me/${ch[1]}` };
    return { platform, kind: 'short', id: '', url: raw };
  }

  if (platform === 'pixiv') {
    const art = /\/artworks\/(\d+)/.exec(path);
    if (art) return { platform, kind: 'illust', id: art[1], url: `https://www.pixiv.net/artworks/${art[1]}` };
    const q = u.searchParams.get('illust_id');
    if (q && /^\d+$/.test(q)) return { platform, kind: 'illust', id: q, url: `https://www.pixiv.net/artworks/${q}` };
    const member = u.searchParams.get('id');
    if (/\/member_illust\.php/.test(path) && member) return { platform, kind: 'member', id: member, url: raw };
    return { platform, kind: 'short', id: '', url: raw };
  }

  return { platform, kind: 'short', id: '', url: raw };
}

/* ============================ 取信息（多路降级） ============================ */

async function fetchOnce(url, { timeoutMs = PROBE_TIMEOUT_MS, headers = {}, redirect = 'follow' } = {}) {
  const res = await fetch(url, {
    redirect,
    headers: {
      'user-agent': UA,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text, finalUrl: res.url || url };
}

/** 跟随重定向拿到最终地址（短链解析）；有些站返回 200 + JS 跳转，也扫一遍 meta refresh / location.href */
async function followRedirect(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const r = await fetchOnce(url, { timeoutMs, redirect: 'follow' });
  if (r.finalUrl && r.finalUrl !== url) return r.finalUrl;
  const meta = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i.exec(r.text);
  if (meta) { try { return new URL(decodeEntities(meta[1]), url).toString(); } catch { /* ignore */ } }
  const js = /(?:location\.(?:href|replace)\s*=\s*|window\.location\s*=\s*)["']([^"']+)["']/i.exec(r.text);
  if (js) { try { return new URL(js[1], url).toString(); } catch { /* ignore */ } }
  return url;
}

/** 把 bilibili 的 JSON 接口读成对象；被风控（-412）时抛特定错误，交给上层决定要不要换路 */
async function biliJson(pathAndQuery, { via = 'direct' } = {}) {
  const api = `https://api.bilibili.com${pathAndQuery}`;
  const wrap = PUBLIC_PROXIES[0];
  const target = via === 'direct' || !wrap ? api : wrap(api);
  const r = await fetchOnce(target, {
    headers: {
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com',
      accept: 'application/json, text/plain, */*',
    },
  });
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* 不是 JSON（被 WAF 换成 HTML 错误页） */ }
  if (!j) {
    const err = new Error(`bilibili 返回的不是 JSON（HTTP ${r.status}，多为风控页面）`);
    err.banned = r.status === 412 || /出错啦|request was banned/i.test(r.text);
    throw err;
  }
  if (j.code === -412 || j.code === -509) {
    const err = new Error(`bilibili 风控：${j.message || j.code}`);
    err.banned = true;
    throw err;
  }
  if (j.code !== 0) throw new Error(`bilibili 接口错误 ${j.code}：${j.message || ''}`);
  return j.data;
}

/**
 * 风控重试：bilibili 的 -412 是"忙/被限速"而不是永久封 —— 实测同一分钟内 4 次调用里 2 次 412、2 次正常。
 * 所以被 412 时等一会儿再来一两次，比直接降级划算得多（降级会丢掉封面和 UP 主）。
 * 非风控错误（接口真报错 / 解析失败）不重试，省时间。
 */
async function withBanRetry(fn, { tries = 3, delayMs = 1200 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (!e?.banned || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/** 只保留"有内容"的字段（0 / '' / 空对象都算没内容），用来把多路结果合并成一份完整信息 */function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') {
      if (!Object.values(v).some((x) => x !== '' && x !== 0 && x !== null && x !== undefined)) continue;
    } else if (v === 0) {
      // 0 有意义（时长 0 秒没意义，但播放量 0 有意义）——统一按"时长类字段"处理
      if (/^(durationSec|cid|pages)$/.test(k)) continue;
    }
    out[k] = v;
  }
  return out;
}

/** 把秒数变成 12:34 / 1:02:03 */
export function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const p2 = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

/** 播放量口语化：105782277 → 1.1亿 */
export function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 100000000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(v);
}

function cleanBiliTitle(raw) {
  return decodeEntities(String(raw ?? ''))
    .replace(/<[^>]*>/g, '')            // 搜索接口的标题带 <em class="keyword">
    .replace(/[\u200b\ufeff]/g, '')
    .trim();
}

/** 从视频页 HTML 的 og: meta 里读信息（国内 IP 可用；机房 IP 常被 412） */
function infoFromHtml(html, canonicalUrl) {
  const doc = extractReadableHtml(html, { url: canonicalUrl, includeLinks: false, maxChars: 1500 });
  if (!doc.title && !doc.image) return null;
  const desc = doc.description || '';
  // bilibili 的 og:description 形如："视频播放量 105782277、弹幕量 149406、…视频作者 索尼音乐中国, 作者简介 …"
  const author = /视频作者\s*([^,，]+)/.exec(desc)?.[1]?.trim() || '';
  const play = /视频播放量\s*(\d+)/.exec(desc)?.[1] || '';
  const danmaku = /弹幕量\s*(\d+)/.exec(desc)?.[1] || '';
  const like = /点赞数\s*(\d+)/.exec(desc)?.[1] || '';
  const pub = /视频发布时间[:：]?\s*([\d-]+\s*[\d:]*)/.exec(desc)?.[1]?.trim() || '';
  return {
    title: cleanBiliTitle(doc.title.replace(/_哔哩哔哩_bilibili$/i, '')).trim(),
    author,
    cover: doc.image || '',
    description: desc.slice(0, 500),
    durationSec: 0,
    stat: { play: play ? Number(play) : 0, danmaku: danmaku ? Number(danmaku) : 0, like: like ? Number(like) : 0 },
    pubdateText: pub,
    source: 'html',
  };
}

/**
 * "视频详情"的两个入口，按顺序试。字段完全同构，风控却不是同一把尺子：
 *   /x/web-interface/wbi/view  ← 本机实测 HTTP 200，是现在唯一能拿到封面的那条
 *   /x/web-interface/view      ← 老路径，本机稳定 412
 * 详见 resolveBilibili 第 1 路上面那段实测记录。
 */
const VIEW_API_PATHS = ['/x/web-interface/wbi/view', '/x/web-interface/view'];

/** 单路：view 接口（信息最全）。apiPath 见 VIEW_API_PATHS */
async function biliViaView(id, kind, via, apiPath = VIEW_API_PATHS[1]) {
  const q = kind === 'aid' ? `aid=${encodeURIComponent(id)}` : `bvid=${encodeURIComponent(id)}`;
  const d = await biliJson(`${apiPath}?${q}`, { via });
  return {
    title: cleanBiliTitle(d.title),
    author: d.owner?.name || '',
    cover: String(d.pic || '').replace(/^http:\/\//i, 'https://'),
    description: String(d.desc || '').slice(0, 500),
    durationSec: Number(d.duration) || 0,
    stat: { play: Number(d.stat?.view) || 0, danmaku: Number(d.stat?.danmaku) || 0, like: Number(d.stat?.like) || 0, coin: Number(d.stat?.coin) || 0, favorite: Number(d.stat?.favorite) || 0, reply: Number(d.stat?.reply) || 0 },
    pubdate: Number(d.pubdate) || 0,
    cid: Number(d.cid) || 0,
    pages: Number(d.videos) || 1,
    aid: Number(d.aid) || 0,     // 官方分享接口的 oid 要的是 aid，顺手带出来省一次请求
    source: (apiPath.includes('/wbi/') ? 'api-wbi' : 'api') + (via === 'direct' ? '' : '-proxy'),
  };
}

/** 单路：分P接口（标题/时长，最稳的一个；view 被风控时它是唯一的标题来源） */
async function biliViaPages(id, kind, via) {
  const q = kind === 'aid' ? `aid=${encodeURIComponent(id)}` : `bvid=${encodeURIComponent(id)}`;
  const list = await biliJson(`/x/player/pagelist?${q}`, { via });
  const first = Array.isArray(list) ? list[0] : null;
  if (!first) throw new Error('分P接口没返回内容');
  return {
    title: cleanBiliTitle(first.part),
    author: '',
    cover: '',
    description: '',
    durationSec: Number(first.duration) || 0,
    stat: {},
    cid: Number(first.cid) || 0,
    pages: Array.isArray(list) ? list.length : 1,
    source: via === 'direct' ? 'pagelist' : 'pagelist-proxy',
  };
}

/**
 * 单路：**拿标题去搜，再按 bvid 精确命中**，补齐封面/UP主/播放量。
 *
 * 为什么绕这一圈：`view`（一次就能拿到全部字段）在这台机房 IP 上是稳定 412，
 * 而 `search/type` 只是"忙的时候"才 412。先用 pagelist 拿到准确标题，
 * 再拿标题当关键词搜（搜索结果里 bvid 是精确匹配的），就能把 view 拿不到的那几个字段凑齐。
 * 搜索接口把标题里的关键词打了 <em>，所以比对前先剥标签再规范化空白。
 */
async function biliViaSearchByTitle(title, bvid, via) {
  const q = String(title ?? '').trim();
  if (!q) throw new Error('没有标题可供反查');
  const d = await biliJson(
    `/x/web-interface/search/type?search_type=video&page=1&page_size=20&keyword=${encodeURIComponent(q)}`,
    { via },
  );
  const list = Array.isArray(d?.result) ? d.result : [];
  const norm = (s) => cleanBiliTitle(s).replace(/\s+/g, '').toLowerCase();
  const hit = list.find((r) => String(r.bvid || '').toLowerCase() === String(bvid || '').toLowerCase())
    || list.find((r) => norm(r.title) === norm(q));
  if (!hit) throw new Error('搜索结果里没有这条视频');
  return {
    title: cleanBiliTitle(hit.title),
    author: String(hit.author || ''),
    cover: String(hit.pic || ''),
    description: String(hit.description || '').replace(/<[^>]*>/g, '').slice(0, 500),
    durationSec: 0,
    stat: { play: Number(hit.play) || 0, danmaku: Number(hit.video_review) || 0 },
    pubdate: Number(hit.pubdate) || 0,
    source: via === 'direct' ? 'search' : 'search-proxy',
  };
}

/* ==================== 第三方聚合解析（secapi.top，绕风控用） ==================== */

/**
 * 第三方解析接口前缀。**每次调用现读环境变量**，不缓存到模块常量：
 * 线上要临时换域名、或者要做"这一路挂掉能不能优雅退回"的现场验证时，
 * 不用改代码重新发版（`QQBRIDGE_SECAPI_BILI=<会失败的地址>` 起一次进程就能复现）。
 * 默认值与 `media.js` 里 QQ 音乐那套 secapi 调用是同一家聚合站，风格照抄它：
 * 只带 `user-agent`、`AbortSignal.timeout` 限时、失败只打日志不抛给上层。
 */
const SECAPI_BILI_DEFAULT = 'http://secapi.top/API/jiexi/bilibili.php';
const secapiBiliBase = () => String(process.env.QQBRIDGE_SECAPI_BILI ?? '').trim() || SECAPI_BILI_DEFAULT;

/** 这一路的超时。实测正常 0.9~1.6s、错误形态 50~190ms，8s 已经是很宽的余量；
 *  它只是**第一路**，卡住太久会拖慢整条发送链，所以不能给到官方那档 9s。 */
const SECAPI_BILI_TIMEOUT_MS = 8000;

/**
 * 单路：secapi.top 的 B 站解析 —— 存在的唯一理由就是**绕开机房 IP 的风控**。
 *
 * ── 2026-09-18 接口实测（`tools/probe-secapi-bili.mjs` 在线上这台 VPS 跑的，逐条可复现）──
 * `GET http://secapi.top/API/jiexi/bilibili.php?url=<链接或 BV>`，**参数名就是 `url`**：
 *   · 传 `bv=BV…` → `{"code":400,"状态":"错误","信息":"请提供B站链接或BV号"}`（HTTP 仍是 200）；
 *   · 认这些入参形态（逐个实测，返回同一条 BVID）：长链、长链带 `?spm_id_from=` 等 query、
 *     裸 BV、`b23.tv/<7位短码>`、**短码带 `?share_medium=android&share_source=qq&bbid=…&ts=…`**、
 *     `b23.tv/<BV>`、`m.bilibili.com/video/<BV>`；
 *   · **不认** `av<aid>` 长链（`{"code":404,…,"信息":"未找到有效的BV号"}`），也不认小写 `bv…` ——
 *     所以 `kind === 'aid'` 时这一路直接跳过，交给官方多路（见 resolveBilibili 第 0 路的判断）。
 *   · 也不认别的平台：抖音/快手/微博的链接一律回上面那句"未找到有效的BV号"。
 *
 * 返回是**中文键**（映射见下），另有 `视频播放地址.{4K,1080P,1080P+,720P,480P,360P,240P}`：
 *   每个清晰度给 `视频链接`（`http://secapi.top/…?code=<base64>`，解出来是 `upos-…bilivideo.com`
 *   或 `upos-hz-mirrorakam.akamaized.net` 的 mp4）、`文件大小`、`时长(秒)`。
 *   实测：解开 base64 后的真实地址里带 `deadline=<unix秒>`，**距今约 2 小时（会过期）**；
 *   逐个清度实取（Range 1KB 看头 12 字节）**大部分是真 MP4**（magic `…66747970` = "ftyp"），
 *   偶有一条回 `{"code":404,"状态":"错误","信息":"短链无效"}`（HTTP 仍是 200）—— 也就是**不保证每条都能播**。
 *   ⚠️ 另一处坑：`时长(秒)` 的值是 `203666`，而同一条视频官方 `duration` 是 204 秒 ——
 *   它其实是**毫秒**，标签写错了。本桥的卡片不需要播放地址（卡片只放封面+标题+短链），
 *   所以这些字段一个都不往 `info` 里带，避免把"会过期的直链"混进缓存。
 *
 * ⚠️ **最坑的一条：不存在的 BV 会回 `code:200 / 状态:"成功"`，但字段全是空的**
 *   （实测 `url=BV1zz411c7zz` → 标题 ""、封面图 ""、时长 0、AID 0、`视频播放地址` 为 `[]`）。
 *   也就是说**不能只看 `code`**：标题为空一律当失败抛出去，否则会把一条"空视频"当成功，
 *   卡片标题变成兜底的"B站视频"、封面也没有，等于把风控那套故障换个姿势重现一遍。
 */
async function biliViaSecapi(id, kind) {
  if (kind !== 'bvid' || !id) throw new Error(`secapi 只认 BV/短链（kind=${kind}），av 号它一律回 404`);
  const url = `${secapiBiliBase()}?url=${encodeURIComponent(`https://b23.tv/${id}`)}`;
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(SECAPI_BILI_TIMEOUT_MS) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 不是 JSON：当失败 */ }
  if (!body) throw new Error(`secapi 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 80)}`);
  if (Number(body.code) !== 200) throw new Error(`secapi 报错 code=${body.code}：${body.信息 || body.状态 || ''}`);
  const v = body.视频信息 || {};
  const title = cleanBiliTitle(v.标题);
  // 见上面那条实测：code=200 也可能是空壳，标题为空就不认
  if (!title) throw new Error(`secapi 回 code=200 但标题为空（实测不存在/已删的视频就是这个形态，BVID=${v.BVID || '?'}）`);
  /* `发布时间` 是 "2026-09-08 16:45:55" 这种**北京时间字符串**，而下游（buildVideoCard / 返回映射）
   * 用的是官方那套 **epoch 秒**。这里显式按 +08:00 解析成 epoch，别用 Date.parse 裸解析
   * （裸解析会按本机时区走，服务器是 UTC 就差 8 小时）。 */
  const pubMs = Date.parse(`${String(v.发布时间 || '').trim().replace(' ', 'T')}+08:00`);
  const s = body.统计信息 || {};
  const u = body.作者信息 || {};
  return {
    title,
    author: String(u.昵称 || '').trim(),
    cover: String(v.封面图 || '').replace(/^http:\/\//i, 'https://'),
    description: String(v.描述 || '').slice(0, 500),
    durationSec: Number(v['时长(秒)']) || 0,
    // 键名与 biliViaView 完全对齐，下游（stat.play → playText）不用改
    stat: {
      play: Number(s.播放量) || 0,
      danmaku: Number(s.弹幕数) || 0,
      like: Number(s.点赞数) || 0,
      coin: Number(s.硬币数) || 0,
      favorite: Number(s.收藏数) || 0,
      reply: Number(s.评论数) || 0,
    },
    pubdate: Number.isFinite(pubMs) ? Math.floor(pubMs / 1000) : 0,
    cid: Number(v.CID) || 0,
    aid: Number(v.AID) || 0,          // 官方 x/share/click 要的是 aid，顺手带出来（拿错也不会发错卡：shortCodeHitsBvid 会核对）
    source: 'secapi',
  };
}

/**
 * 向 B 站官方分享接口要一条 **b23.tv/<7 位不透明短码>** 形态的短链。
 *
 * ── 2026-09-18 第十七批·实测（`tools/probe-bili-share-link.mjs` 在线上机器跑的）──────────
 * 接口：`POST https://api.bilibili.com/x/share/click`（备路 `https://api.biliapi.net/x/share/click`）
 * 参数照 bilibili-API-collect `docs/misc/b23tv.md` 的原文示例逐字搬（那份文档也标了"参数表基本失效"，
 * 所以下面每个字段都是实跑验过的，不是抄完就算）：
 *   platform=unix  share_channel=COPY  share_id=main.ugc-video-detail.0.0.pv
 *   share_mode=4   oid=<**aid**，不是 bvid>  buvid=qwq  build=6114514
 * 本机（机房 IP，老 view 接口稳定 412）实跑 4 组参数，**4/4 全部 HTTP 200 code=0**，例如：
 *   BV13Xb56NEEZ → data.content = "【五十个角色、五十种声音、同一个我-哔哩哔哩】 https://b23.tv/hcBfL2T"
 * 且把返回的短码跟到底验证过：`b23.tv/l38NbiD` → 302 → `https://www.bilibili.com/video/BV13Xb56NEEZ
 * ?…&unique_k=l38NbiD&share_plat=unix…`，**落的正是同一条 BV**；短码后面再挂
 * `?share_medium=android&share_source=qq&ts=…` 这些非设备参数也照样落对（bbid 是设备标识，我们不伪造）。
 *
 * ⚠️ 两个已知限制，如实写在这里：
 *   ① 同一个视频每次调用返回的短码**都不一样**（hcBfL2T / GTSQYqy / hayEZyQ / xbkyqoD），
 *      文档说这类任意短链"有时效限制"，但**具体多久过期没有测出来**（本次只验证了"刚生成就能跳对"）。
 *      所以只缓存 10 分钟用于同轮复用，不做长期缓存；真过期了卡片会点不开，而 b23.tv/<BV> 那种
 *      官方文档承认的形态不存在过期问题 —— 这是这里唯一的取舍。
 *   ② 拿不到短码时**必须**退回 `https://b23.tv/<BV>`（不要在卡片上放长链：
 *      QQ 的链接预览只认 b23.tv 这个白名单短域）。
 */
const SHARE_CODE_TTL_MS = 10 * 60 * 1000;
const shareCodeCache = new Map();          // bvid(大写) → { code, at }

/** 校验短码确实落到目标 BV：只跟 302 那一跳的 Location，不看终点页（机房 IP 终点恒 412） */
async function shortCodeHitsBvid(code, bvid) {
  try {
    const r = await fetch(`https://b23.tv/${code}`, {
      redirect: 'manual',
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    });
    const loc = r.headers.get('location') || '';
    return /\/video\/(BV[0-9A-Za-z]{10})/i.exec(loc)?.[1]?.toUpperCase() === String(bvid).toUpperCase();
  } catch {
    return null;                            // 网络问题不算"对不上"，交给调用方决定
  }
}

/**
 * @param {string} bvid
 * @param {number} [aid] 已经知道 aid 时直接传，省一次 wbi/view
 * @returns {Promise<string>} 7 位短码；拿不到返回空串
 */
export async function fetchBiliShareCode(bvid, aid = 0) {
  const key = String(bvid || '').trim().toUpperCase();
  if (!key) return '';
  const hit = shareCodeCache.get(key);
  if (hit && Date.now() - hit.at < SHARE_CODE_TTL_MS) return hit.code;

  let oid = Number(aid) || 0;
  if (!oid) {
    try { oid = Number((await biliJson(`/x/web-interface/wbi/view?bvid=${encodeURIComponent(key)}`))?.aid) || 0; }
    catch (e) { log(`[video] 取 aid 失败（分享短链要用 aid 当 oid）：${e?.message ?? e}`); }
  }
  if (!oid) return '';

  const body = new URLSearchParams({
    platform: 'unix',
    share_channel: 'COPY',
    share_id: 'main.ugc-video-detail.0.0.pv',
    share_mode: '4',
    oid: String(oid),
    buvid: 'qwq',
    build: '6114514',
  }).toString();

  for (const host of ['https://api.bilibili.com', 'https://api.biliapi.net']) {
    try {
      const r = await fetch(`${host}/x/share/click`, {
        method: 'POST',
        headers: {
          'user-agent': UA,
          referer: `https://www.bilibili.com/video/${key}`,
          origin: 'https://www.bilibili.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      const text = await r.text();
      const j = (() => { try { return JSON.parse(text); } catch { return null; } })();
      const code = /b23\.tv\/([0-9A-Za-z]{5,12})/.exec(String(j?.data?.content ?? ''))?.[1] || '';
      if (j?.code !== 0 || !code || /^BV[0-9A-Za-z]{10}$/i.test(code)) {
        log(`[video] 分享短链 ${host} 没给出短码：HTTP ${r.status} code=${j?.code} body=${text.slice(0, 160)}`);
        continue;
      }
      const ok = await shortCodeHitsBvid(code, key);
      if (ok === false) {
        log(`[video] 分享短链 ${host} 返回 ${code}，但它没落到 ${key} —— 弃用，退回 b23.tv/<BV>`);
        continue;
      }
      shareCodeCache.set(key, { code, at: Date.now() });
      log(`[video] 分享短链：${key} → b23.tv/${code}（官方 x/share/click 签发，302 已核对${ok === true ? '一致' : '（校验请求失败，未核对）'}）`);
      return code;
    } catch (e) {
      log(`[video] 分享短链 ${host} 请求失败：${e?.message ?? e}`);
    }
  }
  return '';
}

/**
 * 解析一个 bilibili 链接/短链 → 统一信息对象。
 * 多路降级，任一成功即返回；全失败抛出最后一个错误（调用方还有"只剩链接"这条路）。
 */
export async function resolveBilibili(rawUrl) {
  const parsed = parseVideoUrl(rawUrl);
  if (!parsed || parsed.platform !== 'bilibili') throw new Error('不是 bilibili 链接');
  let { kind, id } = parsed;
  let url = parsed.url;
  /* 用户给进来的是 **b23.tv + 7 位短码** 时，把他那条短链原样留下
   * （短码只有 B 站签得出来，我们反推不回去；老代码跟完 302 就只留 BV，白丢一条有效分享链）。
   * 注意：`b23.tv/<BV>` 虽然是官方文档承认的形态，但它**不是** B 站 App 分享时用的那种短码，
   * 所以不能因为"输入是 b23.tv 域名"就跳过换真短码这一步 —— 只认 `parsed.shortCode`。 */
  const givenShortUrl = parsed.shortCode ? String(rawUrl).trim() : '';

  if (kind === 'short' || !id) {
    const finalUrl = await followRedirect(rawUrl);
    const p2 = parseVideoUrl(finalUrl);
    if (p2 && p2.id) { kind = p2.kind; id = p2.id; url = p2.url; }
    else throw new Error(`无法从短链里认出视频号：${finalUrl}`);
  }

  const vias = ['direct', ...(PUBLIC_PROXIES.length ? ['proxy'] : [])];
  let info = null;
  let lastErr = null;

  /* 第 0 路：第三方聚合解析 secapi.top（**故意放在官方之前**）。
   *
   * 为什么排在官方前面：这一路的全部价值就是"从第三方服务器去取 B 站数据"，
   * 出口不是这台机房 IP，所以不吃 B 站对机房 IP 的那套风控（背景见下面第 1 路）。
   * 接口实测、字段全集、错误形态、`code=200 但空壳` 那个坑，都写在 `biliViaSecapi` 的注释里。
   *
   * ⚠️ 它是**第三方、随时可能挂**，所以这里失败/超时**只打日志、绝不往上层抛**，
   * 下面官方多路（wbi/view → pagelist+标题反查 → og:meta）原样保留当兜底。
   * 实测它的响应时间 0.9~1.6s、10 次连胜 10/10 无失败，正常时反而比官方那几路快。 */
  if (kind === 'bvid' && id) {
    try {
      const via = await biliViaSecapi(id, kind);
      info = via;
      log(`[video] bilibili 信息来自 secapi（source=${via.source}）：${via.title.slice(0, 40)} 播放=${via.stat.play} 封面=${via.cover ? '有' : '无'}`);
    } catch (e) {
      log(`[video] bilibili secapi 不可用，退回官方路径：${e?.message ?? e}`);
    }
  } else {
    log(`[video] bilibili 跳过 secapi（kind=${kind}）：实测该接口只认 BV/短链，av 长链一律回"未找到有效的BV号"`);
  }

  /* 第 1 路：view —— 一次拿全（标题/UP主/封面/时长/播放量）。
   *
   * ── 2026-09-18 第十六批：这才是「B 站链接发出去还是纯链接」的真因 ──────────────
   * 实发日志里只有一行 `[video] bilibili view/direct 不可用：bilibili 风控：request was banned`，
   * 然后就没有下文了。老路径 `/x/web-interface/view` 在这台机房 IP 上是**稳定 412**，
   * 于是掉到第 2 路 pagelist（它只给标题和时长，**没有封面**），再掉"拿标题反查搜索"
   * （时通时 412）、再掉视频页 og:meta（同样 412）。最终 `info.cover` 是空串，
   * 而 `fetchMiniAppArk` 原来要求必须有封面 → 直接 return null
   * → console-server 里"没 Ark 也没封面" → seg=null → 降级梯子发分享链接。
   * 也就是说：**卡片的零件都在，是"封面"这一个前置条件把整条小程序链路掐断了。**
   *
   * 同一分钟、同一 BV，在服务器上直连实测的对照：
   *   GET /x/web-interface/view?bvid=BV13Xb56NEEZ      → HTTP 412（风控页 3286B）
   *   GET /x/web-interface/wbi/view?bvid=BV13Xb56NEEZ  → HTTP 200 code=0，字段与 view 同构：
   *       title="五十个角色、五十种声音、同一个我"  owner=困雀雀
   *       pic=http://i1.hdslb.com/bfs/archive/d806bc14c8c044b81799200896aa1cb7be45a8e2.jpg
   *       duration=204  stat.view=392087  desc=…
   *   （换 BV1d4411N7zD 复测同样 200；再同一时刻打老 view 仍然 412）
   * 结论：风控是**按老路径打的**，wbi 那条没被拦；而且它**不强制 w_rid 签名**，裸调即可。
   * 所以第一优先改成 wbi/view，老 view 留着兜底（换机器/换网络可能反过来好使）。
   *
   * 【2026-09-18 接入 secapi 后的改动，只有两处，其余逐字未动】：
   *   ① 第 0 路已经把信息拿全了 → **整段跳过**，不再白打两条官方接口；
   *   ② secapi 只给了一部分（比如没封面）时照旧进这里，但用 `{...got, ...pruneEmpty(info)}`
   *      **只补空字段、不覆盖第三方已给的值**（`pruneEmpty` 会把空值剔掉，所以 got 里的空字段
   *      不会把 secapi 的标题顶掉）。拿到东西就 break，判据仍是 `if (info)`，与改动前一致。 */
  if (!info?.cover || !info?.author || !info?.title) {
    for (const apiPath of VIEW_API_PATHS) {
      for (const via of vias) {
        const tag = apiPath.includes('/wbi/') ? 'wbi/view' : 'view';
        try {
          const got = await biliViaView(id, kind, via, apiPath);
          info = info ? { ...got, ...pruneEmpty(info) } : got;
          break;
        } catch (e) { lastErr = e; log(`[video] bilibili ${tag}/${via} 不可用：${e?.message ?? e}`); }
      }
      if (info) break;
    }
  }

  // 第 2 路：分P拿准确标题+时长 → 再用标题反查补齐封面/UP主/播放量
  if (!info?.cover || !info?.author || !info?.title) {
    let pages = null;
    for (const via of vias) {
      try { pages = await biliViaPages(id, kind, via); break; } catch (e) { lastErr = lastErr || e; log(`[video] bilibili pagelist/${via} 不可用：${e?.message ?? e}`); }
    }
    if (pages) {
      info = { ...pages, ...pruneEmpty(info) };     // view 已经拿到的字段优先
      if (!info.cover || !info.author) {
        for (const via of vias) {
          try {
            const extra = await withBanRetry(() => biliViaSearchByTitle(info.title, id, via));
            info = { ...info, ...pruneEmpty(extra), title: info.title || extra.title, durationSec: info.durationSec || extra.durationSec };
            break;
          } catch (e) { lastErr = lastErr || e; log(`[video] bilibili 标题反查/${via} 不可用：${e?.message ?? e}`); }
        }
      }
    }
  }

  // 第 3 路：网页 og: meta 兜底（国内 IP 常能成，机房 IP 常 412；主要用来补封面）
  if (!info || !info.cover) {
    for (const via of vias) {
      try {
        const target = via === 'direct' || !PUBLIC_PROXIES[0] ? url : PUBLIC_PROXIES[0](url);
        const r = await fetchOnce(target, { headers: { referer: 'https://www.bilibili.com/' } });
        const fromHtml = infoFromHtml(r.text, url);
        if (fromHtml?.title) {
          info = info ? { ...info, ...pruneEmpty(fromHtml), title: info.title || fromHtml.title } : fromHtml;
          log(`[video] bilibili og:meta 补齐 via=${via}`);
          break;
        }
      } catch { /* 下一路 */ }
    }
  }

  if (!info) throw lastErr || new Error('bilibili 解析失败');

  /* 卡片/小程序要用的"分享链"（shareUrl）在这里定下来，规则按优先级：
   *   ① 用户给的就是 b23.tv 链接 → 原样用他那条（短码是 B 站签的，反推不回来）；
   *   ② 我们有 BV 号 → 向官方 x/share/click 要一条**真短码**（形态与真卡一致）；
   *      拿不到就退回 b23.tv/<BV>（bilibili-API-collect 明文承认的官方形态，不会过期）；
   *   ③ 都不是 → 空串，调用方回落到长链。 */
  let shareUrl = givenShortUrl;
  if (!shareUrl && kind === 'bvid' && id) {
    const code = await fetchBiliShareCode(id, info.aid);
    shareUrl = code ? `https://b23.tv/${code}` : `https://b23.tv/${id}`;
    if (!code) log(`[video] 没拿到官方短码，本次卡片用 b23.tv/${id}（BV 形态，官方文档承认且不过期）`);
  }
  // 兜底：输入本来就是别的 b23.tv 形态（如 /av<aid>），原样用它
  if (!shareUrl && /^https?:\/\/b23\.tv\//i.test(String(rawUrl).trim())) shareUrl = String(rawUrl).trim();
  if (givenShortUrl) log(`[video] 用户给的是 b23.tv 短链，原样保留：${givenShortUrl}`);

  return {
    platform: 'bilibili',
    id,
    kind,
    url,
    shareUrl,
    title: info.title,
    author: info.author || '',
    cover: normalizeImageUrl(info.cover),
    description: info.description || '',
    durationSec: info.durationSec || 0,
    durationText: info.durationSec ? formatDuration(info.durationSec) : '',
    stat: info.stat || {},
    playText: formatCount(info.stat?.play),
    pubdate: info.pubdate || 0,
    pubdateText: info.pubdate ? new Date(info.pubdate * 1000).toISOString().slice(0, 10) : (info.pubdateText || ''),
    source: info.source || '',
  };
}

/** 封面统一 https（手机端不吃明文 http；bilibili 图床支持 https） */
export function normalizeImageUrl(raw, { width = 0, height = 0 } = {}) {
  let u = String(raw ?? '').trim();
  if (!u) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  if (/^http:\/\//i.test(u)) u = u.replace(/^http:\/\//i, 'https://');
  // bilibili 图床支持 @<w>w_<h>h 缩略后缀：卡片封面用缩图，避免超大图在手机端加载不出来
  if (width && height && /hdslb\.com\//i.test(u) && !/@\d+w_\d+h/.test(u)) {
    u = u.replace(/@[^@]*$/, '') + `@${width}w_${height}h_1c.webp`;
  }
  return u;
}

/** 抖音：短链 → 真实地址 → 从分享页 HTML 里抠 _ROUTER_DATA / og: meta */
export async function resolveDouyin(rawUrl) {
  const parsed = parseVideoUrl(rawUrl);
  if (!parsed || parsed.platform !== 'douyin') throw new Error('不是抖音链接');
  let url = parsed.url;
  let id = parsed.id || '';
  if (!id) {
    const finalUrl = await followRedirect(rawUrl);
    const m = /\/(?:video|note|share\/video)\/(\d{6,})/.exec(finalUrl);
    if (m) { id = m[1]; url = `https://www.douyin.com/video/${m[1]}`; }
    else url = finalUrl;
  }

  // 分享页（iesdouyin 是留给分享的轻页面，比主站好抓）
  const candidates = [
    id ? `https://www.iesdouyin.com/share/video/${id}/` : '',
    url,
  ].filter(Boolean);

  for (const target of candidates) {
    for (const via of ['direct', ...(PUBLIC_PROXIES.length ? ['proxy'] : [])]) {
      try {
        const reqUrl = via === 'direct' || !PUBLIC_PROXIES[0] ? target : PUBLIC_PROXIES[0](target);
        const r = await fetchOnce(reqUrl, { headers: { referer: 'https://www.douyin.com/' } });
        const info = infoFromDouyinHtml(r.text) || null;
        if (info?.title || info?.cover) {
          return {
            platform: 'douyin',
            id,
            url: url || target,
            title: info.title || '',
            author: info.author || '',
            cover: normalizeImageUrl(info.cover),
            description: info.description || '',
            durationSec: 0,
            durationText: '',
            stat: {},
            playText: '',
            pubdate: 0,
            pubdateText: '',
            source: via === 'direct' ? 'html' : 'html-proxy',
          };
        }
      } catch (e) {
        log(`[video] 抖音 ${via} 失败：${e?.message ?? e}`);
      }
    }
  }
  const err = new Error('抖音分享页没有可直接读的标题/封面（页面是 SPA + 签名接口）');
  err.degraded = true;
  throw err;
}

/** 抖音分享页：先找 _ROUTER_DATA（SSR 内嵌 JSON），再退 og: meta */
function infoFromDouyinHtml(html) {
  const s = String(html ?? '');
  const m = /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(s);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const loader = data?.loaderData || {};
      for (const v of Object.values(loader)) {
        const item = v?.videoInfoRes?.item_list?.[0] || v?.aweme_detail || v?.videoInfoRes?.aweme_detail;
        if (item) {
          return {
            title: String(item.desc ?? '').trim().slice(0, 200),
            author: String(item.author?.nickname ?? '').trim(),
            cover: String(item.video?.cover?.url_list?.[0] ?? item.video?.origin_cover?.url_list?.[0] ?? '').trim(),
            description: String(item.desc ?? '').trim().slice(0, 500),
          };
        }
      }
    } catch { /* 退到 og */ }
  }
  const doc = extractReadableHtml(s, { includeLinks: false, maxChars: 800 });
  if (!doc.title && !doc.image) return null;
  return {
    title: cleanBiliTitle(doc.title).replace(/[-—]\s*抖音.*$/, '').trim(),
    author: '',
    cover: doc.image || '',
    description: (doc.description || '').slice(0, 500),
  };
}

/** 统一入口：按平台分派 */
export async function resolveVideo(rawUrl) {
  const parsed = parseVideoUrl(rawUrl);
  if (!parsed) throw new Error('认不出这是哪家的视频链接');
  if (parsed.platform === 'bilibili') return resolveBilibili(rawUrl);
  if (parsed.platform === 'douyin') return resolveDouyin(rawUrl);
  /* 其它平台（YouTube / X / Telegram / Pixiv / 快手 / 小红书 / 微博…）：
   * 只做"通用抓一下 og: meta"，拿不到就只剩链接 —— 这几个平台本来就在 QQ 的链接预览白名单里，
   * 卡片由客户端渲染，我们只需要把**标题**取回来说人话（发出去的永远是官方链接，不是自造卡片）。 */
  const referer = parsed.platform === 'pixiv' ? 'https://www.pixiv.net/'
    : parsed.platform === 'x' ? 'https://x.com/'
      : parsed.platform === 'telegram' ? 'https://t.me/'
        : rawUrl;
  let r;
  try {
    r = await fetchOnce(parsed.url || rawUrl, { headers: { referer } });
  } catch (e) {
    const err = new Error(`抓取 ${parsed.platform} 页面失败：${e?.message ?? e}`);
    err.degraded = true;
    throw err;
  }
  const doc = extractReadableHtml(r.text, { url: rawUrl, includeLinks: false, maxChars: 800 });
  if (!doc.title && !doc.image) throw new Error(`${parsed.platform} 没抓到可用的标题/封面（可能需要登录）`);
  // X 的 og:title 常常就是推文正文；Telegram 的 og:description 是频道简介
  const author = (doc.siteName && doc.siteName !== doc.title ? doc.siteName : '').trim();
  return {
    platform: parsed.platform,
    id: parsed.id,
    url: parsed.url || rawUrl,
    title: cleanBiliTitle(doc.title).replace(/\s*[-|·]\s*(YouTube|X|Twitter|Telegram|Pixiv)\s*$/i, '').slice(0, 200),
    author,
    cover: normalizeImageUrl(doc.image),
    description: (doc.description || '').slice(0, 500),
    durationSec: 0,
    durationText: '',
    stat: {},
    playText: '',
    pubdate: 0,
    pubdateText: '',
    source: 'html',
  };
}

/* ============================ 卡片 ============================ */

const PLATFORM_LABEL = {
  bilibili: '哔哩哔哩',
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  weibo: '微博',
  youtube: 'YouTube',
  x: 'X',
  telegram: 'Telegram',
  pixiv: 'Pixiv',
};

/**
 * 拼 QQ 卡片。返回与音乐卡片同构的 { title, primary, native, link, note }。
 *
 * ⚠️ 2026-09-18 实测纠偏（主人反馈"显示发送者QQ版本太低，无法展示内容"）：
 *   手写的 `json` 段（com.tencent.structmsg / view=news）在**新版 QQ 上会被直接拒收**，
 *   对方看到的是"发送者QQ版本太低，无法展示内容"。这跟本仓库里 QQ 音乐那次结论一致
 *   （见 media.js：ss.xingzhige 关闭 id 解析后，QQ 音乐改成发官方分享链接文本，
 *   由客户端自己渲染卡片）。所以视频默认也走**官方分享链接文本**：
 *   B 站/抖音都在 QQ 的联合预览白名单里，客户端自己会渲染出带封面/标题的原生卡片 ——
 *   比机器人手写的假卡更好，而且不会"版本太低"。
 *
 *   primary 因此默认是 null，真正的载体是 link（纯文本，走桥的文本发送通道）。
 *
 * 【2026-09-18 第十五批】`opts.style='json'` / `QQBRIDGE_VIDEO_CARD=json` 这条路**已停用**：
 *   它手拼的 structmsg/news 卡 `config.token` 只能是空串，会命中"空 token 被 QQ 服务端静默拒收"
 *   那个已知坑（详见本函数尾部的注释）。现在传 json 也只是打一行日志、照样发分享链接。
 *   要原生卡片请走 `fetchMiniAppArk`（miniapp_01，token 由 QQ 服务端签发）。
 */
/**
 * 【2026-09-18 第八批·重大纠正】B 站**原生小程序卡片**其实做得到 —— 直接调 NapCat 的 `get_mini_app_ark`。
 *
 * 前两轮的结论（"小程序 Ark 是客户端能力、服务器版 QQ 生成不了、`res.content` 是 undefined 所以走不通"）
 * **是错的**。线上复测（同一台 QQ 3.2.33-52892 + NapCat 4.18.28，四种参数全试）：
 *
 *   POST /get_mini_app_ark {type:'bili', title, desc, picUrl, jumpUrl}
 *   → {"status":"ok","data":{"data":{ app:"com.tencent.miniapp_01",
 *        view:"view_8C8E89B49BE609866298ADDFF2DBABA4",
 *        meta:{detail_1:{appid:"1109937557", title:"哔哩哔哩", desc:<我们的 title>,
 *                        preview:<封面>, url:"m.q.qq.com/a/s/<hash>",
 *                        shareTemplateId:"8C8E89B49BE609866298ADDFF2DBABA4", host:{uin,nick}}},
 *        config:{type:"normal", forward:1, ctime:…, token:"<签名>"},
 *        miniappShareOrigin:3, miniappOpenRefer:"10002"}}}
 *
 * 这跟主人从 B 站分享进来的**真卡**（见 console-server 里 13.2 那段记录）逐字段对得上：
 * 同一个 `app=com.tencent.miniapp_01`、同一个 `view=view_8C8E89…`、同一个 `appid=1109937557`、
 * 同一个 `shareTemplateId`，连 `m.q.qq.com/a/s/<hash>` 短链和 `config.token` **都是服务端现签的**。
 * 也就是说：**签名不是伪造的，是 QQ 服务端给的** —— 桥只是把参数换成这条视频的。
 *
 * 为什么之前失败：那是**另一轮的偶发失败**（当时那条报的是 `res.content` undefined），
 * 不是"QQ 版本不支持"、更不是"客户端能力"。底下走的是 SSO 服务端命令
 * `LightAppSvc.mini_app_share.AdaptShareInfo`（见 NapCat `operationContext.ts` /
 * `GetMiniAppAdaptShareInfo.ts`），跟本地 QQ 客户端版本无关。
 *
 * 所以"升级 Linux QQ"这条路**不需要走**：NapCat 4.18.28 的版本支持表（`packages/napcat-core/external/*.json`）
 * 最高只到 `3.2.33-52892`，**正是现在这台装的**；装更新的 QQ 反而会让 NapCat 找不到
 * appid/packet/napi2native 映射而直接坏掉。
 *
 * ── 2026-09-18 第十五批·修「B 站卡片能发出来，但点进去不是那个视频」──
 * 物证（`tools/diag-bili-forensic.mjs` 从 NapCat 消息记录里挖出来的那条卡，私聊 1736784911）：
 *   msgId=1559621895  2026-09-18 12:56:17Z  sender=3199924964  real_seq=11222（seq 前进 = 真送达）
 *   app=com.tencent.miniapp_01  view=view_8C8E89B49BE609866298ADDFF2DBABA4
 *   meta.detail_1 = { appid:"1109937557", title:"哔哩哔哩", desc:"【4K修复】周杰伦 - 晴天",
 *                     url:"m.q.qq.com/a/s/beec9bb4fa643e530120b82c9026e71f",
 *                     config.token 由服务端签发 …  —— **没有任何 qqdocurl 字段** }
 * 同一时间窗里**真人从 B 站 App 分享进 QQ 的真卡全都带 qqdocurl**（同一台 NapCat 回读，共 4 张）：
 *   09-17 15:11:22 私聊  desc=“你觉得世界上大多数痛苦…”， qqdocurl=https://b23.tv/WZVnINP?share_medium=android&share_source=qq&bbid=…&ts=…
 *   09-18 11:48:23 群 868756515  qqdocurl=https://b23.tv/9kFv2VX?share_medium=android&share_source=qq&bbid=…&ts=…
 *   09-18 12:46:18 群 868756515  qqdocurl=https://b23.tv/w1c4DfM?share_medium=android&share_source=qq&bbid=…&ts=…
 *   09-18 13:05:35 私聊  desc=五十个角色、五十种声音、同一个我， qqdocurl=https://b23.tv/1ncmZVP?…
 * B 站小程序**点开后靠 `qqdocurl` 决定进哪个视频页**，缺了它就只剩小程序的 url（m.q.qq.com 短链），
 * 于是"卡片显示正常、封面标题都对，点进去却不是那个视频"。
 *
 * qqdocurl 从哪来？NapCat 把 `webUrl` 原样放进 Ark 请求体的 `webURL`（/root/napcat-build/napcat.mjs:14206
 * `webURL: e.webUrl ?? ""`）。`tools/probe-miniapp-ark.mjs` 做的对照实验（同一 BV，只改一个参数）：
 *   A 不传 webUrl                      → detail_1 **没有 qqdocurl**
 *   B webUrl=https://b23.tv/BV1GJ411x7h7 → qqdocurl=https://b23.tv/BV1GJ411x7h7
 *   C webUrl=https://www.bilibili.com/video/BV1GJ411x7h7 → qqdocurl=同一条长链
 *   D jumpUrl/webUrl 都用长链           → qqdocurl=同一条长链
 * 即：**QQ 服务端只在 webURL 非空时才生成 qqdocurl，值就是 webURL 的原样回显**。
 * 之前这里只传了 jumpUrl、没传 webUrl —— 这正是那张卡没有 qqdocurl 的原因。
 *
 * @returns {Promise<null|{type:'json', data:{data:string}}>} 可直接当 rich 段的 json 段；失败返回 null
 */
export async function fetchMiniAppArk(info, { httpUrl = '', token = '', timeoutMs = 12000 } = {}) {
  const platform = String(info?.platform ?? '');
  const type = platform === 'bilibili' ? 'bili' : (platform === 'weibo' ? 'weibo' : '');
  if (!type) return null;                       // 模板只有 bili / weibo 两种
  const base = String(httpUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const title = String(info?.title ?? '').trim();
  const picUrl = String(info?.cover ?? '').trim();
  const jumpUrl = (platform === 'bilibili' && (info?.shareUrl || (info?.kind === 'bvid' && info?.id)))
    ? String(info.shareUrl || `https://b23.tv/${info.id}`)   // 真卡的 qqdocurl 也是 b23.tv 短链
    : String(info?.url ?? '').trim();
  /* webUrl —— **必须传**，它是 qqdocurl 的唯一来源（见上面第十五批的对照实验 A/B/C/D）。
   *
   * 【2026-09-18 二次修正】原来这里取**长链** `https://www.bilibili.com/video/BV…`，
   * 理由是"B 站的规范路由、不用解析短链"。实测发出去后**点进去仍然落不到那条视频**，
   * 而真卡的 `qqdocurl` 形如 `https://b23.tv/<不透明短码>?share_medium=android&share_source=qq&bbid=…&ts=…`
   * —— 也就是 **b23.tv 短链**（同一台机器回读到 4 张真卡，张张如此）。
   *
   * 合理解释：B 站小程序认的是**自己那套 b23.tv 分享链**，给它一个站内网页 URL 它无法据此路由。
   * 所以 webUrl 改回 b23.tv 短链，和真卡保持一致。
   * `https://b23.tv/<BV号>§` 这种形态在 HTTP 层是通的（家宽 IP 抽 8 个真实 BV，8/8 都是
   * `302 → /video/<同一个BV> → 301 → 200`，终点页 <title> 就是那条视频，见 tools/probe-b23-bv.mjs）。
   *
   * 真卡那串 `?share_medium=…&share_source=qq&bbid=…&ts=…` 是 B 站 App 分享时自己带的，
   * 我们**没有**伪造它（bbid 是设备标识、ts 是分享时刻，编不出来也不该编）。
   *
   * ── 2026-09-18 第十七批·把"短码形态"这件事做实 ────────────────────────────────
   * 上一批的结论"真卡用的是 b23.tv 短链，所以我们也拼 b23.tv/<BV>"只对了一半：
   * 形态对不上 —— 真卡是**7 位不透明短码**（`b23.tv/1ncmZVP`），我们是**BV 当路径**
   * （`b23.tv/BV13Xb56NEEZ`）。两者在 b23.tv 的 HTTP 层都能 302 到视频页，所以 HTTP 层
   * 证明不了差别；但 B 站小程序内部是按 qqdocurl 自己那套分享链路由的，形态不同就有风险。
   * 现在不再靠猜：`resolveBilibili` 会直接向官方 `x/share/click` 要一条**真短码**，
   * 这里用 `info.shareUrl`（拿不到才退回 BV 形态）。实测依据见 `fetchBiliShareCode` 的注释。
   *
   * ── 没验证到的部分（不要粉饰）──────────────────────────────────────────────
   * `detail_1.url`（`m.q.qq.com/a/s/<hash>`）是 QQ 服务端签的短链，我们**无法解码**它指向
   * 小程序哪个页面：`tools/probe-qq-miniapp-url.mjs` 用安卓/iPhone QQ 的 UA 跟过真卡和我们的卡，
   * 落地页对两者返回**同一份 3948 字节的壳**，页内只有 `mqqapi://microapp/open?url=` 和
   * `jump-qq.js`，没有任何"hash → 目标页"的接口可查。所以"点进去到底是不是那条视频"
   * **只能在真机 QQ 上看**，服务端侧证明不了。这里能做的是把 qqdocurl 形态对齐真卡。 */
  const webUrl = jumpUrl;
  /* 硬性要求只有两个：title 缺了卡片没标题，jumpUrl 缺了没有跳转目标。
   *
   * 【2026-09-18 第十六批】**封面不再是硬性要求**。原来这里写的是
   *   `if (!title || !picUrl || !jumpUrl) return null;`
   * —— 于是 bilibili 一被风控、resolveVideo 交回空 cover，整条小程序卡链路就**静默断掉**
   * （这个分支连一行日志都没有），降级梯子转而发纯文本链接。
   * 线上 13:25/13:26/13:27 那四次实发全是这个原因，而"函数级自检"因为自己编了封面，
   * 一次都没走到这里 —— 这就是"自检全绿、实发还是链接"的断点。
   *
   * 直接问 NapCat 的对照实验（同一 BV，只改 picUrl 一个字段，rawArkData=true）：
   *   A picUrl=https://i0.hdslb.com/…jpg → app=com.tencent.miniapp_01 view=view_8C8E89…
   *       detail_1.url=m.q.qq.com/a/s/ac97… qqdocurl=https://b23.tv/BV13Xb56NEEZ
   *       preview=https://qq.ugcimg.cn/v1/…（服务端还会把封面重挂到自己图床）config.token 非空
   *   B picUrl=""（空串）                → app / view / url / qqdocurl / token **一样齐全**，
   *       只是 detail_1.preview 是空串 —— 即"没有缩略图的卡片"，不是"没有卡片"
   *   C 索性不传 picUrl 这个键            → 400 Schema compilation error: Expected union value
   *   D 只传 title+jumpUrl                → 同样 400
   * 所以：**picUrl 这个键必须在，值可以是空串**。宁可发一张没有缩略图的真卡片，
   * 也不要因为拿不到封面就退回纯链接 —— 卡片上的标题/UP主/时长照样准，点进去照样是那条视频。 */
  if (!title || !jumpUrl) {
    log(`[video] 不向 QQ 要小程序 Ark：缺 ${[!title && 'title', !jumpUrl && 'jumpUrl'].filter(Boolean).join('+')} —— 这次只能退回分享链接`);
    return null;
  }
  if (!picUrl) {
    log('[video] 本次没有封面（bilibili 风控拿不到 pic）—— 照样要 Ark：实测 picUrl 传空串，'
      + '服务端仍会签发 url/qqdocurl/token，只是卡片没有缩略图');
  }
  const bits = [];
  if (info?.author) bits.push(info.author);
  if (info?.playText) bits.push(`${info.playText}播放`);
  if (info?.durationText) bits.push(info.durationText);
  const desc = bits.join(' · ') || String(info?.description ?? '').slice(0, 60) || title;

  let body = null;
  try {
    const res = await fetch(`${base}/get_mini_app_ark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      // rawArkData=true 拿"原始形态"（appName/appView/metaData），再自己转成发送形态 ——
      // 与 NapCat 内部 MiniAppInfoHelper.RawToSend 的映射逐字一致。
      // webUrl 一定要带：不带就没有 qqdocurl，卡片点进去落不到那条视频（第十五批物证）。
      body: JSON.stringify({ type, title: title.slice(0, 100), desc: desc.slice(0, 100), picUrl, jumpUrl, webUrl, rawArkData: 'true' }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    body = await res.json().catch(() => null);
  } catch (error) {
    log(`[video] get_mini_app_ark 请求失败（${error?.message ?? error}），退回封面+链接`);
    return null;
  }
  const raw = body?.data?.data ?? body?.data ?? null;
  if (!raw?.metaData || !raw?.appName) {
    log(`[video] get_mini_app_ark 没给出可用 Ark（${String(body?.message ?? body?.wording ?? '').slice(0, 80)}），退回封面+链接`);
    return null;
  }
  const send = {
    ver: raw.ver,
    prompt: raw.prompt,
    config: raw.config,
    app: raw.appName,
    view: raw.appView,
    meta: raw.metaData,
    miniappShareOrigin: 3,
    miniappOpenRefer: '10002'
  };
  /* 日志里把 qqdocurl 打出来：它是"点进去是不是这条视频"的唯一判据，
   * 以后线上再出同类问题，看这一行就知道卡片有没有带对目标。 */
  const docUrl = send.meta?.detail_1?.qqdocurl;
  log(`[video] 小程序 Ark 已生成：app=${send.app} view=${send.view}（${type}）webUrl=${webUrl} qqdocurl=${docUrl || '(缺失！点开不会落到这条视频)'}`);
  if (!docUrl) log(`[video] 警告：本次请求带了 webUrl=${webUrl} 但服务端没回 qqdocurl —— 卡片点开会落不到目标视频`);
  return { type: 'json', data: { data: JSON.stringify(send) } };
}

export function buildVideoCard(info, opts = {}) {
  const label = PLATFORM_LABEL[info?.platform] || '视频';
  const title = String(info?.title ?? opts.title ?? '').trim() || `${label}视频`;
  const url = String(info?.url ?? opts.url ?? '').trim();
  if (!url) throw new Error('视频卡片需要可点开的链接');
  const style = String(opts.style ?? process.env.QQBRIDGE_VIDEO_CARD ?? 'share').trim().toLowerCase();

  // 分享文案对齐真人从 B 站"分享到 QQ"的形态：标题 - UP主 + **短链**
  //
  // ⚠️ 2026-09-18 实测纠偏 2（主人反馈"bilibili卡片渲染失败，是链接"）：
  //   发 `https://www.bilibili.com/video/BVxxx` 长链时对方看到的是**纯链接、没有卡片** ——
  //   QQ 的链接预览只认它白名单里的**分享短域**（b23.tv）。
  //   而 `https://b23.tv/BV号` 是合法短链：实测它 302 到对应视频页（本来只用它做解析，现在直接用它当卡片载体）。
  //   所以 bilibili 一律发 b23.tv 短链，长链只在拿不到 BV 号时才退回去。
  //   【第十七批】优先用 `info.shareUrl` —— 它可能是用户给的短码，也可能是官方 x/share/click 签发的
  //   真短码；`b23.tv/<BV>` 只是这两种都拿不到时的兜底（形态见 fetchBiliShareCode 的实测注释）。
  const shareUrl = (() => {
    if (info?.platform === 'bilibili') return String(info?.shareUrl || (info?.kind === 'bvid' && info?.id ? `https://b23.tv/${info.id}` : url));
    if (info?.platform === 'youtube' && info?.id) return `https://youtu.be/${info.id}`;
    return url;
  })();
  const shareText = `${title}${info?.author ? ' - ' + info.author : ''} ${shareUrl}`;

  const base = { title, native: null, link: shareText, platform: info?.platform || '', info, style };

  /* 【2026-09-18 第十五批·停用"手拼 structmsg Ark"这条路，别再让 token 为空的手拼卡上线】
   *
   * style==='json' 时这里原来会手拼一张 `com.tencent.structmsg / view=news` 的 Ark，
   * 其中 `config.token` 是**空字符串**。本仓库已实测过的坑（见 media.js 的"对账"注释与
   * tools/diag-seq-history.mjs）：**手写 Ark 的 token 是空/随机值时 QQ 服务端直接拒收** ——
   * 消息只写进本地库、对方什么都收不到；判据是回读消息的 `real_seq` **不前进**
   * （diag-seq-history 在线上跑出来的就是一批"com.tencent.tuwen.lua … ❌ 本地幽灵"）。
   *
   * 我（这一批）**没有复现**"structmsg+空 token"这一条 —— bridge.log 里找不到 structmsg 的记录
   * （`grep structmsg` 无命中），线上最近发出去的视频卡都是 miniapp_01 或分享链接，所以这条结论
   * 沿用仓库既有实测记录，不当成新证据。但既然它是**已知会静默丢消息**的形态，
   * 就不该留一个"改个环境变量就能把幽灵卡发上线"的开关：
   * 现在 style==='json' **不再产出任何 Ark**，一律退回与默认相同的分享链接形态，并在日志里说明原因。
   *
   * 真正可用的原生卡片是 **NapCat 的 `get_mini_app_ark`**（app=com.tencent.miniapp_01，
   * token/url/preview 全部由 QQ 服务端现场签发）—— 那条在 console-server 的视频分支里是第一优先，
   * 与本函数的 primary 无关。 */
  if (style === 'json') {
    log(`[video] QQBRIDGE_VIDEO_CARD=json 已停用：手拼 structmsg 卡的 token 只能为空，`
      + `QQ 服务端会静默拒收（real_seq 不前进，对方收不到）—— 本次改发分享链接；`
      + `想要原生卡片请依赖 NapCat get_mini_app_ark（miniapp_01，服务端签名）`);
  }

  return {
    ...base,
    primary: null,
    note: style === 'share'
      ? `官方分享链接（${label}，QQ 客户端自己渲染卡片；手写 json 卡会被新版 QQ 判"版本太低"）`
      : `手拼 json 卡已停用（空 token 会被 QQ 服务端静默拒收）→ 改发官方分享链接（${label}）`,
  };
}

/* ============================ 搜索（按关键词找视频） ============================ */

/**
 * bilibili 关键词搜视频。走 search/type 接口（可用性随风控波动，失败就如实报错）。
 * @returns {{ platform:string, results:Array<{bvid,title,author,duration,play,cover,url,description}> }}
 */
export async function videoSearch(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索词不能为空');
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 8));

  let lastErr = null;
  for (const via of ['direct', ...(PUBLIC_PROXIES.length ? ['proxy'] : [])]) {
    try {
      const d = await withBanRetry(() => biliJson(
        `/x/web-interface/search/type?search_type=video&page=1&page_size=${limit}&keyword=${encodeURIComponent(q)}`,
        { via },
      ));
      const list = Array.isArray(d?.result) ? d.result : [];
      const results = list.slice(0, limit).map((r) => {
        const bvid = String(r.bvid || '').trim();
        return {
          bvid,
          aid: String(r.aid || ''),
          title: cleanBiliTitle(r.title),
          author: String(r.author || ''),
          duration: String(r.duration || ''),
          play: Number(r.play) || 0,
          playText: formatCount(Number(r.play) || 0),
          danmaku: Number(r.video_review) || 0,
          typeName: String(r.typename || ''),
          cover: normalizeImageUrl(String(r.pic || '')),
          description: String(r.description || '').replace(/<[^>]*>/g, '').slice(0, 200),
          url: bvid ? `https://www.bilibili.com/video/${bvid}` : String(r.arcurl || '').replace(/^http:\/\//i, 'https://'),
          pubdateText: r.pubdate ? new Date(Number(r.pubdate) * 1000).toISOString().slice(0, 10) : '',
        };
      });
      return { platform: 'bilibili', query: q, via, results };
    } catch (e) {
      lastErr = e;
      log(`[video] bilibili 搜索 ${via} 失败：${e?.message ?? e}`);
    }
  }
  throw lastErr || new Error('bilibili 搜索失败');
}
