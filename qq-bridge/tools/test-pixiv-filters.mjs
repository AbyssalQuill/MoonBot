// pixiv.js 本地筛选 + 自动翻页的自测。
//
// 用法:
//   node tools/test-pixiv-filters.mjs          # 只跑离线用例（不联网：内联样例数据 + 假 fetch）
//   node tools/test-pixiv-filters.mjs --live   # 再真连一次镜像站，跑十几组筛选并打印实际条数（要能上网）
//
// 为什么要有这个文件：筛选/翻页都是"在别人返回的数据上自己筛"，一旦条件写歪（比如把 aiType 写成
// "!=0 就算 AI"）或者翻页没卡住 lastPage，模型那边只会看到"搜不到"，很难查。所以这里把每条规则的
// 边界都钉成断言，尤其是**"不传新参数时结果必须与改动前逐字段一致"**这条硬要求：
// 离线用例里内联复刻了一份旧算法（legacySearch），逐字段比对（含键的先后顺序）。
import {
  pixivSearch,
  normalizePixivFilters,
  filterPixivItems,
  pickPixivBase,
  pixivBase,
  pixivProxyUrl,
  PIXIV_SCAN_PAGES_DEFAULT,
  PIXIV_SCAN_PAGES_MAX,
} from '../src/lib/pixiv.js';

let pass = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); return true; }
  fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
  console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  return false;
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  return ok(name, g === w, `got=${g} want=${w}`);
}
const ids = (arr) => arr.map((x) => x.id);

/* ───────────────────── 内联样例数据（照抄镜像站真实形状） ─────────────────────
 * 键取自 2026-09-18 实测第 1 页 60 条的那 27 个键（aiType/bookmarkData/createDate/
 * illustType/xRestrict…）；字段语义与实测依据见 lib/pixiv.js 顶部注释。 */
function item(o) {
  const id = String(o.id);
  const it = {
    id,
    title: o.title ?? `作品 ${id}`,
    description: '',
    alt: '',
    illustType: o.illustType ?? 0,
    xRestrict: o.xRestrict ?? 0,
    restrict: 0,
    sl: 2,
    isOriginal: false,
    isMasked: false,
    isUnlisted: false,
    isBookmarkable: true,
    bookmarkData: null,
    visibilityScope: 0,
    profileImageUrl: 'https://i.pximg.net/user-profile/img/x.jpg',
    url: `https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/18/01/37/08/${id}_p0_square1200.jpg`,
    tags: o.tags ?? [],
    userId: String(o.userId ?? 1001),
    userName: o.userName ?? '作者A',
    width: o.width === undefined ? 1200 : o.width,
    height: o.height === undefined ? 1600 : o.height,
    pageCount: o.pageCount ?? 1,
    createDate: o.createDate ?? '2026-09-18T12:00:00+09:00',
    updateDate: '2026-09-18T12:00:00+09:00',
    aiType: o.aiType ?? 1,
    titleCaptionTranslation: { workTitle: null, workCaption: null },
    is_howto: false,
  };
  // xRestrictMissing：连键都没有（测 fail-closed），不能写 0 —— 0 是"全年龄"
  if (o.xRestrictMissing) delete it.xRestrict;
  return it;
}

