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
import { extractReadableHtml } from './lib/html-text.js';
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

/* ============================================================================
 * 2026-09-17 扩容：多聚合引擎
 *
 * 原有的 10 个平台（gnews/zhwiki/enwiki/moegirl/duckduckgo/bing/baidu/sogou/so360/mojeek）
 * 偏"通用 + 中文百科"，缺三类东西：
 *   ① 中文长尾内容（知乎/公众号式文章）—— 用雅虎/必应系之外的独立索引补；
 *   ② 视频（B 站）—— 直接接官方搜索 API，比让模型拿网页搜索去猜准得多；
 *   ③ 技术资料（GitHub / Stack Overflow）—— 用官方 JSON API，稳且不占配额。
 *
 * 所有新平台都遵守同一个契约：**失败就抛错，由 searchAll() 收进 failures 并继续**，
 * 绝不因为一个平台挂了让整次搜索失败。返回行统一 { title, url, snippet }。
 * ========================================================================== */

/** 雅虎（独立索引，中文长尾比 Bing 好；HTML 结果块稳定） */
async function yahooSearch(query) {
  const url = new URL('https://search.yahoo.com/search');
  url.searchParams.set('p', query);
  url.searchParams.set('ei', 'UTF-8');
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div class="algo[^"]*"/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const snippet = block.match(/<div class="compText[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Yandex（俄区索引，对中文也有覆盖；结果块 class="serp-item"） */
async function yandexSearch(query) {
  const url = new URL('https://yandex.com/search/');
  url.searchParams.set('text', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li class="serp-item"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/class="OrganicTextContentSpan[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || block.match(/<div class="text-container[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Brave Search（独立索引） */
async function braveSearch(query) {
  const url = new URL('https://search.brave.com/search');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div class="snippet[^"]*"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<div class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Ecosia（Bing 后端 + 自己的排序，HTML 结果块固定 class="result"） */
async function ecosiaSearch(query) {
  const url = new URL('https://www.ecosia.org/search');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<article[^>]*class="[^"]*result[^"]*"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Marginalia：独立小索引，专收"非 SEO 站点"（技术博客、个人站），长尾技术问题很好用 */
async function marginaliaSearch(query) {
  const url = new URL('https://search.marginalia.nu/search');
  url.searchParams.set('query', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div class="card search-result"/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** GitHub 仓库/代码搜索（公开 API，轻量调用不需要 token） */
async function githubSearch(query) {
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '8');
  const res = await fetch(url, {
    headers: { 'user-agent': 'MoonBotQQBridge/1.0', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.items || []).map((r) => ({
    title: r.full_name + (r.description ? ` — ${r.description}` : ''),
    url: r.html_url,
    snippet: [
      r.language && `语言 ${r.language}`,
      Number.isFinite(r.stargazers_count) && `${r.stargazers_count} star`,
      r.updated_at && `更新 ${String(r.updated_at).slice(0, 10)}`,
      r.description || '',
    ].filter(Boolean).join(' · ').slice(0, 400),
  })).filter((r) => r.title);
}

/** Stack Overflow / StackExchange 公开 API（写代码、报错信息查询的权威来源） */
async function stackSearch(query) {
  const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('q', query);
  url.searchParams.set('site', 'stackoverflow');
  url.searchParams.set('pagesize', '8');
  url.searchParams.set('filter', 'default');
  const res = await fetch(url, { headers: { 'user-agent': 'MoonBotQQBridge/1.0' }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.items || []).map((it) => ({
    title: decodeHtml(it.title || ''),
    url: it.link,
    snippet: [
      it.is_answered ? '已有采纳答案' : '尚无采纳答案',
      Number.isFinite(it.score) && `${it.score} 分`,
      Number.isFinite(it.answer_count) && `${it.answer_count} 个回答`,
      (it.tags || []).slice(0, 4).join(' '),
    ].filter(Boolean).join(' · '),
  })).filter((r) => r.title);
}

/** B 站视频搜索（官方 JSON API；"这首/这个视频"类问题直接给视频而不是网页） */
async function bilibiliPlatformSearch(query) {
  const { videoSearch: biliVideoSearch } = await import('./core/video.js');
  const r = await biliVideoSearch(query, { limit: 8 });
  return (r.results || []).map((v) => ({
    title: v.title,
    url: v.url,
    snippet: [
      v.author && `UP ${v.author}`,
      v.duration && `时长 ${v.duration}`,
      v.playText && `${v.playText}播放`,
      v.typeName,
    ].filter(Boolean).join(' · '),
  })).filter((x) => x.title && x.url);
}

/* ----------------------------------------------------------------------------
 * 平台清单 —— 2026-09-17 在**线上那台机器**上逐引擎实测后定稿（中英各一个查询，各跑两次）
 *
 *   可用：gnews(14/14) zhwiki(6/6) enwiki(0/6) moegirl(8/8) bing(10/7)
 *         bilibili(8/8) github(5/8) stackoverflow(0/8)
 *   能用但会限速（忙时会返回 0 条）：baidu sogou duckduckgo yandex
 *   结构上不通（每次都硬报错，留着只是噪声）：
 *         yahoo(HTTP 500) brave(HTTP 429) ecosia(HTTP 403) marginalia(fetch failed)
 *
 * 所以下面只挂"实测过得去"的平台；那几个不通的**函数保留**（网络环境变了随时能启用），
 * 用环境变量挂回来即可：QQBRIDGE_SEARCH_EXTRA=yahoo,brave,ecosia,marginalia,yandex
 * -------------------------------------------------------------------------- */
const EXTRA_PLATFORMS = String(process.env.QQBRIDGE_SEARCH_EXTRA ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Google（走 /search 的 HTML；从机房 IP 常被换成验证码页，失败由 searchAll 收进 failures） */
async function googleSearch(query) {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', '20');
  url.searchParams.set('hl', /[\u4e00-\u9fa5]/.test(query) ? 'zh-CN' : 'en');
  const html = await fetchSearchHtml(url);
  if (/id="captcha-form"|Our systems have detected unusual traffic|unusual traffic/i.test(html)) {
    throw new Error('被 Google 要求人机验证（机房 IP 常态）');
  }
  const out = [];
  // Google 的结果块：<div class="g">…<a href="/url?q=…"> 或直接 https 链接
  for (const block of html.split(/<div class="[^"]*\bGx5Zad\b[^"]*"|<div class="g"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i) || block.match(/href="\/url\?q=([^&"]+)/i);
    if (!href) continue;
    let u = decodeHtml(href[1]);
    if (!/^https?:/i.test(u)) { try { u = decodeURIComponent(u); } catch { /* ignore */ } }
    const title = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const snippet = block.match(/<div[^>]*class="[^"]*(?:VwiC3b|yXK7lf)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || block.match(/<span[^>]*>([\s\S]{40,400}?)<\/span>/i);
    if (!title || !u) continue;
    pushResult(out, { title: title[1], url: u, snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
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
  // 2026-09-17 新增（线上实测可用）
  bilibili: bilibiliPlatformSearch,
  github: githubSearch,
  stackoverflow: stackSearch,
  // 2026-09-18 新增（主人要求"拓展谷歌搜索引擎"；机房 IP 常被验证码拦，失败会如实进 failures）
  google: googleSearch,
};

/** 实测从机房 IP 不通、默认收起；要挂回来用 QQBRIDGE_SEARCH_EXTRA=名字（逗号分隔） */
const SHELVED_PLATFORMS = {
  yahoo: yahooSearch,
  yandex: yandexSearch,
  brave: braveSearch,
  ecosia: ecosiaSearch,
  marginalia: marginaliaSearch,
};

for (const name of EXTRA_PLATFORMS) {
  const fn = SHELVED_PLATFORMS[name];
  if (fn) SEARCH_PLATFORMS[name] = fn;
}

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
  'Web search (read-only, multi-platform aggregate: Bing / DuckDuckGo / Baidu / Sogou / 360 / Mojeek / Yahoo / Yandex / Brave / Ecosia / Marginalia / Google News / Wikipedia (zh+en) / Moegirl / Bilibili / GitHub / Stack Overflow, run in parallel, results interleaved round-robin by platform and de-duplicated by URL). '
  + 'Use it for anything outside your own knowledge: an unfamiliar word / meme / slang, a fact or number you are unsure of, a person / work / current event, any question that needs outside material. '
  + '**No call limit, no result limit** (maxResults caps at 30); the same query within 5 minutes hits the cache and answers instantly. '
  + 'One thin result is not a wall: reword it, switch language or platforms, search again - never hold back because "I already searched". '
  + '**Search first, then answer is the default**: when you are not sure of something, search once before you speak; never fob anyone off with "I think maybe…", and never bounce the question back to the asker ("what is this?"). '
  + 'Use web_fetch when you only need the text of one page. It performs no local actions.',
  {
    query: z.string().describe('Search terms (natural language is fine; site: is supported)'),
    maxResults: z.number().int().min(3).max(30).optional().describe('How many results to return, default 12'),
    platforms: z.array(z.enum(['gnews', 'zhwiki', 'enwiki', 'moegirl', 'duckduckgo', 'bing', 'baidu', 'sogou', 'so360', 'mojeek', 'bilibili', 'github', 'stackoverflow', 'yahoo', 'yandex', 'brave', 'ecosia', 'marginalia'])).optional()
      .describe('Search only the listed platforms (default: all). gnews=Google News, zhwiki/enwiki=Wikipedia, moegirl=Moegirl wiki, bilibili=Bilibili video, github=GitHub repos, stackoverflow=Stack Overflow; the rest are search engines (yahoo/yandex/brave/ecosia/marginalia are unreachable from this host, an admin can re-enable them via QQBRIDGE_SEARCH_EXTRA)'),
  },
  async ({ query, maxResults, platforms }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: 'Empty query - refused.' }], isError: true };
    }
    try {
      const result = await searchAll(clean, { maxResults, platforms });
      if (!result.results.length) {
        return {
          content: [{ type: 'text', text: `No results (platforms: ${JSON.stringify(result.platforms)} failures: ${JSON.stringify(result.failures)}, took ${result.tookMs}ms). Try different wording.` }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Search failed: ${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  'Read one HTTP(S) page and return it as CLEAN READABLE TEXT (not raw HTML): { title, description, image, text, links, truncated }. '
  + 'Use it to actually READ a page - the most relevant hit from web_search, a link the owner pasted, a GitHub README, a news article, or a video page. '
  + 'Pass raw=true only when you need the original markup (e.g. hunting for a specific tag); the default extracted text is far shorter and easier to reason about. '
  + 'Returns at most ~12000 characters of text (clean) or 50000 (raw), 20s timeout. Blocks intranet/loopback hosts; performs no local action.',
  {
    url: z.string().describe('The http(s) URL to read'),
    raw: z.boolean().optional().describe('true = return the original HTML body (up to 50000 chars) instead of the extracted text'),
    maxChars: z.number().int().min(500).max(50000).optional().describe('Text budget for the extracted form, default 12000'),
  },
  async ({ url, raw, maxChars }) => {
    try {
      const result = await safeFetch(url, raw ? 50000 : 400000);
      if (raw) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      const doc = extractReadableHtml(result.body, { url: result.url, maxChars: maxChars || 12000 });
      const payload = {
        url: result.url,
        statusCode: result.statusCode,
        title: doc.title || '',
        description: doc.description || '',
        ...(doc.image ? { image: doc.image } : {}),
        ...(doc.siteName ? { siteName: doc.siteName } : {}),
        text: doc.text,
        textChars: doc.textChars,
        truncated: doc.truncated,
        ...(doc.extracted ? { extracted: doc.extracted } : {}),
        ...(doc.links ? { links: doc.links.slice(0, 40) } : {}),
      };
      if (!doc.text && !doc.title) {
        return { content: [{ type: 'text', text: `页面没有可读正文（HTTP ${result.statusCode}）。可能是纯前端渲染或需要登录；可以试 raw=true 看原始 HTML。\n${JSON.stringify(payload, null, 2)}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
