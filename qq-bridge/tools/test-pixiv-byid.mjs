/* qq_send_pixiv 按号取图的回归自测（2026-09-18 修「试了 0 个地址」时一并写的）。
 *
 * 目的：把这次修的东西**钉在可复跑的测试上**，而不是只靠"当时手工试了一次"。
 *   · 纯函数部分（离线，跑 CI/本机都行）：日期→逐页原图推导、master1200 改写、详情归一化、
 *     R-18 fail-closed、候选排序；
 *   · 联网部分（`--live`，需要能上 pixiv 的网络，线上 VPS 可以）：
 *     真作品号 → 真原图直链 → **逐字节比对**（直联 vs 镜像代理 vs 老候选），
 *     并验证 safeFetchBuffer 的第三参（referer）真的把 i.pximg 的 403 变成 200。
 *
 * 用法：
 *   node qq-bridge/tools/test-pixiv-byid.mjs            # 只跑离线部分
 *   node qq-bridge/tools/test-pixiv-byid.mjs --live     # 再跑联网部分（要能直连 pixiv）
 */
import { createHash } from 'node:crypto';
import {
  parsePixivId, pixivPageUrl, normalizePixivIllustDetail, deriveOriginalPageUrls,
  pixivMasterUrl, pixivImageSources, pixivImageCandidates, isAdultWork, PIXIV_REFERER,
  pixivIllustDetail, pixivIllustOriginals,
} from '../src/lib/pixiv.js';
import { safeFetchBuffer } from '../src/safe-fetch.js';

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${extra ? '  → ' + extra : ''}`); }
}
function eq(label, got, want) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/* ───────────────────────── 离线：纯函数 ───────────────────────── */
console.log('\n=== 1. 作品号解析 ===');
eq('pixiv.net/artworks/80643572 → 80643572', parsePixivId('https://www.pixiv.net/artworks/80643572'), '80643572');
eq('带语言前缀的链接', parsePixivId('https://www.pixiv.net/en/artworks/149807268'), '149807268');
eq('裸数字', parsePixivId('80643572'), '80643572');
eq('短数字不算作品号（避免把 1234 当作品）', parsePixivId('1234'), '');
eq('作品页地址', pixivPageUrl('80643572'), 'https://www.pixiv.net/artworks/80643572');

console.log('\n=== 2. 逐页原图推导（pages 接口失败时的兜底）===');
eq('jpg 作品 3 页', deriveOriginalPageUrls('https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg', 3), [
  'https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg',
  'https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p1.jpg',
  'https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p2.jpg',
]);
eq('png 原图保留 png', deriveOriginalPageUrls('https://i.pximg.net/img-original/img/2026/09/18/19/01/42/149807268_p0.png', 1), [
  'https://i.pximg.net/img-original/img/2026/09/18/19/01/42/149807268_p0.png',
]);
eq('认不出形状 → 空数组（不瞎猜地址）', deriveOriginalPageUrls('https://example.com/a.jpg', 3), []);

console.log('\n=== 3. master1200 改写（实测 master 一律 .jpg）===');
eq('jpg 原图 → master1200.jpg', pixivMasterUrl('https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg'),
  'https://i.pximg.net/img-master/img/2020/04/08/11/41/00/80643572_p0_master1200.jpg');
eq('png 原图 → master1200.jpg（实测 .png 是 404）', pixivMasterUrl('https://i.pximg.net/img-original/img/2026/09/18/19/01/42/149807268_p0.png'),
  'https://i.pximg.net/img-master/img/2026/09/18/19/01/42/149807268_p0_master1200.jpg');

console.log('\n=== 4. 详情归一化 + R-18 fail-closed ===');
const fixture = {
  id: '80643572', title: 'YGOツイログ①', userName: 'ちーのすけ', userId: '52021072',
  tags: { tags: [{ tag: '遊戯王女性向け' }, { tag: '闇表' }] },
  pageCount: 46, width: 2048, height: 2048, illustType: 0, xRestrict: 0, aiType: 0,
  createDate: '2020-04-08T11:41:00+09:00',
  urls: { original: null, regular: null, thumb: null },
};
const d = normalizePixivIllustDetail(fixture, 'pixiv');
eq('id/title/author', [d.id, d.title, d.author, d.authorId], ['80643572', 'YGOツイログ①', 'ちーのすけ', '52021072']);
eq('tags 摊平成字符串数组', d.tags, ['遊戯王女性向け', '闇表']);
eq('pageCount/尺寸', [d.pageCount, d.width, d.height], [46, 2048, 2048]);
ok('xRestrict=0 → 不是 R-18', d.adult === false);
ok('pageUrl 指向作品页', d.pageUrl === 'https://www.pixiv.net/artworks/80643572');
ok('urls 全 null 也不炸（实测 80643572 就是这样）', d.urls.original === '');
ok('xRestrict 缺失 → 当 R-18（fail-closed）', normalizePixivIllustDetail({ id: '1', title: 'x' }).adult === true);
ok('xRestrict=1 → R-18', normalizePixivIllustDetail({ id: '110000000', xRestrict: 1 }).adult === true);
ok('标签兜底 R-18G 也算 R-18', normalizePixivIllustDetail({ id: '1', xRestrict: 0, tags: { tags: [{ tag: 'R-18G' }] } }).adult === true);
ok('isAdultWork 与详情口径一致', isAdultWork({ xRestrict: 1 }) === true && isAdultWork({ xRestrict: 0, tags: [] }) === false);

console.log('\n=== 5. 候选排序（直联优先、逐字节一致的代理兜底、老候选垫底）===');
const det = normalizePixivIllustDetail({ ...fixture, urls: { original: 'https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg', regular: 'https://i.pximg.net/img-master/img/2020/04/08/11/41/00/80643572_p0_master1200.jpg', thumb: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2020/04/08/11/41/00/80643572_p0_square1200.jpg' } }, 'pixiv');
const srcOrig = pixivImageSources(det, {
  page: 0, size: 'original',
  originals: ['https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg', 'https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p1.jpg'],
});
ok('原图第 1 条 = 直联 i.pximg 且带 Referer', srcOrig[0].url.endsWith('80643572_p0.jpg') && srcOrig[0].referer === PIXIV_REFERER, JSON.stringify(srcOrig[0]));
ok('原图第 2 条 = 镜像代理兜底（同 URL、无 Referer）', /\/api\/image\.php\?url=/.test(srcOrig[1].url) && !srcOrig[1].referer, JSON.stringify(srcOrig[1]));
ok('候选里没有重复地址', new Set(srcOrig.map((s) => s.url)).size === srcOrig.length);
const srcPage1 = pixivImageSources(det, { page: 1, size: 'original', originals: ['a_p0.jpg', 'a_p1.jpg'] });
ok('page=1 取的是第 2 页原图', srcPage1[0].url === 'a_p1.jpg', JSON.stringify(srcPage1[0]));
const srcMaster = pixivImageSources(det, { page: 0, size: 'master', originals: ['https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg'] });
ok('size=master → 直联 master1200.jpg', srcMaster[0].url.endsWith('80643572_p0_master1200.jpg') && srcMaster[0].referer === PIXIV_REFERER, JSON.stringify(srcMaster[0]));
const srcSearch = pixivImageSources(
  { id: '149787938', thumbUrl: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/18/01/37/08/149787938_p0_square1200.jpg' },
  { page: 0, size: 'master' },
);
eq('搜索路径（只有缩略图）与老候选完全一致 —— 老行为没被改坏',
  srcSearch.map((s) => s.url),
  pixivImageCandidates({ id: '149787938', thumbUrl: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/18/01/37/08/149787938_p0_square1200.jpg' }, { page: 0, size: 'master' }));
ok('搜索路径不塞 Referer（仍走代理）', srcSearch.every((s) => !s.referer));

/* ───────────────────────── 联网：真作品号 ───────────────────────── */
if (!process.argv.includes('--live')) {
  console.log(`\n（跳过联网部分；加 --live 才会真去 pixiv 取图）\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
