// 联网找图：按关键词从图片搜索引擎取可直链的图片 URL。
//
// 为什么单独一个模块：这是纯网络+解析逻辑（没有 QQ、没有 config），
// 放在 lib/ 下既能被 MCP 工具直接用，也能离线单测（tools/test-image-search.mjs）。
//
// 两个源都是"网页 JSON"，不需要任何 API key：
//   · Bing 图片   —— 结果内嵌在 <a class="iusc" m="{...}"> 的 m 属性里（HTML 实体包裹的 JSON）
//   · 百度图片   —— 有 acjson 接口，直接返回 JSON（国内网络更稳）
// 两个都失败才抛错，调用方据此决定要不要让模型换说法。
//
// 只返回 URL，不下载、不落盘 —— 下载和发送由调用方走 SSRF 安全的 safeFetchBuffer 完成。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 9000;

/** 只认真正能当图片直链用的 URL：http(s)，且不是已知的"防盗链占位图" */
function usableImageUrl(raw) {
  const u = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  // Bing 自己的占位/图标、百度空白图，都是取不到原图时的兜底，发出去等于发张灰图
  if (/bing\.com\/(th|images\/search)/i.test(u)) return '';
  if (/(^|\/)(spacer|blank|transparent|loading)\.(gif|png|jpg)/i.test(u)) return '';
  if (/logo|icon/i.test(u) && /\.(png|gif|svg)(\?|$)/i.test(u)) return '';
  // 2026-09-18 实测踩到：Bing 结果里有大量 fbsbx/lookaside 抓取代理地址：
  // 搜"蓝鲸"第一条给的就是 facebook 的 lookaside 链接（而且是别的图），
  // 这类 URL 既不可靠又常常和查询无关 —— 直接不用。
  if (/(lookaside\.fbsbx\.com|scontent\..*\.fbcdn\.net)/i.test(u)) return '';
  return u.replace(/&amp;/g, '&');
}

function decodeHtmlEntities(s) {
  return String(s ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return _; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } });
}

function stripTags(s) {
  return decodeHtmlEntities(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Bing 图片：结果块 <a class="iusc" ... m="{&quot;murl&quot;:...}"> */
export async function bingImageSearch(query, limit = 8) {
  const url = new URL('https://www.bing.com/images/search');
  url.searchParams.set('q', query);
  url.searchParams.set('form', 'HDRSC2');
  url.searchParams.set('first', '1');
  url.searchParams.set('count', String(Math.max(10, limit * 3)));
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`bing 图片 HTTP ${res.status}`);
  const html = await res.text();

  const out = [];
  const re = /<a[^>]+class="[^"]*iusc[^"]*"[^>]*\bm="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let meta;
    try { meta = JSON.parse(decodeHtmlEntities(m[1])); } catch { continue; }
    const imageUrl = usableImageUrl(meta.murl || meta.turl);
    if (!imageUrl) continue;
    if (out.some((x) => x.imageUrl === imageUrl)) continue;
    out.push({
      source: 'bing',
      title: stripTags(meta.t || '').slice(0, 120),
      imageUrl,
      thumbUrl: usableImageUrl(meta.turl) || imageUrl,
      pageUrl: String(meta.purl || '').trim(),
      width: 0,
      height: 0,
    });
  }
  return out;
}

/** 百度图片 acjson：直接是 JSON，不用解析 HTML */
export async function baiduImageSearch(query, limit = 8) {
  const url = new URL('https://image.baidu.com/search/acjson');
  url.searchParams.set('tn', 'resultjson_com');
  url.searchParams.set('ipn', 'rj');
  url.searchParams.set('ct', '201326592');
  url.searchParams.set('fp', 'result');
  url.searchParams.set('word', query);
  url.searchParams.set('pn', '0');
  url.searchParams.set('rn', String(Math.max(10, limit * 3)));
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://image.baidu.com/', accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`baidu 图片 HTTP ${res.status}`);
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('baidu 图片返回的不是 JSON'); }
  const out = [];
  for (const it of (j.data || [])) {
    if (!it || typeof it !== 'object') continue;
    const imageUrl = usableImageUrl(it.middleURL || it.hoverURL || it.thumbURL || it.objURL);
    if (!imageUrl) continue;
    if (out.some((x) => x.imageUrl === imageUrl)) continue;
    out.push({
      source: 'baidu',
      title: stripTags(it.fromPageTitleEnc || it.fromPageTitle || '').slice(0, 120),
      imageUrl,
      thumbUrl: usableImageUrl(it.thumbURL) || imageUrl,
      pageUrl: String(it.fromURL || '').trim(),
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 联网找图（多源聚合）：任一源有结果就返回，并把另一个源的结果接在后面。
 * @returns {{ query:string, tookMs:number, sources:Record<string,number>, failures:Record<string,string>, results:Array }}
 */
export async function searchImages(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索词不能为空');
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 8));
  const only = String(opts.source ?? '').trim().toLowerCase();
  const engines = only === 'bing' ? [['bing', bingImageSearch]]
    : only === 'baidu' ? [['baidu', baiduImageSearch]]
      : [['bing', bingImageSearch], ['baidu', baiduImageSearch]];

  const t0 = Date.now();
  const failures = {};
  const sources = {};
  const all = [];
  await Promise.all(engines.map(async ([name, fn]) => {
    try {
      const rows = await fn(q, limit);
      sources[name] = rows.length;
      all.push(...rows);
    } catch (e) {
      sources[name] = 0;
      failures[name] = String(e?.message ?? e).slice(0, 120);
    }
  }));

  // 交错去重，保证两个源都有机会露头（和 web_search 的 interleave 同一思路）
  const bySource = {};
  for (const r of all) (bySource[r.source] ||= []).push(r);
  const interleaved = [];
  const seen = new Set();
  for (let guard = 0; guard < 200; guard += 1) {
    let progressed = false;
    for (const name of Object.keys(bySource)) {
      const row = bySource[name].shift();
      if (!row) continue;
      progressed = true;
      if (seen.has(row.imageUrl)) continue;
      seen.add(row.imageUrl);
      interleaved.push(row);
    }
    if (!progressed) break;
  }

  /* 2026-09-18 实测踩到：按源顺序直接发第一张不可靠：搜"蓝鲸"时 Bing 的第一条是
   * facebook 抓取链接 + 完全无关的标题，发出去就是"找了张不相干的图"。
   * 所以做一次**按查询词的相关度排序**：标题/页面 URL/图片 URL 里命中查询词的加分，
   * 中文查询下纯英文标题减分（多半是国外站点噪声）。稳定排序，同分保持原顺序。 */
  const tokens = String(q).toLowerCase().split(/[\s,，、]+/).filter((t) => t.length >= 1);
  const isChinese = /[\u4e00-\u9fa5]/.test(q);
  const scored = interleaved.map((r, i) => {
    const hay = `${r.title} ${r.pageUrl} ${r.imageUrl}`.toLowerCase();
    let s = 0;
    for (const t of tokens) if (t && hay.includes(t)) s += 2;
    if (isChinese && r.title && !/[\u4e00-\u9fa5]/.test(r.title)) s -= 2;
    if (/baidu\.com|bdimg|bdstatic|hdslb|zhimg|sinaimg|qpic|byteimg|douyinpic/i.test(r.imageUrl)) s += 1;
    return { r, i, s };
  });
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  const out = scored.slice(0, limit).map((x) => x.r);

  return { query: q, tookMs: Date.now() - t0, sources, failures, results: out };
}
