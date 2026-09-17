// Pixiv 图片：搜索 + 拿可下载的图片地址。
//
// 为什么走第三方平替站（不想登录、也进不去官网）：
//   · pixiv.net 的搜索/详情接口要**登录 cookie**，而且机房 IP 常被挡；
//   · 主人给的 https://x.pixigraph.xyz 是一个平替站，2026-09-18 在线上 VPS 实测可用：
//
//       GET /api/search.php?keyword=<关键词>&page=1
//         → {"error":false,"body":{"illustManga":{"data":[<一页 60 条>],"total":…,"lastPage":…}}}
//           每条就是 pixiv ajax 的原生形状：
//           {id,title,userName,tags[],url,pageCount,width,height,xRestrict,sl,alt,userId,…}
//
//       GET /api/image.php?url=<encodeURIComponent(图片URL)>     ← 站内图床代理，绕开 i.pximg.net 的防盗链
//
// 图片地址怎么来（搜索结果只给 250×250 缩略图，但 URL 里带着**日期路径**，可以推出大图）：
//
//   缩略图 https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/18/01/37/08/149787938_p0_square1200.jpg
//   master https://i.pximg.net/img-master/img/2026/09/18/01/37/08/149787938_p0_master1200.jpg   ← 实测直连 200 / 227KB
//   原图   https://i.pximg.net/img-original/img/2026/09/18/01/37/08/149787938_p0.jpg            ← VPS 直连 404，走站内代理 200
//
// 所以默认发 **master1200**（够清晰、体积可控），要原图传 size='original'。
// 注意 `custom-thumb` 那种缩略图（作者自定义封面）路径里同样有 `img/<日期>/<id>_pN_`，同一个正则能吃。
//
// ⚠️ 两条纪律（与 image-search.js 一致）：
//   ① 只返回 URL，**不下载、不落盘** —— 下载由调用方走 SSRF 安全的 safeFetchBuffer；
//   ② safeFetchBuffer 不能带自定义请求头，所以**所有候选都走站内代理**（i.pximg.net 需要 Referer 才给图）。

const BASE = String(process.env.QQBRIDGE_PIXIV_BASE ?? 'https://x.pixigraph.xyz').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

/** 把任意图片 URL 包成站内代理地址（绕开 i.pximg.net 的 Referer 防盗链）。 */
export function pixivProxyUrl(imageUrl) {
  return `${BASE}/api/image.php?url=${encodeURIComponent(String(imageUrl ?? '').trim())}`;
}

/** 作品页地址（给模型/用户点开用）。 */
export function pixivPageUrl(id) {
  return `https://www.pixiv.net/artworks/${String(id ?? '').trim()}`;
}

/** 从一堆文本里认 pixiv 作品号：pixiv.net/artworks/123456 或裸的 6 位以上数字。 */
export function parsePixivId(text) {
  const s = String(text ?? '').trim();
  const m = /pixiv\.net\/(?:en\/)?artworks\/(\d{5,})/i.exec(s);
  if (m) return m[1];
  if (/^\d{5,}$/.test(s)) return s;
  return '';
}

/** 不宜在 QQ 里发的作品：R-18 / R-18G。默认过滤掉。 */
function isAdult(item) {
  if (Number(item?.xRestrict) !== 0) return true;
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ') : '';
  return /r-?18|r18|エロ|グロ|成人|18禁/i.test(tags);
}

/**
 * 搜 Pixiv 作品。
 * @returns {Promise<{query:string, page:number, total:number, lastPage:number, filtered:number, results:Array}>}
 */
export async function pixivSearch(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索词不能为空');
  const page = Math.max(1, Math.min(200, Number(opts.page) || 1));
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 8));
  const url = `${BASE}/api/search.php?keyword=${encodeURIComponent(q)}&page=${page}`;
  /* 这个平替站**偶发**慢/超时（实测同一条请求 0.4s 正常，偶尔直接挂到 12s 超时），
   * 所以重试一次再放弃 —— 否则一次抖动模型就以为"Pixiv 搜不到"。 */
  let body = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: `${BASE}/` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`pixiv 搜索 HTTP ${res.status}`);
      body = await res.json();
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  if (!body) throw new Error(`pixiv 搜索失败（试了 2 次）：${lastErr?.message ?? lastErr}`);
  if (body?.error) throw new Error(`pixiv 搜索失败：${body.message || '未知错误'}`);
  const box = body?.body?.illustManga ?? body?.body?.illust ?? null;
  const data = Array.isArray(box?.data) ? box.data : [];
  const safe = data.filter((it) => it && it.id && !isAdult(it));
  const filtered = data.length - safe.length;
  const results = safe.slice(0, limit).map((it) => ({
    id: String(it.id),
    title: String(it.title ?? '').trim(),
    author: String(it.userName ?? '').trim(),
    tags: (Array.isArray(it.tags) ? it.tags : []).map(String).slice(0, 8),
    pages: Number(it.pageCount) || 1,
    width: Number(it.width) || 0,
    height: Number(it.height) || 0,
    pageUrl: pixivPageUrl(it.id),
    thumbUrl: String(it.url ?? '').trim(),
    description: String(it.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
  return {
    query: q,
    page,
    total: Number(box?.total) || 0,
    lastPage: Number(box?.lastPage) || 0,
    filtered,
    results,
  };
}

/**
 * 由搜索结果推出可下载的大图地址（按可靠性排序，**全部走站内代理**）。
 * @param {object} work pixivSearch 的 results 里的元素（或任何带 thumbUrl 的对象）
 * @param {{page?:number, size?:'master'|'original'}} opts
 * @returns {string[]} 候选 URL，按优先级从高到低
 */
export function pixivImageCandidates(work, opts = {}) {
  const id = String(work?.id ?? '').trim();
  const thumb = String(work?.thumbUrl ?? '').trim();
  const p = Math.max(0, Number(opts.page) || 0);
  const size = String(opts.size ?? 'master').toLowerCase() === 'original' ? 'original' : 'master';
  const out = [];
  // 缩略图 URL 里的日期路径 —— master / original / custom-thumb 三种都吃
  const m = thumb ? /\/img\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+)_p(\d+)_/.exec(thumb) : null;
  if (m && id) {
    const datePath = m[1];
    const pid = m[2];
    const master = `https://i.pximg.net/img-master/img/${datePath}/${pid}_p${p}_master1200.jpg`;
    if (size === 'original') {
      // 原图扩展名有 jpg 也有 png，两个都试（站内代理会自己挑得到内容的那个）
      out.push(pixivProxyUrl(`https://i.pximg.net/img-original/img/${datePath}/${pid}_p${p}.jpg`));
      out.push(pixivProxyUrl(`https://i.pximg.net/img-original/img/${datePath}/${pid}_p${p}.png`));
    }
    out.push(pixivProxyUrl(master));
  }
  // 最后兜底：就用搜索结果给的那张缩略图（也过代理）
  if (thumb) out.push(pixivProxyUrl(thumb));
  return [...new Set(out)];
}
