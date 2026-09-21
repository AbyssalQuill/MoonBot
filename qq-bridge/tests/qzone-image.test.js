// 回归测试：说说配图（2026-09-21 新增）
//
// 覆盖三件"线上会疼"的事，全程离线（不联网、不碰生产 state）：
//   ① 配图**零落盘**：字节 ≤ base64 上限时交给 NapCat 的是 `base64://…`，磁盘上一个文件都不新增
//      （依据：napcat.mjs 的 SendQzoneMsg._handle 只认 `images`，base64 由 NapCat 自己落盘又自己在 finally 删）；
//   ② 超过上限才落盘（容器可读的路径），**cleanup 之后必须消失**，而且 cleanup 幂等（finally 里可能被调两次）；
//   ③ 体检闸门：截断的 PNG/JPEG、content-length 对不上的字节一律**不许配图**，转而发纯文字说说。
//
// 跑法：cd qq-bridge && node tests/qzone-image.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-qzone-img-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-qzone-img-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '1' }, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const {
  QZONE_IMAGE_MAX, clampQzoneImageCount, qzoneImageTmpDir, sniffQzoneImageExt,
  verifyQzoneImage, prepareQzoneImageArg, sweepQzoneImageTmp, collectQzoneImages,
} = await import(url('lib/qzone-image.js'));

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

// ── 造图：一张"完整"的 PNG（带 IEND 尾块）、一张被截断的 PNG、一对完整/截断的 JPEG ──
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const pngComplete = (() => {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  Buffer.from('IHDR').copy(b, 12);
  b.writeUInt32BE(1200, 16);
  b.writeUInt32BE(800, 20);
  PNG_IEND.copy(b, 40 - PNG_IEND.length);                 // IEND 收尾（截断的 PNG 缺的就是它）
  return b;
})();
const pngTruncated = Buffer.from(pngComplete);
pngTruncated.fill(0, pngComplete.length - PNG_IEND.length);   // 尾块整块被啃掉 → 缺 IEND
const jpegTruncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(40, 7)]);
const jpegComplete = Buffer.concat([jpegTruncated, Buffer.from([0xff, 0xd9])]);

const sharedTmp = path.join(sandbox, 'napcat-mounted', 'moonbot-tmp');
const cfgShared = {
  napcat: {
    imageFileMode: 'auto',
    tmpDir: sharedTmp,
    dockerPathMap: [{ host: path.join(sandbox, 'napcat-mounted'), container: '/app/napcat/config' }],
  },
};
const listTmp = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

console.log('== 说说配图：张数上限 ==');

await t('张数默认 1、非法值当 1、上限 3', () => {
  assert.equal(QZONE_IMAGE_MAX, 3);
  assert.equal(clampQzoneImageCount(undefined), 1);
  assert.equal(clampQzoneImageCount(0), 1);
  assert.equal(clampQzoneImageCount(-5), 1);
  assert.equal(clampQzoneImageCount('abc'), 1);
  assert.equal(clampQzoneImageCount(2), 2);
  assert.equal(clampQzoneImageCount(9), 3);
});

console.log('== 说说配图：体检闸门（截断图绝不配进说说） ==');

await t('完整 PNG 通过；截断 PNG（缺 IEND）被拒', () => {
  const ok = verifyQzoneImage(pngComplete);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.ext, 'png');
  assert.equal(ok.width, 1200);
  assert.equal(ok.height, 800);
  const bad = verifyQzoneImage(pngTruncated);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /IEND|不完整/);
});

await t('完整 JPEG 通过；截断 JPEG（缺 FFD9）被拒', () => {
  assert.equal(sniffQzoneImageExt(jpegComplete), 'jpg');
  assert.equal(verifyQzoneImage(jpegComplete).ok, true);
  const bad = verifyQzoneImage(jpegTruncated);
  assert.equal(bad.ok, false, '缺 FFD9 的 JPEG 必须被拒');
  assert.match(bad.reason, /FFD9|不完整/);
});

await t('content-length 对不上 → 拒（这是"上游给半截图"的另一种形态）', () => {
  const v = verifyQzoneImage(pngComplete, { contentLength: pngComplete.length + 4096 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /content-length|字节数/);
});

await t('不是图片的字节（HTML）被拒', () => {
  const v = verifyQzoneImage(Buffer.from('<!doctype html><html>nope</html>'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /认不出|不完整/);
});

await t('魔数认格式：PNG/JPEG/GIF/WebP 认得，其它为 \'\'', () => {
  assert.equal(sniffQzoneImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])), 'png');
  assert.equal(sniffQzoneImageExt(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)])), 'gif');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  assert.equal(sniffQzoneImageExt(webp), 'webp');
  assert.equal(sniffQzoneImageExt(Buffer.from('hello world, not an image')), '');
});

console.log('== 说说配图：零落盘优先 ==');

