// 「全语音发送模式」（state/voice-config.json 的 send.allVoice）回归测试。
//
// 设计原则与 tests/voice.test.js 一致：**不给真 QQ 发东西、不打真网络**（global.fetch 全被替身接管，
// 因此哪怕本机配了真的语音服务，也不可能真的发出去），并且**不写 state 下的配置/额度文件**
// （合成一律在失败前置检查处抛错，走不到 bumpUsage/写缓存那一步；语音缓存目录被指到系统临时目录）。
// 唯一会被 append 的是桥日志 state/bridge.log —— 与既有 voice.test.js 的表现一致，那里本来就写着日志。
//
// 覆盖主人点名的三条硬约束：
//   ① allVoice 缺失（老配置）→ 行为与现在一致：不发语音、不打合成接口；
//   ② allVoice=true 且合成失败 → **退回文字且不丢消息**（文字必须真的落到 send_group_msg）；
//   ③ allVoice=true 且超过 dailyChars → 退回文字，并在日志里写明额度原因（而且**不该再打合成接口**）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const voice = await import('../src/core/voice.js');
const qqSend = await import('../src/core/qq-send.js');

let pass = 0;
let fail = 0;
const cases = [];
/** 运行备注：端到端用例真的跑了还是被跳过了，必须看得见（别让"全绿"骗人）。 */
const notes = [];
function t(name, fn) { cases.push([name, fn]); }

// ── 替身与工具 ───────────────────────────────────────────────────────────────

/** fetch 替身：语音合成走 res.text()，OneBot 发送走 res.json()，两个都给上。 */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const rec = { url: String(url), payload: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(rec);
    const r = await handler(calls.length, rec);
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.body ?? {}))
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 抓桥日志（lib/log.js 会 console.log）：用来断言"回退时留下了一行带原因的日志"。 */
function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  return {
    lines,
    restore: () => { console.log = original; },
    has: (re) => lines.some((l) => re.test(l))
  };
}

const isSynth = (c) => /\/chat\/completions$/.test(c.url);
const isGroupSend = (c) => /\/send_group_msg$/.test(c.url);

/** 缓存目录：必须落到系统临时目录，绝不能在仓库 state/ 下建目录。 */
const TMP_DIR = path.join(os.tmpdir(), `qq-bridge-allvoice-${process.pid}`);

/** 一份"全语音已开、语音服务在 127.0.0.1 无人监听"的配置（配合 fetch 替身用，永不真连）。 */
function allVoiceCfg(over = {}) {
  return {
    enabled: true,
    cacheEnabled: false,
    maxChars: 120,
    dailyChars: 20000,
    defaultVoice: '冰糖',
    send: { allVoice: true, probability: 0.2, cooldownMs: 600000 },
    models: {
      tts: { baseUrl: 'http://127.0.0.1:59999/v1', apiKey: 'unit-test-key', model: 'mimo-v2.5-tts' },
      design: {}, clone: {}, asr: {}
    },
    ...over
  };
}

/** 让 sendMessages 能跑起来的最小桥配置（不给真 NapCat 发东西：fetch 已被替身接管）。 */
qqSend.initQqSendCore({
  sendDelayMs: 0,
  social: { send: { smartQuoteEnabled: false, linearEnabled: false } },
  napcat: { httpUrl: 'http://127.0.0.1:3000' }
});

// ── ① 开关缺失 = 关闭（老用户行为不变） ──────────────────────────────────────

t('allVoice 缺失/非布尔 true → 一律按关闭处理（容错，绝不影响回复发送）', () => {
  assert.equal(voice.allVoiceEnabled({}), false, '空配置必须视为关闭');
  assert.equal(voice.allVoiceEnabled({ send: {} }), false, 'send 段里没有 allVoice = 关闭');
  assert.equal(voice.allVoiceEnabled({ send: { probability: 0.2, cooldownMs: 600000 } }), false, '老配置 = 关闭');
  // 严格布尔：字符串/数字一律不算开（"false" 是真值，宽松判定会把老用户的文字回复全变成语音）
  assert.equal(voice.allVoiceEnabled({ send: { allVoice: 'true' } }), false);
  assert.equal(voice.allVoiceEnabled({ send: { allVoice: 1 } }), false);
  assert.equal(voice.allVoiceEnabled({ send: { allVoice: true } }), true);
  // 配置读取炸了也不能抛（绝不能因此让回复发不出去）
  assert.equal(voice.allVoiceEnabled({ get send() { throw new Error('boom'); } }), false);
});