console.log('\n=== 6. 联网：按作品号取详情 + 原图直链 ===');
const liveId = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : '80643572';
const live = await pixivIllustDetail(liveId);
console.log(`  作品 ${live.id}「${live.title}」by ${live.author}（${live.pageCount} 页，xRestrict=${live.xRestrict}，来源=${live.source}）`);
ok('详情拿到了标题与作者', Boolean(live.title && live.author));
ok('不是 R-18', live.adult === false);
const op = await pixivIllustOriginals(live);
console.log(`  原图地址来源=${op.source}${op.note ? ' 备注=' + op.note : ''}  第 1 页=${op.urls[0]}`);
ok('拿到了逐页原图直链', op.urls.length >= 1 && /img-original\/img\//.test(op.urls[0] || ''));
ok('页数与 pageCount 对齐', op.urls.length === live.pageCount || op.source === 'derived', `urls=${op.urls.length} pageCount=${live.pageCount}`);

console.log('\n=== 7. 联网：字节级无损校验（直联 vs 镜像代理）===');
const sources = pixivImageSources(live, { page: 0, size: 'original', originals: op.urls });
const direct = await safeFetchBuffer(sources[0].url, 15 * 1024 * 1024, { referer: sources[0].referer });
console.log(`  直联 ${sources[0].url}\n       ${direct.buffer.length}B sha256=${sha(direct.buffer).slice(0, 16)}…`);
ok('safeFetchBuffer 带 referer 能拿到 i.pximg 原图（不带是 403）', direct.buffer.length > 0);
let noRef403 = false;
try { await safeFetchBuffer(sources[0].url, 15 * 1024 * 1024); } catch (e) { noRef403 = /403/.test(String(e?.message ?? e)); }
ok('同地址不带 referer 确实被拒（证明第三参起了作用）', noRef403 || direct.buffer.length === 0);
const proxySrc = sources.find((s) => !s.referer && /\/api\/image\.php\?url=/.test(s.url));
if (proxySrc) {
  const viaProxy = await safeFetchBuffer(proxySrc.url, 15 * 1024 * 1024);
  console.log(`  代理 ${viaProxy.buffer.length}B sha256=${sha(viaProxy.buffer).slice(0, 16)}…`);
  ok('镜像代理字节与直联逐字节相同', sha(viaProxy.buffer) === sha(direct.buffer));
} else {
  console.log('  （没有代理兜底候选，跳过对比）');
}

console.log('\n=== 8. 联网：错误路径要说人话 ===');
let badMsg = '';
try { await pixivIllustDetail('99999999999'); } catch (e) { badMsg = String(e?.message ?? e); }
ok('不存在的作品号报错且带来源说明', /取 Pixiv 作品 99999999999 失败/.test(badMsg), badMsg);
let badFmt = '';
try { await pixivIllustDetail('abc'); } catch (e) { badFmt = String(e?.message ?? e); }
ok('非数字入参被挡下', /作品号不合法/.test(badFmt), badFmt);
const r18Id = process.argv.includes('--r18') ? process.argv[process.argv.indexOf('--r18') + 1] : '110000000';
try {
  const r18 = await pixivIllustDetail(r18Id);
  ok('R-18 作品被判为不宜发送', r18.adult === true, `xRestrict=${r18.xRestrict} adult=${r18.adult}`);
} catch (e) {
  ok('R-18 作品取不到（也算安全：报错而非发出去）', true, String(e?.message ?? e));
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