await t('【核心】≤10MB 时交给 NapCat 的是 base64://，且**磁盘上没有新增任何文件**', async () => {
  const dir = qzoneImageTmpDir({ napcat: {} }, sandbox);
  const before = listTmp(dir);
  const p = prepareQzoneImageArg(pngComplete, { napcat: {} }, { root: sandbox });
  assert.equal(p.mode, 'base64');
  assert.equal(p.cleanup, null, '零落盘那条路不该有 cleanup');
  assert.ok(p.arg.startsWith('base64://'), p.arg.slice(0, 24));
  assert.deepEqual(Buffer.from(p.arg.slice('base64://'.length), 'base64'), pngComplete, 'base64 解出来必须逐字节一致');
  assert.deepEqual(listTmp(dir), before, '不许新增文件');
  assert.equal(fs.existsSync(dir), false, '临时目录都不该被创建');
});

await t('临时目录口径：napcat.tmpDir 优先，否则 <root>/state/qzone-img-tmp', () => {
  assert.equal(qzoneImageTmpDir(cfgShared, sandbox), sharedTmp);
  assert.equal(qzoneImageTmpDir({ napcat: { tmpDir: '  ' } }, sandbox), path.join(sandbox, 'state', 'qzone-img-tmp'));
});

await t('【核心】超上限才落盘：走统一 helper 拿到容器可读路径，cleanup 之后文件消失且幂等', async () => {
  const big = Buffer.alloc(64, 0x41);
  const p = prepareQzoneImageArg(big, cfgShared, { root: sandbox, maxBytes: 16 });
  assert.equal(p.mode, 'file');
  assert.ok(fs.existsSync(p.path), '落盘失败');
  assert.match(p.path.replace(/\\/g, '/'), /\/moonbot-tmp\//);
  // 交给 NapCat 的形态由 napcatImageFileArg 决定：auto + dockerPathMap → 容器内路径（docx 那个坑）
  assert.ok(p.arg.startsWith('/app/napcat/config/moonbot-tmp/'), p.arg);
  await p.cleanup();
  assert.equal(fs.existsSync(p.path), false, 'cleanup 必须删掉临时文件');
  await p.cleanup();   // 幂等：finally 里可能被调多次
  assert.equal(fs.existsSync(p.path), false);
});

console.log('== 说说配图：残留清扫（只删自己写的） ==');

await t('启动清扫：删 3 小时前自己写的文件，保留新的与别人的文件', async () => {
  const dir = path.join(sandbox, 'sweep-tmp');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'qzone-1700000000000-a1b2c3.png');
  const fresh = path.join(dir, `qzone-${Date.now()}-d4e5f6.jpg`);
  const foreign = path.join(dir, '1789397607787-o217kf.jpeg');   // 表情包那条路的命名（别人写的）
  for (const f of [old, fresh, foreign]) fs.writeFileSync(f, 'x');
  const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(foreign, past, past);

  const r = sweepQzoneImageTmp(dir);
  assert.equal(r.removed, 1, `只该删 1 个，实际 ${r.removed}（${r.names.join(',')}）`);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true, '新文件不许删');
  assert.equal(fs.existsSync(foreign), true, '不是我们命名的文件绝对不许删（tmpDir 可能与表情/文档共用）');
  assert.equal(sweepQzoneImageTmp(path.join(sandbox, 'not-exist')).removed, 0, '目录不存在也不能抛');
});

console.log('== 说说配图：取图（本地文件这条路不联网） ==');

await t('本地图片过闸后收下（from=file、像素对得上）', async () => {
  const f = path.join(sandbox, 'ok.png');
  fs.writeFileSync(f, pngComplete);
  const got = await collectQzoneImages({ file: f, cfg: { napcat: {} } });
  assert.equal(got.requested, true);
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].from, 'file');
  assert.equal(got.items[0].ext, 'png');
  assert.equal(got.items[0].bytes, pngComplete.length);
  assert.equal(got.items[0].pixels, '1200x800');
  assert.equal(got.items[0].localPath, f);
});

await t('【核心】本地截断图被拒 → 不抛错、items 为空、notes 说清原因（这次只发文字）', async () => {
  const f = path.join(sandbox, 'bad.png');
  fs.writeFileSync(f, pngTruncated);
  const got = await collectQzoneImages({ file: f, cfg: { napcat: {} } });
  assert.equal(got.items.length, 0);
  assert.ok(got.notes.some((n) => /没通过体检/.test(n)), JSON.stringify(got.notes));
});

await t('文件读不到也不抛（发纯文字说说）', async () => {
  const got = await collectQzoneImages({ file: path.join(sandbox, 'nope.png'), cfg: { napcat: {} } });
  assert.equal(got.items.length, 0);
  assert.ok(got.notes.length >= 1);
});

await t('没要求配图时 requested=false（文字说说行为一字不变）', async () => {
  const got = await collectQzoneImages({ cfg: { napcat: {} } });
  assert.equal(got.requested, false);
  assert.equal(got.items.length, 0);
  assert.deepEqual(got.notes, []);
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
