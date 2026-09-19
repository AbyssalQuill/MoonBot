// Pixiv 图片：搜索（含本地筛选 + 自动翻页） + 拿可下载的图片地址。
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
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// 【2026-09-18 实测：镜像站只认 keyword / page，所以筛选只能在本地做】
//   逐个试过 mode=safe/all/r18、s_mode=s_tag/s_tag_full/s_tc、order=date_d/popular_d、p、bl、
//   type=illust/manga：**全部被忽略**（同一关键词 total 恒定、首条 id 恒定）；只有 page 让结果换了一批。
//   前端那几个参数是浏览器里本地过滤的，没传给上游。⇒ 本文件里的 normalizePixivFilters /
//   filterPixivItems 就是"在已抓回来的数据上自己筛"，这也是 scanPages 自动翻页存在的原因。
//
// 【2026-09-18 实测：返回体里没有收藏数 —— 按人气/收藏排序做不到，别假装支持】
//   逐条核对了第 1 页 60 条 item 的全部键：aiType / alt / bookmarkData / createDate / description /
//   height / id / illustType / isBookmarkable / isMasked / isOriginal / isUnlisted / is_howto /
//   pageCount / profileImageUrl / restrict / sl / tags / title / titleCaptionTranslation /
//   updateDate / url / userId / userName / visibilityScope / width / xRestrict。
//   其中 bookmarkData 是"**当前登录用户**有没有收藏"（未登录恒为 null），isBookmarkable 只是"能不能收藏"；
//   把整个返回体当字符串数过：bookmarkCount = 0 次、like = 0 次、view = 0 次。
//   ⇒ 收藏数/浏览数这类热度指标**根本没返回**，所以 sort 只能按 createDate（投稿时间），
//     调用方若传 sort=popular/hot 会被回落成 date_desc 并在 warnings 里写明原因。
//
// 【2026-09-18 实测：aiType 到底是什么值 —— 不能写成 aiType !== 0】
//   · 关键词「AIイラスト」→ 60/60 条 aiType=2；「AI生成」→ 60/60 条 aiType=2；
//   · 关键词「手描き」→ 60/60 条 aiType=1（手绘，几乎不可能是 AI）；「アナログ」1=57 / 2=3。
//   ⇒ **aiType=2 = AI 生成，aiType=1 = 非 AI**（0 在实测样本里没出现过，按"未标注"处理）。
//     如果按"!=0 就算 AI"来写，会把整页作品全过滤光——这是本次实测最容易踩的坑。
//
// 【2026-09-18 实测：xRestrict（R-18）在本镜像站默认搜索里恒为 0】
//   「初音ミク」「エロ」「R-18」「巨乳」「オリジナル」各 60 条，xRestrict **全是 0**：
//   本站只搜全年龄库（这也是它不认 mode=r18 的同一个原因）。
//   ⇒ r18='only' 实测恒为空；'exclude'（默认）和 'include' 拿到的是同一批数据。
//   过滤逻辑仍然保留（xRestrict !== 0 + R-18/R-18G 标签兜底）：上游随时可能变，
//   而且标签兜底确实能挡住"关键词本身就是 R-18 标签"的作品。
//
// 【2026-09-18 实测：illustType 有 0/1/2 三种，2 是动图】
//   0=插画、1=漫画、2=动图(ugoira)；实测「初音ミク」60 条里有 1 条 illustType=2。
//   ⇒ illustType='illust'|'manga' 只认 0/1；2 不属于任何一类，被这两条筛选中任意一条排除。
//
// 【2026-09-18 实测：翻页与边界】
//   · 相邻页 id 不重叠（p1∩p2=p1∩p3=p2∩p3=0），每页 60 条，lastPage 恒为 10；
//   · page 超出 lastPage（试过 page=11）**仍然返回 60 条**，明显是兜底/循环 —— 不可采信，
//     所以自动翻页一律卡在 lastPage 内，不会去扫越界页。
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// 【本地筛选 + 自动翻页的设计（2026-09-18 主人确认走"方案 A"：不登录、不用会员、不加部署）】
//   筛选全在本地对已抓回来的数据做，只筛一页结果会很少（一页 60 条），所以支持 scanPages 自动往后翻，
//   直到筛够 limit 或扫到 lastPage；默认 3 页、上限 10 页。返回里的 scan / scanNotice 会**如实**告诉
//   调用方"只扫了 N 页 / 全站共 total 条 / lastPage 多少"，免得模型以为自己筛了全站。
//
//   ⚠️ 硬要求：**不传任何新参数时，结果必须与改动前逐字段一致**。
//   做法：把"调用方有没有用新参数"当开关 ——
//     · 一个筛选参数都没给 → 完全走旧路径：只抓 1 页、不排序、只过滤 R-18（与旧版逐字段一致）；
//     · 给了任意一个（包括显式 scanPages）→ 启用扫描引擎：默认排序 date_desc、默认扫 3 页。
//   这样"已经能用的搜索"不可能被改坏（回归测试见 tools/test-pixiv-filters.mjs）。
//
// 【镜像站地址可改（2026-09-18）】优先级 config.json 的 pixiv.base > 环境变量 QQBRIDGE_PIXIV_BASE
//   > 内置默认 —— 与 core/config.js 里 dsh.baseUrl 的"配置文件覆盖环境变量"同一套路。
//   为什么要接配置：桥打包给别人装好后，用户没法方便地改环境变量，而镜像站是第三方、随时可能换域名/挂掉；
//   改 config.json 一处即可，不用改代码（见 qq-bridge/config.example.json 的 pixiv 段）。
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// 【2026-09-18 实测更正：官网并不需要登录，机房 IP 也没被挡（至少在线上那台 VPS 上）】
//   上面"官网要登录、机房 IP 常被挡"是本文件最初写的理由，**实测不成立**，逐条留证：
//     · GET https://www.pixiv.net/ajax/illust/<id>?lang=zh        → 200，带完整 title/userName/tags/xRestrict/aiType
//     · GET https://www.pixiv.net/ajax/illust/<id>/pages?lang=zh  → 200，逐页给出 urls.original（原图直链）
//     · GET https://www.pixiv.net/ajax/search/artworks/<kw>?lang=zh → 200，illustManga.data 60 条
//     · GET https://www.pixiv.net/ajax/user/<uid>/profile/all?lang=zh → 200，body.illusts 是 id→null 的表
//   **全部不需要 cookie，也不需要 Referer**（带不带 referer 都 200；UA 用 'Mozilla/5.0' 就行）。
//   唯一真需要 Referer 的是图床 i.pximg.net：不带 `referer: https://www.pixiv.net/` 一律 403 nginx，
//   带上就 200 —— 所以取图那条路要给 safeFetchBuffer 传 referer（见下面 pixivImageSources）。
//   ⇒ 现在的分工：**元数据与地址直联官网**（快：100~400ms），**镜像站只当兜底**
//     （它的 search.php 实测就是 pixiv search 的透传，detail.php 则是它拿自己登录态换来的同一份
//      ajax 响应；它慢得多：同一张图 2.7~5.7s，还出现过 25s 超时，所以只能兜底）。
// ══════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 桥的 config.json（本文件在 qq-bridge/src/lib/ 下 → 上两级就是 qq-bridge/）。 */
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');
const DEFAULT_BASE = 'https://x.pixigraph.xyz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