t('对外配置会回读 allVoice（前端渲染开关要用），且与生效判定一致', () => {
  const pub = voice.voiceConfigPublic();
  assert.equal(typeof pub.send.allVoice, 'boolean');
  assert.equal(typeof pub.send.probability, 'number');
  assert.equal(typeof pub.send.cooldownMs, 'number');
  // ⚠️ 这里**故意不断言** ambient 必须为 false：主人可能正开着全语音模式自测，
  // 测试不该因为磁盘上的开关状态而变红。"默认关闭"由上一条用显式 cfg（{} / 缺字段）钉死。
  assert.equal(pub.send.allVoice, voice.allVoiceEnabled(), '对外配置必须与生效值一致');
});

t('开关关闭时：tryAllVoiceReply 空转，一次合成接口都不打（= 与现在行为一致）', async () => {
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 1 } } }));
  const logs = captureLog();
  try {
    const r = await voice.tryAllVoiceReply('group:10000', '你好呀', { cfg: allVoiceCfg({ send: { probability: 0.2, cooldownMs: 600000 } }) });
    assert.equal(r.ok, false);
    assert.equal(r.off, true, '未开启要标记 off，调用方据此不打日志');
    assert.equal(stub.calls.length, 0, '开关关闭时不该发出任何请求');
    assert.equal(logs.lines.length, 0, '开关关闭时不该刷日志（这是每条消息都会经过的路径）');
  } finally {
    logs.restore();
    stub.restore();
  }
});

t('开关关闭时：sendMessages 仍然只发文字（老路径一字不变）', async () => {
  // 显式注入一份"关闭"的配置：只有它真的生效时这条才有意义
  // （磁盘上的 state/voice-config.json 优先级更高，若存过 true 会盖过注入 → 这时跳过并说明）
  voice.initVoiceCore({
    napcat: { httpUrl: 'http://127.0.0.1:3000', tmpDir: TMP_DIR },
    voice: { enabled: true, send: { allVoice: false, probability: 0.2, cooldownMs: 600000 } }
  });
  if (voice.allVoiceEnabled()) {
    notes.push('· 关闭路径的端到端用例【已跳过】：本机 state/voice-config.json 里 send.allVoice=true（注入的 false 被磁盘配置覆盖）');
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });
    return;
  }
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 777 } } }));
  try {
    const sent = await qqSend.sendMessages('group:10009', ['文字回复'], [], null, null);
    assert.equal(stub.calls.filter(isSynth).length, 0, '不该尝试合成');
    const textCall = stub.calls.find(isGroupSend);
    assert.ok(textCall, '必须走文字发送');
    assert.equal(textCall.payload.message[0].data.text, '文字回复');
    assert.equal(sent[0].messageId, '777');
    assert.ok(!sent[0].voice, '不该被标记成语音');
    notes.push('✓ 关闭路径端到端用例【已执行】：allVoice 关闭 → 只发文字、不碰语音接口');
  } finally {
    stub.restore();
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });
  }
});

// ── ② 全语音开启 + 合成失败 → 退回文字，不丢消息 ─────────────────────────────

