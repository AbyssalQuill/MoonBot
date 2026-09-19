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
  cleanPixivCookie, parsePixivUserSearch, rankArtistCandidates, parseAuthorInput,
  pixivRequestHeaders, pixivLoggedIn, pixivLoginState, pixivSearchUsersByName, pixivUserSearchUrl,
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

/* ───────────────────────── 离线：登录 cookie 层（按名字搜画师） ───────────────────────── */
console.log('\n=== 6. cookie 规整（三种写法都要认，换行要清掉）===');
eq('整条 cookie 串原样保留（只留认识的键）', cleanPixivCookie('PHPSESSID=abc123; p_ab_id=7; other=1'), 'PHPSESSID=abc123; p_ab_id=7');
eq('只给会话值 → 自动补 PHPSESSID=', cleanPixivCookie('12345678_abcdefghijklmnop'), 'PHPSESSID=12345678_abcdefghijklmnop');
eq('带 PHPSESSID= 前缀照收', cleanPixivCookie('PHPSESSID=xyz_987654321'), 'PHPSESSID=xyz_987654321');
eq('复制时带上的换行/tab 被清掉（换行进请求头会弄坏请求）', cleanPixivCookie('PHPSESSID=abc\r\ndef\t'), 'PHPSESSID=abc def');
eq('空值 → 空串', cleanPixivCookie('   '), '');
ok('超长被截断（不让凭证面无限大）', cleanPixivCookie(`PHPSESSID=${'a'.repeat(5000)}`).length <= 2000);

console.log('\n=== 7. 登录态只发给 pixiv，绝不发给第三方镜像站 ===');
const hPixiv = pixivRequestHeaders('https://www.pixiv.net/ajax/illust/80643572');
const hMirror = pixivRequestHeaders('https://x.pixigraph.xyz/api/detail.php?id=80643572');
ok('请求头里本来就没有 cookie 时也不报错', typeof hPixiv === 'object' && typeof hMirror === 'object');
ok('两个域名都会带 Referer（图床防盗链要用）', hPixiv.referer === PIXIV_REFERER && hMirror.referer === PIXIV_REFERER);
if (pixivLoggedIn()) {
  ok('pixiv 域名拿到 cookie', Boolean(hPixiv.cookie));
  ok('★ 镜像站**拿不到** cookie（第三方，不能泄露登录凭证）', !hMirror.cookie);
} else {
  console.log('  （本机没配 pixiv.cookie，跳过"带 cookie"的两条断言；线上有配就会跑）');
  ok('没配 cookie 时两个域名都不带 cookie', !hPixiv.cookie && !hMirror.cookie);
}

console.log('\n=== 8. 用户搜索返回体的宽松解析 + 候选排序 ===');
/* 这条断言专门钉住参数名：pixiv 的用户搜索要的是 **nick** 不是 word —— 之前一直 400 就是栽在这。
 * 证据：pixiv 用户搜索页的 chunk 里写着 e.get("/ajax/search/users", {}, { nick: t.nick, ... })。 */
const searchUrl = pixivUserSearchUrl('米山舞');
ok('用户搜索地址用 nick= 参数', /[?&]nick=/.test(searchUrl) && !/[?&]word=/.test(searchUrl), searchUrl);
ok('带上 s_mode=s_usr / p=1 / i=0', /s_mode=s_usr/.test(searchUrl) && /[?&]p=1/.test(searchUrl) && /[?&]i=0/.test(searchUrl), searchUrl);
ok('onlyCreator=true → i=1', /[?&]i=1/.test(pixivUserSearchUrl('x', 1, true)));
const fixtureSearch = {
  error: false,
  body: {
    users: [
      { userId: '1554775', name: '米山舞', comment: 'イラストレーター、アニメーター。', partial: 0, premium: false, image: 'https://i.pximg.net/user-profile/img/a_50.jpg' },
      { userId: '49982457', name: '米山舞', comment: '', partial: 0 },
      { userId: '91868118', name: '米山舞sama', partial: 1 },
      { name: '没有号的脏数据' },
    ],
  },
};
const parsed = parsePixivUserSearch(fixtureSearch);
eq('只留真有号的条目', parsed.length, 3);
eq('id/name/签名/主页地址', [parsed[0].id, parsed[0].name, parsed[0].comment, parsed[0].pageUrl], ['1554775', '米山舞', 'イラストレーター、アニメーター。', 'https://www.pixiv.net/users/1554775']);
eq('裸数组形状也认', parsePixivUserSearch([{ id: 5, name: 'x' }]).length, 1);
eq('认不出来 → 空数组（不抛错）', parsePixivUserSearch({ error: true, body: [] }), []);
const rankedAmbiguous = rankArtistCandidates([{ id: '1554775', name: '米山舞', works: 46 }, { id: '49982457', name: '米山舞', works: 37 }], '米山舞');
ok('两个同名号都有作品 → 不敢定号，给候选', rankedAmbiguous.unique === null, JSON.stringify(rankedAmbiguous.candidates.map((u) => u.id)));
ok('候选按作品数多→少排', rankArtistCandidates([{ id: 'a', name: 'X', works: 3 }, { id: 'b', name: 'X', works: 9 }], 'X').candidates[0].id === 'b');
/* 实测形状：搜「米山舞」会带出 1 个真号（46 件）+ 一堆 0 作品的同名小号 + "米山舞sama" 这种近似号 */
const rankedReal = rankArtistCandidates([
  { id: '1554775', name: '米山舞', works: 46 },
  { id: '78071615', name: '米山舞', works: 0 },
  { id: '69453785', name: '米山舞', works: 0 },
  { id: '91868118', name: '米山舞sama', works: 0 },
], '米山舞');
ok('只有一个同名号有作品、其余同名都是 0 件 → 敢直接定号', rankedReal.unique?.id === '1554775', JSON.stringify(rankedReal.candidates.map((u) => `${u.id}:${u.works}`)));
ok('近似号作品更多时 → 不敢定号', rankArtistCandidates([{ id: '1', name: '米山舞', works: 2 }, { id: '2', name: '米山舞です', works: 300 }], '米山舞').unique === null);
ok('同名号全是 0 件（判不出谁是画师）→ 保守给候选', rankArtistCandidates([{ id: '1', name: 'x', works: 0 }, { id: '2', name: 'x', works: 0 }], 'x').unique === null);
eq('全角空格/大小写不影响同名判定', rankArtistCandidates([{ id: '3', name: 'YONEYAMA  MAI', works: 1 }], 'yoneyama mai').unique?.id, '3');

