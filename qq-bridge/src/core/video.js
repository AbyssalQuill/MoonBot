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
    // 短链 / 其它形态：交给解析阶段跟随重定向
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

/** 单路：view 接口（信息最全） */
async function biliViaView(id, kind, via) {
  const q = kind === 'aid' ? `aid=${encodeURIComponent(id)}` : `bvid=${encodeURIComponent(id)}`;
  const d = await biliJson(`/x/web-interface/view?${q}`, { via });
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
    source: via === 'direct' ? 'api' : 'api-proxy',
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

/**
 * 解析一个 bilibili 链接/短链 → 统一信息对象。
 * 多路降级，任一成功即返回；全失败抛出最后一个错误（调用方还有"只剩链接"这条路）。
 */
export async function resolveBilibili(rawUrl) {
  const parsed = parseVideoUrl(rawUrl);
  if (!parsed || parsed.platform !== 'bilibili') throw new Error('不是 bilibili 链接');
  let { kind, id } = parsed;
  let url = parsed.url;

  if (kind === 'short' || !id) {
    const finalUrl = await followRedirect(rawUrl);
    const p2 = parseVideoUrl(finalUrl);
    if (p2 && p2.id) { kind = p2.kind; id = p2.id; url = p2.url; }
    else throw new Error(`无法从短链里认出视频号：${finalUrl}`);
  }

  const vias = ['direct', ...(PUBLIC_PROXIES.length ? ['proxy'] : [])];
  let info = null;
  let lastErr = null;

  // 第 1 路：view —— 一次拿全（标题/UP主/封面/时长/播放量），可惜这台机房 IP 会被 412
  for (const via of vias) {
    try { info = await biliViaView(id, kind, via); break; } catch (e) { lastErr = e; log(`[video] bilibili view/${via} 不可用：${e?.message ?? e}`); }
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

  return {
    platform: 'bilibili',
    id,
    kind,
    url,
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
 *   primary 因此默认是 null，真正的载体是 link（纯文本，走桥的文本发送通道）；
 *   想强行试手写卡片的机器上用 opts.style='json' 或环境变量 QQBRIDGE_VIDEO_CARD=json。
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
  const jumpUrl = (platform === 'bilibili' && info?.kind === 'bvid' && info?.id)
    ? `https://b23.tv/${info.id}`                  // 真卡的 qqdocurl 也是 b23.tv 短链
    : String(info?.url ?? '').trim();
  if (!title || !picUrl || !jumpUrl) return null;
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
      body: JSON.stringify({ type, title: title.slice(0, 100), desc: desc.slice(0, 100), picUrl, jumpUrl, rawArkData: 'true' }),
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
  log(`[video] 小程序 Ark 已生成：app=${send.app} view=${send.view}（${type}）`);
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
  const shareUrl = (() => {
    if (info?.platform === 'bilibili' && info?.kind === 'bvid' && info?.id) return `https://b23.tv/${info.id}`;
    if (info?.platform === 'youtube' && info?.id) return `https://youtu.be/${info.id}`;
    return url;
  })();
  const shareText = `${title}${info?.author ? ' - ' + info.author : ''} ${shareUrl}`;

  const statBits = [];
  if (info?.author) statBits.push(info.author);
  if (info?.playText) statBits.push(`${info.playText}播放`);
  if (info?.durationText) statBits.push(info.durationText);
  const sub = statBits.join(' · ') || (info?.description || '').slice(0, 60);
  const cover = normalizeImageUrl(info?.cover, { width: 480, height: 270 });

  const base = { title, native: null, link: shareText, platform: info?.platform || '', info, style };

  if (style !== 'json') {
    return {
      ...base,
      primary: null,
      note: `官方分享链接（${label}，QQ 客户端自己渲染卡片；手写 json 卡会被新版 QQ 判"版本太低"）`,
    };
  }

  const payload = {
    app: 'com.tencent.structmsg',
    desc: '新闻',
    view: 'news',
    ver: '0.0.0.1',
    prompt: `[分享] ${title}`.slice(0, 100),
    /* 【2026-09-18】补 `extra` —— 主人发进来的真实 B 站卡片是 `m.q.qq.com/a/s/<hash>` 的
     * structmsg/news，除了 meta.news 之外顶层还带一个 extra（app_type/appid/uin/type）。
     * 之前缺这一段，很可能就是新版 QQ 判"版本太低"的原因之一。 */
    extra: { app_type: 1, appid: '100951776', uin: 0, type: 'normal' },
    config: { autosize: true, ctime: Math.floor(Date.now() / 1000), forward: true, token: '', type: 'normal' },
    meta: {
      news: {
        action: '',
        app_type: 1,
        appid: '100951776',
        appType: 1,
        ctime: Math.floor(Date.now() / 1000),
        desc: sub.slice(0, 150),
        jumpUrl: url,
        tag: label,
        title: title.slice(0, 120),
        source: label,
        ...(cover ? { preview: cover, image: cover } : {}),
      },
    },
  };

  return {
    ...base,
    // NapCat json 段：data 是"字符串里的 JSON"
    primary: { type: 'json', data: { data: JSON.stringify(payload) } },
    note: cover
      ? `桥拼 ${label} 卡片（structmsg/news，封面 480×270 已归一化 https）—— 新版 QQ 可能拒收`
      : `桥拼 ${label} 卡片（structmsg/news，没取到封面）—— 新版 QQ 可能拒收`,
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
