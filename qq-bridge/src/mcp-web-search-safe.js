// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dnsLookup = dns.promises.lookup;

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ───────────────────────── 多平台聚合搜索（2026-09-16 主人要求）─────────────────────────
 * 原来只有一个后端（cn.bing.com）、15 秒超时、最多 8 条，而且工具描述写着"仅用于理解词义"——
 * 于是模型遇到不懂的东西要么少搜、要么问主人。现在：
 *   · **多平台并行**：Bing / DuckDuckGo / 百度 / 搜狗 / Mojeek 同时发（谁先回谁先用）；
 *   · **快速返回**：每个后端 7 秒硬超时；只要 2 个平台回来了、去重后够 maxResults 条就立刻返回，
 *     不等最慢的那个（整体耗时 ≈ 最快那个平台，而不是五个串起来）；
 *   · **合并去重**：按规范化 URL（去掉 utm_/spm 等跟踪参数）去重，多平台命中同一条只留一次；
 *   · **没有条数/次数限制**：调用次数不限，返回条数由 maxResults 决定（默认 12，最多 30）；
 *   · **5 分钟缓存**：同一查询 + 同样参数直接命中缓存（秒回），避免重复联网。
 */
const SEARCH_TIMEOUT_MS = 7000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) { searchCache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  searchCache.set(key, { at: Date.now(), value });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    for (const [k, v] of searchCache) { if (Date.now() - v.at > SEARCH_CACHE_TTL_MS) searchCache.delete(k); }
    while (searchCache.size > SEARCH_CACHE_MAX) { const first = searchCache.keys().next().value; searchCache.delete(first); }
  }
}

/** 去掉跟踪参数，便于跨平台去重 */
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const drop = [];
    for (const k of u.searchParams.keys()) {
      if (/^(utm_|spm|from|fr|src|ref|refer|wd|sa|ved|usg|tn|rsv_|bsst|_?client)/i.test(k)) drop.push(k);
    }
    for (const k of drop) u.searchParams.delete(k);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('?')) s = s.slice(0, -1);
    return s.replace(/\/$/, '');
  } catch { return String(raw || '').trim(); }
}

/** DuckDuckGo 的跳转链（//duckduckgo.com/l/?uddg=…）解出真实地址 */
function unwrapDuck(raw) {
  try {
    const s = String(raw);
    const u = new URL(s.startsWith('//') ? 'https:' + s : s);
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : s;
  } catch { return String(raw || ''); }
}

async function fetchSearchHtml(url, timeoutMs = SEARCH_TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: { 'user-agent': SEARCH_UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function pushResult(out, { title, url, snippet }, limit) {
  const t = decodeHtml(title);
  const u = normalizeUrl(url);
  if (!t || !u || !/^https?:\/\//i.test(u)) return;
  if (out.some((r) => r.url === u)) return;
  out.push({ title: t.slice(0, 200), url: u, snippet: decodeHtml(snippet || '').slice(0, 400) });
  void limit;
}

async function bingSearch(query) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '20');
  // 中文查询走中国区市场，结果更贴中文语境（实测国际站 bing.com 可达、cn.bing.com 从境外 IP 常被截断）
  if (/[\u4e00-\u9fa5]/.test(query)) { url.searchParams.set('mkt', 'zh-CN'); url.searchParams.set('setlang', 'zh-CN'); }
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!href) continue;
    const title = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    pushResult(out, { title: title ? title[1] : '', url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
  }
  return out;
}

/** 360 搜索（国内网络可用；境外 IP 常被拦，失败即跳过） */
async function so360Search(query) {
  const url = new URL('https://www.so.com/s');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li class="res-list"/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="res-desc"[^>]*>([\s\S]*?)<\/p>/i) || block.match(/class="res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** 萌娘百科站内搜索（ACG 梗/角色/作品最对口；API 需要授权，所以走搜索页 HTML） */
async function moegirlSearch(query) {
  const url = new URL('https://zh.moegirl.org.cn/index.php');
  url.searchParams.set('search', query);
  url.searchParams.set('title', 'Special:搜索');
  url.searchParams.set('fulltext', '1');
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li[^>]+class="mw-search-result[^"]*"/i).slice(1)) {
    const href = block.match(/href="(\/index\.php\?[^"]+|\/[^"]+)"/i);
    const title = block.match(/title="([^"]+)"/i);
    const snippet = block.match(/class="searchresult">([\s\S]*?)<\/div>/i);
    if (!href) continue;
    pushResult(out, {
      title: title ? title[1] : '',
      url: new URL(decodeHtml(href[1]), 'https://zh.moegirl.org.cn').toString(),
      snippet: snippet ? snippet[1] : '',
    });
    if (out.length >= 8) break;
  }
  return out;
}

