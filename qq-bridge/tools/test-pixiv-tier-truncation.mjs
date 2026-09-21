/* qq_send_pixiv 的「档位」与「字节完整性」回归自测（2026-09-21 线上现场）。
 *
 * 现场（主人报，证据是发到 QQ 的那个附件名）：
 *   · 文件名 `3bbd4e1d0c3c1308c4d6fbf2ca3493bc_720.jpg` —— pixiv 的档位命名是确定性的：
 *     `<id>_pN.jpg/_pN.png` = 原图、`_pN_master1200.jpg` = 1200 档、`_pN_square1200.jpg` = 缩略图、
 *     而 `_720` 是 720 档。也就是说**用户要的是原图，拿到的是 720 档**。
 *   · 图像下半幅 60~70% 是纯 #808080 平色、边界干净、没有 JPEG 块状噪声 ——
 *     这是**渐进式 JPEG 被截断**的典型特征（解码器对没收到的部分只填 DC 均值），不是画的内容。
 *
 * 本脚本离线可跑（不联网、不碰 pixiv）：
 *   A. 同一个作品，size=original / master 各会产生哪些地址、分别属于哪一档；
 *   B. 上游（镜像站）把"原图"地址写成 720/1200 档时，pixivIllustOriginals 与候选拼装怎么反应；
 *   C. 字节完整性：截断的 JPEG / PNG 在改前会不会被当成"合法图片"放出去。
 *
 * 跑法：node qq-bridge/tools/test-pixiv-tier-truncation.mjs   （失败退出码 1）
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SRC = new URL('../src/', import.meta.url);
const pixiv = await import(new URL('lib/pixiv.js', SRC).href);
const safeFetch = await import(new URL('safe-fetch.js', SRC).href);
const { sniffImageInfo } = await import(new URL('lib/image-compress.js', SRC).href);

const jpeg = require(fileURLToPath(new URL('lib/vendor/jpeg-js/index.js', SRC)));
const { PNG } = require(fileURLToPath(new URL('lib/vendor/pngjs/lib/png.js', SRC)));

let pass = 0;
const fails = [];
const check = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fails.push(label); console.log(`  ❌ ${label}${extra ? '  → ' + extra : ''}`); }
};
const tierOf = pixiv.pixivImageTier;   // 改动前不存在 → 后面按 undefined 兜底

/* ── 夹具：一个真实的线上作品形状（149787938 / p0 / 2048×2896 竖图）───────────────
 * 日期路径与文件名照抄 pixiv 线上实测形状（见 lib/pixiv.js 顶部第 16~18 行）。 */
const PID = '149787938';
const DATE = '2026/09/18/01/37/08';
const URLS = {
  original: `https://i.pximg.net/img-original/img/${DATE}/${PID}_p0.jpg`,
  master: `https://i.pximg.net/img-master/img/${DATE}/${PID}_p0_master1200.jpg`,
  thumb: `https://i.pximg.net/c/250x250_80_a2/img-master/img/${DATE}/${PID}_p0_square1200.jpg`,
  proxyOf720: `https://i.pximg.net/img-master/img/${DATE}/${PID}_p0_720.jpg`,
};
const detail = {
  id: PID, title: 't', author: 'a', authorId: '1', tags: ['x'], pageCount: 1,
  width: 2048, height: 2896, illustType: 0, xRestrict: 0, aiType: 1, createDate: '',
  pageUrl: pixiv.pixivPageUrl(PID), thumbUrl: URLS.thumb,
  urls: { original: URLS.original, regular: URLS.master, thumb: URLS.thumb },
  metaPages: [URLS.original], source: 'app-api', adult: false, origin: 'detail',
};

const show = (label, list) => {
  console.log(`  ${label}`);
  list.forEach((s, i) => {
    const t = tierOf ? tierOf(s.url) : '(无档位函数)';
    const tag = s.fallback ? ` fallback=${s.fallback}` : '';
    console.log(`    ${i + 1}. [${t}]${tag} ${s.url.length > 120 ? s.url.slice(0, 117) + '…' : s.url}`);
  });
};

console.log(`\n=== A. 候选地址与档位（镜像站 base = ${pixiv.pixivBase()}）===`);
const srcOrig = pixiv.pixivImageSources(detail, { page: 0, size: 'original', originals: [URLS.original] });
show('size=original（调用方要原图；qq_send_pixiv 的默认就是它）:', srcOrig);
const srcMaster = pixiv.pixivImageSources(detail, { page: 0, size: 'master', originals: [URLS.original] });
show('size=master（调用方明确要 1200 档）:', srcMaster);

const origTiers = srcOrig.map((s) => (tierOf ? tierOf(s.url) : '?'));
const nonOriginal = srcOrig.filter((s) => tierOf && tierOf(s.url) !== 'original');
check('size=original 时，非原图档的候选都被标注成 fallback（不再和原图混在一起）',
  Boolean(tierOf) && nonOriginal.length > 0 && nonOriginal.every((s) => s.fallback === true),
  JSON.stringify(nonOriginal.map((s) => [tierOf ? tierOf(s.url) : '?', s.fallback])));
