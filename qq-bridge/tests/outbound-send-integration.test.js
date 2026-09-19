// 出站正文形态：**端到端**回归（真起 console-server + 假 OneBot 端点收消息）
// 【2026-09-20 主人实测】
//   · 正文不许显式带换行（代码/诗歌除外）；
//   · 正文不许是"被序列化的工具参数数组"：能还原就还原成多条气泡，还原不了就 400 硬失败。
// 单元判据在 tests/outbound-format.test.js；这里跑的是"真发一次，看 OneBot 到底收到什么"。
// 跑法：node tests/outbound-send-integration.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = path.join(HERE, '.tmp-outbound-send');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-outbound-send-sandbox', private: true, type: 'module' }));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const onebotPort = await freePort();
const consolePort = await freePort();

// 假 OneBot：把每条真正被发出去的消息（文本段）记下来
const received = [];
const onebot = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    if (/send_(group|private)_msg/.test(String(req.url ?? ''))) received.push(parsed);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9000 + received.length } }));
  });
});
await new Promise((r) => onebot.listen(onebotPort, '127.0.0.1', r));

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
      smartQuoteEnabled: false, linearEnabled: false, burstMaxMessages: 8,
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
// 真发消息要初始化这两个：qq-send（OneBot 出口）与 social-flow（发出去要记账）
const qqSend = await import(modUrl('core/qq-send.js'));
qqSend.initQqSendCore(cfg);
const socialFlow = await import(modUrl('core/social-flow.js'));
socialFlow.initSocialFlowCore(cfg);
const consoleSrv = await import(modUrl('core/console-server.js'));
consoleSrv.initConsoleCore(cfg);
consoleSrv.setConsoleBot(null);
consoleSrv.startConsoleServer();

const KEY = 'group:868756515';
const TOKEN = '868756515';                    // 会话令牌 = 会话本体（群号），见 social-state.fixedTokenForKey
const posts = [];
const post = async (payload) => {
  const res = await fetch(`http://127.0.0.1:${consolePort}/api/social/send-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  posts.push({ status: res.status, json });
  return { status: res.status, json };
};
const textsOf = (batches) => batches.map((b) => (b.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join(''));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

// 等监听就绪（避免 CI 上抢跑）
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${consolePort}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
socialState.getSocialState(KEY);   // 建立会话（签发 agentToken）

// 现场原文：引号嵌套 → JSON.parse 必然失败
const SITE_RAW = '["直接跟我说就行", "比如"谬友圈活跃19点到23点"", "或者"所有群免打扰 0点到10点"", "我帮你设 ᗜ ‸ ᗜ"]';

await t('E2E1 现场原文（数组被序列化成字符串）→ 真的发出 4 条气泡，且都不含数组语法', async () => {
  received.length = 0;
  const r = await post({ key: KEY, messages: SITE_RAW });
  assert.equal(r.status, 200, `期望 200，实到 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(received.length, 4, `期望 4 条气泡，实到 ${received.length}`);
  assert.deepEqual(textsOf(received), [
    '直接跟我说就行',
    '比如"谬友圈活跃19点到23点"',
    '或者"所有群免打扰 0点到10点"',
    '我帮你设 ᗜ ‸ ᗜ',
  ]);
  for (const txt of textsOf(received)) assert.ok(!/^\[.*\]$/.test(txt.trim()), `气泡里不该有数组语法: ${txt}`);
});

await t('E2E2 还原不了（只剩引号）→ 400 硬失败，一条都不发', async () => {
  received.length = 0;
  const r = await post({ key: KEY, messages: '["", ""]' });
  assert.equal(r.status, 400, `期望 400，实到 ${r.status} ${JSON.stringify(r.json)}`);
  assert.match(String(r.json.error ?? ''), /被序列化的气泡数组/);
  assert.equal(received.length, 0, '硬失败时不该有任何消息发出去');
});

await t('E2E3 正文里的显式换行 → 真发出去时已经是一行', async () => {
  received.length = 0;
  const r = await post({ key: KEY, messages: '今天天气真好\n要不要出去玩' });
  assert.equal(r.status, 200, `期望 200，实到 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(received.length, 1);
  assert.equal(textsOf(received)[0], '今天天气真好要不要出去玩');
});

await t('E2E4 代码块原样保留换行', async () => {
  received.length = 0;
  const code = '```js\nconst a = 1;\nconsole.log(a);\n```';
  const r = await post({ key: KEY, messages: code });
  assert.equal(r.status, 200, `期望 200，实到 ${r.status}`);
  assert.equal(textsOf(received)[0], code);
});

await t('E2E5 单条气泡里嵌了数组（不是整条）→ 由 onebotSend 兜底拒发并报错', async () => {
  received.length = 0;
  const r = await post({ key: KEY, messages: ['好嘞', '["a","b"]'] });
  assert.equal(received.length, 1, '第 1 条正常气泡照发');
  assert.equal(textsOf(received)[0], '好嘞');
  assert.equal(r.status >= 400 || r.json.failed >= 1, true, `整批不该静默成功：${JSON.stringify(r.json)}`);
});

// 收尾：先断开 keep-alive 连接再关服务，避免 Windows 上 libuv 在进程退出时报 UV_HANDLE_CLOSING
try { onebot.closeAllConnections?.(); } catch {}
await new Promise((r) => onebot.close(() => r()));
// 沙箱不在这里删：console-server 起的 node:sqlite 连接要到进程结束才释放，Windows 上 rm 会 EPERM。
// 每次运行开头都会重建它（见文件顶部），并且 .gitignore 里已忽略 tests/.tmp-*/。
console.log(`outbound-send-integration: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