/** 把地址规整成"能用或 null"：必须是 http(s)、去掉尾部斜杠。 */
function cleanBase(v) {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
}

/** 读 config.json 里的 pixiv.base（读不到文件 / 格式坏 / 值非法都当"没配"，绝不让它把搜索搞挂）。 */
export function configPixivBase() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return cleanBase(JSON.parse(text)?.pixiv?.base);
  } catch {
    return null;
  }
}

/**
 * 纯函数：决定这次用哪个镜像站地址（便于离线测试优先级）。
 * 顺序与 core/config.js 的 dsh.baseUrl 一致：配置文件 > 环境变量 > 内置默认。
 */
export function pickPixivBase({ configBase, envBase, fallback = DEFAULT_BASE } = {}) {
  return cleanBase(configBase) ?? cleanBase(envBase) ?? fallback;
}

/** 当前生效的镜像站地址。**每次现读** config.json：改完配置不用重启 MCP 子进程。 */
export function pixivBase() {
  return pickPixivBase({ configBase: configPixivBase(), envBase: process.env.QQBRIDGE_PIXIV_BASE });
}

/** 把任意图片 URL 包成站内代理地址（绕开 i.pximg.net 的 Referer 防盗链）。 */
export function pixivProxyUrl(imageUrl) {
  return `${pixivBase()}/api/image.php?url=${encodeURIComponent(String(imageUrl ?? '').trim())}`;
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

/** 不宜在 QQ 里发的作品：R-18 / R-18G。默认过滤掉。
 *  fail-closed：xRestrict 缺失/非 0（含 NaN）一律当 R-18；标签兜底挡"关键词本身是 R-18 标签"的作品。 */
function isAdult(item) {
  if (Number(item?.xRestrict) !== 0) return true;
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ') : '';
  return /r-?18|r18|エロ|グロ|成人|18禁/i.test(tags);
}

/* ────────────────────────── 本地筛选：参数规范化 ────────────────────────── */

export const PIXIV_SCAN_PAGES_DEFAULT = 3; // 默认往后扫几页（克制值：3 页 = 最多 180 条原始数据）
export const PIXIV_SCAN_PAGES_MAX = 10;    // 上限（镜像站 lastPage 实测就是 10）
const R18_VALUES = ['exclude', 'only', 'include'];
const SORT_VALUES = ['date_desc', 'date_asc', 'random'];
const ORIENTATION_VALUES = ['portrait', 'landscape', 'square'];
const ILLUST_TYPE_CODE = { illust: 0, manga: 1 }; // 2=动图(ugoira)，不属于这两类
/** 实测 aiType=2 才是 AI 生成（见文件头）。写成"!=0"会把整页都当 AI 排掉。 */
const AI_TYPE_OF_AI = 2;
/** AI 标签兜底正则：锚定 `^ai$` + 明确的 AI 词，避免 'Maid'、'Fairy' 这种含 "ai" 的普通标签误伤。 */
const AI_TAG_RE = /^ai$|ai\s*生成|aiイラスト|ai[-_ ]?art|ai绘画|ai作画|ai[-_ ]?girl|generated by ai|stable\s*diffusion|novelai|midjourney/i;
/** 调用方能用的全部新参数（判断"这次要不要启用筛选引擎"就靠这张表）。 */
const NEW_KEYS = ['r18', 'tags', 'author', 'orientation', 'minWidth', 'minHeight', 'multiPage', 'excludeAi', 'illustType', 'sort', 'scanPages'];

/**
 * 把调用方给的筛选参数规范化成内部形状。
 * **非法值一律不抛错**（工具层要返回给模型看，不能炸）：回落到安全默认并记进 warnings，
 * 尤其是 r18 —— 取值不认识时一定回落 'exclude'，绝不可能因为拼错就把 R-18 放行。
 * @returns {object} 含 engaged（调用方到底用没用新参数）
 */
export function normalizePixivFilters(opts = {}) {
  const warnings = [];
  const given = (k) => opts[k] !== undefined && opts[k] !== null;
  const engaged = NEW_KEYS.some(given);

  let r18 = 'exclude';
  if (given('r18')) {
    const v = String(opts.r18).trim().toLowerCase();
    if (R18_VALUES.includes(v)) r18 = v;
    else warnings.push(`r18=「${opts.r18}」不认识（只有 exclude/only/include），已按最保险的 exclude 排除 R-18`);
  }

  let sort = 'date_desc';
  if (given('sort')) {
    const v = String(opts.sort).trim().toLowerCase();
    if (SORT_VALUES.includes(v)) sort = v;
    else if (/pop|hot|bookmark|fav|rank|收藏|人气|热度/.test(v)) {
      warnings.push(`sort=「${opts.sort}」做不到：镜像站返回体里没有收藏数（bookmarkData 恒为 null，实测 bookmarkCount/like/view 出现 0 次），只能按投稿时间排，已回落 date_desc`);
    } else warnings.push(`sort=「${opts.sort}」不认识（只有 date_desc/date_asc/random），已回落 date_desc`);
  }

  let tags = [];
  if (given('tags')) {
    if (Array.isArray(opts.tags)) tags = opts.tags.map((t) => String(t).trim()).filter(Boolean);
    else if (typeof opts.tags === 'string') {
      tags = opts.tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
      if (tags.length) warnings.push('tags 传的是字符串，已按逗号/空格拆成数组（建议直接传数组）');
    } else warnings.push('tags 必须是字符串数组，已忽略');
  }

  let author = '';
  if (given('author')) {
    author = String(opts.author).trim();
    if (!author) warnings.push('author 是空串，已忽略');
  }

  let orientation = '';
  if (given('orientation')) {
    const v = String(opts.orientation).trim().toLowerCase();
    if (ORIENTATION_VALUES.includes(v)) orientation = v;
    else warnings.push(`orientation=「${opts.orientation}」不认识（只有 portrait/landscape/square），已忽略该项`);
  }

  const numOrNull = (key, min) => {
    if (!given(key)) return null;
    const n = Number(opts[key]);
    if (Number.isFinite(n) && n >= min) return n;
    warnings.push(`${key}=「${opts[key]}」不是 ≥${min} 的数字，已忽略该项`);
    return null;
  };
  const minWidth = numOrNull('minWidth', 1);
  const minHeight = numOrNull('minHeight', 1);

  let multiPage = false;
  if (given('multiPage')) {
    if (typeof opts.multiPage === 'boolean') multiPage = opts.multiPage;
    else warnings.push(`multiPage=「${opts.multiPage}」不是布尔值，已忽略该项`);
  }
  let excludeAi = false;
  if (given('excludeAi')) {
    if (typeof opts.excludeAi === 'boolean') excludeAi = opts.excludeAi;
    else warnings.push(`excludeAi=「${opts.excludeAi}」不是布尔值，已忽略该项`);
  }

  let illustType = '';
  if (given('illustType')) {
    const v = String(opts.illustType).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ILLUST_TYPE_CODE, v)) illustType = v;
    else warnings.push(`illustType=「${opts.illustType}」不认识（只有 illust=插画0 / manga=漫画1；本站还有 illustType=2 的动图，不属于这两类），已忽略该项`);
  }

  let scanPages = PIXIV_SCAN_PAGES_DEFAULT;
  if (given('scanPages')) {
    const n = Number(opts.scanPages);
    if (Number.isFinite(n) && n >= 1) {
      const capped = Math.min(PIXIV_SCAN_PAGES_MAX, Math.floor(n));
      if (capped !== Math.floor(n)) warnings.push(`scanPages=${opts.scanPages} 超过上限，已按 ${PIXIV_SCAN_PAGES_MAX} 页处理`);
      scanPages = capped;
    } else warnings.push(`scanPages=「${opts.scanPages}」不是 ≥1 的数字，已按默认 ${PIXIV_SCAN_PAGES_DEFAULT} 页处理`);
  }

  return {
    engaged, warnings,
    r18, tags, author, orientation, minWidth, minHeight, multiPage, excludeAi, illustType, sort, scanPages,
  };
}

