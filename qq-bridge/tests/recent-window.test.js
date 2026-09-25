// 回归测试：/api/social/recent（qq_get_recent_messages）**只看内存窗口**，聊天记录走 memory research。
//
// 背景（2026-09-24 深夜，主人原话）："qq_get_recent_messages 本来就是读内存窗口的，
// memory research 才是读聊天记录。" 白天我曾把窗口不够的部分改成回 SQLite 补齐（当时主人报过
// "之前那段我这边看不到"），但那把两件事混进了一条接口：工具名/描述/返回字段都在暗示"这是记录"，
// 模型于是拿它当记录翻，权限与裁剪纪律也跟着糊。现在按主人的分工还原：
//
//   · /api/social/recent、/api/social/my-recent = 内存滚动窗口 st.recentMessages（带现场标记、最新）
//   · 聊天记录 = /api/social/history-search ← qq_memory_search（无关键词也能翻，key+limit 即最新若干条）
//
// 本测试起了真控制台 + 真 SQLite 库（库里塞 45 条），故意让窗口只有 2 条：
//   ① 窗口 2 条 + limit=20 → 只回窗口那 2 条（旧→新），绝不混进库里那 45 条
//   ② offset 在窗口内往前挪（offset=1 → 窗口第 1 条）
//   ③ offset 越过窗口 → 0 条，且 windowSize 明示窗口真实大小
//   ④ 窗口为空 → 0 条（不会偷偷回库兜底）
//   ⑤ my-recent 只数窗口里"我"发的
//   ⑥ 读记录走 /api/social/history-search（能拿到库里内容）
//   ⑦ 静态接线：改的是 /api/social/recent；开局 [Recent messages] 块只在窗口**完全为空**时查库
//
// 用法：node tests/recent-window.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'private:1736784911';

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

const port = await freePort();
const sandbox = path.join(HERE, '.tmp-recent-window');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-recent-window', private: true, type: 'module' }));

const cfg = {
  ownerQQ: '1736784911',
  consolePort: port,
  napcat: { httpUrl: 'http://127.0.0.1:1', accessToken: '' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: {}, deny: {}, allowAllWhenEmpty: true,
  prompt: { styleLine: '[Style] 说人话' },
  social: { tools: {}, send: { linearEnabled: false }, wake: {} },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const chatDb = await import(url('core/chat-db.js'));
const socialState = await import(url('core/social-state.js'));
const modeMod = await import(url('core/mode.js'));
const consoleMod = await import(url('core/console-server.js'));

consoleMod.initConsoleCore(cfg);
socialState.initSocialCore(cfg);
modeMod.initModeCore(cfg);
chatDb.initChatDb();

// ── 库里 45 条（正文带序号，便于断言"到底回的是窗口还是库"）──────────────────
const T0 = 1790000000000;
const TOTAL = 45;
const texts = [];
for (let i = 0; i < TOTAL; i += 1) {
  const text = `库消息${String(i + 1).padStart(2, '0')}`;
  texts.push(text);
  chatDb.persistChatMessage(KEY, {
    messageId: String(900000 + i),
    userId: i % 3 === 0 ? 'self' : '1736784911',
    sender: i % 3 === 0 ? '我' : '私聊',
    isSelf: i % 3 === 0,
    text,
    time: T0 + i * 60000,
    seq: i + 1,
  });
}
assert.equal(chatDb.chatCounters().total, TOTAL, '库里应有 45 条');

// ── 内存窗口故意只放 2 条（模拟重启/软重置后的真实状态）──────────────────────
const st = socialState.getSocialState(KEY);
st.agentToken = 'test-token-aaaaaaaaaaaaaaaa';
st.recentMessages = [
  { seq: 1001, messageId: 'x1', isSelf: false, sender: '私聊', userId: '1736784911', time: T0 + 999 * 60000, text: '窗口里对方说的' },
  { seq: 1002, messageId: 'x2', isSelf: true, sender: '我', userId: null, time: T0 + 1000 * 60000, text: '窗口里我最后说的' },
];

const server = consoleMod.startConsoleServer();
const get = async (p, tok) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, tok ? { headers: { 'x-agent-token': tok } } : undefined);
  const raw = await res.text();
  let body = null; try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
};
const recent = (qs) => get(`/api/social/recent?key=${encodeURIComponent(KEY)}&${qs}`);

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