t('全语音 + 合成失败 → 退回文字且不丢消息（走完整发送链，日志写明原因）', async () => {
  // 注入一份"全语音已开、语音服务必然 500"的配置。initVoiceCore 的 voice 段优先级**低于**
  // state/voice-config.json，所以本机若显式存过 allVoice=false（或总开关没开），这条会先被跳过 —— 见下。
  voice.initVoiceCore({
    napcat: { httpUrl: 'http://127.0.0.1:3000', tmpDir: TMP_DIR },
    voice: {
      enabled: true,
      cacheEnabled: false,
      maxChars: 120,
      dailyChars: 20000,
      defaultVoice: '冰糖',
      send: { allVoice: true, probability: 0.2, cooldownMs: 600000 },
      models: { tts: { baseUrl: 'http://127.0.0.1:59999/v1', apiKey: 'unit-test-key', model: 'mimo-v2.5-tts' } }
    }
  });
  if (!voice.allVoiceEnabled()) {
    notes.push('⚠️ 端到端用例【已跳过】：本机 state/voice-config.json 里 send.allVoice 显式不是 true，注入被磁盘配置覆盖');
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });
    return;
  }
  notes.push('✓ 端到端用例【已执行】：全语音已开 → 合成失败时必须退回文字（不丢消息）');
  const stub = stubFetch((n, c) => (isSynth(c)
    ? { ok: false, status: 500, body: { error: { message: '合成服务炸了' } } }   // 合成必然失败
    : { body: { status: 'ok', retcode: 0, data: { message_id: 4242 } } }));
  const logs = captureLog();
  try {
    const sent = await qqSend.sendMessages('group:10001', ['你好呀，今天出去玩吗'], [], null, null);
    logs.restore();
    assert.ok(stub.calls.some(isSynth), '应当先尝试过语音合成');
    assert.ok(
      logs.has(/\[voice\] 全语音模式：合成失败，退回文字（原因：.*）/) || logs.has(/\[voice\] 全语音模式：语音发送失败，退回文字/),
      `日志里必须有一行带原因的退回记录，实际：\n${logs.lines.join('\n')}`
    );
    const textCall = stub.calls.find(isGroupSend);
    assert.ok(textCall, '合成失败后必须退回文字发送（不丢消息）');
    assert.equal(textCall.payload.group_id, 10001);
    assert.equal(textCall.payload.message[0].type, 'text');
    assert.equal(textCall.payload.message[0].data.text, '你好呀，今天出去玩吗');
    assert.equal(sent.length, 1, '必须有一条发送记录');
    assert.equal(sent[0].messageId, '4242');
    assert.ok(!sent[0].voice, '这条是文字，不该标成语音');
  } finally {
    logs.restore();
    stub.restore();
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });   // 收尾：撤掉注入的全语音配置
  }
});

t('全语音 + 本条带图 → 不转语音（转了就丢图），图文原样发出', async () => {
  const imgPath = path.join(TMP_DIR, 'pic.png');
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 515 } } }));
  const logs = captureLog();
  try {
    const r = await voice.tryAllVoiceReply('group:10002', '看这张图', { hasMedia: true, cfg: allVoiceCfg() });
    logs.restore();
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /带图/);
    assert.equal(stub.calls.length, 0, '带图时不该打合成接口');
    assert.ok(logs.has(/\[voice\] 全语音模式：.*带图.*退回文字/), '必须留下带原因的日志');
  } finally {
    logs.restore();
    stub.restore();
    try { fs.unlinkSync(imgPath); } catch {}
  }
});

t('全语音 + 超出单条上限 / 没有可朗读文本 / 含链接 → 都退回文字并说明原因', async () => {
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 1 } } }));
  const logs = captureLog();
  try {
    const long = await voice.tryAllVoiceReply('group:10003', '啊'.repeat(200), { cfg: allVoiceCfg({ maxChars: 120 }) });
    assert.equal(long.ok, false);
    assert.match(String(long.reason), /超过单条语音上限 120 字/);
    const empty = await voice.tryAllVoiceReply('group:10003', '   ', { cfg: allVoiceCfg() });
    assert.equal(empty.ok, false);
    assert.match(String(empty.reason), /没有可朗读的文本/);
    const link = await voice.tryAllVoiceReply('group:10003', '来听这首 https://i.y.qq.com/x', { cfg: allVoiceCfg() });
    assert.equal(link.ok, false);
    assert.match(String(link.reason), /链接|CQ/);
    logs.restore();
    assert.equal(stub.calls.length, 0, '三种情况都不该打合成接口');
    assert.equal(logs.lines.filter((l) => /\[voice\] 全语音模式：/.test(l)).length, 3, '每种退回都要有一条日志');
  } finally {
    logs.restore();
    stub.restore();
  }
});

// ── ③ 全语音 + 当日额度用尽 → 退回文字并记录原因 ─────────────────────────────

