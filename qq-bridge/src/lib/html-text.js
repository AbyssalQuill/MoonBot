// HTML → 可读正文的极简提取器（零依赖，纯正则+状态机）。
//
// 为什么需要它：web_fetch 以前把原始 HTML 前 50000 字符直接扔给模型 ——
// 一页现代网页里 90% 是 <script>/<style>/导航/footer，模型得自己啃标签，
// 既费 token 又经常整段看漏正文（"让他可以访问链接"卡在这一步）。
//
// 设计原则（刻意保守）：
//   · 只做"去噪 + 还原文本"，不做全文排版/摘要 —— 抽不准也不能把正文抽没了；
//   · 任何一步失败都退回上一级（正文 → body）而不是丢内容；
//   · 不引第三方库：payload 只有几百字节，装到哪台机器都能跑。
//
// 用法：
//   const doc = extractReadableHtml(html, { url });
//   // -> { title, description, siteName, image, lang, text, links, truncated }

/** 命名实体表：只覆盖真正常见的，其余用数字实体处理 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', shy: '', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', bull: '•', dagger: '†', deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§',
  euro: '€', pound: '£', yen: '¥', cent: '¢', larr: '←', uarr: '↑', rarr: '→', darr: '↓',
  harr: '↔', infin: '∞', ne: '≠', le: '≤', ge: '≥', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ',
  phi: 'φ', omega: 'ω', Omega: 'Ω', Delta: 'Δ', Sigma: 'Σ', Pi: 'Π',
};

/** 解码 HTML 实体（命名 + 十进制 + 十六进制） */
export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const hit = NAMED_ENTITIES[body];
    return hit === undefined ? m : hit;
  });
}

/** 去掉注释 / CDATA；顺便把 <br>、块级标签换成换行，避免整页粘成一行 */
function stripNoise(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    // 这些标签的内容对"看正文"没有价值，且往往极长
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ');
}

/** 取出某个标签的内容（取第一个匹配；内容里可以嵌套同名标签的简单场景够用了） */
function tagContent(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(html);
  return m ? m[1] : '';
}

/** 从 <head> 里读 meta：支持 name/property/http-equiv 三种 key */
function readMeta(head, keys) {
  const out = {};
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(head))) {
    const attrs = parseAttrs(m[1]);
    const key = (attrs.name || attrs.property || attrs['http-equiv'] || attrs.itemprop || '').toLowerCase();
    if (!key) continue;
    const val = attrs.content;
    if (val === undefined || val === '') continue;
    for (const k of keys) {
      if (key === k.toLowerCase() && out[k] === undefined) out[k] = decodeEntities(val).trim();
    }
  }
  return out;
}

/** 极简属性解析：够读 meta/link/a 的属性；不做完整 HTML 词法分析 */
function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(String(raw ?? '')))) {
    const name = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (attrs[name] === undefined) attrs[name] = val === undefined ? '' : decodeEntities(val);
  }
  return attrs;
}

const BLOCK_TAGS = 'p|div|section|article|main|header|footer|aside|nav|h[1-6]|li|tr|td|th|ul|ol|dl|dt|dd|blockquote|pre|figure|figcaption|table|thead|tbody|tfoot|hr|address|details|summary|fieldset|legend|option|label|button|caption';

/** HTML 片段 → 文本：块级标签转换行，行内标签转空格，再压掉多余空白 */
export function htmlToText(html) {
  let s = stripNoise(html);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  s = s.replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi'), '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(?:li)\s*>/gi, '');
  s = s.replace(/<[^>]*>/g, ' ');           // 剩下的行内标签
  s = decodeEntities(s);
  // 全角空格也当空白处理
  s = s.replace(/[ \t\u00a0\u3000\f\v]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 抓取页面里的链接（href + 锚文本），相对地址按 baseUrl 补全 */
function extractLinks(bodyHtml, baseUrl, limit = 60) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(bodyHtml)) && out.length < limit) {
    const attrs = parseAttrs(m[1]);
    const href = String(attrs.href ?? '').trim();
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    let abs = href;
    try { abs = new URL(href, baseUrl).toString(); } catch { /* 保留原样 */ }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').slice(0, 120);
    out.push(text ? { text, url: abs } : { url: abs });
  }
  return out;
}

