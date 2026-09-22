// 回归测试：带 query 的历史检索必须**真的走 FTS5 BM25**，而不是静默退回 LIKE/直接报错。
//
// 现场（2026-09-22 审计发现，代码级可验证）：searchChatMessages 的 FTS 分支写成
//     JOIN chat_fts f ON f.rowid = chat_messages.id  ...  WHERE chat_fts MATCH ?  ORDER BY bm25(chat_fts)
// —— SQLite 里表一旦起别名就必须一律用别名：`chat_fts` 这两处被当成"列名"，整条语句直接报错，
// 于是被 catch 吞掉、退回 LIKE。表现是"搜历史搜不到/排序不对"，而且不报错，属于静默失效。
// 修法：三处统一用别名 `f`（mem_fts 那条没有别名，本来就没问题）。
//
// 做法与仓库里其它测试一致：把 src 拷进临时沙盒再 import，这样 ROOT/state 都落在沙盒里，
// 不会碰真实 state/memory.db。
// 用法：node tests/memory-fts.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-fts-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-fts-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({ ownerQQ: '123456789', allowAllWhenEmpty: true, social: {} }));

let fails = 0;
const check = (n, f) => { try { f(); console.log('PASS  ' + n); } catch (e) { fails += 1; console.log('FAIL  ' + n + '  ' + (e?.message ?? e)); } };

const mem = await import(pathToFileURL(path.join(sandbox, 'src', 'core', 'memory.js')).href);

const t0 = Date.parse('2026-09-22T10:00:00+08:00');
const put = (uid, name, text, ts, id) => mem.persistChatMessage('group:1', {
  time: ts, text, plain: text, isSelf: false, messageId: id, senderUid: String(uid), senderName: name,
});
put(1, '甲', '今天去看了电影 奥本海默', t0, 'm1');
put(2, '乙', '电影票好贵 但值得', t0 + 60000, 'm2');
put(1, '甲', '量子计算的书到了', t0 + 120000, 'm3');

check('索引真的建起来了（rebuildMemoryFts 后 chat_fts 可用）', () => {
  const r = mem.rebuildMemoryFts({ reason: 'memory-fts-test' });
  assert.ok(r, 'rebuildMemoryFts 无返回');
  const q = mem.searchChatMessages({ query: '电影票', limit: 10 });
  assert.equal(q.ranked, true, '重建索引后仍没走 FTS 分支：' + JSON.stringify(q).slice(0, 200));
});

check('带 query 的历史检索能搜到（不再静默失效）', () => {
  const r = mem.searchChatMessages({ query: '电影票', limit: 10 });
  assert.ok(r.messages.length >= 1, `命中 ${r.messages.length} 条：${JSON.stringify((r.messages || []).map((m) => m.content))}`);
  // 换个词再搜一次：中文 trigram 要求 token ≥ 3 字，所以这里都用 3 字以上的词
  const r2 = mem.searchChatMessages({ query: '奥本海默', limit: 10 });
  assert.ok(r2.messages.length >= 1, `第二个词命中 ${r2.messages.length} 条`);
});

check('结果带 ranked 标记 —— 说明真的走了 FTS/BM25 分支', () => {
  const r = mem.searchChatMessages({ query: '电影票', limit: 10 });
  assert.equal(r.ranked, true, JSON.stringify(r).slice(0, 200));
});

check('单字（trigram 用不了）退回 LIKE 也能搜到，不抛错', () => {
  const r = mem.searchChatMessages({ query: '书', limit: 10 });
  assert.ok(r.ok && r.messages.length >= 1, JSON.stringify(r).slice(0, 200));
});

check('搜不到的词返回空数组而不是抛错', () => {
  const r = mem.searchChatMessages({ query: '绝对搜不到的词xyz', limit: 10 });
  assert.ok(r.ok && Array.isArray(r.messages), JSON.stringify(r).slice(0, 200));
});

check('同一会话过滤 + query 一起用也正常（convKey 在 FTS 分支里同样要成立）', () => {
  const r = mem.searchChatMessages({ query: '电影票', convKey: 'group:1', limit: 10 });
  assert.ok(r.ok && r.messages.length >= 1, JSON.stringify(r).slice(0, 200));
  const none = mem.searchChatMessages({ query: '电影票', convKey: 'group:999', limit: 10 });
  assert.equal(none.messages.length, 0, JSON.stringify(none).slice(0, 200));
});

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
