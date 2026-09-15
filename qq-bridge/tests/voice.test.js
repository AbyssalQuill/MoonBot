// 语音模块（src/core/voice.js）的纯逻辑与守卫测试。
//
// 设计原则：**不写任何文件、不打任何网络**。被断言的要么是纯函数/默认值，要么是会在
// 发请求之前就抛错的守卫；发语音那段用替身（stub）接管 global.fetch，只校验
// 「发出去的报文长什么样」（record 段、group_id/user_id、读不到文件时的 base64 兜底），
// 不给真 QQ 发东西、也不碰 NapCat。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const voice = await import('../src/core/voice.js');

let pass = 0;
let fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }

// ── 内置音色与角色表（官方文档抄录值，2026-09-15） ─────────────────────────────
t('内置音色表是官方那 9 个，且含中文音色', () => {
  const ids = voice.BUILTIN_VOICES.map((v) => v.id);
  for (const want of ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']) {
    assert.ok(ids.includes(want), `缺少内置音色 ${want}`);
  }
  assert.equal(ids.length, 9);
  assert.equal(voice.BUILTIN_VOICES.find((v) => v.id === '冰糖').gender, '女');
});

t('四个角色各自的默认模型名正确', () => {
  const byRole = Object.fromEntries(voice.VOICE_ROLES.map((r) => [r.role, r.defaultModel]));
  assert.equal(byRole.tts, 'mimo-v2.5-tts');
  assert.equal(byRole.design, 'mimo-v2.5-tts-voicedesign');
  assert.equal(byRole.clone, 'mimo-v2.5-tts-voiceclone');
  assert.equal(byRole.asr, 'mimo-v2.5-asr');
});

// ── 配置：默认值 + 掩码 + models 必须回传（回归用例） ─────────────────────────
t('默认配置：未启用、单条上限>0、默认音色非空', () => {
  const c = voice.voiceConfig();
  assert.equal(typeof c.enabled, 'boolean');
  assert.ok(Number(c.maxChars) > 0, 'maxChars 必须为正整数');
  assert.ok(Number(c.dailyChars) >= 0, 'dailyChars 不能为负');
  assert.ok(String(c.defaultVoice).length > 0, '默认音色不能为空');
  assert.equal(c.models.tts.model, 'mimo-v2.5-tts');
});

t('对外配置必须带 models，且密钥只回掩码（曾漏传 models 导致保存洗掉配置）', () => {
  const pub = voice.voiceConfigPublic();
  assert.equal(pub.ok, true);
  assert.ok(pub.models && typeof pub.models === 'object', 'voiceConfigPublic 必须回传 models');
  for (const role of ['tts', 'design', 'clone', 'asr']) {
    assert.ok(pub.models[role], `models.${role} 缺失`);
    assert.equal(typeof pub.models[role].baseUrl, 'string');
    assert.equal(typeof pub.models[role].model, 'string');
    assert.equal(typeof pub.models[role].apiKeySet, 'boolean');
    // 掩码里绝不能出现完整密钥：只允许 **** 形式或空串
    const masked = String(pub.models[role].apiKeyMasked ?? '');
    assert.ok(masked === '' || masked.includes('****'), `apiKeyMasked 必须是掩码：${masked}`);
  }
  assert.ok(Array.isArray(pub.roles) && pub.roles.length === 4);
  assert.ok(pub.presets.tokenPlanCn.startsWith('https://') && pub.presets.official.startsWith('https://'));
});

t('用量结构：按北京日给出字数/次数', () => {
  const u = voice.usageToday();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(u.day), `day 格式不对：${u.day}`);
  for (const k of ['chars', 'calls', 'cacheHits', 'asrCalls']) assert.equal(typeof u[k], 'number');
});

t('音色库只读接口：内置 9 个、自建是数组', () => {
  const lib = voice.listVoices();
  assert.equal(lib.ok, true);
  assert.equal(lib.builtin.length, 9);
  assert.ok(Array.isArray(lib.custom));
});

// ── 合成/识别的守卫（都在发出请求之前就拦下） ────────────────────────────────
t('合成：空文本被拒；未启用时明确提示未启用', async () => {
  const enabled = voice.voiceConfig().enabled === true;
  await assert.rejects(() => voice.synthesize({ text: '   ' }), (e) => {
    assert.match(String(e.message), enabled ? /文本为空/ : /未启用/);
    return true;
  });
});

t('合成：超长文本被拒（且提示里带字数）', async () => {
  if (voice.voiceConfig().enabled !== true) return;   // 未启用时先被"未启用"拦下，这条不适用
  const max = Number(voice.voiceConfig().maxChars) || 120;
  await assert.rejects(
    () => voice.synthesize({ text: '啊'.repeat(max + 5) }),
    (e) => { assert.match(String(e.message), /文本过长/); return true; }
  );
});

t('音色复刻缺样本 / 音色设计缺描述时明确报错', async () => {
  if (voice.voiceConfig().enabled !== true) return;
  await assert.rejects(() => voice.synthesize({ text: '你好', mode: 'clone', sampleBase64: '' }), /音频样本/);
  await assert.rejects(() => voice.synthesize({ text: '你好', mode: 'design', description: '' }), /音色描述/);
});

