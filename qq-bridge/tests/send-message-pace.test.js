// qq_send_message 的「内置线性延迟」：端到端回归（真起 console-server + 假 OneBot 量到达时间）
//
// 为什么必须有这个测试：模型的多气泡回复是**一次工具调用发一条气泡**（线上实测 342 次调用 / 0 次一次带多条），
// 所以"按批内第几条计算间隔"的写法在真实形态下恒等于不延迟（每条都被当成批内首条 → 0ms）。
// 判据必须落在"真的发出去了、并且真的等了"上，而不是只测 send-chain 的纯函数：
//   · 单条消息：发出前应等 字数 × linearPerCharMs（本测试用 100ms/字、抖动 0 → 精确值）；
//   · 两条消息：第 2 条自己也按自己的字数等，且两条在假 OneBot 侧的到达间隔也应 ≥ 第 2 条的字数 × 每字毫秒；
//   · 太短的气泡被 linearMinMs 抬起来（下限生效）。
// 跑法：node tests/send-message-pace.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 沙箱：固定名删不掉就退回带 pid 的名字（Windows 上 node:sqlite 的连接要到进程结束才释放）。
let sandbox = path.join(HERE, '.tmp-send-message-pace');
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  sandbox = path.join(HERE, `.tmp-send-message-pace-${process.pid}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-send-pace-sandbox', private: true, type: 'module' }));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const onebotPort = await freePort();
const consolePort = await freePort();

// 假 OneBot：记下每条真发出去的消息 + 到达时刻（到达间隔就是"有没有等"的直接证据）
const arrived = [];
const onebot = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    if (/send_(group|private)_msg/.test(String(req.url ?? ''))) {
      const text = (parsed.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join('');
      arrived.push({ text, at: Date.now() });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9000 + arrived.length } }));
  });
});
await new Promise((r) => onebot.listen(onebotPort, '127.0.0.1', r));

const PER_CHAR = 100;      // 每字 100ms；抖动关掉 → 期望值可以是精确数字
const MIN_MS = 250;
const cfg = {
  ownerQQ: '100001',
  consolePort,
  sendDelayMs: 0,
  napcat: { httpUrl: `http://127.0.0.1:${onebotPort}`, accessToken: '' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: {}, deny: {}, allowAllWhenEmpty: true,
  social: {
    tools: {},
    send: {
      linearEnabled: true,
      linearPerCharMs: PER_CHAR,
      linearMinMs: MIN_MS,
      linearCapMs: 4000,
      linearJitterRatio: 0,
      maxMessageChars: 1000, maxSendPerMinute: 0, maxSendPerHour: 0,
    },
  },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));

const modUrl = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const socialState = await import(modUrl('core/social-state.js'));
socialState.initSocialCore(cfg);
const modeMod = await import(modUrl('core/mode.js'));
modeMod.initModeCore(cfg);
const qqSend = await import(modUrl('core/qq-send.js'));
qqSend.initQqSendCore(cfg);
const socialFlow = await import(modUrl('core/social-flow.js'));
socialFlow.initSocialFlowCore(cfg);
const consoleSrv = await import(modUrl('core/console-server.js'));
consoleSrv.initConsoleCore(cfg);
consoleSrv.setConsoleBot(null);
consoleSrv.startConsoleServer();

const KEY = 'group:868756515';
const TOKEN = '868756515';
const post = async (payload) => {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${consolePort}/api/social/send-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, elapsed: Date.now() - t0 };
};

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${consolePort}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
socialState.getSocialState(KEY);

// 单条：字数 × 每字毫秒（下限之上）
const ONE = '这是一条用来量延迟的测试消息呀';   // 15 字
await t(`P1 单条 ${[...ONE].length} 字 → 发出前等 ≈ ${[...ONE].length * PER_CHAR}ms（内置延迟真的生效）`, async () => {
  arrived.length = 0;
  const len = [...ONE].length;
  const expect = Math.max(MIN_MS, len * PER_CHAR);
  const r = await post({ key: KEY, messages: ONE });
  assert.equal(r.status, 200, `期望 200，实到 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(arrived.length, 1, `应发出 1 条，实到 ${arrived.length}`);
  assert.equal(arrived[0].text, ONE, '正文必须原样');
  assert.ok(r.elapsed >= expect - 150, `应至少等 ${expect - 150}ms，实际 ${r.elapsed}ms（内置延迟没生效？）`);
  assert.ok(r.elapsed <= expect + 1500, `等待 ${r.elapsed}ms 超出合理上界（${expect}+1500）`);
});

// 两条：各自按自己的字数等（第 1 条也等 —— 这正是"批内首条秒回"写法吃不到的那部分）
const A = '第一条短句';                                          // 5 字 → 被下限抬到 250
const B = '第二条明显长很多很多很多很多很多很多很多很多';        // 24 字 → 2400
await t('P2 两条一起发 → 每条各等自己的打字时间，假 OneBot 侧到达间隔 ≥ 第 2 条字数×100ms', async () => {
  arrived.length = 0;
  const lenA = [...A].length, lenB = [...B].length;
  const waitA = Math.max(MIN_MS, lenA * PER_CHAR);
  const waitB = Math.max(MIN_MS, lenB * PER_CHAR);
  const r = await post({ key: KEY, messages: [A, B] });
  assert.equal(r.status, 200, `期望 200，实到 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(arrived.length, 2, `应发出 2 条，实到 ${arrived.length}`);
  assert.deepEqual(arrived.map((x) => x.text), [A, B], '顺序必须是模型给的顺序');
  const gap = arrived[1].at - arrived[0].at;
  assert.ok(gap >= waitB - 250, `第 2 条应等自己的字数（≥${waitB - 250}ms），实际间隔 ${gap}ms`);
  assert.ok(r.elapsed >= waitA + waitB - 400, `整批应至少等 ${waitA + waitB - 400}ms，实际 ${r.elapsed}ms`);
});

// 下限：2 字 × 100ms = 200ms < linearMinMs 250 → 抬到 250
await t(`P3 2 字气泡 → 被 linearMinMs（${MIN_MS}ms）抬起，而不是 200ms`, async () => {
  arrived.length = 0;
  const r = await post({ key: KEY, messages: '收到' });
  assert.equal(r.status, 200);
  assert.equal(arrived.length, 1);
  assert.ok(r.elapsed >= MIN_MS - 120, `下限 ${MIN_MS}ms 应生效，实际 ${r.elapsed}ms`);
  assert.ok(r.elapsed < 1500, `2 字不该等这么久，实际 ${r.elapsed}ms`);
});

try { onebot.closeAllConnections?.(); } catch {}
await new Promise((r) => onebot.close(() => r()));
console.log(`send-message-pace: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