check('size=original 时首选里没有缩略图（250×250 square1200 不许冒充原图）',
  Boolean(tierOf) && origTiers.filter((t) => t === 'thumb').length > 0 && srcOrig.every((s) => (tierOf(s.url) === 'thumb' ? s.fallback === true : true)),
  origTiers.join(','));
check('候选里仍保留原图（没有把好的候选也砍掉）', origTiers.includes('original'), origTiers.join(','));

console.log('\n=== B. 上游把"原图"写成 720 档（镜像站 rewrote original → 720 档的情形）===');
/* 模拟：镜像站 detail.php 的 urls.original 给的是 720 档地址（第三方平替站的常见行为），
 * 而且 no-token / pages 接口不通 → 只能靠这条 derived 兜底。 */
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: false, body: { id: PID, userId: '1', userName: 'a', pageCount: 1, xRestrict: 0, tags: { tags: [] }, urls: { original: URLS.proxyOf720, regular: URLS.master, thumb: URLS.thumb } } }),
  json: async () => JSON.parse(await Promise.resolve('null')),
});
delete process.env.QQBRIDGE_PIXIV_REFRESH_TOKEN;
try {
  const d720 = await pixiv.pixivIllustDetail(PID);
  const op = await pixiv.pixivIllustOriginals(d720);
  console.log(`  镜像站给的 urls.original = ${URLS.proxyOf720}`);
  console.log(`  pixivIllustOriginals → source=${op.source || '(空)'} urls=${JSON.stringify(op.urls)}`);
  const d720Sources = pixiv.pixivImageSources(d720, { page: 0, size: 'original', originals: op.urls });
  show('由它拼出的候选:', d720Sources);
  check('720/1200 档的地址不会被当成原图档放行（tier != original）',
    Boolean(tierOf) && op.urls.every((u) => tierOf(u) !== 'original'),
    JSON.stringify(op.urls.map((u) => (tierOf ? tierOf(u) : '?'))));
} catch (e) {
  console.log(`  取详情失败（预期内，假 fetch 只给镜像站形状）：${e?.message ?? e}`);
}
globalThis.fetch = realFetch;

console.log('\n=== C. 字节完整性（截断的 JPEG/PNG 绝不能再发出去）===');
const mkJpeg = (w, h) => {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = (i * 7) % 255; data[i * 4 + 1] = 128; data[i * 4 + 2] = 200; data[i * 4 + 3] = 255; }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 82).data);
};
const fullJpeg = mkJpeg(2048, 2896);
const cutJpeg = fullJpeg.subarray(0, Math.floor(fullJpeg.length * 0.62));   // 截掉后 38%（现场是 60~70% 灰）
const fullPng = (() => {
  const p = new PNG({ width: 8, height: 8 });
  p.data.fill(128);
  return Buffer.from(PNG.sync.write(p));
})();
const cutPng = fullPng.subarray(0, fullPng.length - 12);   // 砍掉 IEND

console.log(`  完整 jpeg: ${fullJpeg.length}B 尾部=${fullJpeg.subarray(-2).toString('hex')}  截断 jpeg: ${cutJpeg.length}B 尾部=${cutJpeg.subarray(-2).toString('hex')}`);
console.log(`  完整 png:  ${fullPng.length}B  截断 png: ${cutPng.length}B`);
console.log(`  尺寸嗅探（720 档 vs 原图）: 720×720 → ${JSON.stringify(sniffImageInfo(mkJpeg(720, 720)))} / 2048×2896 → ${JSON.stringify(sniffImageInfo(fullJpeg))}`);

const verify = safeFetch.verifyImageComplete;
if (!verify) {
  check('safe-fetch 暴露"图片字节完整性"校验（verifyImageComplete）', false, '改动前不存在：截断的图只过 magic-byte 检查就被当成合法图片');
  check('截断的 JPEG 会被拒（现场那半幅灰就是这么发出去的）', false, `截断体依旧通过 looksLikeImageBuffer = ${safeFetch.looksLikeImageBuffer(cutJpeg)}`);
} else {
  check('完整 JPEG 通过', verify(fullJpeg, fullJpeg.length).ok === true, JSON.stringify(verify(fullJpeg, fullJpeg.length)));
  const vCut = verify(cutJpeg, fullJpeg.length);
  check('截断的 JPEG 被拒（缺 FFD9 / 与 content-length 不符）', vCut.ok === false, JSON.stringify(vCut));
  check('与 content-length 不符也会被拒', verify(fullJpeg, fullJpeg.length + 4096).ok === false, JSON.stringify(verify(fullJpeg, fullJpeg.length + 4096)));
  check('完整 PNG 通过', verify(fullPng, fullPng.length).ok === true, JSON.stringify(verify(fullPng, fullPng.length)));
  check('缺 IEND 的 PNG 被拒', verify(cutPng, fullPng.length).ok === false, JSON.stringify(verify(cutPng, fullPng.length)));
  // 光"导出了函数"不算修好：这道闸门必须真的装在 safeFetchBuffer 的返回路径上（截断就抛错、让调用方换候选）
  const { readFile } = await import('node:fs/promises');
  const sfText = await readFile(new URL('../src/safe-fetch.js', import.meta.url), 'utf8');
  check('safeFetchBuffer 真的接上了这道闸门（截断 → 抛错 → 换下一个候选）',
    /verifyImageComplete\(result\.buffer, result\.contentLength, result\.contentEncoding\)/.test(sfText)
    && /图片字节不完整/.test(sfText),
    '没有接线就等于白写');
}