/** 维基百科（中/英）MediaWiki API：事实、人物、作品、术语的可靠覆盖面。
 *  429 是它的常态限流（同一 IP 短时间多次查询）——退避重试一次，仍失败就交给其它平台。 */
async function wikiSearch(query, lang = 'zh') {
  const build = () => {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', '6');
    url.searchParams.set('format', 'json');
    url.searchParams.set('utf8', '1');
    return url;
  };
  const attempt = async () => {
    const res = await fetch(build(), {
      headers: {
        // 维基要求可识别的 UA（带联系方式），否则容易被限流
        'user-agent': 'MoonBotQQBridge/1.0 (https://github.com/AbyssalQuill/MoonBot; web search for a QQ chat bot)',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (res.status === 429) throw new Error('HTTP 429');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(() => null);
  };
  let j = null;
  try {
    j = await attempt();
  } catch (error) {
    if (!String(error?.message || '').includes('429')) throw error;
    await new Promise((r) => setTimeout(r, 700));
    j = await attempt();
  }
  const hits = Array.isArray(j?.query?.search) ? j.query.search : [];
  return hits.map((h) => ({
    title: `${h.title} · ${lang === 'zh' ? '中文维基' : 'Wikipedia'}`,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/\s+/g, '_'))}`,
    snippet: decodeHtml(String(h.snippet || '')).slice(0, 400),
  }));
}
const zhwikiSearch = (q) => wikiSearch(q, 'zh');
const enwikiSearch = (q) => wikiSearch(q, 'en');

/**
 * Google News RSS（**实测从境外 VPS 唯一稳定的中文检索源**：2026-09-16 查「宁芙奖」得 52 条、
 * 354ms，全是第五人格「宁芙奖」相关报道；同一时刻 Bing 从该 IP 返回的是完全无关的结果、
 * 百度/搜狗/360/searx 是验证码或 429）。普通 HTML 搜索页对机房 IP 基本都不友好，RSS 没事。
 */
async function gnewsSearch(query) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'zh-CN');
  url.searchParams.set('gl', 'CN');
  url.searchParams.set('ceid', 'CN:zh-Hans');
  const res = await fetch(url, { headers: { 'user-agent': SEARCH_UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
    const desc = (block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ');
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] || '').trim();
    if (!title || !link) continue;
    pushResult(out, { title: source ? `${title}` : title, url: link, snippet: `${desc}${source ? '（' + source + '）' : ''}` });
    if (out.length >= 14) break;
  }
  return out;
}

/* ── 查询词清洗：把"是什么 / 什么意思 / 是谁 / 帮我查一下"这类问句外壳剥掉 ──
 * 实测 2026-09-16：把「宁芙奖 是什么」原样丢给维基/Bing，匹配会飘到毫不相干的条目；
 * 「这个梗是什么意思 贴贴」更是直接搜成了"这个"这个字的词典解释。
 * 剥成「宁芙奖」/「贴贴」之后命中率明显变好（全文检索对问句外壳和虚词特别敏感）。 */
const QUERY_FILLER_RE = /(是什么意思|什么意思|啥意思|是啥意思|什么梗|是啥|是什么|是谁|谁啊|怎么办|怎么样|为什么|为啥|多少|多少钱|请问|帮我|帮忙|查一下|搜一下|有谁知道|这个|那个|到底|究竟|意思|含义|解释|梗)/g;
/** 只允许剥掉**结尾**的单字语气词：`我的世界` 这种不能把"的"挖掉。 */
const TRAILING_PARTICLES = /[吗呢啊呀啦吧嘛的了哦喔诶]$/;
export function cleanQuery(raw) {
  const original = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  let s = original
    .replace(/[？?。！!，,、；;：:"'「」『』（）()【】\[\]]/g, ' ')
    .replace(QUERY_FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i += 1) s = s.replace(TRAILING_PARTICLES, '').trim();
  return s.length >= 2 ? s : original;
}

/** 相关度打分：查询词（中文 2-gram + 英文/数字词）在标题/摘要里命中越多分越高。 */
function relevance(result, grams) {
  if (!grams.size) return 0;
  const title = String(result.title || '').toLowerCase();
  const body = String(result.snippet || '').toLowerCase();
  let score = 0;
  for (const g of grams) {
    if (title.includes(g)) score += 2;
    else if (body.includes(g)) score += 1;
  }
  return score;
}

export function queryGrams(query) {
  const t = String(query || '').toLowerCase();
  const set = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) set.add(w);
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i += 1) set.add(cjk.slice(i, i + 2));
  if (cjk.length === 1) set.add(cjk);
  return set;
}

async function duckSearch(query) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  const blocks = html.split('class="result__body"').slice(1);
  for (const block of blocks) {
    const href = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/i) || block.match(/href="(\/\/duckduckgo\.com\/l\/[^"]+)"/i);
    if (!href) continue;
    const title = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    pushResult(out, { title: title ? title[1] : '', url: unwrapDuck(decodeHtml(href[1])), snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
  }
  return out;
}

async function baiduSearch(query) {
  const url = new URL('https://www.baidu.com/s');
  url.searchParams.set('wd', query);
  url.searchParams.set('rn', '20');
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div[^>]+class="result[^"]*c-container/i).slice(1)) {
    const href = block.match(/<h3[^>]*>\s*<a[^>]+href="([^"]+)"/i) || block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="(?:c-abstract|content-right_[^"]*)"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/class="c-span-last[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: decodeHtml(href[1]).replace(/^http:/, 'https:'), snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
  }
  return out;
}

async function sogouSearch(query) {
  const url = new URL('https://www.sogou.com/web');
  url.searchParams.set('query', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div[^>]+class="(?:vrwrap|rb)"[^>]*>/i).slice(1)) {
    const href = block.match(/<h3[^>]*>\s*<a[^>]+href="([^"]+)"/i) || block.match(/<a[^>]+href="(\/link\?url=[^"]+)"/i);
    const title = block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="(?:str_info|space-txt|fz-mid|text-layout)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!href || !title) continue;
    const raw = decodeHtml(href[1]);
    pushResult(out, { title: title[1], url: raw.startsWith('http') ? raw : new URL(raw, 'https://www.sogou.com').toString(), snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

async function mojeekSearch(query) {
  const url = new URL('https://www.mojeek.com/search');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li>\s*<h2>/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<p class="s">([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

export const SEARCH_PLATFORMS = {
  gnews: gnewsSearch,
  zhwiki: zhwikiSearch,
  enwiki: enwikiSearch,
  moegirl: moegirlSearch,
  duckduckgo: duckSearch,
  bing: bingSearch,
  baidu: baiduSearch,
  sogou: sogouSearch,
  so360: so360Search,
  mojeek: mojeekSearch,
};

/** 把各平台结果按"平台轮转"交错合并，保证任何一次搜索都有多平台视角（而不是被某一个平台刷屏）。 */
function interleave(bySource, maxResults) {
  const lists = Object.entries(bySource)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => ({ k, items: [...v] }));
  const out = [];
  const seen = new Set();
  for (let guard = 0; guard < 400 && out.length < maxResults; guard += 1) {
    let progressed = false;
    for (const { k, items } of lists) {
      while (items.length) {
        const r = items.shift();
        if (!r || !r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        out.push({ ...r, source: k });
        progressed = true;
        break;
      }
      if (out.length >= maxResults) break;
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * 多平台并行搜索 + 快速返回。
 * @param {string} query
 * @param {{ maxResults?:number, platforms?:string[] }} opts
 */
/**
 * "核心平台"：实测从机房 IP 稳定可用的那几个（Google 新闻 RSS、维基、萌娘、DDG）。
 * 早退只在**它们都回来之后**才允许 —— 否则会拿着 Bing 的垃圾结果提前收工
 * （2026-09-16 实测：bing 从这台 VPS 返回的是完全无关的页面，且它 150ms 就回，
 *  比 gnews/维基都早，于是"2 个平台够数就早退"直接把好结果挡在门外）。
 */
const CORE_PLATFORMS = new Set(['gnews', 'zhwiki', 'enwiki', 'moegirl', 'duckduckgo']);

export async function searchAll(query, opts = {}) {
  const maxResults = Math.min(30, Math.max(3, Number(opts.maxResults) || 12));
  const clean = String(opts.raw === true ? query : cleanQuery(query));
  const names = (Array.isArray(opts.platforms) && opts.platforms.length ? opts.platforms : Object.keys(SEARCH_PLATFORMS))
    .map((n) => String(n).toLowerCase())
    .filter((n) => SEARCH_PLATFORMS[n]);
  const cacheKey = `${clean}|${maxResults}|${names.join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const t0 = Date.now();
  const bySource = {};
  const failures = {};
  const settledNames = new Set();
  const coreWanted = names.filter((n) => CORE_PLATFORMS.has(n));

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    // 硬上限：即使有平台卡住也不超过 SEARCH_TIMEOUT_MS 多一点
    const hardTimer = setTimeout(finish, SEARCH_TIMEOUT_MS + 400);
    const maybeFinish = () => {
      // 核心平台全部有结论 → 立刻返回（不等 bing/baidu 这些可选件）
      if (coreWanted.every((n) => settledNames.has(n))) { clearTimeout(hardTimer); finish(); return; }
      if (settledNames.size >= names.length) { clearTimeout(hardTimer); finish(); }
    };
    for (const name of names) {
      SEARCH_PLATFORMS[name](clean).then((rows) => {
        bySource[name] = Array.isArray(rows) ? rows : [];
        settledNames.add(name);
        maybeFinish();
      }).catch((error) => {
        failures[name] = String(error?.message ?? error).slice(0, 120);
        settledNames.add(name);
        maybeFinish();
      });
    }
    if (!names.length) { clearTimeout(hardTimer); finish(); }
  });

  // ① 平台轮转交错 → 多平台视角、不被单一平台刷屏
  const grams = queryGrams(clean);
  const interleaved = interleave(bySource, Math.max(maxResults * 2, 24));
  // ② 按"和查询词的相关度"稳定排序
  const scored = interleaved.map((r, i) => ({ r, i, s: relevance(r, grams) }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  // ③ 精度优先：先只要真有共同词的结果（机房 IP 下 bing/维基全文检索经常整屏无关），
  //    相关结果够（≥3）就干脆不掺垃圾；不够才退回原序，并如实标注低相关。
  const relevant = scored.filter((x) => x.s > 0);
  const useRelevant = relevant.length >= Math.min(3, maxResults);
  const picked = (useRelevant ? relevant : scored).slice(0, maxResults);
  const results = picked.map((x) => ({ ...x.r, ...(useRelevant ? {} : { lowRelevance: true }) }));

  const value = {
    query: String(query),
    searchedFor: clean,
    tookMs: Date.now() - t0,
    platforms: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])),
    failures,
    ...(useRelevant ? {} : { note: '没有找到与查询词明显相关的条目，下面这些是各平台的原样返回，请谨慎采用' }),
    results,
  };
  cacheSet(cacheKey, value);
  return value;
}

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1、::a.b.c.d 等）。
// 只处理标准 IPv4-mapped / IPv4-compatible 形式，避免把 fc00::1、fe80::1 误判成内嵌 IPv4。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  // ::ffff:7f00:1 或 ::7f00:1（IPv4-mapped / compatible）
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 198.18.0.0/15（benchmarking）、192.0.0.0/24（IETF 协议保留）
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 组播与保留段
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    // fc00::/7 ULA
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    // fe80::/10 link-local
    if (/^fe[89ab]/.test(h)) return true;
    // fec0::/10 site-local（已废弃）
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 2001:db8::/32 文档地址
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    // 6to4 内嵌 IPv4，例如 2002:c0a8:0101:: -> 192.168.1.1
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    // ff00::/8 组播地址
    if (h.startsWith('ff')) return true;
    return false;
  }

  // 非标准 IP 字面量由 DNS 解析后统一检查。
  return false;
}