/* ────────────────────────── 本地筛选：逐条判定（纯函数） ────────────────────────── */

/** 构图：竖图/横图/正方；尺寸缺失（0）判不出来 → 返回空串。 */
function orientationOf(item) {
  const w = Number(item?.width) || 0;
  const h = Number(item?.height) || 0;
  if (!w || !h) return '';
  if (h > w) return 'portrait';
  if (w > h) return 'landscape';
  return 'square';
}

/** 是不是 AI 生成：以实测的 aiType=2 为准，再用标签兜底（aiType 有漏标时仍能挡住一部分）。 */
function isAiWork(item) {
  if (Number(item?.aiType) === AI_TYPE_OF_AI) return true;
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return tags.some((t) => AI_TAG_RE.test(String(t)));
}

/** 标签全命中（大小写不敏感、子串匹配：'初音ミク' 能命中 '初音ミク(Hatsune Miku)'）。 */
function hitAllTags(item, wanted) {
  const have = (Array.isArray(item?.tags) ? item.tags : []).map((t) => String(t).toLowerCase());
  return wanted.every((w) => {
    const lw = String(w).toLowerCase();
    return have.some((h) => h.includes(lw));
  });
}

/** 作者：纯数字当 userId 精确比对，否则按 userName 子串匹配（大小写不敏感）。 */
function hitAuthor(item, want) {
  if (/^\d+$/.test(want)) return String(item?.userId ?? '') === want;
  return String(item?.userName ?? '').toLowerCase().includes(want.toLowerCase());
}

/**
 * 对一批镜像站原始条目做本地筛选（**纯函数，离线可测**，见 tools/test-pixiv-filters.mjs）。
 * @param {Array} items 原始条目
 * @param {object} f normalizePixivFilters 的结果
 * @param {Set<string>} seenIds 跨页去重用的已见 id（会被就地更新）
 * @returns {{items:Array, dropped:object, droppedTotal:number}} dropped = 各类丢弃计数（写进 scan 里给模型看）
 */
export function filterPixivItems(items, f, seenIds = new Set()) {
  const kept = [];
  const dropped = {
    noId: 0, adult: 0, notR18: 0, tag: 0, author: 0, orientation: 0,
    minWidth: 0, minHeight: 0, multiPage: 0, ai: 0, illustType: 0, duplicate: 0,
  };
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.id) { dropped.noId++; continue; }
    const id = String(it.id);
    if (seenIds.has(id)) { dropped.duplicate++; continue; }

    // ① R-18 规则（默认 exclude，与旧行为一致）
    const adult = isAdult(it);
    if (f.r18 === 'exclude' && adult) { dropped.adult++; continue; }
    if (f.r18 === 'only' && !adult) { dropped.notR18++; continue; }
    // 'include' → 不按 R-18 过滤

    // ② 标签全命中
    if (f.tags.length && !hitAllTags(it, f.tags)) { dropped.tag++; continue; }
    // ③ 作者
    if (f.author && !hitAuthor(it, f.author)) { dropped.author++; continue; }
    // ④ 构图（尺寸缺失判不出来 → 该条不算命中，如实排除）
    if (f.orientation) {
      const o = orientationOf(it);
      if (o !== f.orientation) { dropped.orientation++; continue; }
    }
    // ⑤ 最小尺寸（0/缺失都算不达标）
    if (f.minWidth !== null && (Number(it.width) || 0) < f.minWidth) { dropped.minWidth++; continue; }
    if (f.minHeight !== null && (Number(it.height) || 0) < f.minHeight) { dropped.minHeight++; continue; }
    // ⑥ 只看多图
    if (f.multiPage && !(Number(it.pageCount) > 1)) { dropped.multiPage++; continue; }
    // ⑦ 排除 AI
    if (f.excludeAi && isAiWork(it)) { dropped.ai++; continue; }
    // ⑧ 插画 / 漫画
    if (f.illustType && Number(it.illustType) !== ILLUST_TYPE_CODE[f.illustType]) { dropped.illustType++; continue; }

    seenIds.add(id);
    kept.push(it);
  }
  const droppedTotal = Object.values(dropped).reduce((a, b) => a + b, 0);
  return { items: kept, dropped, droppedTotal };
}

/** 按 createDate（ISO，带 +09:00 偏移）排序；缺日期当 0 处理。Array.sort 在 V8 里是稳定排序。 */
function sortByCreateDate(items, dir) {
  return items.slice().sort((a, b) => {
    const ta = Date.parse(a?.createDate ?? '') || 0;
    const tb = Date.parse(b?.createDate ?? '') || 0;
    return dir > 0 ? ta - tb : tb - ta;
  });
}

/** Fisher–Yates 洗牌（sort='random' 用；不追求可复现，只在已扫到的页里打乱）。 */
function shuffle(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 原始条目 → 对外返回的形状（旧版原样保留，字段一个不动，避免改坏下游）。 */
function toResult(it) {
  return {
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
  };
}

/**
 * 抓镜像站的一页搜索结果（重试 2 次）。
 * 这个平替站**偶发**慢/超时（实测同一条请求 0.4s 正常，偶尔直接挂到 12s 超时），
 * 所以重试一次再放弃 —— 否则一次抖动模型就以为"Pixiv 搜不到"。
 * @returns {Promise<{data:Array, total:number, lastPage:number}>}
 */
async function fetchPixivPage(keyword, page) {
  const base = pixivBase();
  const url = `${base}/api/search.php?keyword=${encodeURIComponent(keyword)}&page=${page}`;
  let body = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: `${base}/` },
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
  return {
    data: Array.isArray(box?.data) ? box.data : [],
    total: Number(box?.total) || 0,
    lastPage: Number(box?.lastPage) || 0,
  };
}

