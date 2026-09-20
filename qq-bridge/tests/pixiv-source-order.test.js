// Pixiv 来源优先级（官方 app-api 优先，镜像站只做兜底）离线自测。
// 跑法：node tests/pixiv-source-order.test.js
//
// 为什么要有它（2026-09-20 主人要求"官方 pixiv API 优先，镜像站只做兜底"）：
//   来源顺序写错的后果**在线上完全看不出来** —— 镜像站也能给出正确的图，只是慢、还会偶发超时；
//   "有没有偷偷联系第三方"更是完全静默的（凭证泄露也就这么发生了）。
//   所以这里用假 fetch 记录**每一次请求的主机名与请求头**，把顺序、回退、凭证边界、归一化全钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_DIR = path.join(ROOT, 'state', '.tmp-pixiv-order-test');

// 环境变量必须在 import 之前设好：镜像站域名、令牌文件、画师缓存路径都是模块加载时读的。
process.env.QQBRIDGE_PIXIV_BASE = 'https://mirror.test.invalid';       // 明确的假域名，便于断言"没联系过镜像站"
process.env.QQBRIDGE_PIXIV_TOKEN_PATH = path.join(TMP_DIR, 'pixiv-token.json');
process.env.QQBRIDGE_PIXIV_CACHE_PATH = path.join(TMP_DIR, 'pixiv-artists.json');
delete process.env.QQBRIDGE_PIXIV_REFRESH_TOKEN;
delete process.env.QQBRIDGE_PIXIV_COOKIE;

fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
// 一份"还有一小时有效期"的 access_token：让 app-api 那条路可走，且**不需要任何刷新请求**。
fs.writeFileSync(process.env.QQBRIDGE_PIXIV_TOKEN_PATH, JSON.stringify({ v: 1, access_token: 'A-test-token', expires_at: Date.now() + 3600_000, refresh_token: '' }));

const { pixivSearch, pixivIllustDetail, pixivIllustOriginals, pixivUserWorkIds, resolvePixivAuthor, pixivBase } =
  await import('../src/lib/pixiv.js');

const MIRROR_HOST = new URL(pixivBase()).host;
const realFetch = globalThis.fetch;

/* ─────────────────────────── 假 fetch / 夹具 ─────────────────────────── */
let passed = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (e) { fails.push(`${name}\n       ${e?.message ?? e}`); console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); }
}

/** 记录每一次请求（URL/主机/请求头），并交给 route 决定回什么。 */
function stubFetch(route) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const call = { url: u.toString(), host: u.host, path: u.pathname, search: u.search, headers };
    calls.push(call);
    const r = await route(call);
    if (!r) throw new Error(`假 fetch 没有为这个请求准备响应：${call.host}${call.path}`);
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: () => null },
      text: async () => r.text ?? '',
      json: async () => JSON.parse(r.text ?? 'null'),
    };
  };
  return calls;
}
const hostsOf = (calls) => [...new Set(calls.map((c) => c.host))].sort();
const json = (obj, status = 200) => ({ status, text: JSON.stringify(obj) });

/** app-api 搜索行（snake_case + 嵌套 user/image_urls，与官方返回体一致）。 */
function appRow(id, extra = {}) {
  return {
    id,
    title: `作品${id}`,
    user: { id: '20401', name: '作者甲' },
    tags: [{ name: '初音ミク' }],
    image_urls: { square_medium: `https://i.pximg.net/c/540x540_70/img-master/img/2026/09/18/01/37/08/${id}_p0_square1200.jpg` },
    width: 1000, height: 1500, page_count: 1, illust_type: 0, x_restrict: 0, illust_ai_type: 1,
    create_date: '2026-09-18T12:00:00+09:00',
    ...extra,
  };
}
/** web ajax / 镜像站形状的一页。 */
function webPage(data, total = 3, lastPage = 3) {
  return json({ error: false, body: { illustManga: { data, total, lastPage } } });
}
const webRow = (id) => ({
  id: String(id), title: `网页作品${id}`, userName: '作者乙', userId: '30001',
  tags: ['初音ミク'], url: `https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/18/01/37/08/${id}_p0_square1200.jpg`,
  width: 800, height: 1200, pageCount: 1, illustType: 0, xRestrict: 0, aiType: 1,
  createDate: '2026-09-18T12:00:00+09:00',
});