t('全语音 + 当日额度用尽 → 退回文字，日志写明额度原因，且不再打合成接口', async () => {
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 1 } } }));
  const logs = captureLog();
  try {
    // dailyChars=1 时"已用 0 字 + 本条 7 字 > 1"必然成立，与磁盘上的真实用量无关（确定性）
    const r = await voice.tryAllVoiceReply('group:10004', '今天天气不错呀', { cfg: allVoiceCfg({ dailyChars: 1 }) });
    logs.restore();
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /额度已用尽/);
    assert.equal(stub.calls.filter(isSynth).length, 0, '额度用尽必须**在请求之前**就退回，不该打合成接口');
    assert.ok(
      logs.has(/\[voice\] 全语音模式：合成失败，退回文字（原因：.*额度已用尽.*）/),
      `日志必须写明额度原因，实际：\n${logs.lines.join('\n')}`
    );
  } finally {
    logs.restore();
    stub.restore();
  }
});

t('全语音 + 当日额度用尽：sendMessages 里同样落到文字发送（不丢消息）', async () => {
  voice.initVoiceCore({
    napcat: { httpUrl: 'http://127.0.0.1:3000', tmpDir: TMP_DIR },
    voice: {
      enabled: true,
      cacheEnabled: false,
      maxChars: 120,
      dailyChars: 1,          // 必然用尽：0 字已用 + 本条 > 1
      defaultVoice: '冰糖',
      send: { allVoice: true, probability: 0.2, cooldownMs: 600000 },
      models: { tts: { baseUrl: 'http://127.0.0.1:59999/v1', apiKey: 'unit-test-key', model: 'mimo-v2.5-tts' } }
    }
  });
  // 两个前提都必须真的生效，这条端到端才有意义：① 全语音已开；② 生效的 dailyChars 就是注入的 1
  // （磁盘上的 state/voice-config.json 优先级更高，会盖过注入 → 这时跳过并说明，绝不假装通过）
  if (!voice.allVoiceEnabled() || Number(voice.voiceConfig().dailyChars) !== 1) {
    notes.push('⚠️ 端到端用例【已跳过】：本机 state/voice-config.json 盖过了注入（allVoice 或 dailyChars 对不上）');
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });
    return;
  }
  notes.push('✓ 端到端用例【已执行】：额度用尽 → sendMessages 落到文字发送');
  const stub = stubFetch(() => ({ body: { status: 'ok', retcode: 0, data: { message_id: 6262 } } }));
  const logs = captureLog();
  try {
    const sent = await qqSend.sendMessages('group:10005', ['额度用尽也要发出来'], [], null, null);
    logs.restore();
    assert.equal(stub.calls.filter(isSynth).length, 0, '额度用尽不该打合成接口');
    const textCall = stub.calls.find(isGroupSend);
    assert.ok(textCall, '必须退回文字发送');
    assert.equal(textCall.payload.message[0].data.text, '额度用尽也要发出来');
    assert.ok(logs.has(/额度已用尽/), `日志必须写明额度原因，实际：\n${logs.lines.join('\n')}`);
    assert.equal(sent.length, 1);
  } finally {
    logs.restore();
    stub.restore();
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });
  }
});