/** 扫描摘要的中文一句话（模型只读这段也能明白"没筛全站"）。 */
function buildScanNotice({ q, scanned, fromPage, toPage, scanPages, total, lastPage, rawScanned, kept, returned, dropped, f, warnings, sort, reachedLimit, exhausted }) {
  const parts = [];
  parts.push(`本地筛选：搜「${q}」全站共 ${total} 条（镜像站最多给 ${lastPage || '?'} 页，每页 60 条）`);
  parts.push(`本次扫了第 ${fromPage}~${toPage} 页共 ${scanned} 页（上限 ${scanPages} 页），原始 ${rawScanned} 条`);
  const dropBits = [];
  if (dropped.adult) dropBits.push(`R-18 规则 ${dropped.adult} 条`);
  if (dropped.notR18) dropBits.push(`非 R-18 ${dropped.notR18} 条`);
  if (dropped.duplicate) dropBits.push(`跨页重复 ${dropped.duplicate} 条`);
  const ruleDrop = dropped.tag + dropped.author + dropped.orientation + dropped.minWidth + dropped.minHeight + dropped.multiPage + dropped.ai + dropped.illustType;
  if (ruleDrop) dropBits.push(`条件不符 ${ruleDrop} 条`);
  parts.push(`筛掉 ${dropBits.length ? dropBits.join('、') : '0 条'}，命中 ${kept} 条，返回 ${returned} 条`);
  parts.push(`r18=${f.r18}、排序=${sort}`);
  if (exhausted) parts.push('已扫到镜像站最后一页（后面没有了）');
  else if (reachedLimit) parts.push('命中已够 limit，没继续往后翻');
  else parts.push(`扫满 ${scanPages} 页上限仍未凑够 limit（后面还有页，可调大 scanPages 或放宽筛选）`);
  if (warnings.length) parts.push(`提示：${warnings.join('；')}`);
  return parts.join('；') + '。注意：这不是全站筛选结果。';
}

/**
 * 搜 Pixiv 作品。
 *
 * 旧签名照旧（query + page + limit）；新增本地筛选参数（见 normalizePixivFilters）。
 * @returns {Promise<{query:string, page:number, total:number, lastPage:number, filtered:number, results:Array,
 *                    scan?:object, scanNotice?:string}>}
 *          scan / scanNotice 只在用了筛选参数时出现（旧路径不产生，保证与改动前逐字段一致）。
 */