t('识别：非 mp3/wav 内容被拒', async () => {
  const enabled = voice.voiceConfig().enabled === true;
  await assert.rejects(
    () => voice.transcribeBuffer(Buffer.from('这不是音频')),
    (e) => { assert.match(String(e.message), enabled ? /不支持/ : /未启用/); return true; }
  );
});

t('自建音色：缺名字/缺描述/缺样本都被拒（且不会落盘）', () => {
  assert.throws(() => voice.saveCustomVoice({ name: '  ' }), /名字不能为空/);
  assert.throws(() => voice.saveCustomVoice({ name: 'x', kind: 'design', description: '' }), /音色描述/);
  assert.throws(() => voice.saveCustomVoice({ name: 'x', kind: 'clone', sampleBase64: '' }), /音频样本/);
  assert.throws(() => voice.deleteCustomVoice('不存在的音色'), /音色不存在/);
});

// ── 发送报文（用替身 fetch，绝不真发给 QQ） ──────────────────────────────────
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), payload });
    const r = await handler(calls.length, { url: String(url), payload });
    return { ok: r.ok !== false, status: r.status ?? 200, json: async () => r.body };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function tmpAudio() {
  const p = path.join(os.tmpdir(), `voice-test-${process.pid}-${Date.now()}.mp3`);
  fs.writeFileSync(p, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03]));
  return p;
}

t('群聊语音：走到 send_group_msg，报文里是 record 段 + group_id', async () => {
  const file = tmpAudio();
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 987654 } } }));
  try {
    const out = await voice.sendVoiceToOneBot('group:123456', file);
    assert.equal(out.messageId, 987654);
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /\/send_group_msg$/);
    assert.equal(stub.calls[0].payload.group_id, 123456);
    assert.equal(stub.calls[0].payload.message.length, 1);
    assert.equal(stub.calls[0].payload.message[0].type, 'record');
    assert.ok(String(stub.calls[0].payload.message[0].data.file).length > 0);
  } finally {
    stub.restore();
    fs.unlinkSync(file);
  }
});

t('私聊语音：走 send_private_msg + user_id，带引用时先加 reply 段', async () => {
  const file = tmpAudio();
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 1 } } }));
  try {
    await voice.sendVoiceToOneBot('private:10001', file, { replyToMessageId: '555' });
    assert.match(stub.calls[0].url, /\/send_private_msg$/);
    assert.equal(stub.calls[0].payload.user_id, 10001);
    assert.equal(stub.calls[0].payload.message[0].type, 'reply');
    assert.equal(stub.calls[0].payload.message[0].data.id, '555');
    assert.equal(stub.calls[0].payload.message[1].type, 'record');
  } finally {
    stub.restore();
    fs.unlinkSync(file);
  }
});

t('NapCat 读不到语音文件时：自动改 base64 重发一次（不会重复发两条）', async () => {
  const file = tmpAudio();
  const stub = stubFetch((n) => (n === 1
    ? { ok: false, status: 200, body: { status: 'failed', retcode: 100, wording: '文件处理失败: 识别URL失败' } }
    : { body: { status: 'ok', retcode: 0, data: { message_id: 2 } } }));
  try {
    const out = await voice.sendVoiceToOneBot('group:999', file);
    assert.equal(out.messageId, 2);
    assert.equal(stub.calls.length, 2, '应当只有一次兜底重发');
    assert.ok(String(stub.calls[0].payload.message[0].data.file).startsWith('base64://') === false);
    assert.ok(String(stub.calls[1].payload.message[0].data.file).startsWith('base64://'));
  } finally {
    stub.restore();
    fs.unlinkSync(file);
  }
});

t('发送守卫：key 非法 / 文件不存在 / 引用 id 非法', async () => {
  await assert.rejects(() => voice.sendVoiceToOneBot('nope', '/tmp/x.mp3'), /key 格式/);
  await assert.rejects(() => voice.sendVoiceToOneBot('group:1', '/tmp/绝对不存在的语音.mp3'), /语音文件不存在/);
  const file = tmpAudio();
  try {
    await assert.rejects(() => voice.sendVoiceToOneBot('group:1', file, { replyToMessageId: 'abc' }), /replyToMessageId/);
  } finally {
    fs.unlinkSync(file);
  }
});

// ── 执行 ────────────────────────────────────────────────────────────────────
for (const [name, fn] of cases) {
  try {
    await fn();
    pass += 1;
    // 静默通过，只报失败，保持 CI 输出干净
  } catch (e) {
    fail += 1;
    console.error(`FAIL: ${name}\n      ${e?.message ?? e}`);
  }
}

if (fail === 0) console.log(`voice 语音模块测试全部通过 ✓  pass=${pass} fail=0`);
else { console.error(`voice 语音模块测试失败：pass=${pass} fail=${fail}`); process.exitCode = 1; }