// 解析主机名并固定到已校验的 IP，避免 DNS rebinding。
async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

// 从 Node IncomingMessage 读取最多 maxChars 个字符，用 StringDecoder 避免切断 UTF-8。
function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBoundedText(res, maxChars) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      text += decoder.write(chunk);
      if (text.length >= maxChars) {
        text = sliceByCodePoints(text, maxChars);
        try { res.destroy(); } catch {}
        finish(resolve, text);
      }
    });
    res.on('end', () => {
      if (!settled) {
        text += decoder.end();
        finish(resolve, sliceByCodePoints(text, maxChars));
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 12000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, 50000)
        .then((body) => resolve({ statusCode, body }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

async function safeFetch(urlString) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const maxChars = 50000;
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: body.length >= maxChars,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.0' });

server.tool(
  'web_search',
  '联网搜索（只读，多平台聚合：Bing / DuckDuckGo / 百度 / 搜狗 / Mojeek 并行，结果按平台轮转交错合并、按 URL 去重）。'
  + '通用用途：不认识的说法/梗/黑话、不确定的事实与数字、人名/作品/时事、需要外部资料才能回答的任何问题。'
  + '**调用次数不限、条数不限**（maxResults 最多 30），5 分钟内的同一查询会命中缓存秒回。'
  + '**先搜再答是你的默认动作**：凡是自己不确定的东西，先搜一次再开口，绝不拿"我记得可能是…"糊弄，也不要回头问发问的人"这是什么"。'
  + '只需要看一条网页正文时用 web_fetch。不执行任何本地操作。',
  {
    query: z.string().describe('搜索词（自然语言即可；可带 site: 限定）'),
    maxResults: z.number().int().min(3).max(30).optional().describe('返回条数，默认 12'),
    platforms: z.array(z.enum(['gnews', 'zhwiki', 'enwiki', 'moegirl', 'duckduckgo', 'bing', 'baidu', 'sogou', 'so360', 'mojeek'])).optional()
      .describe('只查指定平台（默认全部；gnews=Google 新闻 RSS、zhwiki/enwiki=维基、moegirl=萌娘百科、bing/baidu/sogou/so360/mojeek/duckduckgo=搜索引擎）'),
  },
  async ({ query, maxResults, platforms }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await searchAll(clean, { maxResults, platforms });
      if (!result.results.length) {
        return {
          content: [{ type: 'text', text: `没有搜到结果（平台：${JSON.stringify(result.platforms)} 失败：${JSON.stringify(result.failures)}，耗时 ${result.tookMs}ms）。可以换个说法再搜一次。` }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符（12 秒超时）。用于把搜索结果里最相关的一两条**读完整**，或主人给了链接让你看。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