console.log('== /api/social/recent 只读内存窗口 ==');

await t('① 窗口 2 条 + limit=20 → 只回窗口那 2 条，绝不混进库里那 45 条', async () => {
  const r = await recent('limit=20&offset=0');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 2, `应回窗口的 2 条，实际 ${r.body.count}`);
  assert.deepEqual(r.body.messages.map((m) => m.text), ['窗口里对方说的', '窗口里我最后说的']);
  assert.equal(r.body.windowSize, 2);
  assert.ok(!r.raw.includes('库消息'), '窗口接口不得返回库里的记录：' + r.raw.slice(0, 200));
});

await t('② offset 在窗口内往前挪（offset=1 → 窗口里更早的那 1 条）', async () => {
  const r = await recent('limit=20&offset=1');
  assert.equal(r.body.count, 1);
  assert.deepEqual(r.body.messages.map((m) => m.text), ['窗口里对方说的']);
  assert.equal(r.body.offset, 1);
});

await t('③ offset 越过窗口 → 0 条（窗口之外就是没有），windowSize 明示真实窗口', async () => {
  const r = await recent('limit=20&offset=50');
  assert.equal(r.body.count, 0);
  assert.equal(r.body.windowSize, 2);
  assert.ok(!r.raw.includes('库消息'), '窗口之外不得回库兜底');
});

await t('④ 窗口为空 → 0 条（不会偷偷回库补齐）', async () => {
  const backup = st.recentMessages;
  st.recentMessages = [];
  try {
    const r = await recent('limit=20&offset=0');
    assert.equal(r.body.count, 0, '空窗口就该是 0 条（记录请走 qq_memory_search）');
    assert.equal(r.body.windowSize, 0);
    assert.ok(!r.raw.includes('库消息'));
  } finally { st.recentMessages = backup; }
});

await t('⑤ my-recent 只数窗口里"我"发的', async () => {
  const r = await get(`/api/social/my-recent?key=${encodeURIComponent(KEY)}&limit=10`);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1, `窗口里只有 1 条我自己发的，实际 ${r.body.count}`);
  assert.deepEqual(r.body.messages.map((m) => m.text), ['窗口里我最后说的']);
  assert.equal(r.body.windowSize, 2);
});

await t('⑥ 读聊天记录走 /api/social/history-search（qq_memory_search 的入口）', async () => {
  const r = await get(`/api/social/history-search?key=${encodeURIComponent(KEY)}&limit=5`, st.agentToken);
  assert.equal(r.status, 200, `history-search 应可用，实际 ${r.status} ${r.raw.slice(0, 160)}`);
  assert.ok(r.raw.includes('库消息45'), '记录入口应能读到库里最新那条：' + r.raw.slice(0, 200));
});

await t('⑦ 静态接线：工具打的是 /api/social/recent；开局块只在窗口完全为空时查库', () => {
  const mcp = fs.readFileSync(path.join(sandbox, 'src', 'mcp-napcat-safe.js'), 'utf8');
  const recentTool = mcp.slice(mcp.indexOf("'qq_get_recent_messages'"), mcp.indexOf("'qq_get_my_recent_messages'"));
  assert.match(recentTool, /agentApi\(`\/api\/social\/recent/, 'qq_get_recent_messages 应打 /api/social/recent');
  assert.ok(!/sinceMs/.test(recentTool), 'sinceMs 参数已随"翻库"一起撤掉');
  assert.match(recentTool, /qq_memory_search/, '描述里必须把"读记录"指向 qq_memory_search');
  const wake = fs.readFileSync(path.join(sandbox, 'src', 'core', 'wake-send.js'), 'utf8');
  assert.match(wake, /if \(!recent\.length && key\) recent = recentChatMessages\(key, maxCount\);/, '开局块只在窗口完全为空时查库');
  assert.ok(!/recent\.length < maxCount/.test(wake), '不应再"窗口不够就查库补齐"');
});

server.close();
try { chatDb.chatDb?.close?.(); } catch {}
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