export async function pixivSearch(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索词不能为空');
  const page = Math.max(1, Math.min(200, Number(opts.page) || 1));
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 8));
  const f = normalizePixivFilters(opts);

  /* ── 旧路径：调用方一个筛选参数都没用 → 与改动前逐字段一致（只抓 1 页、不排序、只过滤 R-18）── */
  if (!f.engaged) {
    const box = await fetchPixivPage(q, page);
    const safe = box.data.filter((it) => it && it.id && !isAdult(it));
    const filtered = box.data.length - safe.length;
    const results = safe.slice(0, limit).map(toResult);
    return { query: q, page, total: box.total, lastPage: box.lastPage, filtered, results };
  }

  /* ── 扫描引擎：按页往后翻，直到筛够 limit / 扫满 scanPages / 到底 lastPage ── */
  const seenIds = new Set();
  const kept = [];
  const dropped = {
    noId: 0, adult: 0, notR18: 0, tag: 0, author: 0, orientation: 0,
    minWidth: 0, minHeight: 0, multiPage: 0, ai: 0, illustType: 0, duplicate: 0,
  };
  const warnings = [...f.warnings];
  let scanned = 0;
  let fromPage = page;
  let toPage = page;
  let rawScanned = 0;
  let total = 0;
  let lastPage = 0;
  let exhausted = false;
  let reachedLimit = false;

  for (let i = 0; i < f.scanPages; i += 1) {
    const p = page + i;
    if (p > 200) { warnings.push('页码已达 200 上限，停止翻页'); break; }
    let box;
    try {
      box = await fetchPixivPage(q, p);
    } catch (e) {
      // 第一页就抓不到 → 按旧行为抛错；中途失败 → 保留已扫到的部分结果（别把第一页的收获也扔掉）
      if (i === 0) throw e;
      warnings.push(`第 ${p} 页抓取失败（${e?.message ?? e}），已返回扫到的 ${scanned} 页结果`);
      break;
    }
    scanned += 1;
    toPage = p;
    rawScanned += box.data.length;
    if (box.total) total = box.total;
    if (box.lastPage) lastPage = box.lastPage;

    const r = filterPixivItems(box.data, f, seenIds);
    for (const k of Object.keys(dropped)) dropped[k] += r.dropped[k] || 0;
    kept.push(...r.items);

    if (kept.length >= limit) { reachedLimit = true; break; }
    if (lastPage && p >= lastPage) { exhausted = true; break; }
  }

  if (!scanned) throw new Error('pixiv 搜索失败：一页都没扫到');
  /* 注意：这里**不**再额外塞一条"扫满上限仍不够"的警告 —— scan 里的 reachedLimit/exhausted
   * 和下面 scanNotice 的末句已经把这件事说清楚了，再塞一条会让模型的 JSON 里出现两遍同样的话。 */

  // 排序只在**已扫到的页**内生效（镜像站不给服务端排序，而且我们要先凑够 limit 才能截断）
  const ordered = f.sort === 'random' ? shuffle(kept)
    : f.sort === 'date_asc' ? sortByCreateDate(kept, 1)
      : sortByCreateDate(kept, -1);
  const results = ordered.slice(0, limit).map(toResult);
  const droppedTotal = Object.values(dropped).reduce((a, b) => a + b, 0);

  const scan = {
    pagesScanned: scanned,
    fromPage,
    toPage,
    scanPagesLimit: f.scanPages,
    total,
    lastPage,
    rawScanned,
    kept: kept.length,
    returned: results.length,
    dropped,
    droppedTotal,
    reachedLimit,       // 凑够 limit 了
    exhausted,          // 扫到镜像站最后一页了
    r18: f.r18,
    sort: f.sort,
    filters: {
      tags: f.tags, author: f.author, orientation: f.orientation,
      minWidth: f.minWidth, minHeight: f.minHeight,
      multiPage: f.multiPage, excludeAi: f.excludeAi, illustType: f.illustType,
    },
    warnings,
  };
  return {
    query: q,
    page,
    total,
    lastPage,
    // 旧字段语义保持：被 R-18 规则丢掉的条数（发图工具的"已过滤 R-18 N 条"提示还在用）
    filtered: dropped.adult + dropped.notR18,
    results,
    scan,
    scanNotice: buildScanNotice({
      q, scanned, fromPage, toPage, scanPages: f.scanPages, total, lastPage,
      rawScanned, kept: kept.length, returned: results.length, dropped, f, warnings, sort: f.sort,
      reachedLimit, exhausted,
    }),
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

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 【2026-09-18 新增：按作品号取图 —— 修「给了 illustId 却试了 0 个地址」】
 *
 * 现场（主人报的）：`qq_send_pixiv {illustId:"80643572", size:"original"}` 返回
 *   `Pixiv 图片下载失败（试了 0 个地址）`，**一个候选都没生成**。
 * 根因：换 illustId 的那条路只会拼 `work = {id, thumbUrl:''}`（当时注释写着"没有按号取详情的免登录接口"），
 *   而 `pixivImageCandidates` 是从 **thumbUrl 里的日期路径**推大图地址的 —— thumbUrl 是空串，
 *   日期路径推不出来，于是 out 里只剩"再兜一次空 thumb"= 0 个候选。
 *   ⇒ 这条路等于**从来没通过**：不是被风控、也不是地址过期，是压根没地址可试。
 *
 * 修法：先按作品号把"下游地址"问出来，再交给 `pixivImageSources` 拼候选。实测可用的来源：
 *   ① pixiv 直联（首选）：`ajax/illust/{id}` 取元数据、`ajax/illust/{id}/pages` 取**逐页原图直链**。
 *      实测 `pages` 给出的就是 `https://i.pximg.net/img-original/img/<日期>_p<N>.<ext>` —— 真原图，
 *      拿它拼地址不用猜日期、也不用猜扩展名（同一作品各页扩展名实测一致，但不同作品有 jpg 也有 png）。
 *      注意 `ajax/illust/{id}` 的 `urls` 字段**可能整组为 null**（实测：80643572 全 null，
 *      149807268 齐全），所以**不要**只依赖它 —— 原图地址以 `pages` 为准。
 *   ② 镜像站兜底：`api/detail.php?id=`（形状与 pixiv 的 ajax 一致，它用自己的登录态取），
 *      慢（实测 0.9~14s）且偶发超时，只在 ① 失败时用。
 * 取字节：`i.pximg.net` 需要 `referer: https://www.pixiv.net/`（不带 403），所以直联优先、镜像代理兜底；
 *   两者返回的字节实测**逐字节相同**（jpg 1,886,996B sha 536c4aeb… / png 696,829B sha c792e5ce…）。
 *
 * R-18 闸门：按号取图**不会**经过搜索的本地筛选，所以这里必须自己判 —— 用同一个 `isAdult` 规则
 *   （xRestrict 缺失/非 0 一律当 R-18）。实测 R-18 作品 `ajax/illust` 仍会 200 且 `xRestrict:1`
 *   （例：110000000），所以"官网会替我挡"是错的；倒是 `pages` 对 R-18 会 404。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 直联 pixiv 时必须带的 Referer（图床防盗链只认它；ajax 本身带不带都行）。 */
export const PIXIV_REFERER = 'https://www.pixiv.net/';
const PIXIV_AJAX = 'https://www.pixiv.net/ajax';
const PIXIV_DIRECT_TIMEOUT_MS = 15000;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 【2026-09-19 新增：pixiv 登录态（cookie）—— 只为"按名字搜画师"这一件事】
 *
 * 为什么需要：pixiv 的**用户搜索**接口对匿名请求一律拒绝。实测（线上 VPS，未登录）：
 *   · GET /ajax/search/users?word=米山舞[&s_mode=s_usr][&p=1][&type=user] → 400「不正确的请求。」
 *     （注意**不是 404**：路由存在，只是不接受匿名请求）
 *   · GET /ajax/search/users/米山舞 → 404；/ajax/search/users/米山舞?s_mode=s_usr → 404
 *   · 作品关键词搜索替不了它：搜「米山舞」全站 173 条里，作者名含"米山舞"的**0 条**
 *     （那些是打了她名字标签的粉丝图）。所以"找某人本人的作品"没法靠关键词搜。
 *   · 镜像站 x.pixigraph.xyz 也没有用户搜索（猜的 5 条路由全 404，search.php 忽略 type/mode/s_mode，
 *     native.php 代拉 pixiv 的用户搜索返回空）。
 *   ⇒ 想按名字找人，只能自己带登录态。**免费号就够**（会员只管人气排序/多标签检索这类玩法）。
 *
 * 三条纪律：
 *   ① **只在 pixiv 域名上带 cookie**（见 pixivRequestHeaders）—— 绝不能把登录凭证发给第三方镜像站；
 *   ② cookie 只从本地配置读（config.json 的 pixiv.cookie / 环境变量），**永不写进任何返回值、日志或 QQ 消息**；
 *   ③ 没配 cookie 时"按名字搜"要**明确说不支持**，不许悄悄退化成"关键词搜"（那会给出错误的答案）。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 纯函数：把用户给的东西规整成一条能用的 Cookie 头。
 * 容忍三种写法（主人不一定会照抄格式）：整条 cookie 串、`PHPSESSID=xxx`、光秃秃的会话值。
 * 空/含换行（有人会连回车一起复制）都要处理干净 —— 换行进请求头会直接把请求弄坏。
 * @returns {string} 可用则返回 cookie 串，否则空串
 */
export function cleanPixivCookie(v) {
  let s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return '';
  // 有人只复制会话值本身（32 位左右的十六进制/字母数字），补上键名
  if (!s.includes('=') && /^[A-Za-z0-9_%\-+/=.]{8,200}$/.test(s)) s = `PHPSESSID=${s}`;
  // 只保留 pixiv 需要的几个键（其余键带过去没意义，还会把凭证面铺大）
  const keep = s.split(';')
    .map((x) => x.trim())
    .filter((x) => /^(PHPSESSID|device_token|p_ab_id|p_ab_id_2|p_ab_d_id|p_ab_id_3|yuid_b|cookies_banner)=/i.test(x));
  const out = (keep.length ? keep : [s]).join('; ').slice(0, 2000);
  return /^[\x20-\x7E]+$/.test(out) ? out : '';
}

/** 读 config.json 的 pixiv.cookie（读不到/格式坏都当"没配"，绝不让它把搜索搞挂）。 */
export function configPixivCookie() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return cleanPixivCookie(JSON.parse(text)?.pixiv?.cookie);
  } catch {
    return '';
  }
}

/** 当前生效的 pixiv 登录 cookie。**每次现读** config.json：贴完新 cookie 不用重启 MCP 子进程。 */
export function pixivCookie() {
  return configPixivCookie() || cleanPixivCookie(process.env.QQBRIDGE_PIXIV_COOKIE);
}