/** 第 1 页样例：每种筛选的边界各摆一条（成人向 3 条：1004/1007/1010）。 */
const P1 = [
  // 0 普通竖图、单图、非 AI、名字带 VOCALOID（大小写匹配用）
  item({ id: 1001, tags: ['初音ミク', 'VOCALOID'], userName: 'HatsuneArtist', userId: 2001, width: 1200, height: 1600, createDate: '2026-09-10T10:00:00+09:00' }),
  // 1 横图、多图（pageCount=3）
  item({ id: 1002, tags: ['初音ミク', 'オリジナル'], userName: '作者B', userId: 2002, width: 2000, height: 1000, pageCount: 3, createDate: '2026-09-12T10:00:00+09:00' }),
  // 2 漫画（illustType=1）、正方
  item({ id: 1003, tags: ['初音ミク', '漫画'], userName: '作者A', userId: 1001, illustType: 1, width: 1000, height: 1000, pageCount: 2, createDate: '2026-09-11T10:00:00+09:00' }),
  // 3 R-18（xRestrict=1）
  item({ id: 1004, tags: ['初音ミク', 'R-18'], userName: '作者C', xRestrict: 1, width: 800, height: 1200, createDate: '2026-09-13T10:00:00+09:00' }),
  // 4 AI 作品（aiType=2，实测语义）
  item({ id: 1005, tags: ['初音ミク'], userName: '作者D', width: 500, height: 700, aiType: 2, createDate: '2026-09-09T10:00:00+09:00' }),
  // 5 动图（illustType=2，实测存在，既不算 illust 也不算 manga）
  item({ id: 1006, tags: ['初音ミク', '動画'], userName: '作者A', width: 600, height: 600, illustType: 2, createDate: '2026-09-14T10:00:00+09:00' }),
  // 6 R-18G（xRestrict=2）
  item({ id: 1007, tags: ['初音ミク', 'グロ'], userName: '作者E', xRestrict: 2, width: 1200, height: 1600, createDate: '2026-09-15T10:00:00+09:00' }),
  // 7 正方大图、多图（pageCount=5）
  item({ id: 1008, tags: ['初音ミク', '公式'], userName: '作者A', width: 1500, height: 1500, pageCount: 5, createDate: '2026-09-16T10:00:00+09:00' }),
  // 8 尺寸缺失（width/height=0）
  item({ id: 1009, tags: ['初音ミク'], userName: '作者F', width: 0, height: 0, createDate: '2026-09-17T10:00:00+09:00' }),
  // 9 xRestrict 键缺失 → fail-closed 当 R-18（旧逻辑 Number(undefined)!==0 就是 true）
  item({ id: 1010, tags: ['初音ミク'], userName: '作者X', xRestrictMissing: true, createDate: '2026-09-08T10:00:00+09:00' }),
  // 10 aiType=1 但打了 AI 标签 → 靠标签兜底当成 AI
  item({ id: 1011, tags: ['初音ミク', 'AIイラスト'], userName: '作者G', pageCount: 4, createDate: '2026-09-07T10:00:00+09:00' }),
  // 11 标签里含小写 'ai' 但不是 AI 作品（'Maid' 这类误伤检查）
  item({ id: 1012, tags: ['初音ミク', 'Maid'], userName: '作者H', createDate: '2026-09-06T10:00:00+09:00' }),
];
/** P1 里会被 R-18 规则丢掉的 3 条（1004 xRestrict=1、1007 xRestrict=2、1010 xRestrict 缺失）。 */
const ADULT_IDS = ['1004', '1007', '1010'];

/** 造一页"只有前 hits 条带『命中』标签"的数据（翻页用例：让第 1 页凑不够 limit）。 */
function starvedPage(base, hits) {
  return Array.from({ length: 30 }, (_, i) => item({
    id: base + i,
    tags: i < hits ? ['初音ミク', '命中'] : ['初音ミク'],
    createDate: `2026-09-${String(10 + (i % 9)).padStart(2, '0')}T10:00:00+09:00`,
  }));
}

const TOTAL = 618930;
/** 假 fetch：把 search.php 的请求映射到内存页数据；可指定某几页抛错（测中途失败）。 */
function fakeFetch(pages, { lastPage = 10, total = TOTAL, failPages = [], onCall = null } = {}) {
  return async (url) => {
    const u = new URL(String(url));
    if (!u.pathname.endsWith('/api/search.php')) throw new Error(`假 fetch 只认 search.php，收到 ${u.pathname}`);
    const p = Number(u.searchParams.get('page')) || 1;
    if (onCall) onCall(p, u.searchParams.get('keyword'));
    if (failPages.includes(p)) throw new Error(`模拟抓取失败 page=${p}`);
    const data = pages[p] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ error: false, body: { illustManga: { data, total, lastPage, bookmarkRanges: [] } } }),
    };
  };
}

