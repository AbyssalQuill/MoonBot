// 兜底发送：模型漏引号 → 桥把裸文本捞回来自己发（走同一条发送端点）
// 跑法：node tests/args-recover.test.js
import assert from 'node:assert/strict';
import { recoverUnquotedSend, isRecoverableSendTool } from '../src/core/args-recover.js';

let passed = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const SITE = '{"key": "private:1736784911", "messages": 就知道会这样，那主人打算怎么办呀, "token": "1736784911"}';

function stubFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), token: init.headers['x-agent-token'] });
    return { status: 200, json: async () => ({ ok: true, sent: 1 }) };
  };
  return { calls, impl };
}

await t('① 现场原文 → 兜底发出那一条，key/messages/token 都正确', async () => {
  const { calls, impl } = stubFetch();
  const r = await recoverUnquotedSend({
    key: 'private:1736784911', callId: 'c1', cfg: { consolePort: 3100 },
    stash: { raw: SITE, tool: 'mcp__napcat__qq_send_message', key: 'private:1736784911' },
    post: { url: 'http://127.0.0.1:3100/api/social/send-message', fetch: impl },
  });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.key, 'private:1736784911');
  assert.deepEqual(calls[0].body.messages, ['就知道会这样，那主人打算怎么办呀']);
  assert.equal(calls[0].token, '1736784911');
});

await t('② 修不出来 → 一条都不发（绝不猜内容）', async () => {
  const { calls, impl } = stubFetch();
  const r = await recoverUnquotedSend({
    key: 'private:1',
    stash: { raw: '{"key":"private:1",,,', tool: 'mcp__napcat__qq_send_message' },
    post: { url: 'http://127.0.0.1:3100/x', fetch: impl },
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

await t('③ 不是发送类工具 → 不管', async () => {
  const { calls, impl } = stubFetch();
  const r = await recoverUnquotedSend({
    key: 'private:1',
    stash: { raw: SITE, tool: 'mcp__napcat__qq_meme_search' },
    post: { url: 'http://127.0.0.1:3100/x', fetch: impl },
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

await t('④ 修复后的 key 不合法 → 不发（防串会话）', async () => {
  const { calls, impl } = stubFetch();
  const r = await recoverUnquotedSend({
    key: '',
    stash: { raw: '{"key":"someone-else","messages": 你好}', tool: 'mcp__napcat__qq_send_message' },
    post: { url: 'http://127.0.0.1:3100/x', fetch: impl },
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

await t('⑤ 工具名识别（长短名都要认）', () => {
  assert.equal(isRecoverableSendTool('mcp__napcat__qq_send_message'), true);
  assert.equal(isRecoverableSendTool('qq_reply'), true);
  assert.equal(isRecoverableSendTool('mcp__napcat__qq_mark_read'), false);
});

await t('⑥ 端点报错（比如被频率闸拦下）→ 如实返回失败，不算已发', async () => {
  const calls = [];
  const impl = async (url, init) => { calls.push(init); return { status: 429, json: async () => ({ ok: false, error: '发送频率超限' }) }; };
  const r = await recoverUnquotedSend({
    key: 'private:1736784911',
    stash: { raw: SITE, tool: 'mcp__napcat__qq_send_message' },
    post: { url: 'http://127.0.0.1:3100/x', fetch: impl },
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

for (const [name, fn] of cases) {
  try { await fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); process.exitCode = 1; }
}
console.log(`args-recover: ${passed}/${cases.length} 通过`);
if (process.exitCode) process.exit(process.exitCode);