/** 找"最像正文"的那块：优先 article/main，其次挑文字量最大的 div/section */
function pickMainHtml(html) {
  const candidates = [];
  for (const tag of ['article', 'main']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m;
    while ((m = re.exec(html))) candidates.push({ tag, html: m[1] });
  }
  if (!candidates.length) {
    const re = /<(div|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    let guard = 0;
    while ((m = re.exec(html)) && guard < 4000) {
      guard += 1;
      const inner = m[2];
      if (inner.length < 400) continue;                 // 太短的块基本是组件噪声
      const textLen = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').length;
      // 文字/标签比过低说明这层主要是结构，不是正文
      if (textLen < 200 || textLen / Math.max(1, inner.length) < 0.2) continue;
      candidates.push({ tag: m[1].toLowerCase(), html: inner, textLen });
    }
    candidates.sort((a, b) => (b.textLen ?? 0) - (a.textLen ?? 0));
  }
  if (!candidates.length) return null;
  // article/main 命中优先；否则取文字最多的那个候选
  const preferred = candidates.find((c) => c.tag === 'article') || candidates.find((c) => c.tag === 'main');
  return (preferred || candidates[0]).html;
}

/** 去掉正文里仍然残留的导航/页脚碎片 */
function trimBoilerplate(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      // 纯链接行、纯按钮/菜单字样，删掉
      if (/^(登录|注册|首页|上一页|下一页|返回|更多|评论|点赞|收藏|分享|关注|下载|客户端|APP|扫码|客服|举报|免责声明|版权所有|Copyright|All Rights Reserved)[:：]?$/i.test(t)) return false;
      if (/^[\s|·—\-–_=•]+$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 主入口：把整页 HTML 变成"标题 + 描述 + 正文 + 链接"。
 * @param {string} html 原始 HTML
 * @param {{url?:string, maxChars?:number, includeLinks?:boolean}} [opts]
 */
export function extractReadableHtml(html, opts = {}) {
  const url = String(opts.url ?? '');
  const maxChars = Math.max(500, Number(opts.maxChars) || 12000);
  const includeLinks = opts.includeLinks !== false;
  const raw = String(html ?? '');

  const head = tagContent(raw, 'head') || raw.slice(0, 4000);
  const body = tagContent(raw, 'body') || raw;
  const meta = readMeta(head, [
    'og:title', 'og:description', 'og:image', 'og:site_name',
    'twitter:title', 'twitter:description', 'twitter:image',
    'description', 'keywords', 'author', 'article:published_time', 'weibo:article:create_at',
  ]);

  let title = (meta['og:title'] || meta['twitter:title'] || htmlToText(tagContent(head, 'title')) || '').trim();
  title = title.replace(/\s+/g, ' ').slice(0, 300);

  const description = (meta['og:description'] || meta['twitter:description'] || meta.description || '').trim().slice(0, 1000);
  const image = (meta['og:image'] || meta['twitter:image'] || '').trim();
  const siteName = (meta['og:site_name'] || '').trim();

  const mainHtml = pickMainHtml(body);
  let text = trimBoilerplate(htmlToText(mainHtml || body));
  let degraded = false;
  // 正文抽得太少（很多站点的内容在 JS 里，或者候选块选偏了）→ 退回整页文本，宁可多不要漏
  if (text.length < 200) {
    const full = trimBoilerplate(htmlToText(body));
    if (full.length > text.length) { text = full; degraded = true; }
  }

  const truncated = text.length > maxChars;
  if (truncated) text = Array.from(text).slice(0, maxChars).join('');

  const out = {
    title,
    description,
    image: image || undefined,
    siteName: siteName || undefined,
    lang: (parseAttrs(/(<html\b[^>]*>)/i.exec(raw)?.[1] ?? '').lang || '').trim() || undefined,
    text,
    textChars: Array.from(text).length,
    truncated,
    ...(degraded ? { extracted: 'full-page' } : mainHtml ? { extracted: 'main' } : {}),
  };
  if (includeLinks) {
    const links = extractLinks(body, url || 'https://example.invalid/');
    if (links.length) out.links = links;
  }
  return out;
}