/** 是否配了登录 cookie（只回布尔，**绝不回值**）。 */
export function pixivLoggedIn() {
  return pixivCookie().length > 0;
}

/**
 * pixiv 请求头。**cookie 只发给 pixiv 自己的域名** —— 镜像站是第三方，把登录凭证发过去等于泄露账号。
 * @param {string} url 目标地址
 */
export function pixivRequestHeaders(url, extra = {}) {
  const u = String(url ?? '');
  const isPixiv = /^https?:\/\/(?:[a-z0-9-]+\.)*pixiv\.net(?:[/:]|$)/i.test(u);
  const ck = isPixiv ? pixivCookie() : '';
  return {
    'user-agent': UA,
    accept: 'application/json,text/plain,*/*',
    referer: PIXIV_REFERER,
    ...(ck ? { cookie: ck } : {}),
    ...extra,
  };
}

/**
 * 登录态自检：拿一个"匿名时被抹掉原图地址"的作品当试纸。
 *
 * 依据（实测）：作品 80643572 匿名请求 `ajax/illust/{id}` 时 `urls` 整组为 null（sl=4），
 * 而 149807268（sl=2）匿名也带 urls。所以"试纸作品 80643572 的 urls.original 非空"
 * 就能证明 cookie 真的生效了 —— 比"看有没有配 cookie"可靠得多（cookie 会过期）。
 * @returns {Promise<{configured:boolean, loggedIn:boolean, probeId:string, evidence:string}>}
 */
export async function pixivLoginState(probeId = '80643572') {
  const configured = pixivLoggedIn();
  if (!configured) {
    return { configured: false, loggedIn: false, probeId: String(probeId), evidence: '没配 pixiv.cookie（config.json 的 pixiv.cookie 或环境变量 QQBRIDGE_PIXIV_COOKIE）' };
  }
  try {
    const r = await fetchPixivJson(`${PIXIV_AJAX}/illust/${probeId}?lang=zh`);
    const url = String(r.json?.body?.urls?.original ?? '').trim();
    return {
      configured: true,
      loggedIn: Boolean(url),
      probeId: String(probeId),
      evidence: url ? `试纸作品 ${probeId} 拿到了原图地址（登录态生效）` : `试纸作品 ${probeId} 的 urls.original 仍是 null（cookie 无效/已过期）`,
    };
  } catch (e) {
    return { configured: true, loggedIn: false, probeId: String(probeId), evidence: `自检请求失败：${e?.message ?? e}` };
  }
}

/** 归一化名字用于比对：去掉空白与全角空格、转小写（'米山舞 ！！' 与 '米山舞！！' 视为同名）。 */
export function normalizeArtistName(s) {
  return String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
}

/**
 * 纯函数：解析"用户搜索"的返回体 —— 形状没实测过（要登录态才能试），所以**宽容解析**：
 * 认 `body.users` / `body.list` / 裸数组，字段认 userId|id、userName|name、illusts|works|illustCount。
 * @returns {{id:string,name:string,works:number,premium:boolean,pageUrl:string}[]}
 */
export function parsePixivUserSearch(json) {
  const b = json?.body ?? json;
  const arr = Array.isArray(b?.users) ? b.users
    : Array.isArray(b?.list) ? b.list
      : Array.isArray(b?.data) ? b.data
        : Array.isArray(b) ? b : [];
  return arr.map((u) => {
    const id = String(u?.userId ?? u?.id ?? '').trim();
    const w = Number(u?.illusts ?? u?.works ?? u?.illustCount ?? u?.illust_count);
    return {
      id,
      name: String(u?.userName ?? u?.name ?? '').trim(),
      works: Number.isFinite(w) ? w : 0,
      premium: Boolean(u?.premium),
      pageUrl: /^\d+$/.test(id) ? `https://www.pixiv.net/users/${id}` : '',
      avatar: String(u?.profileImageUrl ?? u?.image ?? u?.imageBig ?? u?.profile_image_url ?? '').trim(),
    };
  }).filter((u) => u.id);
}

/**
 * 把"按画师名搜"的返回体排序/挑选（**纯函数，离线可测**）：
 * 名字完全相等的排前面（pixiv 搜索本身也会按相关度排，这里只做一道确定性收口），
 * 同档次内按作品数多→少（作品数是"这个号是不是活跃画师"的唯一可用信号）。
 *
 * 什么时候**才敢**直接定号（unique）：名字完全相等的那一个**只有一个**，且
 *   · 没有任何"包含关系"的近似号（如搜"米山舞"时冒出来的"米山舞です"），或者
 *   · 它的作品数**严格多于**所有近似号 —— 粉丝小号通常作品很少，这条能救回"重名号扎堆"的常见情况。
 * 其余一律返回候选列表让用户挑：**发错人比不发出去更糟**。
 * @returns {{exact:object[], partial:object[], others:object[], candidates:object[], unique:object|null}}
 */
export function rankArtistCandidates(users, name) {
  const want = normalizeArtistName(name);
  const list = Array.isArray(users) ? users.slice() : [];
  const exact = list.filter((u) => normalizeArtistName(u.name) === want);
  const partial = list.filter((u) => {
    const n = normalizeArtistName(u.name);
    return n !== want && (n.includes(want) || want.includes(n));
  });
  const others = list.filter((u) => !exact.includes(u) && !partial.includes(u));
  const byWorks = (a, b) => (b.works || 0) - (a.works || 0);
  const candidates = [...exact.slice().sort(byWorks), ...partial.slice().sort(byWorks), ...others];
  const topPartialWorks = partial.reduce((m, u) => Math.max(m, u.works || 0), 0);
  const unique = (exact.length === 1 && (partial.length === 0 || (exact[0].works || 0) > topPartialWorks))
    ? exact[0] : null;
  return { exact, partial, others, candidates, unique };
}

