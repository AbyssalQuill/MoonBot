// 看实际发到 QQ 的自己消息（chat_messages 里 is_self=1），判断"重复"到底有没有落到 QQ。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时目录从本文件位置推导（tools/ -> qq-bridge/），绝不写死盘符/安装路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const db = new DatabaseSync(path.join(ROOT, 'state', 'memory.db'), { readOnly: true });
const cols = db.prepare('PRAGMA table_info(chat_messages)').all().map((r) => r.name);
console.log('chat_messages 列:', cols.join(', '));
const textCol = cols.includes('plain') ? 'plain' : (cols.includes('text') ? 'text' : (cols.includes('content') ? 'content' : null));
const timeCol = cols.includes('created_at') ? 'created_at' : (cols.includes('time') ? 'time' : cols[0]);
if (!textCol) { console.log('找不到正文字段'); process.exit(0); }
const rows = db.prepare(
  `SELECT conv_key, ${textCol} AS body, ${timeCol} AS ts FROM chat_messages WHERE is_self = 1 ORDER BY ${timeCol} DESC LIMIT 24`
).all();
const fmt = (v) => {
  const n = Number(v);
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString().slice(11, 19);
};
console.log('UTC时间   会话                  内容');
for (const r of rows.reverse()) {
  console.log(`${fmt(r.ts)}  ${String(r.conv_key || '').padEnd(20)} ${String(r.body || '').replace(/\n/g, ' ').slice(0, 70)}`);
}