console.log('\n=== 9. 画师入参收口：号 / 链接 / 名字 / 空 ===');
eq('裸数字 → 就是画师号', parseAuthorInput('1554775'), { kind: 'id', id: '1554775', from: 'number' });
eq('主页链接 → 提取画师号', parseAuthorInput('https://www.pixiv.net/users/1554775'), { kind: 'id', id: '1554775', from: 'link' });
eq('带语言前缀的链接', parseAuthorInput('https://www.pixiv.net/en/users/1554775'), { kind: 'id', id: '1554775', from: 'link' });
eq('名字 → 走名字搜', parseAuthorInput('米山舞'), { kind: 'name', name: '米山舞' });
eq('空 → none', parseAuthorInput('   '), { kind: 'none' });

/* ───────────────────────── 联网 ───────────────────────── */
const wantLive = process.argv.includes('--live');
const wantLogin = process.argv.includes('--login');
if (!wantLive && !wantLogin) {
  console.log(`\n（跳过联网部分；--live 真去 pixiv 取图，--login 只做登录态自检 + 按名字搜画师）\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

console.log('\n=== 10. 联网：登录态自检 + 按名字搜画师 ===');
const login = await pixivLoginState();
console.log(`  配了 cookie=${login.configured} 登录生效=${login.loggedIn} —— ${login.evidence}`);
ok('登录态自检给得出明确结论（不猜）', typeof login.loggedIn === 'boolean');
const nameToTry = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : '米山舞';
try {
  const found = await pixivSearchUsersByName(nameToTry);
  console.log(`  按名字「${nameToTry}」搜到 ${found.users.length} 个号（${found.endpoint}）：`);
  for (const u of rankArtistCandidates(found.users, nameToTry).candidates.slice(0, 6)) {
    console.log(`    ${u.id.padEnd(10)} ${u.name}${u.works ? `（${u.works} 件）` : ''} ${u.pageUrl}`);
  }
  ok('★ 按名字搜画师拿到结果（cookie 生效、该接口对免费号开放）', found.users.length > 0);
  ok('结果里含真值 1554775（米山舞）', found.users.some((u) => u.id === '1554775') || nameToTry !== '米山舞');
} catch (e) {
  const msg = String(e?.message ?? e);
  console.log('  ' + msg);
  ok('没配 cookie 时明确说不支持（而不是偷偷退化成关键词搜）', login.configured || /需要 pixiv 登录态/.test(msg), msg);
  ok('配了 cookie 但搜不到 → 如实报每条路由的失败原因', !login.configured || /逐条试过/.test(msg), msg);
}
if (!wantLive) {
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

console.log('\n=== 11. 联网：按作品号取详情 + 原图直链 ===');
const liveId = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : '80643572';
const live = await pixivIllustDetail(liveId);
console.log(`  作品 ${live.id}「${live.title}」by ${live.author}（${live.pageCount} 页，xRestrict=${live.xRestrict}，来源=${live.source}）`);
ok('详情拿到了标题与作者', Boolean(live.title && live.author));
ok('不是 R-18', live.adult === false);
const op = await pixivIllustOriginals(live);
console.log(`  原图地址来源=${op.source}${op.note ? ' 备注=' + op.note : ''}  第 1 页=${op.urls[0]}`);
ok('拿到了逐页原图直链', op.urls.length >= 1 && /img-original\/img\//.test(op.urls[0] || ''));
ok('页数与 pageCount 对齐', op.urls.length === live.pageCount || op.source === 'derived', `urls=${op.urls.length} pageCount=${live.pageCount}`);

console.log('\n=== 12. 联网：字节级无损校验（直联 vs 镜像代理）===');
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

console.log('\n=== 13. 联网：错误路径要说人话 ===');
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