/** GET 一个 pixiv/mirror 的 JSON 端点。**不抛 HTTP 状态错**（404 的 JSON 体也要能读到，才能给准话）。 */
async function fetchPixivJson(url, timeoutMs = PIXIV_DIRECT_TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: pixivRequestHeaders(url),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** 把 pixiv ajax（或镜像站同形状）的 body 归一成本模块对外的作品形状。**纯函数，离线可测**。 */
export function normalizePixivIllustDetail(body, source = 'pixiv') {
  const b = body ?? {};
  const id = String(b.id ?? b.illustId ?? '').trim();
  const tagList = Array.isArray(b.tags?.tags) ? b.tags.tags
    : Array.isArray(b.tags) ? b.tags : [];
  const tags = tagList.map((t) => String(t?.tag ?? t ?? '').trim()).filter(Boolean);
  const out = {
    id,
    title: String(b.title ?? b.illustTitle ?? '').trim(),
    author: String(b.userName ?? '').trim(),
    authorId: String(b.userId ?? '').trim(),
    tags,
    description: String(b.description ?? b.illustComment ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    pageCount: Math.max(1, Number(b.pageCount) || 1),
    width: Number(b.width) || 0,
    height: Number(b.height) || 0,
    illustType: Number(b.illustType) || 0,
    xRestrict: b.xRestrict,
    aiType: Number(b.aiType) || 0,
    createDate: String(b.createDate ?? ''),
    pageUrl: pixivPageUrl(id),
    thumbUrl: String(b.urls?.thumb ?? '').trim(),
    urls: {
      original: String(b.urls?.original ?? '').trim(),
      regular: String(b.urls?.regular ?? '').trim(),
      thumb: String(b.urls?.thumb ?? '').trim(),
    },
    source,
  };
  // fail-closed：xRestrict 缺失/非 0 都当 R-18（与搜索路径的 isAdult 同一口径）
  out.adult = isAdult({ xRestrict: out.xRestrict, tags });
  out.origin = 'detail';
  return out;
}

/**
 * 按作品号取详情（元数据 + 可能的原图地址）。
 * 顺序：pixiv 直联 → 镜像站 detail.php（兜底）。两者都失败才抛错，并把两边的原话都带上。
 */
export async function pixivIllustDetail(id) {
  const pid = String(id ?? '').trim();
  if (!/^\d{1,12}$/.test(pid)) throw new Error(`Pixiv 作品号不合法：「${String(id ?? '')}」（应为纯数字，例如 80643572）`);
  const attempts = [
    ['pixiv', `${PIXIV_AJAX}/illust/${pid}?lang=zh`],
    ['mirror', `${pixivBase()}/api/detail.php?id=${pid}`],
  ];
  const errors = [];
  for (const [source, url] of attempts) {
    try {
      const r = await fetchPixivJson(url, source === 'mirror' ? TIMEOUT_MS + 10000 : PIXIV_DIRECT_TIMEOUT_MS);
      const body = r.json?.body;
      if (r.json?.error || !body || !String(body.id ?? body.illustId ?? '').trim()) {
        throw new Error(`HTTP ${r.status}${r.json?.error ? '（官网说没这个作品或不让看）' : ''}`);
      }
      return normalizePixivIllustDetail(body, source);
    } catch (e) {
      errors.push(`${source}: ${e?.message ?? e}`);
    }
  }
  throw new Error(`取 Pixiv 作品 ${pid} 失败 —— ${errors.join('；')}。请核对作品号，或换成关键词搜索（query）。`);
}

/** 由 p0 原图直链推出同一作品每一页的原图直链。**纯函数，离线可测**（pages 接口失败时的兜底）。 */
export function deriveOriginalPageUrls(p0, pageCount) {
  const s = String(p0 ?? '').trim();
  const m = /^(.*_p)(\d+)(\.[A-Za-z0-9]+)$/.exec(s);
  if (!m) return [];
  const n = Math.max(1, Number(pageCount) || 1);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(`${m[1]}${i}${m[3]}`);
  return out;
}

/** 原图直链 → master1200 直链。**纯函数，离线可测**。
 *  实测：master **一律是 .jpg**（png 原图的作品，`..._p0_master1200.png` 是 404，`.jpg` 才是 200/740KB）。 */
export function pixivMasterUrl(originalUrl) {
  return String(originalUrl ?? '').trim()
    .replace('/img-original/img/', '/img-master/img/')
    .replace(/\.[A-Za-z0-9]+$/, '_master1200.jpg');
}

/**
 * 取一个作品的**逐页原图直链**。
 * ① 官网 `ajax/illust/{id}/pages`（首选，实测 100~400ms，逐页给 urls.original）；
 * ② 官网 `ajax/illust/{id}` 的 urls.original + `deriveOriginalPageUrls` 推页（① 失败时）；
 * ③ 镜像站 detail.php 的 urls.original（`pixivIllustDetail` 兜底时已带回来）同样能推。
 * @returns {Promise<{urls:string[], source:string, note:string}>}
 */
export async function pixivIllustOriginals(detail) {
  const id = String(detail?.id ?? '').trim();
  const pageCount = Math.max(1, Number(detail?.pageCount) || 1);
  let note = '';
  if (id) {
    try {
      const r = await fetchPixivJson(`${PIXIV_AJAX}/illust/${id}/pages?lang=zh`);
      const arr = r.json?.body;
      if (Array.isArray(arr)) {
        const urls = arr.map((p) => String(p?.urls?.original ?? '').trim()).filter(Boolean);
        if (urls.length) return { urls, source: 'pixiv:pages', note };
        note = `pixiv pages 没给原图地址（HTTP ${r.status}）`;
      } else {
        note = `pixiv pages 返回了非预期形状（HTTP ${r.status}）`;
      }
    } catch (e) {
      note = `pixiv pages 失败：${e?.message ?? e}`;
    }
  }
  const p0 = String(detail?.urls?.original ?? '').trim();
  if (p0) {
    const derived = deriveOriginalPageUrls(p0, pageCount);
    if (derived.length) return { urls: derived, source: 'derived', note };
  }
  return { urls: [], source: '', note: note || '拿不到原图地址' };
}

/**
 * 取一个画师（userId）的公开作品号列表，**新→旧**。
 *
 * 为什么需要它：关键词搜索搜的是"标签/标题里出现这个词的作品"，所以搜「米山舞」搜到的是**别人画的、
 * 打了她名字标签的**图，找不到她本人的作品（主人 2026-09-18 报的正是这件事）。
 * 找"某人本人的作品"必须走 user 接口：`ajax/user/{uid}/profile/all` 的 `body.illusts` 是 `{id: null}` 表。
 * 实测：uid=26249081 → 29 条；uid=52021072 → 20 条；uid=533797 → 0 条（该号叫 "Kana"，本来就没作品）。
 * pixiv 作品号全局递增，所以**按号倒序 = 按投稿时间新→旧**（这里没有 createDate 可用，只能这么排）。
 * @returns {Promise<{userId:string, ids:string[]}>}
 */
export async function pixivUserWorkIds(userId) {
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,12}$/.test(uid)) throw new Error(`画师号不合法：「${String(userId ?? '')}」（应为纯数字，例如 26249081）`);
  const r = await fetchPixivJson(`${PIXIV_AJAX}/user/${uid}/profile/all?lang=zh`);
  const b = r.json?.body;
  if (r.json?.error || !b) throw new Error(`取画师 ${uid} 的作品列表失败（HTTP ${r.status}）`);
  const raw = [...Object.keys(b.illusts ?? {}), ...Object.keys(b.manga ?? {})];
  const ids = [...new Set(raw.filter((x) => /^\d+$/.test(String(x))).map(String))]
    .sort((a, b2) => Number(b2) - Number(a));
  return { userId: uid, ids };
}

