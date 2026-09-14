// 回归测试：NapCat 图片路径归一化（2026-09-15 修「表情包一张都发不出去」）
//
// 线上真实故障（服务器 NapCat 日志，北京时间 2026-09-14 22:53:28）：
//   文件处理失败 识别URL失败, uri= /root/qq-bridge/state/sticker-tmp/1789397607787-o217kf.jpeg
// 原因：桥把**宿主机**绝对路径当 image 段的 file 交给 NapCat，而服务器 NapCat 跑在 Docker 里
// （容器只挂了 `-v /root/napcat/config:/app/napcat/config`），宿主路径在容器内不存在。
//
// 用法：node tests/napcat-file.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-nfile-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-nfile-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '1' }, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const { napcatImageFileArg, rewriteToContainerPath, resolveImageFileMode, resolveStickerTmpDir } = await import(url('lib/napcat-file.js'));

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-img-'));
const imgPath = path.join(tmp, 'x.webp');
const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5]);
fs.writeFileSync(imgPath, bytes);
const serverCfg = {
  napcat: {
    imageFileMode: 'auto',
    tmpDir: '/root/napcat/config/moonbot-tmp',
    dockerPathMap: [{ host: '/root/napcat/config', container: '/app/napcat/config' }],
  },
};

console.log('== NapCat 图片参数 ==');

t('默认（path，本机裸机部署）：原样返回路径', () => {
  assert.equal(resolveImageFileMode({}), 'path');
  assert.equal(napcatImageFileArg(imgPath, { napcat: {} }), imgPath);
});

t('base64 模式：读字节转 base64://', () => {
  const got = napcatImageFileArg(imgPath, { napcat: { imageFileMode: 'base64' } });
  assert.ok(got.startsWith('base64://'));
  assert.deepEqual(Buffer.from(got.slice('base64://'.length), 'base64'), bytes);
});

t('【回归】auto + dockerPathMap：宿主路径改写成**容器内**路径（服务器 NapCat 在 Docker 里）', () => {
  const hostFile = '/root/napcat/config/moonbot-tmp/1789397607787.webp';
  assert.equal(napcatImageFileArg(hostFile, serverCfg), '/app/napcat/config/moonbot-tmp/1789397607787.webp');
});

t('auto + 没有映射：退回 base64（跨容器也能发，不会再出现"识别URL失败"）', () => {
  const got = napcatImageFileArg(imgPath, { napcat: { imageFileMode: 'auto' } });
  assert.ok(got.startsWith('base64://'), got.slice(0, 40));
});

t('auto + 映射目录外的文件（如聊天图/上传表情）：也是 base64', () => {
  const got = napcatImageFileArg(imgPath, serverCfg);
  assert.ok(got.startsWith('base64://'));
});

t('超过 base64 上限：退回路径（优先容器路径）', () => {
  const hostFile = '/root/napcat/config/big.webp';
  assert.equal(napcatImageFileArg(hostFile, serverCfg, { maxBytes: 1 }), '/app/napcat/config/big.webp');
});

t('已经是 URL/base64 的原样返回', () => {
  for (const u of ['https://q1.qlogo.cn/x.png', 'http://127.0.0.1:3000/x', 'base64://AAAA', 'file:///app/x.png']) {
    assert.equal(napcatImageFileArg(u, serverCfg), u);
  }
});

t('dockerPathMap 前缀匹配：只有目录内的文件才改写', () => {
  const maps = serverCfg.napcat.dockerPathMap;
  const cfg = { napcat: { dockerPathMap: maps } };
  assert.equal(rewriteToContainerPath('/root/napcat/config/a/b/c.webp', cfg), '/app/napcat/config/a/b/c.webp');
  assert.equal(rewriteToContainerPath('/root/napcat/config', cfg), '/app/napcat/config');
  assert.equal(rewriteToContainerPath('/root/napcat/config-x/a.webp', cfg), null);
  assert.equal(rewriteToContainerPath('/root/qq-bridge/state/sticker-tmp/a.webp', cfg), null);
  assert.equal(rewriteToContainerPath('/root/napcat/config/a.webp', { napcat: {} }), null);
});

t('文件不存在时不编造路径（交给下游报"图片文件不存在"）', () => {
  const missing = path.join(tmp, 'nope.webp');
  assert.equal(napcatImageFileArg(missing, serverCfg), missing);
});

t('tmpDir 解析：配置优先，否则用 fallback', () => {
  assert.equal(resolveStickerTmpDir(serverCfg, '/tmp/fallback'), '/root/napcat/config/moonbot-tmp');
  assert.equal(resolveStickerTmpDir({ napcat: {} }, '/tmp/fallback'), '/tmp/fallback');
});

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