/* ─────────────────────────── 一、app-api 成功：就用它，绝不碰镜像站 ─────────────────────────── */
console.log('\n一、官方 app-api 命中');
await t('搜索走 app-api：source 标明来源，www.pixiv.net 与镜像站一次都没被联系', async () => {
  const calls = stubFetch((c) => {
    if (c.host === 'app-api.pixiv.net' && c.path === '/v1/search/illust') {
      return json({ error: false, illusts: [appRow('111'), appRow('112', { illust_ai_type: 2 }), appRow('113', { x_restrict: undefined })], next_url: null });
    }
    throw new Error(`不该联系 ${c.host}`);
  });
  const r = await pixivSearch('初音ミク', { tags: ['初音ミク'], limit: 10, scanPages: 1 });
  assert.equal(r.source, 'app-api');
  assert.equal(r.scan.source, 'app-api');
  assert.deepEqual(r.sourcesTried, []);
  assert.deepEqual(hostsOf(calls), ['app-api.pixiv.net'], '除了 app-api 一个主机都不该碰');
  // 归一化：app-api 的 snake_case 行要变成和 web ajax 一样的形状，筛选才能照常工作
  assert.deepEqual(r.results.map((x) => x.id), ['111', '112']);
  assert.equal(r.results[0].author, '作者甲');
  assert.deepEqual(r.results[0].tags, ['初音ミク']);
  assert.equal(r.results[0].pages, 1);
  assert.match(r.results[0].thumbUrl, /111_p0_square1200\.jpg$/);
  // R-18 fail-closed：app-api 没给 x_restrict 的 113 必须被当 R-18 排掉（不能补 0）
  assert.equal(r.scan.dropped.adult, 1);
  assert.ok(!r.results.some((x) => x.id === '113'));
  // 凭证边界：app-api 用 Bearer，且绝不带 cookie
  const q = calls[0];
  assert.equal(q.headers.authorization, 'Bearer A-test-token');
  assert.equal(q.headers.cookie, undefined);
  assert.match(r.scanNotice, /数据来源 app-api/);
});
await t('旧路径（不传筛选参数）形状冻结，但同样优先走 app-api', async () => {
  const calls = stubFetch((c) => {
    if (c.path === '/v1/search/illust') return json({ error: false, illusts: [appRow('221'), appRow('222')], next_url: null });
    throw new Error(`不该联系 ${c.host}`);
  });
  const r = await pixivSearch('初音ミク', { limit: 8 });
  assert.deepEqual(Object.keys(r).sort(), ['filtered', 'lastPage', 'page', 'query', 'results', 'total'], '旧路径的键集合必须与改动前逐字段一致（不许冒出新字段）');
  assert.deepEqual(Object.keys(r.results[0]), ['id', 'title', 'author', 'tags', 'pages', 'width', 'height', 'pageUrl', 'thumbUrl', 'description']);
  assert.deepEqual(r.results.map((x) => x.id), ['221', '222']);
  assert.deepEqual(hostsOf(calls), ['app-api.pixiv.net']);
});