/** 供工具层用的 R-18 判定（与搜索路径同一个函数，避免两处规则漂移）。 */
export function isAdultWork(item) {
  return isAdult(item);
}

/**
 * 拼出"这张图的字节从哪几个地址能拿到"，**按可靠性排序**（工具层逐个试）。
 *
 * 每条是 `{url, referer?}`：带 referer 的走**直联**（要传给 safeFetchBuffer 的第三个参数），
 * 不带的走镜像站代理。直联在前是因为实测它快一个数量级（60~400ms vs 2.7~5.7s）且字节完全一致；
 * 镜像代理想吐超时时直联早就成功了。
 * 最后仍会追加 `pixivImageCandidates` 的老候选（从缩略图推的日期路径），保证"搜索路径"行为不变。
 *
 * @param {object} work 作品对象（搜索结果或 `pixivIllustDetail` 的结果）
 * @param {{page?:number, size?:'master'|'original', originals?:string[]}} opts
 * @returns {{url:string, referer?:string}[]}
 */
export function pixivImageSources(work, opts = {}) {
  const page = Math.max(0, Number(opts.page) || 0);
  const size = String(opts.size ?? 'master').toLowerCase() === 'original' ? 'original' : 'master';
  const out = [];
  const push = (url, referer) => {
    const u = String(url ?? '').trim();
    if (!u || out.some((x) => x.url === u)) return;
    out.push(referer ? { url: u, referer } : { url: u });
  };
  const originals = Array.isArray(opts.originals) ? opts.originals.map((u) => String(u ?? '').trim()).filter(Boolean) : [];
  const upstream = originals.length ? originals[Math.min(page, originals.length - 1)] : String(work?.urls?.original ?? '').trim();
  if (upstream) {
    const target = size === 'original' ? upstream : (String(work?.urls?.regular ?? '').trim() && page === 0
      ? String(work.urls.regular).trim()
      : pixivMasterUrl(upstream));
    push(target, PIXIV_REFERER);   // ① 直联 i.pximg（带 Referer）
    push(pixivProxyUrl(target));   // ② 镜像站代理兜底（同字节，但慢）
  }
  // ③ 老候选：从缩略图推日期路径（搜索路径一直用这套，保持行为不变）
  for (const u of pixivImageCandidates(work, { page, size })) push(u);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 【2026-09-19 新增：按画师名字找号（要登录 cookie；见本文件上方 cookie 段）】
 *
 * 调用方给的"画师"入参可能是三种东西，这里统一收口：
 *   · 画师号 / pixiv.net/users/<数字> 链接 → 直接用；
 *   · 画师名（不含数字）→ 走登录态的用户搜索；
 *   · 什么都没给 → none。
 * 名字搜出来**不保证唯一**（同名号在 pixiv 上很常见），所以：
 *   · 只有一个名字完全相等、且没有包含关系的候选 → 敢直接定（unique）；
 *   · 否则**返回候选列表让用户挑**，绝不瞎猜一个发出去 —— 发错人比不发更糟。
 *   （web 搜索引擎那条路实测不可靠：这台 VPS 上 bing 候选恒 0、duckduckgo 时好时坏 202，
 *    且"七菜"这种常见名会捞出 3 个同名号而真号不在前列；所以只做候选，不做自动定号。）
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 纯函数：认调用方给的"画师"入参。 */
export function parseAuthorInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return { kind: 'none' };
  const link = /pixiv\.net\/(?:en\/)?users\/(\d{1,12})/i.exec(s);
  if (link) return { kind: 'id', id: link[1], from: 'link' };
  if (/^\d{1,12}$/.test(s)) return { kind: 'id', id: s, from: 'number' };
  return { kind: 'name', name: s };
}

/**
 * 按名字搜画师（**需要登录 cookie**，没配就直接说清楚，不退化成关键词搜）。
 * 逐条试几个可能的用户搜索路由（形状没实测过：匿名时它们全被拒，只有带上 cookie 才知道哪条对）。
 * @returns {Promise<{query:string, endpoint:string, users:object[]}>}
 */
export async function pixivSearchUsersByName(name) {
  const w = String(name ?? '').trim();
  if (!w) throw new Error('要搜的画师名不能为空');
  if (!pixivLoggedIn()) {
    throw new Error('按名字找画师需要 pixiv 登录态：在 config.json 的 pixiv.cookie 里填一个会话 cookie（免费号即可）。'
      + '没登录态时只能改用 authorId（画师号，如 1554775）或作品链接（pixiv.net/artworks/<数字>）；'
      + '关键词搜索搜的是"标题/标签含该名字"的作品，找不到作者本人。');
  }
  const ends = [
    `${PIXIV_AJAX}/search/users/${encodeURIComponent(w)}?s_mode=s_usr&lang=zh`,
    `${PIXIV_AJAX}/search/users?word=${encodeURIComponent(w)}&s_mode=s_usr&lang=zh`,
    `${PIXIV_AJAX}/search/users?word=${encodeURIComponent(w)}&lang=zh`,
  ];
  const tried = [];
  for (const url of ends) {
    try {
      const r = await fetchPixivJson(url);
      const users = parsePixivUserSearch(r.json);
      if (users.length) return { query: w, endpoint: url.replace(PIXIV_AJAX, ''), users };
      const why = r.json?.error ? `error=${String(r.json.message ?? '').slice(0, 40)}` : '无 users 字段';
      tried.push(`${url.replace(PIXIV_AJAX, '')} → HTTP ${r.status} ${why}`);
    } catch (e) {
      tried.push(`${url.replace(PIXIV_AJAX, '')} → ${e?.message ?? e}`);
    }
  }
  throw new Error(`按名字搜「${w}」没拿到结果。逐条试过：${tried.join('；')}。`
    + '（若全是 400/404，说明这个 cookie 没生效或该接口对免费号也不开放 —— 用 tools/test-pixiv-byid.mjs --login 先自检登录态。）');
}

/**
 * 收口"画师入参" → 画师号 或 候选列表。
 * @returns {Promise<{kind:'id',id:string,from:string,name?:string,alternatives?:object[]}|{kind:'candidates',name:string,candidates:object[],endpoint:string}|{kind:'none'}>}
 */
export async function resolvePixivAuthor(input) {
  const p = parseAuthorInput(input);
  if (p.kind === 'none') return { kind: 'none' };
  if (p.kind === 'id') return { kind: 'id', id: p.id, from: p.from };
  const r = await pixivSearchUsersByName(p.name);
  const ranked = rankArtistCandidates(r.users, p.name);
  if (ranked.unique) {
    return {
      kind: 'id', id: ranked.unique.id, from: 'name', name: p.name, endpoint: r.endpoint,
      alternatives: ranked.candidates.filter((u) => u.id !== ranked.unique.id).slice(0, 5),
    };
  }
  return { kind: 'candidates', name: p.name, candidates: ranked.candidates.slice(0, 8), endpoint: r.endpoint };
}
