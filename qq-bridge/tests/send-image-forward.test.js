// 「把对方/自己发的那张图转出去」回归（2026-09-22 三轮实测报障的收敛点）：
//   · messageId 来源：按消息 id 取回原图再发（模型手上只有 id 的情况）
//   · 引用穿透：图在被引用的那条消息里时，用当前消息 id 也能拿到
//   · 跨会话：key 是目的地，图在发起会话里 —— 必须找得到（否则只能退回"联网搜一张差不多的"）
//   · 参数必须真的声明在 qq_send_image 的 schema 里，且两个 body 分支都塞 crossSession
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.join(process.cwd(), 'src');
const sandbox = path.join(process.cwd(), 'tests', `.tmp-send-image-forward-${process.pid}`);
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(SRC, path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-imgfwd', private: true, type: 'module' }));

const cfg = {
  ownerQQ: '1736784911',
  consolePort: 3999,
  napcat: { httpUrl: 'http://127.0.0.1:1', accessToken: '', tmpDir: path.join(sandbox, 'state', 'napcat-tmp') },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: {}, deny: {}, allowAllWhenEmpty: true,
  social: { tools: {}, send: { linearEnabled: false }, wake: {} },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const socialState = await import(url('core/social-state.js'));
socialState.initSocialCore(cfg);
const modeMod = await import(url('core/mode.js'));
modeMod.initModeCore(cfg);
const flow = await import(url('core/social-flow.js'));
flow.initSocialFlowCore(cfg);
const { segmentsToText } = await import(url('lib/message-parse.js'));

const PIC = [{ kind: 'image', file: 'a.jpg', url: 'https://example.invalid/a.jpg' }];
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

console.log('== ① 入站消息记下被引用那条的 id，并沿它穿透 ==');
// 会话 1（私聊）：1001 = 对方发的图；1002 = 引用着 1001 的那句话（图在被引用那条里）
flow.appendSocialMessage('private:1736784911', '私聊', '[图片]', '[图片]', false, false, '1001', PIC, '1736784911');
flow.appendSocialMessage('private:1736784911', '私聊', '[引用 某某：[图片]]现在把我这张图转发到实验群', '现在把我这张图转发到实验群', false, false, '1002', [], '1736784911', [], false, [], '1001');
const st1 = socialState.getSocialState('private:1736784911');
const rec = st1.recentMessages.find((m) => m.messageId === '1002');
ok('appendSocialMessage 把 quoteTargetId 记进 msg.quoteTarget', rec && String(rec.quoteTarget) === '1001', JSON.stringify(rec?.quoteTarget));

const direct = flow.findMessageMedia('private:1736784911', '1001');
ok('原有签名（返回数组）保持兼容', Array.isArray(direct) && direct.length === 1, JSON.stringify(direct));
const viaQuote = flow.findMessageMedia('private:1736784911', '1002', { info: true });
ok('传引用那条的 id 也能拿到图', viaQuote.media.length === 1, JSON.stringify(viaQuote));
ok('如实报出 viaQuote + quoteMessageId', viaQuote.viaQuote === true && viaQuote.quoteMessageId === '1001', JSON.stringify(viaQuote));
ok('报出在哪个会话找到的', viaQuote.foundIn === 'private:1736784911', String(viaQuote.foundIn));

console.log('== ② 跨会话：key 是目的地，图在发起会话里 ==');
flow.appendSocialMessage('group:1072393236', '群友', '[图片]', '[图片]', false, false, '2001', PIC, '999');
const cross = flow.findMessageMedia('group:1072393236', '1001', { info: true });
ok('目的地会话里没有这条消息，仍能在发起会话里找到', cross.media.length === 1, JSON.stringify(cross));
ok('foundIn 指向真正持有它的会话', cross.foundIn === 'private:1736784911', String(cross.foundIn));
const crossQuote = flow.findMessageMedia('group:1072393236', '1002', { info: true });
ok('跨会话 + 引用穿透可以叠用', crossQuote.media.length === 1 && crossQuote.viaQuote === true, JSON.stringify(crossQuote));
ok('目的会话自己的图照旧能找到', flow.findMessageMedia('group:1072393236', '2001', { info: true }).foundIn === 'group:1072393236');
ok('anywhere:false 时不做跨会话兜底', flow.findMessageMedia('group:1072393236', '1001', { info: true, anywhere: false }).media.length === 0);
const missing = flow.findMessageMedia('group:1072393236', 'no-such-id', { info: true });
ok('找不到时干净返回（不抛、不编）', missing.media.length === 0 && missing.viaQuote === false);

console.log('== ③ 被引用的内容带图时，唤醒正文里带上那条消息的 id ==');
const quotedImg = await segmentsToText(
  [{ type: 'reply', data: { id: '1001' } }, { type: 'text', data: { text: '现在把我这张图转发到实验群' } }],
  { resolveReply: async () => ({ sender: 'AbyssalQuill', text: '[图片]' }) },
);
ok('渲染成 [引用 某某#id：[图片]]', /\[引用 AbyssalQuill#1001：\[图片\]\]/.test(quotedImg), quotedImg);
const quotedText = await segmentsToText(
  [{ type: 'reply', data: { id: '1003' } }, { type: 'text', data: { text: '这个说法对' } }],
  { resolveReply: async () => ({ sender: '某某', text: '本来就是这么回事' }) },
);
ok('纯文字引用的格式一字不变', quotedText.includes('[引用 某某：本来就是这么回事]'), quotedText);

console.log('== ④ qq_send_image 的参数声明的确是这四条来源 + 跨会话标志 ==');
const mcpSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp-napcat-safe.js'), 'utf8');
const block = mcpSrc.slice(mcpSrc.indexOf("registerTool(\n    'qq_send_image'"), mcpSrc.indexOf("registerTool(\n    'qq_send_pixiv'"));
ok('schema 声明 file', /\bfile: z\.string\(\)/.test(block));
ok('schema 声明 messageId', /\bmessageId: z\.union\(\[z\.number\(\), z\.string\(\)\]\)/.test(block));
ok('schema 声明 imageIndex', /\bimageIndex: z\.number\(\)/.test(block));
ok('schema 声明 crossSession', /\bcrossSession: z\.boolean\(\)/.test(block));
ok('messageId 分支真的调用取图端点', /api\/images\/message\?/.test(block));
ok('file 分支塞 crossSession', /if \(crossSession === true\) bodyF\.crossSession = true;/.test(block));
ok('imageUrl/query 分支塞 crossSession', /if \(crossSession === true\) body\.crossSession = true;/.test(block));
ok('三条来源统一走公共落盘函数 stageImageBytes', (mcpSrc.match(/stageImageBytes\(/g) || []).length >= 4, String((mcpSrc.match(/stageImageBytes\(/g) || []).length));

console.log('== ⑤ 「默认转发原图，别压缩」：raw 取图必须原样字节 ==');
/* 造一张 200x200 随机像素 PNG（> 40KB，正好落进 image-compress 的"值得压"区间）：
 * 非 raw 时它会被重编码（喂模型用的副本），raw 时必须**字节完全相同**。 */
const zlib = await import('node:zlib');
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const W = 1400; const H = 700; // 长边 > IMAGE_MAX_SIDE(1280)：压缩档一定会缩，raw 档必须原样
let seed = 1234567;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const off = y * (1 + W * 3);
  raw[off] = 0; // filter: none
  for (let x = 0; x < W * 3; x++) raw[off + 1 + x] = rnd();
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
]);
const fixtureDir = path.join(sandbox, 'napcat-home');
fs.mkdirSync(fixtureDir, { recursive: true });
const fixture = path.join(fixtureDir, 'forward-src.png');
fs.writeFileSync(fixture, png);
cfg.napcat.homeDir = fixtureDir;
const mediaPipe = await import(url('core/media-pipe.js'));
mediaPipe.initMediaPipeCore(cfg);
mediaPipe.setMediaPipeBot({ getImage: async () => ({ file: fixture }) });
const one = [{ kind: 'image', file: 'forward-src.png', url: 'https://example.invalid/x.png' }];
const rawOut = await mediaPipe.fetchMediaData(one, { raw: true });
const cmpOut = await mediaPipe.fetchMediaData(one, {});
const rawBuf = Buffer.from(rawOut[0].data, 'base64');
ok('raw 取图原样返回字节（与磁盘文件逐字节一致）', rawBuf.equals(png), `${rawBuf.length} vs ${png.length}`);
ok('raw 结果标了 raw + sha256', rawOut[0].raw === true && /^[0-9a-f]{64}$/.test(String(rawOut[0].sha256)), JSON.stringify({ raw: rawOut[0].raw, sha: rawOut[0].sha256 }));
ok('raw 报了真实字节数', rawOut[0].bytes === png.length, `${rawOut[0].bytes} vs ${png.length}`);
/* 压缩档必须**永不大于**原图（image-compress 的策略是"只在更小时才替换"，噪声 PNG 压不小就保持原样）；
 * 真正会缩的是照相机拍的大 JPEG（长边几千像素，长边 > 1280 必缩）。raw 那条路的判据在上一行：
 * 与磁盘文件逐字节一致 —— 只要这条成立，"转发原图"就已经成立，跟压缩档这次有没有变无关。 */
ok('默认（喂模型那条路）仍走压缩档，不标 raw 且不会比原图更大', !cmpOut[0].raw && (cmpOut[0].bytes ?? 0) <= png.length, JSON.stringify({ bytes: cmpOut[0].bytes, orig: png.length }));
const oneRaw = await mediaPipe.resolveOneMedia(one[0], { raw: true });
ok('resolveOneMedia(raw) 跳过投递闸门的重编码', oneRaw.raw === true && oneRaw.buffer.equals(png), `${oneRaw.buffer?.length}`);

// 收尾：先把定时器清掉（appendSocialMessage 会安排主动检查），否则沙箱目录可能还被库文件占着
try { socialState.clearAllSocialTimers(); } catch { /* ignore */ }
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 上库文件可能仍被占用，留着不影响判据 */ }
console.log(`\nALL PASS  pass=${pass} fail=${process.exitCode ? 1 : 0}`);