/* ─────────────────────────── 二、app-api 失败 → web ajax 顶上 ─────────────────────────── */
console.log('\n二、app-api 失败 → pixiv web ajax 顶上');
await t('app-api 400 → 用 web ajax 的数据，sourcesTried 记下失败原因，镜像站仍然没被联系', async () => {
  const calls = stubFetch((c) => {
    if (c.host === 'app-api.pixiv.net') return json({ error: true, message: 'invalid token' }, 400);
    if (c.host === 'www.pixiv.net' && c.path.startsWith('/ajax/search/artworks/')) return webPage([webRow(301), webRow(302)]);
    throw new Error(`不该联系 ${c.host}`);
  });
  const r = await pixivSearch('初音ミク', { tags: ['初音ミク'], limit: 10, scanPages: 1 });
  assert.equal(r.source, 'web-ajax');
  assert.deepEqual(r.results.map((x) => x.id), ['301', '302']);
  assert.equal(r.results[0].author, '作者乙');
  assert.equal(r.scan.total, 3);
  assert.equal(r.sourcesTried.length, 1);
  assert.match(r.sourcesTried[0], /^app-api: HTTP 400/);
  assert.deepEqual(hostsOf(calls), ['app-api.pixiv.net', 'www.pixiv.net']);
  assert.ok(!hostsOf(calls).includes(MIRROR_HOST), '官网 ajax 成了就不该再碰第三方镜像站');
  // web ajax 这条带上 cookie（有配的话），但绝不出 Bearer
  const webCall = calls.find((c) => c.host === 'www.pixiv.net');
  assert.equal(webCall.headers.authorization, undefined);
});

/* ─────────────────────────── 三、三家全失败 ─────────────────────────── */
console.log('\n三、三个来源全失败 → 如实报错，且镜像站拿不到任何凭证');
await t('错误文本列出三个来源各自的原话；镜像站请求不带 cookie / Bearer', async () => {
  const calls = stubFetch((c) => {
    if (c.host === 'app-api.pixiv.net') return json({ error: true, message: 'boom' }, 400);
    if (c.host === 'www.pixiv.net') return json({ error: true, message: '爆了' }, 500);
    if (c.host === MIRROR_HOST) return json({ error: false, body: { illustManga: null } }, 500);
    throw new Error(`不该联系 ${c.host}`);
  });
  let msg = '';
  try { await pixivSearch('初音ミク', { tags: ['初音ミク'], limit: 5, scanPages: 1 }); } catch (e) { msg = String(e?.message ?? e); }
  assert.match(msg, /^pixiv 搜索失败：三个来源都没给出结果 —— /);
  assert.match(msg, /app-api: HTTP 400/);
  assert.match(msg, /web-ajax: HTTP 500/);
  assert.match(msg, /mirror: (HTTP 500|返回了非预期形状)/);
  const mirrorCall = calls.find((c) => c.host === MIRROR_HOST);
  assert.ok(mirrorCall, '镜像站是最后一档兜底，必须试到');
  assert.equal(mirrorCall.headers.cookie, undefined, '第三方镜像站绝不能拿到 cookie');
  assert.equal(mirrorCall.headers.authorization, undefined, '第三方镜像站绝不能拿到 Bearer');
});