// ── ④ 成功路径（默认不跑，见说明） ───────────────────────────────────────────
//
// 为什么默认关闭：语音**成功**这一路会调 bumpUsage()，也就是写 state/voice-usage.json ——
// 那是"真实每日额度"计数器，桥在运行时也随时会写它。测试去动它有两个后果：
//   ① 会吃掉主人当天的真实额度；② 与正在跑的桥抢写同一个文件。
// 所以默认只做"不落盘"的失败/回退链；要验成功路径时用 DSH_ALLVOICE_E2E=1 单独跑，
// 或者（推荐）把 src/ 与 package.json 复制到一个临时目录里跑 —— 那样 usage 文件写在临时目录里，
// 仓库的 state/ 一点都不会被动到。成功路径已验证过：合成 → record 段 → send_group_msg，且不发文字。
t('成功路径（需 DSH_ALLVOICE_E2E=1）：合成成功 → record 段发出，不再发文字', async () => {
  if (process.env.DSH_ALLVOICE_E2E !== '1') {
    notes.push('· 成功路径用例未跑（默认关闭，避免写 state/voice-usage.json 吃掉真实额度；DSH_ALLVOICE_E2E=1 可单独跑）');
    return;
  }
  voice.initVoiceCore({
    napcat: { httpUrl: 'http://127.0.0.1:3000', tmpDir: TMP_DIR },
    voice: {
      enabled: true,
      cacheEnabled: false,
      maxChars: 120,
      dailyChars: 20000,
      defaultVoice: '冰糖',
      send: { allVoice: true, probability: 0.2, cooldownMs: 600000 },
      models: { tts: { baseUrl: 'http://127.0.0.1:59999/v1', apiKey: 'unit-test-key', model: 'mimo-v2.5-tts' } }
    }
  });
  if (!voice.allVoiceEnabled()) {
    notes.push('⚠️ 成功路径用例【已跳过】：本机 state/voice-config.json 里 send.allVoice 显式不是 true');
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });
    return;
  }
  const stub = stubFetch((n, c) => {
    if (isSynth(c)) {
      const b64 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11]).toString('base64');
      const body = { choices: [{ message: { audio: { data: b64 } } }] };
      return { body, text: JSON.stringify(body) };      // 合成读 res.text()，两个都给上
    }
    return { body: { status: 'ok', retcode: 0, data: { message_id: 8888 } } };
  });
  const logs = captureLog();
  try {
    const sent = await qqSend.sendMessages('group:10006', ['今天天气不错呀'], [], null, null);
    logs.restore();
    const sendCall = stub.calls.find(isGroupSend);
    assert.ok(sendCall, '必须走 send_group_msg');
    assert.equal(sendCall.payload.message.length, 1);
    assert.equal(sendCall.payload.message[0].type, 'record', '全语音模式下发出去的必须是 QQ 语音段');
    assert.equal(sent[0].voice, true);
    assert.equal(sent[0].text, '[语音] 今天天气不错呀');
    assert.equal(sent[0].messageId, '8888');
    assert.ok(logs.has(/\[voice\] 全语音模式：已用语音发出/), '必须留下"已用语音发出"的日志');
    notes.push('✓ 成功路径用例【已执行】（本次写了 state/voice-usage.json，因为显式开了 DSH_ALLVOICE_E2E=1）');
  } finally {
    logs.restore();
    stub.restore();
    voice.initVoiceCore({ napcat: { tmpDir: TMP_DIR } });
  }
});

// ── 唤醒提示词（voiceTurnHint） ──────────────────────────────────────────────

t('唤醒提示词：全语音模式写"必须用语音"，平时保持原样（不掷骰）', () => {
  // 提示词这一支没法脱离真实配置注入（voiceTurnHint 内部现读配置），所以按"本机生效值"分两路校验：
  // 开了全语音 → 必须出现 ALL-VOICE 指令；没开 → 一个字都不许出现（老用户提示词不变）。
  const hint = voice.voiceTurnHint('private:1');
  if (voice.allVoiceEnabled()) {
    assert.match(hint, /ALL-VOICE MODE ON/);
    assert.match(hint, /VOICE bubble/);
    assert.match(hint, /hard limit \d+ chars/);
  } else {
    assert.doesNotMatch(hint, /ALL-VOICE/, '未开启时不得注入全语音指令');
  }
});

// ── 执行 ────────────────────────────────────────────────────────────────────

for (const [name, fn] of cases) {
  try {
    await fn();
    pass += 1;   // 静默通过，只报失败，保持输出干净
  } catch (e) {
    fail += 1;
    console.error(`FAIL: ${name}\n      ${e?.message ?? e}`);
  }
}

// 收尾：临时缓存目录（synthesize 的 ensureDir 可能在失败前建出来）清掉，仓库里不留痕迹
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

for (const n of notes) console.log(`  ${n}`);
if (fail === 0) console.log(`全语音模式测试全部通过 ✓  pass=${pass} fail=0`);
else { console.error(`全语音模式测试失败：pass=${pass} fail=${fail}`); process.exitCode = 1; }
