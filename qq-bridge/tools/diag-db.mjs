// 用正确列名查 memory.db：找出**从未被标读**的消息（= 最可能的被吞消息）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时目录从本文件位置推导（tools/ -> qq-bridge/），绝不写死盘符/安装路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(ROOT, 'state', 'memory.db'));
// 会话 key：命令行参数优先，否则读桥配置的 ownerQQ —— 绝不把作者 QQ 写进代码。
const K = process.argv[2] || (() => {
  try { return 'private:' + JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).ownerQQ; }
  catch { return 'private:0'; }
})();
const bj = (ms) => (Number(ms) > 0 ? new Date(Number(ms) + 8 * 3600e3).toISOString().slice(5, 19).replace('T', ' ') : '-');

console.log('=== 全部「对方发的、但 read_at 为空」的消息（最可能是被吞的）===');
const unread = db.prepare(
  "SELECT ts_ms, message_id, content, msg_seq, qq_seq FROM chat_messages " +
  "WHERE conv_key = ? AND is_self = 0 AND (read_at IS NULL OR read_at = 0) ORDER BY ts_ms DESC LIMIT 25"
).all(K);
console.log(`共 ${unread.length} 条（列出最近 25）`);
for (const r of unread) {
  console.log(`  ${bj(r.ts_ms)}  id=${String(r.message_id).slice(-10)}  msg_seq=${r.msg_seq} qq_seq=${r.qq_seq}  ${String(r.content).replace(/\s+/g, ' ').slice(0, 40)}`);
}

console.log('\n=== 搜「注意点」===');
for (const r of db.prepare("SELECT ts_ms, is_self, content, read_at FROM chat_messages WHERE conv_key = ? AND content LIKE ? ORDER BY ts_ms DESC LIMIT 8").all(K, '%注意点%')) {
  console.log(`  ${bj(r.ts_ms)}  ${Number(r.is_self) ? 'AI  ' : '对方'}  read_at=${r.read_at ?? 'NULL'}  ${String(r.content).replace(/\s+/g, ' ').slice(0, 50)}`);
}

console.log('\n=== 最近 12 条原始行（含 read_at / recalled_at）===');
for (const r of db.prepare("SELECT ts_ms, is_self, content, read_at, recalled_at, qq_seq FROM chat_messages WHERE conv_key = ? ORDER BY ts_ms DESC LIMIT 12").all(K).reverse()) {
  console.log(`  ${bj(r.ts_ms)}  ${Number(r.is_self) ? 'AI  ' : '对方'}  read_at=${String(r.read_at ?? 'NULL').padStart(14)}  qq_seq=${String(r.qq_seq ?? '-').padStart(4)}  ${String(r.content).replace(/\s+/g, ' ').slice(0, 30)}`);
}

console.log('\n=== 今天 read_at 为空 的条数（按小时）===');
const byHour = db.prepare(
  "SELECT substr(datetime(ts_ms/1000,'unixepoch','+8 hours'),1,13) AS h, COUNT(*) AS n " +
  "FROM chat_messages WHERE conv_key = ? AND is_self = 0 AND (read_at IS NULL OR read_at = 0) AND ts_ms > ? " +
  "GROUP BY h ORDER BY h DESC LIMIT 12"
).all(K, Date.now() - 3 * 86400e3);
for (const r of byHour) console.log(`  ${r.h}  ${r.n} 条`);
db.close();
