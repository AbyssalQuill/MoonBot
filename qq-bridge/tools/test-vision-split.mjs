// 独立识图模型（core/vision.js）自检：
//   ① 没配「识图模型请求地址」→ 不启用（图片仍按附件走老路，行为一字不变）；
//   ② 配置 → 真的 POST 到 <base>/chat/completions，带 model + image_url 的 data URL + Bearer 头；
//   ③ 非 2xx / 响应没文字 / 地址就带 /chat/completions → 各自的降级与回退都对；
//   ④ 失败了**不抛异常**（调用方按"退回附件"处理）。
// 用一个真的本机 HTTP 服务当"假的识图模型"，不看代码猜行为。
import http from 'node:http';
import assert from 'node:assert/strict';
import { initVisionCore, visionSplitEnabled, visionEndpoint, describeImageWithVisionModel } from '../src/core/vision.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); failed += 1; }
}

/** 起一个假识图服务：记录收到的请求，按 reply 决定怎么回 */
function startFakeVision(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch { /* 保留 null，测试自己断言 */ }
        seen.push({ url: req.url, method: req.method, headers: req.headers, body, raw });
        handler(req, res, seen.length);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

console.log('== ① 未配置：不启用 ==');
initVisionCore({ dsh: {} });
check('baseUrl 空 → visionSplitEnabled=false', () => assert.equal(visionSplitEnabled(), false));
check('baseUrl 空 → visionEndpoint()=null', () => assert.equal(visionEndpoint(), null));
{
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('未配置时调用 → ok:false（不抛）', () => { assert.equal(d.ok, false); assert.match(d.error, /未配置/); });
}

console.log('\n== ② 配了地址但没配模型：仍不启用（不瞎猜模型名） ==');
initVisionCore({ dsh: { visionBaseUrl: 'http://127.0.0.1:9/v1', visionModel: '' } });
check('缺 visionModel → 不启用', () => assert.equal(visionSplitEnabled(), false));

console.log('\n== ③ 正常通路 ==');
{
  const fake = await startFakeVision((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一只橘猫趴在键盘上，屏幕里是报错窗口。' } }] }));
  });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${fake.port}/v1`, visionModel: 'qwen-vl-max', visionApiKey: 'sk-fake-vision-key' } });
  check('启用', () => assert.equal(visionSplitEnabled(), true));
  check('地址补 /chat/completions', () => assert.equal(visionEndpoint().url, `http://127.0.0.1:${fake.port}/v1/chat/completions`));
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('拿到描述文字', () => { assert.equal(d.ok, true); assert.match(d.text, /橘猫/); assert.equal(d.model, 'qwen-vl-max'); });
  const got = fake.seen[0];
  check('POST 到 /v1/chat/completions', () => { assert.equal(got.method, 'POST'); assert.equal(got.url, '/v1/chat/completions'); });
  check('带 model', () => assert.equal(got.body.model, 'qwen-vl-max'));
  check('图片以 image_url 的 data URL 递过去', () => {
    const parts = got.body.messages[0].content;
    const img = parts.find((p) => p.type === 'image_url');
    assert.ok(img, '没有 image_url 段');
    assert.match(img.image_url.url, /^data:image\/png;base64,/);
    assert.ok(img.image_url.url.includes(PNG.toString('base64')), 'data URL 里不是那张图的字节');
  });
  check('带 Authorization: Bearer（用识图模型自己的 key）', () => assert.equal(got.headers.authorization, 'Bearer sk-fake-vision-key'));
  check('提示词是中文描述指令', () => assert.match(got.body.messages[0].content.find((p) => p.type === 'text').text, /中文详细描述/));
  fake.server.close();
}

console.log('\n== ④ 无 key 时不带 Authorization（本机自建服务） ==');
{
  const fake = await startFakeVision((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '一张截图。' } }] }));
  });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${fake.port}/v1`, visionModel: 'local-vl' } });
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('拿到文字', () => assert.equal(d.ok, true));
  check('无 key → 没有 authorization 头', () => assert.equal(fake.seen[0].headers.authorization, undefined));
  fake.server.close();
}

console.log('\n== ⑤ 各种失败都降级不抛 ==');
{
  const fake = await startFakeVision((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model not found' } }));
  });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${fake.port}/v1`, visionModel: 'nope' } });
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('404 → ok:false 且带上状态码', () => { assert.equal(d.ok, false); assert.match(d.error, /HTTP 404/); });
  fake.server.close();
}
{
  const fake = await startFakeVision((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json at all'); });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${fake.port}/v1`, visionModel: 'x' } });
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('非 JSON → ok:false', () => { assert.equal(d.ok, false); assert.match(d.error, /合法 JSON/); });
  fake.server.close();
}
{
  const fake = await startFakeVision((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${fake.port}/v1`, visionModel: 'x' } });
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('空文字 → ok:false', () => { assert.equal(d.ok, false); assert.match(d.error, /没有可用的文字描述/); });
  fake.server.close();
}
{
  initVisionCore({ dsh: { visionBaseUrl: 'http://127.0.0.1:1/v1', visionModel: 'x' } });
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('连不上 → ok:false（不抛）', () => assert.equal(d.ok, false));
}
{
  initVisionCore({ dsh: { visionBaseUrl: 'ftp://example.com/v1', visionModel: 'x' } });
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('非 http/https → ok:false', () => { assert.equal(d.ok, false); assert.match(d.error, /只支持 http\/https/); });
}
{
  const fake = await startFakeVision((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '分段' }, { type: 'text', text: '内容' }] } }] })); });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${fake.port}/v1/chat/completions`, visionModel: 'x' } });
  check('地址已带 /chat/completions 不重复拼', () => assert.equal(visionEndpoint().url, `http://127.0.0.1:${fake.port}/v1/chat/completions`));
  const d = await describeImageWithVisionModel(PNG, 'image/png');
  check('content 是分段数组也能拼出文字', () => { assert.equal(d.ok, true); assert.equal(d.text, '分段内容'); });
  fake.server.close();
}

console.log('\n== ⑥ 真管道：resolveMediaList 交给 DSH 的内容到底变成什么 ==');
{
  // 真的调 media-pipe 里那个投递前用的函数（不是复刻逻辑），只把"从 NapCat 取图"换成假的
  const { initMediaPipeCore, setMediaPipeBot, resolveMediaList } = await import('../src/core/media-pipe.js');
  initMediaPipeCore({ napcat: { homeDir: '' } });
  setMediaPipeBot({ getImage: async () => ({ data: `base64://${PNG.toString('base64')}` }) });

  // ① 没配独立识图 → 老行为：一张图 = 一个文字占位 + 一个 image 段（附件）
  initVisionCore({ dsh: {} });
  const legacy = await resolveMediaList([{ kind: 'image', file: 'fake-cache.png' }]);
  check('未配置：仍是 [文字占位, image 附件]', () => {
    assert.equal(legacy.length, 2);
    assert.equal(legacy[0].type, 'text');
    assert.equal(legacy[1].type, 'image');
    assert.ok(legacy[1].data.length > 0);
  });

  // ② 配了独立识图 → 图片不进上下文，只有描述文字
  const fake = await startFakeVision((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '一张 1x1 的测试图，纯色。' } }] }));
  });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${fake.port}/v1`, visionModel: 'fake-vl', visionApiKey: 'sk-x' } });
  const withVision = await resolveMediaList([{ kind: 'image', file: 'fake-cache.png' }]);
  check('已配置：只剩 1 段，且是带描述的 text', () => {
    assert.equal(withVision.length, 1);
    assert.equal(withVision[0].type, 'text');
    assert.match(withVision[0].text, /^\[图片1\] /);
    assert.match(withVision[0].text, /1x1 的测试图/);
  });
  check('已配置：没有任何 image 段（图片没进上下文）', () => assert.equal(withVision.some((p) => p.type === 'image'), false));
  check('识图服务真的被调了一次', () => assert.equal(fake.seen.length, 1));
  fake.server.close();

  // ③ 识图服务挂了 → 退回附件，图不丢
  initVisionCore({ dsh: { visionBaseUrl: 'http://127.0.0.1:1/v1', visionModel: 'dead-vl' } });
  const degraded = await resolveMediaList([{ kind: 'image', file: 'fake-cache.png' }]);
  check('识图失败：退回 [文字占位, image 附件]', () => {
    assert.equal(degraded.length, 2);
    assert.equal(degraded[1].type, 'image');
  });

  // ④ 表情（face）不受影响：照旧用自己的文字 + 图片，不额外花识图额度
  const faceFake = await startFakeVision((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '不该被调用' } }] }));
  });
  initVisionCore({ dsh: { visionBaseUrl: `http://127.0.0.1:${faceFake.port}/v1`, visionModel: 'fake-vl' } });
  setMediaPipeBot({
    getImage: async () => ({ data: `base64://${PNG.toString('base64')}` }),
    fetchFaceEntity: async () => ({ url: '', q_des: '微笑', emoji_name_alias: [] }),
  });
  const faceParts = await resolveMediaList([{ kind: 'face', faceId: 14 }]);
  // 注：假 bot 没给可抓的图片 URL（safeFetchBuffer 会拒绝内网地址），所以这里断言的是
  // "表情照旧按它自己的文字走、**不**去调识图模型"，而不是"表情会变成 image 段"。
  check('表情：走自己的文字、不调识图模型', () => {
    assert.equal(faceFake.seen.length, 0, '表情不该调用识图模型');
    assert.equal(faceParts.some((p) => p.type === 'text' && /微笑/.test(p.text)), true);
    assert.equal(faceParts.some((p) => p.type === 'text' && /^\[图片/.test(p.text)), false, '表情不该被当成图片走识图');
  });
  faceFake.server.close();
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（通过 ${passed}，失败 ${failed}）`);
process.exit(failed === 0 ? 0 : 1);