console.log('\n=== D. 工具真正用的两个闸门（planPixivSend / pixivTierSizeVerdict）===');
const plan = pixiv.planPixivSend ? pixiv.planPixivSend(srcOrig, { size: 'original' }) : null;
if (!plan) {
  check('planPixivSend 存在（按档位分桶，决定谁首选、谁降级、谁不发）', false, '改动前不存在：候选混在一起，谁先成功发谁');
} else {
  const brief = (l) => l.map((s) => `[${s.tier}]${s.url.slice(-28)}`);
  console.log(`  primary(${plan.primary.length}): ${brief(plan.primary).join(' , ')}`);
  console.log(`  fallback(${plan.fallback.length}): ${brief(plan.fallback).join(' , ')}`);
  console.log(`  skipped(${plan.skipped.length}):  ${brief(plan.skipped).join(' , ')}`);
  check('size=original → 首选全是原图档', plan.primary.length > 0 && plan.primary.every((s) => s.tier === 'original'));
  check('size=original → 1200 档只出现在 fallback 里（且带降级原因）',
    plan.fallback.length > 0 && plan.fallback.every((s) => s.tier === 'master' && s.fallback === true && s.fallbackReason),
    JSON.stringify(plan.fallback.map((s) => s.tier)));
  check('缩略档被 skipped（永远不试）', plan.skipped.length === 1 && plan.skipped[0].tier === 'thumb', JSON.stringify(plan.skipped.map((s) => s.tier)));
  const planMaster = pixiv.planPixivSend(srcMaster, { size: 'master' });
  check('size=master → 1200 档是首选（用户明确要的档，不拦）', planMaster.primary.some((s) => s.tier === 'master') && planMaster.skipped.every((s) => s.tier === 'thumb'));
  // 上游给 720 档地址那一组：真正拼出来的原图候选必须排在它前面
  const plan720 = pixiv.planPixivSend(pixiv.pixivImageSources(detail, { page: 0, size: 'original', originals: [URLS.proxyOf720] }), { size: 'original' });
  console.log(`  （上游给 720 档时）primary 第一条 = [${plan720.primary[0]?.tier}] ${String(plan720.primary[0]?.url).slice(-30)}`);
  check('上游把 720 档当原图给 → 首选仍是真原图档，720 档退到 fallback',
    plan720.primary[0]?.tier === 'original' && plan720.fallback.every((s) => s.tier === 'master'),
    JSON.stringify(plan720.primary.map((s) => s.tier)));
}
const verdict720 = pixiv.pixivTierSizeVerdict
  ? pixiv.pixivTierSizeVerdict('original', { originalWidth: 2048, originalHeight: 2896, imageWidth: 720, imageHeight: 720, page: 0 })
  : null;
console.log(`  像素对账（要原图 2048×2896，实拿 720×720）：${verdict720 ? JSON.stringify(verdict720) : '(改动前无此判定)'}`);
check('地址看着是原图、字节却是 720 档 → 被像素对账拦下（这是第三方代理唯一认不出的形态）',
  Boolean(verdict720) && verdict720.ok === false && verdict720.expectedLongSide === 2896,
  verdict720 ? verdict720.reason : '改动前不存在');
check('原图字节与声明尺寸一致时放行', Boolean(pixiv.pixivTierSizeVerdict)
  && pixiv.pixivTierSizeVerdict('original', { originalWidth: 2048, originalHeight: 2896, imageWidth: 2048, imageHeight: 2896, page: 0 }).ok === true);
check('非第 0 页不作尺寸判定（详情里的宽高只是第 0 页的，不瞎比）',
  Boolean(pixiv.pixivTierSizeVerdict)
  && pixiv.pixivTierSizeVerdict('original', { originalWidth: 2048, originalHeight: 2896, imageWidth: 900, imageHeight: 900, page: 1 }).ok === true);

console.log(`\n结果：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · 未通过：${f}`);
process.exit(fails.length ? 1 : 0);
