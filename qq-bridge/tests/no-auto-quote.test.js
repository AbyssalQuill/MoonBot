// 「引用只能来自模型」+「跨会话发送必须显式声明」——端到端回归
// 2026-09-20 约定：
//   ① 桥不再自己猜着加引用（旧 pickSmartQuote 已删除）：没传 replyToMessageId 就不许有任何引用框；
//      传了就必须原样带上（别把显式的引用悄悄摘掉）。
//   ② 防「pixiv 发图发错群」：带 A 会话令牌却要发到 B 会话 → 403（把两个会话都报出来），
//      只有显式 crossSession:true 才放行。
// 真起 console-server + 假 OneBot，看 OneBot 究竟收到了什么段。
// 跑法：node tests/no-auto-quote.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let sandbox = path.join(HERE, '.tmp-no-auto-quote');
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  sandbox = path.join(HERE, `.tmp-no-auto-quote-${process.pid}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-no-auto-quote-sandbox', private: true, type: 'module' }));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const onebotPort = await freePort();
const consolePort = await freePort();

const received = [];
const onebot = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    if (/send_(group|private)_msg/.test(String(req.url ?? ''))) received.push({ url: req.url, ...parsed });
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
    send: { linearEnabled: false, burstMaxMessages: 8, maxMessageChars: 1000, maxSendPerMinute: 0, maxSendPerHour: 0 },
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
/* 引用解析要能拿到"被引用那条消息"：真实运行走 OneBot 的 get_msg。这里给一个最小假 bot，
 * 只实现 get_msg（返回群归属 + 发送者 + 文本），让"显式引用"那条路真的能发出引用段。 */
const fakeBot = {
  async getMessage(id) {
    const map = {
      610061: { group_id: 868756515, user_id: 2001, sender: { user_id: 2001, nickname: '甲' }, message: [{ type: 'text', data: { text: '三角洲我玩得菜' } }] },
      620062: { group_id: 868756515, user_id: 2002, sender: { user_id: 2002, nickname: '乙' }, message: [{ type: 'text', data: { text: '在干嘛呢' } }] },
    };
    return map[Number(id)] ?? null;
  },
};
consoleSrv.setConsoleBot(fakeBot);
const messageCache = await import(modUrl('core/message-cache.js'));
messageCache.setMessageCacheBot(fakeBot);
consoleSrv.startConsoleServer();
const textSafe = await import(modUrl('lib/text-safe.js'));

const KEY = 'group:868756515';
const TOKEN = '868756515';                       // 会话令牌 = 会话本体（群号）
const OTHER_KEY = 'private:100002';
const OTHER_TOKEN = '100002';

for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${consolePort}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const st = socialState.getSocialState(KEY);
const stOther = socialState.getSocialState(OTHER_KEY);
socialState.getSocialState('private:100001');

const post = async (payload, token = TOKEN) => {
  const res = await fetch(`http://127.0.0.1:${consolePort}/api/social/send-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};
const replySegs = (batch) => (batch.message || []).filter((s) => s && s.type === 'reply').map((s) => String(s.data?.id));
const texts = (batch) => (batch.message || []).filter((s) => s && s.type === 'text').map((s) => s.data.text).join('');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

// 造出"旧实现一定会自动引用"的局面：本回合投递过两条对端消息，候选里有一条和回复有共同词。
const seedQuoteCandidates = () => {
  const now = Date.now();
  st.recentMessages = [
    { isSelf: false, userId: '2001', seq: 61, messageId: 610061, time: now - 60000, plain: '三角洲我玩得菜', text: '三角洲我玩得菜' },
    { isSelf: false, userId: '2002', seq: 62, messageId: 620062, time: now - 30000, plain: '在干嘛呢', text: '在干嘛呢' },
  ];
  st.turnSeenUnread = [61, 62];
  st.turnSteeredSeqs = [];
  st.recentQuoteIds = [];
};

const resetSeen = () => { received.length = 0; };

// ── ① 没传引用 → 一个 reply 段都不许有 ────────────────────────────────────────────
await t('① 模型没传 replyToMessageId → 桥绝不自己加引用（旧 pickSmartQuote 已删除）', async () => {
  seedQuoteCandidates();
  resetSeen();
  const r = await post({ key: KEY, messages: '三角洲我玩得菜，但我还是想玩' });
  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(received.length, 1, `OneBot 应收到 1 条，实际 ${received.length}`);
  assert.deepEqual(replySegs(received[0]), [], `不该有引用段，实际 ${JSON.stringify(replySegs(received[0]))}`);
  assert.equal(r.json.quoted, null, 'quoted 应为 null');
  assert.equal(r.json.autoQuoted, undefined, 'autoQuoted 这个字段已不再回给模型');
});

// ── ② 传了引用 → 原样带上（显式引用不许被摘掉）───────────────────────────────────
await t('② 模型显式传 replyToMessageId → 引用原样发出', async () => {
  seedQuoteCandidates();
  resetSeen();
  const r = await post({ key: KEY, messages: '在呢', replyToMessageId: 620062 });
  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(received.length, 1, `OneBot 应收到 1 条，实际 ${received.length}`);
  assert.deepEqual(replySegs(received[0]), ['620062'], '应引用 620062');
});

// ── ③ 跨会话发送：默认拒绝，点名两个会话 ────────────────────────────────────────
await t('③ 带群令牌却发到别的会话 → 403，并把两个会话都报出来（防发错群）', async () => {
  resetSeen();
  const r = await post({ key: OTHER_KEY, messages: '这张图给你' }, TOKEN);
  assert.equal(r.status, 403, `应 403，实际 ${r.status}: ${JSON.stringify(r.json)}`);
  assert.match(String(r.json.error ?? ''), /crossSession/, '错误里应告诉模型怎么放行');
  assert.match(String(r.json.error ?? ''), new RegExp(KEY.replace(':', '\\:')), '错误里应写出调用方会话');
  assert.match(String(r.json.error ?? ''), new RegExp(OTHER_KEY.replace(':', '\\:')), '错误里应写出目标会话');
  assert.equal(received.length, 0, '被拒绝时不该真的发出去');
});

await t('④ 显式 crossSession:true → 跨会话发送放行（有意转达仍然可用）', async () => {
  resetSeen();
  const r = await post({ key: OTHER_KEY, messages: '这张图给你', crossSession: true }, TOKEN);
  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(received.length, 1, `OneBot 应收到 1 条，实际 ${received.length}`);
  assert.match(String(received[0].url ?? ''), /send_private_msg/, '应发到私聊端点');
  assert.equal(texts(received[0]), '这张图给你');
});

await t('⑤ 自己的会话照常发（guard 不误伤）', async () => {
  resetSeen();
  const r = await post({ key: OTHER_KEY, messages: '正常一句' }, OTHER_TOKEN);
  assert.equal(r.status, 200, `HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(received.length, 1);
});

// ── ⑥ 工具日志要能看出"发去了哪个会话"（号码曾被当令牌脱敏成 ***）───────────────
await t('⑥ extractToolTargetKey：工具日志能记下未脱敏目标会话', async () => {
  assert.equal(textSafe.extractToolTargetKey('{"key":"private:1736784911","messages":"hi"}'), 'private:1736784911');
  assert.equal(textSafe.extractToolTargetKey('{"groupId":"868756515","message":"hi"}'), 'group:868756515');
  assert.equal(textSafe.extractToolTargetKey('{"userId":100002,"message":"hi"}'), 'private:100002');
  assert.equal(textSafe.extractToolTargetKey('{"query":"nope"}'), '');
  assert.equal(textSafe.extractToolTargetKey(null), '');
  // 参数本身仍然照旧脱敏（token 不给落盘）
  assert.match(textSafe.sanitizeToolArgs('{"key":"private:1","token":"secret-token-value"}'), /\*\*\*/);
});

await t('⑦ qq-send.js 里已经没有智能引用实现（防止被重新加回来）', async () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'core', 'qq-send.js'), 'utf8');
  assert.doesNotMatch(src, /pickSmartQuote\s*\(/, '不该再调用 pickSmartQuote');
  assert.doesNotMatch(src, /export function pickSmartQuote/, '不该再有 pickSmartQuote 实现');
  assert.doesNotMatch(src, /SMART_QUOTE_MIN_SCORE/, '不该再有打分常量');
});

await new Promise((r) => onebot.close(r));
try { consoleSrv.stopConsoleServer?.(); } catch { /* 关不掉就算了 */ }
console.log(`no-auto-quote: ${pass}/${pass + fail} 通过`);
/* 必须显式退出：console-server 起的"主动机会检查/回复检查"定时器会让事件循环一直不空
 * （沙箱里没有真 NapCat，等它们超时是白等几十秒）。 */
process.exit(fail ? 1 : 0);