/** 旧算法（改动前的 pixivSearch）—— 逐字复刻，用来证明"不传新参数时结果一致"。 */
function legacySearch(data, q, page, limit, total, lastPage) {
  const isAdult = (it) => {
    if (Number(it?.xRestrict) !== 0) return true;
    const tags = Array.isArray(it?.tags) ? it.tags.join(' ') : '';
    return /r-?18|r18|エロ|グロ|成人|18禁/i.test(tags);
  };
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
    pageUrl: `https://www.pixiv.net/artworks/${String(it.id).trim()}`,
    thumbUrl: String(it.url ?? '').trim(),
    description: String(it.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
  return { query: q, page, total, lastPage, filtered, results };
}

const realFetch = globalThis.fetch;
let mode = '';

async function offline() {
  console.log('\n══════ 一、不传任何新参数：必须与改动前逐字段一致（硬要求）══════');
  globalThis.fetch = fakeFetch({ 1: P1 }, { lastPage: 3 });
  const legacy = legacySearch(P1, '初音ミク', 1, 8, TOTAL, 3);
  const now = await pixivSearch('初音ミク', { page: 1, limit: 8 });
  eq('返回值键集合完全一致（不多出 scan/scanNotice）', Object.keys(now).sort(), Object.keys(legacy).sort());
  eq('整体逐字段一致（含 results 内每个字段与顺序）', now, legacy);
  eq('results 每条的键与旧版一致', Object.keys(now.results[0]), [
    'id', 'title', 'author', 'tags', 'pages', 'width', 'height', 'pageUrl', 'thumbUrl', 'description',
  ]);
  eq('filtered = 被 R-18 规则丢掉的条数（1004/1007/1010 共 3 条）', now.filtered, 3);
  const onlyOld = await pixivSearch('初音ミク', { page: 1, limit: 3 });
  eq('只传 page/limit（旧参数）仍走旧路径', onlyOld, legacySearch(P1, '初音ミク', 1, 3, TOTAL, 3));
  const nullish = await pixivSearch('初音ミク', { limit: 8, r18: null, tags: undefined, sort: null, scanPages: null });
  eq('新参数传 null/undefined 视为没给（仍走旧路径）', Object.keys(nullish).sort(), Object.keys(legacy).sort());

  console.log('\n══════ 二、r18 三种取值 ══════');
  const ex = await pixivSearch('初音ミク', { limit: 20, r18: 'exclude', scanPages: 1 });
  ok('exclude：R-18/R-18G/xRestrict 缺失的都不在结果里', ids(ex.results).every((id) => !ADULT_IDS.includes(id)), ids(ex.results).join(','));
  const only = await pixivSearch('初音ミク', { limit: 20, r18: 'only', scanPages: 1 });
  eq('only：只剩 R-18 规则命中的 3 条', ids(only.results).sort(), ['1004', '1007', '1010']);
  const inc = await pixivSearch('初音ミク', { limit: 20, r18: 'include', scanPages: 1 });
  ok('include：R-18 也一起进来', ids(inc.results).includes('1004') && ids(inc.results).includes('1007'));
  eq('include：全 12 条都在', inc.results.length, 12);
  const badR18 = await pixivSearch('初音ミク', { r18: 'r18', limit: 20, scanPages: 1 });
  eq('非法 r18 取值回落 exclude（绝不放行 R-18）', badR18.scan.r18, 'exclude');
  ok('非法 r18 取值有警告（写清回落到 exclude），且结果里没有 R-18', badR18.scan.warnings.some((w) => /exclude/.test(w)) && ids(badR18.results).every((id) => !ADULT_IDS.includes(id)), badR18.scan.warnings.join(''));

  console.log('\n══════ 三、tags（全部命中 + 大小写不敏感 + 子串）══════');
  eq('两个标签全命中（vocaloid ↔ VOCALOID）', ids((await pixivSearch('初音ミク', { tags: ['初音ミク', 'vocaloid'], limit: 20, scanPages: 1 })).results), ['1001']);
  eq('第二个标签没中就不算', ids((await pixivSearch('初音ミク', { tags: ['初音ミク', 'オリジナル'], limit: 20, scanPages: 1 })).results), ['1002']);
  ok('标签子串匹配（"ミク" 命中所有含它的）', (await pixivSearch('初音ミク', { tags: ['ミク'], limit: 20, scanPages: 1 })).results.length > 1);
  ok('tags 传字符串 → 按逗号/空格拆开并给提示', /拆成数组/.test((await pixivSearch('初音ミク', { tags: '漫画, 初音', limit: 20, scanPages: 1 })).scan.warnings.join('')));

  console.log('\n══════ 四、author（名字子串 / 纯数字=作者ID）══════');
  eq('author 名字子串 + 大小写不敏感', ids((await pixivSearch('初音ミク', { author: 'hatsuneartist', limit: 20, scanPages: 1 })).results), ['1001']);
  eq('author 纯数字 = 作者 ID 精确匹配', ids((await pixivSearch('初音ミク', { author: '2002', limit: 20, scanPages: 1 })).results), ['1002']);
  eq('author 名字命中多条', ids((await pixivSearch('初音ミク', { author: '作者A', limit: 20, scanPages: 1 })).results).sort(), ['1003', '1006', '1008']);

  console.log('\n══════ 五、orientation / minWidth / minHeight ══════');
  const po = await pixivSearch('初音ミク', { orientation: 'portrait', limit: 20, scanPages: 1 });
  ok('portrait：高>宽；尺寸缺失的 1009 不算命中', ids(po.results).includes('1001') && !ids(po.results).includes('1009'), ids(po.results).join(','));
  eq('landscape：只有 1002', ids((await pixivSearch('初音ミク', { orientation: 'landscape', limit: 20, scanPages: 1 })).results), ['1002']);
  eq('square：1003/1006/1008', ids((await pixivSearch('初音ミク', { orientation: 'square', limit: 20, scanPages: 1 })).results).sort(), ['1003', '1006', '1008']);
  eq('minWidth=1500', ids((await pixivSearch('初音ミク', { minWidth: 1500, limit: 20, scanPages: 1 })).results).sort(), ['1002', '1008']);
  eq('minWidth+minHeight 同时生效', ids((await pixivSearch('初音ミク', { minWidth: 1000, minHeight: 1500, limit: 20, scanPages: 1 })).results).sort(), ['1001', '1008', '1011', '1012']);

  console.log('\n══════ 六、multiPage / excludeAi / illustType ══════');
  eq('multiPage：pageCount>1 的 1002/1003/1008/1011', ids((await pixivSearch('初音ミク', { multiPage: true, limit: 20, scanPages: 1 })).results).sort(), ['1002', '1003', '1008', '1011']);
  const noAi = await pixivSearch('初音ミク', { excludeAi: true, limit: 20, scanPages: 1 });
  ok('excludeAi：aiType=2 的 1005 与 AI 标签的 1011 都排掉', !ids(noAi.results).includes('1005') && !ids(noAi.results).includes('1011'), ids(noAi.results).join(','));
  ok('excludeAi：标签里只是含 "ai" 的 Maid(1012) 不误伤', ids(noAi.results).includes('1012'));
  eq('excludeAi：统计 ai=2', noAi.scan.dropped.ai, 2);
  eq('illustType=illust：只要 illustType=0', ids((await pixivSearch('初音ミク', { illustType: 'illust', limit: 20, scanPages: 1 })).results).sort(), ['1001', '1002', '1005', '1008', '1009', '1011', '1012']);
  eq('illustType=manga：只有 1003', ids((await pixivSearch('初音ミク', { illustType: 'manga', limit: 20, scanPages: 1 })).results), ['1003']);
  ok('illustType=2（动图 ugoira）两个取值都不收', !ids((await pixivSearch('初音ミク', { illustType: 'illust', limit: 20, scanPages: 1 })).results).includes('1006'));

  console.log('\n══════ 七、sort（只支持投稿时间，不支持人气/收藏）══════');
  const dd = await pixivSearch('初音ミク', { sort: 'date_desc', limit: 20, scanPages: 1 });
  eq('date_desc：createDate 从新到旧', ids(dd.results).slice(0, 4), ['1009', '1008', '1006', '1002']);
  eq('date_asc：createDate 从旧到新', ids((await pixivSearch('初音ミク', { sort: 'date_asc', limit: 20, scanPages: 1 })).results).slice(0, 4), ['1012', '1011', '1005', '1001']);
  eq('random：成员集合与 date_desc 相同（只是顺序不同）', ids((await pixivSearch('初音ミク', { sort: 'random', limit: 20, scanPages: 1 })).results).sort(), ids(dd.results).sort());
  const pop = await pixivSearch('初音ミク', { sort: 'popular', limit: 20, scanPages: 1 });
  eq('sort=popular 回落 date_desc', pop.scan.sort, 'date_desc');
  ok('sort=popular 的警告明确写"没有收藏数"', /收藏数/.test(pop.scan.warnings.join('')), pop.scan.warnings.join(''));
  ok('sort=hot 同样被明确拒绝', /收藏数/.test((await pixivSearch('初音ミク', { sort: 'hot', limit: 20, scanPages: 1 })).scan.warnings.join('')));

  console.log('\n══════ 八、scanPages：自动翻页 / 上限 / 到底了 ══════');
  globalThis.fetch = fakeFetch({ 1: starvedPage(900001, 2), 2: starvedPage(900101, 3), 3: starvedPage(900201, 8) }, { lastPage: 3 });
  const s1 = await pixivSearch('初音ミク', { tags: ['命中'], limit: 5, scanPages: 3 });
  eq('第 1 页只有 2 条 → 自动翻到第 2 页凑够 5 条', s1.scan.pagesScanned, 2);
  eq('如实报出扫过的页范围', [s1.scan.fromPage, s1.scan.toPage], [1, 2]);
  eq('reachedLimit=true', s1.scan.reachedLimit, true);
  eq('原始条数 = 2 页 × 30', s1.scan.rawScanned, 60);
  eq('返回 limit 条', s1.results.length, 5);
  ok('scanNotice 写清扫了几页 / 全站多少条 / 不是全站筛选', /扫了第 1~2 页共 2 页/.test(s1.scanNotice) && /全站共 \d+ 条/.test(s1.scanNotice) && /不是全站筛选结果/.test(s1.scanNotice), s1.scanNotice);

  const s2 = await pixivSearch('初音ミク', { tags: ['命中'], limit: 8, scanPages: 2 });
  eq('scanPages=2：翻到第 2 页就停（即使还不够）', s2.scan.pagesScanned, 2);
  eq('不够 limit → reachedLimit=false', s2.scan.reachedLimit, false);
  ok('scanNotice 的末句写清"扫满上限仍未凑够、可以调大 scanPages"', /扫满 2 页上限仍未凑够 limit/.test(s2.scanNotice) && /scanPages/.test(s2.scanNotice), s2.scanNotice);

  const s3 = await pixivSearch('初音ミク', { tags: ['命中'], limit: 50, scanPages: 10 });
  eq('扫到 lastPage(3) 就停，不去扫越界页', s3.scan.pagesScanned, 3);
  eq('exhausted=true', s3.scan.exhausted, true);
  eq('命中 2+3+8=13 条', s3.results.length, 13);

  globalThis.fetch = fakeFetch({ 1: starvedPage(900001, 1) }, { lastPage: 10 });
  const s4 = await pixivSearch('初音ミク', { tags: ['命中'], limit: 5, scanPages: 99 });
  eq('scanPages 超过上限被夹到 10', s4.scan.scanPagesLimit, PIXIV_SCAN_PAGES_MAX);
  eq('夹到 10 后确实扫了 10 页（空页也算扫过）', s4.scan.pagesScanned, 10);
  eq('scanPages 默认值 = 3', PIXIV_SCAN_PAGES_DEFAULT, 3);
  eq('不传 scanPages → 用默认 3', (await pixivSearch('初音ミク', { tags: ['命中'], limit: 5 })).scan.scanPagesLimit, PIXIV_SCAN_PAGES_DEFAULT);
  eq('page=2 起始：从第 2 页往后扫', [(await pixivSearch('初音ミク', { tags: ['命中'], page: 2, limit: 5, scanPages: 2 })).scan.fromPage, (await pixivSearch('初音ミク', { tags: ['命中'], page: 2, limit: 5, scanPages: 2 })).scan.toPage], [2, 3]);

  console.log('\n══════ 九、跨页去重 / 中途抓取失败 ══════');
  const dupPage = starvedPage(900501, 10);
  globalThis.fetch = fakeFetch({ 1: dupPage, 2: dupPage }, { lastPage: 5 });
  const d1 = await pixivSearch('初音ミク', { tags: ['命中'], limit: 20, scanPages: 2 });
  eq('同一批作品出现在两页 → 结果里 id 不重复', ids(d1.results).length, new Set(ids(d1.results)).size);
  eq('命中 10 条（第二页 30 条全判重）', d1.results.length, 10);
  eq('重复项计入 dropped.duplicate', d1.scan.dropped.duplicate, 10);

  globalThis.fetch = fakeFetch({ 1: starvedPage(900001, 1), 2: starvedPage(900101, 5), 3: starvedPage(900201, 5) }, { lastPage: 5, failPages: [2] });
  const f1 = await pixivSearch('初音ミク', { tags: ['命中'], limit: 5, scanPages: 3 });
  eq('第 2 页抓失败：停在那里，但第 1 页的收获不丢', f1.scan.pagesScanned, 1);
  eq('第 1 页那 1 条还在', f1.results.length, 1);
  ok('警告里写清哪一页失败', /第 2 页抓取失败/.test(f1.scan.warnings.join('')), f1.scan.warnings.join(''));

  globalThis.fetch = fakeFetch({ 1: P1 }, { lastPage: 10, failPages: [1] });
  let threw = '';
  try { await pixivSearch('初音ミク', { tags: ['初音ミク'] }); } catch (e) { threw = String(e?.message ?? e); }
  ok('第 1 页就抓失败 → 照旧抛错（不拿空结果骗模型）', /pixiv 搜索失败/.test(threw), threw);

  console.log('\n══════ 十、非法入参：不崩、不给危险默认、有警告 ══════');
  globalThis.fetch = fakeFetch({ 1: P1 }, { lastPage: 10 });
  const bad1 = await pixivSearch('初音ミク', { tags: 123, limit: 5, scanPages: 1 });
  ok('tags=数字：不崩、忽略该项、有警告', bad1.scan.filters.tags.length === 0 && bad1.scan.warnings.length >= 1);
  const bad2 = await pixivSearch('初音ミク', { minWidth: 'abc', minHeight: -5, limit: 5, scanPages: 1 });
  eq('minWidth/minHeight 非正数 → 忽略', [bad2.scan.filters.minWidth, bad2.scan.filters.minHeight], [null, null]);
  eq('两条非法尺寸各有警告', bad2.scan.warnings.length, 2);
  const bad3 = await pixivSearch('初音ミク', { orientation: 'wide', illustType: 'anime', multiPage: 'yes', excludeAi: 1, limit: 5, scanPages: 1 });
  eq('orientation/illustType/multiPage/excludeAi 非法值一律忽略', [
    bad3.scan.filters.orientation, bad3.scan.filters.illustType, bad3.scan.filters.multiPage, bad3.scan.filters.excludeAi,
  ], ['', '', false, false]);
  eq('四项非法值 → 四条警告', bad3.scan.warnings.length, 4);
  eq('scanPages=0 回落默认 3', (await pixivSearch('初音ミク', { scanPages: 0, limit: 5 })).scan.scanPagesLimit, PIXIV_SCAN_PAGES_DEFAULT);
  eq('scanPages 非数字回落默认 3', (await pixivSearch('初音ミク', { scanPages: 'x', limit: 5 })).scan.scanPagesLimit, PIXIV_SCAN_PAGES_DEFAULT);
  const bad6 = await pixivSearch('初音ミク', { page: 'abc', limit: 'xyz', scanPages: 1, tags: ['初音ミク'] });
  eq('page/limit 垃圾值 → 旧默认（1 / 8）', [bad6.page, bad6.results.length], [1, 8]);
  eq('limit=999 仍夹在 20 以内（命中 9 条就 9 条）', (await pixivSearch('初音ミク', { limit: 999, tags: ['初音ミク'], scanPages: 1 })).results.length, 9);
  const bad8 = await pixivSearch('初音ミク', { filter: 'whatever', unknownKey: 1, limit: 5 });
  eq('不认识的键不影响"用没用新参数"（仍走旧路径）', Object.keys(bad8).sort(), Object.keys(legacySearch(P1, '初音ミク', 1, 5, TOTAL, 10)).sort());
  let emptyThrew = '';
  try { await pixivSearch('   '); } catch (e) { emptyThrew = String(e?.message ?? e); }
  eq('空搜索词照旧抛错', emptyThrew, '搜索词不能为空');

  console.log('\n══════ 十一、纯函数直测（不经过 fetch）══════');
  eq('没给新参数 → engaged=false', normalizePixivFilters({}).engaged, false);
  eq('给的只是旧参数（page/limit）→ engaged=false', normalizePixivFilters({ page: 2, limit: 5 }).engaged, false);
  eq('给了任一新参数（哪怕值是 false）→ engaged=true', normalizePixivFilters({ multiPage: false }).engaged, true);
  eq('默认 r18=exclude、默认排序 date_desc、默认扫 3 页', [
    normalizePixivFilters({ tags: ['a'] }).r18, normalizePixivFilters({ tags: ['a'] }).sort, normalizePixivFilters({ tags: ['a'] }).scanPages,
  ], ['exclude', 'date_desc', PIXIV_SCAN_PAGES_DEFAULT]);
  const seen = new Set();
  const fr = filterPixivItems(P1, normalizePixivFilters({ tags: ['初音ミク'], scanPages: 1 }), seen);
  eq('filterPixivItems：R-18 规则丢 3 条（含 xRestrict 缺失的 fail-closed）', fr.dropped.adult, 3);
  eq('filterPixivItems：命中的 id 记进 seenIds（跨页去重用）', seen.size, fr.items.length);
  eq('同一批数据再过一遍 → 全判为重复', filterPixivItems(P1, normalizePixivFilters({ tags: ['初音ミク'], scanPages: 1 }), seen).items.length, 0);

  console.log('\n══════ 十二、镜像站地址（打包给别人也要能改）══════');
  eq('pickPixivBase：config.json 优先于环境变量，尾部斜杠去掉',
    pickPixivBase({ configBase: 'https://mirror.example/', envBase: 'https://env.example' }), 'https://mirror.example');
  eq('pickPixivBase：没配 config 时用环境变量', pickPixivBase({ envBase: 'https://env.example' }), 'https://env.example');
  eq('pickPixivBase：都没配 → 内置默认', pickPixivBase({}), 'https://x.pixigraph.xyz');
  eq('pickPixivBase：非法值一律忽略', pickPixivBase({ configBase: 'not-a-url', envBase: 'ftp://x' }), 'https://x.pixigraph.xyz');
  const before = process.env.QQBRIDGE_PIXIV_BASE;
  process.env.QQBRIDGE_PIXIV_BASE = 'https://env-only.example/';
  eq('环境变量能改实际生效地址', pixivBase(), 'https://env-only.example');
  ok('代理地址跟着 BASE 走', pixivProxyUrl('https://i.pximg.net/x.jpg').startsWith('https://env-only.example/api/image.php?url='), pixivProxyUrl('https://i.pximg.net/x.jpg'));
  if (before === undefined) delete process.env.QQBRIDGE_PIXIV_BASE; else process.env.QQBRIDGE_PIXIV_BASE = before;
  ok('默认地址可用（config.json 没配 pixiv.base 时）', /^https:\/\//.test(pixivBase()), pixivBase());

  // 用完必须把真 fetch 装回去：否则下面 --live 的"联网实跑"会继续吃假数据（第一版就踩了这个坑，
  // 明明在跑真搜索，打印出来的却全是内联样例的 id 1001/1002…）。
  globalThis.fetch = realFetch;
}

/* ───────────────────── 联网实跑（--live）：只打印真实数字，不编 ───────────────────── */
async function live() {
  console.log('\n══════ 十三、联网实跑（真镜像站）══════');
  globalThis.fetch = realFetch; // 双保险：确保走真网络（离线段落收尾已还原一次）
  console.log(`镜像站 = ${pixivBase()}`);
  const KW = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '初音ミク';
  console.log(`关键词 = ${KW}`);
  const cases = [
    ['旧行为（不传新参数）', { page: 1, limit: 8 }],
    ['tags=[初音ミク]', { tags: ['初音ミク'], limit: 8 }],
    ['tags=[初音ミク,VOCALOID]', { tags: ['初音ミク', 'VOCALOID'], limit: 8 }],
    ['excludeAi', { excludeAi: true, limit: 8 }],
    ['multiPage', { multiPage: true, limit: 5 }],
    ['orientation=landscape', { orientation: 'landscape', limit: 5 }],
    ['orientation=portrait', { orientation: 'portrait', limit: 5 }],
    ['illustType=manga', { illustType: 'manga', limit: 5 }],
    ['minWidth=2500', { minWidth: 2500, limit: 5, scanPages: 5 }],
    ['minWidth=4000（更严，多翻几页）', { minWidth: 4000, limit: 5, scanPages: 8 }],
    ['sort=random', { sort: 'random', limit: 5 }],
    ['sort=date_asc', { sort: 'date_asc', limit: 5 }],
    ['r18=only', { r18: 'only', limit: 5 }],
    ['r18=include', { r18: 'include', limit: 5 }],
    ['sort=popular（不支持，应回落并警告）', { sort: 'popular', limit: 5 }],
    ['非法组合 orientation=wide + scanPages=0', { orientation: 'wide', scanPages: 0, limit: 5 }],
  ];
  for (const [name, opts] of cases) {
    try {
      const r = await pixivSearch(KW, opts);
      const first = r.results[0];
      // 防呆：内联样例的 id 是 1001~1012，真 pixiv 作品号都是 6 位数以上。
      // 第一版这里踩过坑（离线段落的假 fetch 没还原，联网段落其实在吃样例数据），加这条断言挡住。
      if (r.results.some((x) => Number(x.id) < 100000)) {
        fails.push(`联网用例「${name}」拿到的不是真实数据（id=${ids(r.results).join(',')}）`);
        console.log(`  ❌ ${name} —— 返回的 id 不像真作品号：${ids(r.results).join(',')}`);
        continue;
      }
      console.log(`  · ${name}\n      返回 ${r.results.length} 条${first ? `，首条 id=${first.id}（${first.width}x${first.height}，${first.pages}图，tags=${JSON.stringify(first.tags.slice(0, 4))}）` : '（空）'}`);
      if (r.scan) {
        const d = r.scan.dropped;
        console.log(`      扫 ${r.scan.pagesScanned} 页(${r.scan.fromPage}~${r.scan.toPage}) / 上限 ${r.scan.scanPagesLimit} / lastPage ${r.scan.lastPage} / total ${r.scan.total}；原始 ${r.scan.rawScanned} 条，命中 ${r.scan.kept}；丢弃 R18=${d.adult} 标签=${d.tag} 作者=${d.author} 构图=${d.orientation} 尺寸=${d.minWidth + d.minHeight} 多图=${d.multiPage} AI=${d.ai} 类型=${d.illustType} 重复=${d.duplicate}`);
        if (r.scan.warnings.length) console.log(`      ⚠ ${r.scan.warnings.join(' | ')}`);
        console.log(`      ${r.scanNotice}`);
      } else {
        console.log('      （旧路径：只抓 1 页、无 scan 字段 —— 与改动前一致）');
      }
    } catch (e) {
      fails.push(`联网用例「${name}」：${e?.message ?? e}`);
      console.log(`  ❌ ${name} —— ${e?.message ?? e}`);
    }
  }

  // 顺带看一条实现假设：镜像站自己就是按 createDate 倒序返回的吗？（旧路径不排序要站得住脚）
  try {
    const plain = await pixivSearch(KW, { limit: 20 });
    const sorted = await pixivSearch(KW, { sort: 'date_desc', limit: 20 });
    const sameOrder = JSON.stringify(ids(plain.results)) === JSON.stringify(ids(sorted.results));
    const nums = ids(plain.results).map(Number);
    const desc = nums.every((v, i) => i === 0 || nums[i - 1] > v);
    console.log(`  · 旧路径 vs sort=date_desc：id 顺序${sameOrder ? '一致' : '不一致'}；旧路径 id 严格递减=${desc}`);
    console.log(`      旧路径首条 ${ids(plain.results)[0]} / 末条 ${ids(plain.results).at(-1)}`);
  } catch (e) {
    console.log(`  ⚠ 旧路径对比失败：${e?.message ?? e}`);
  }
}

try {
  mode = process.argv.includes('--live') ? 'offline+live' : 'offline';
  console.log(`pixiv 本地筛选自测（${mode}）`);
  await offline();
  if (process.argv.includes('--live')) await live();
} catch (e) {
  fails.push(`用例本身崩了：${e?.stack ?? e}`);
  console.error(e);
} finally {
  globalThis.fetch = realFetch;
}

console.log('\n' + '─'.repeat(64));
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言。${mode === 'offline' ? '（离线，不联网）' : '（含联网实跑）'}`);
  process.exit(0);
}
console.log(`❌ 失败 ${fails.length} 项 / 通过 ${pass} 项：`);
for (const f of fails) console.log(`  · ${f}`);
process.exit(1);