/* ─────────────────────────── 四、详情 / 原图 / 画师作品 / 找人 ─────────────────────────── */
console.log('\n四、详情与原图（app-api 的 meta_pages 优先）');
const DETAIL = {
  id: 111, title: '作品111', user: { id: '20401', name: '作者甲' }, caption: '说明文字',
  tags: [{ name: '初音ミク' }, { name: 'オリジナル' }],
  image_urls: {
    original: 'https://i.pximg.net/img-original/img/2026/09/18/01/37/08/111_p0.jpg',
    large: 'https://i.pximg.net/c/1200x1200/img-master/img/2026/09/18/01/37/08/111_p0_master1200.jpg',
    square_medium: 'https://i.pximg.net/c/540x540_70/img-master/img/2026/09/18/01/37/08/111_p0_square1200.jpg',
  },
  meta_pages: [
    { image_urls: { original: 'https://i.pximg.net/img-original/img/2026/09/18/01/37/08/111_p0.jpg' } },
    { image_urls: { original: 'https://i.pximg.net/img-original/img/2026/09/18/01/37/08/111_p1.png' } },
  ],
  width: 1000, height: 1500, page_count: 2, illust_type: 0, x_restrict: 0, illust_ai_type: 1,
  create_date: '2026-09-18T12:00:00+09:00',
};
await t('pixivIllustDetail 走 app-api，并带上 metaPages；pixivIllustOriginals 直接用 meta_pages（不再发请求）', async () => {
  const calls = stubFetch((c) => {
    if (c.path === '/v1/illust/detail') return json({ error: false, illust: DETAIL });
    throw new Error(`不该联系 ${c.host}${c.path}`);
  });
  const d = await pixivIllustDetail('111');
  assert.equal(d.source, 'app-api');
  assert.equal(d.title, '作品111');
  assert.equal(d.authorId, '20401');
  assert.equal(d.pageCount, 2);
  assert.deepEqual(d.tags, ['初音ミク', 'オリジナル']);
  assert.equal(d.adult, false);
  assert.deepEqual(d.metaPages, [DETAIL.meta_pages[0].image_urls.original, DETAIL.meta_pages[1].image_urls.original]);
  assert.equal(d.note, '', '首选来源成功时不该有失败备注');

  const before = calls.length;
  const op = await pixivIllustOriginals(d);
  assert.equal(op.source, 'app-api:meta_pages');
  assert.deepEqual(op.urls, d.metaPages);
  assert.equal(calls.length, before, '详情里已经有 meta_pages，不该再问一次 pages 接口');
});
await t('app-api 详情失败 → 回退 web ajax，并在 note 里说明为什么没用 app-api', async () => {
  const calls = stubFetch((c) => {
    if (c.host === 'app-api.pixiv.net') return json({ error: true, message: 'nope' }, 400);
    if (c.path === '/ajax/illust/222') return json({ error: false, body: { id: '222', title: '网页详情', userId: '9', userName: 'W', pageCount: 1, xRestrict: 0, tags: { tags: [{ tag: 'x' }] }, urls: {} } });
    throw new Error(`不该联系 ${c.host}${c.path}`);
  });
  const d = await pixivIllustDetail('222');
  assert.equal(d.source, 'web-ajax');
  assert.equal(d.title, '网页详情');
  assert.match(d.note, /^app-api: HTTP 400/);
  assert.deepEqual(d.metaPages, []);
  assert.deepEqual(hostsOf(calls), ['app-api.pixiv.net', 'www.pixiv.net']);
});

console.log('\n五、画师作品 / 按名字找画师');
await t('pixivUserWorkIds 走 app-api /v1/user/illusts，并按作品号倒序（新→旧）', async () => {
  const calls = stubFetch((c) => {
    if (c.path === '/v1/user/illusts') return json({ error: false, illusts: [{ id: 1001 }, { id: 1003 }, { id: 1002 }], next_url: null });
    throw new Error(`不该联系 ${c.host}${c.path}`);
  });
  const r = await pixivUserWorkIds('20401');
  assert.equal(r.source, 'app-api');
  assert.deepEqual(r.ids, ['1003', '1002', '1001']);
  assert.match(calls[0].search, /user_id=20401/);
  assert.deepEqual(hostsOf(calls), ['app-api.pixiv.net']);
});
await t('resolvePixivAuthor 用 app-api 的用户搜索自己定号（模型不该再问用户要画师号）', async () => {
  const NAME = `米山舞_order_test_${Date.now()}`;   // 名字带上时间戳，避开（也顺便证明）本地缓存
  const calls = stubFetch((c) => {
    if (c.path === '/v1/search/user') return json({ error: false, user_previews: [{ user: { id: '1554775', name: NAME }, illusts: [{ id: 1 }, { id: 2 }] }] });
    if (c.path === '/ajax/user/1554775/profile/all') return json({ error: false, body: { illusts: { 1: null, 2: null }, manga: {} } });
    throw new Error(`不该联系 ${c.host}${c.path}`);
  });
  const r = await resolvePixivAuthor(NAME);
  assert.equal(r.kind, 'id');
  assert.equal(r.id, '1554775');
  assert.equal(r.from, 'name');
  assert.match(r.endpoint, /app-api/);
  assert.deepEqual(hostsOf(calls), ['app-api.pixiv.net', 'www.pixiv.net']);
});

globalThis.fetch = realFetch;
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\n' + '─'.repeat(64));
if (fails.length === 0) console.log(`pixiv-source-order: 全部通过（${passed} 项）`);
else {
  console.error(`pixiv-source-order: 失败 ${fails.length} 项 / 通过 ${passed} 项`);
  for (const f of fails) console.error(`  · ${f}`);
  process.exitCode = 1;
}
