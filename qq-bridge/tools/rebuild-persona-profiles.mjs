/**
 * 一次性重修：把历史上被**截断 / 重复 / 带「备注」标签**的人格档案重建成完整成文画像。
 *
 * 为什么需要它：旧版人格学习把摘要写进 `profiles.notes`（备注字段）并追加历史摘要，同时
 * `summarizePersonaChinese` 把整段摘要 `slice(0,300)`、落库再 `slice(0,500)`、personality
 * 字段上限 400 —— 于是界面上看到的是"两段几乎一样的备注 + 半句断掉的性格"。代码已修，
 * 但**已经存进库里的老数据**不会自己变好，这个脚本负责重算一遍。
 *
 * 数据来源：state/persona-library.json（结构化字段，未被截断）→ 重新合成 → 回写：
 *   ① profiles.personality = 成文画像（完整）
 *   ② profiles.notes       = 清掉「人格学习:…」段落（保留主人自己写的部分）
 *   ③ memory_entries(category='persona') = 同一段成文画像（替换，不再 slice(0,500)）
 *   ④ persona-library.json 每条补一个 profile 字段（界面直接读它）
 *
 * 用法（桥可以开着，SQLite WAL 允许并发写；改完 JSON 后重启桥让它重载库文件）：
 *   node qq-bridge/tools/rebuild-persona-profiles.mjs <bridgeDir> [--dry]
 * 例：
 *   node qq-bridge/tools/rebuild-persona-profiles.mjs "D:\MoonBot\resources\runtime\qq-bridge"
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { composePersonaProfile, stripLearnNotes } from '../src/core/persona-text.js';

const bridgeDir = process.argv[2];
const dry = process.argv.includes('--dry');
if (!bridgeDir) { console.error('用法: node rebuild-persona-profiles.mjs <bridgeDir> [--dry]'); process.exit(2); }

const libFile = path.join(bridgeDir, 'state', 'persona-library.json');
const dbFile = path.join(bridgeDir, 'state', 'memory.db');
if (!fs.existsSync(libFile)) { console.error('找不到 ' + libFile); process.exit(1); }
if (!fs.existsSync(dbFile)) { console.error('找不到 ' + dbFile); process.exit(1); }

const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'));
const uids = Object.keys(lib);
console.log(`档案库: ${uids.length} 条  (${libFile})`);
console.log(`数据库: ${dbFile}${dry ? '   [DRY RUN 不写]' : ''}`);

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 5000');

let changed = 0;
let notesFixed = 0;
for (const uid of uids) {
  const entry = lib[uid] || {};
  const profileText = composePersonaProfile(entry);
  if (!profileText) { console.log(`- ${uid}: 字段全空，跳过`); continue; }

  const row = db.prepare('SELECT personality, notes FROM profiles WHERE uid = ?').get(String(uid)) || null;
  const oldPersonality = String(row?.personality ?? '');
  const oldNotes = String(row?.notes ?? '');
  const newNotes = stripLearnNotes(oldNotes);
  const persona = db.prepare("SELECT content FROM memory_entries WHERE uid = ? AND category = 'persona' ORDER BY created_at DESC LIMIT 1").get(String(uid)) || null;
  const oldSummary = String(persona?.content ?? '');

  console.log(`\n- ${uid} ${entry.nickname ? '「' + entry.nickname + '」' : ''}`);
  console.log(`  性格 ${oldPersonality.length} → ${profileText.length} 字`);
  if (oldNotes !== newNotes) { notesFixed++; console.log(`  备注 ${oldNotes.length} → ${newNotes.length} 字（清掉「人格学习:」段落）`); }
  console.log(`  摘要 ${oldSummary.length} → ${profileText.length} 字`);
  console.log(`  新画像: ${profileText.slice(0, 80)}${profileText.length > 80 ? '…' : ''}`);

  if (dry) { changed++; continue; }
  db.prepare(`INSERT INTO profiles (uid, personality, notes, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET personality = excluded.personality, notes = excluded.notes, updated_at = excluded.updated_at`)
    .run(String(uid), profileText, newNotes, Date.now());
  db.prepare("DELETE FROM memory_entries WHERE uid = ? AND category = 'persona'").run(String(uid));
  db.prepare("INSERT INTO memory_entries (uid, category, content, created_at) VALUES (?, 'persona', ?, ?)")
    .run(String(uid), profileText, Date.now());
  lib[uid].profile = profileText;
  changed++;
}
if (!dry) fs.writeFileSync(libFile, JSON.stringify(lib, null, 2), 'utf8');
db.close();
console.log(`\n完成：${changed}/${uids.length} 条重写${notesFixed ? `，其中 ${notesFixed} 条备注被清理` : ''}${dry ? '（dry run，未落盘）' : ''}`);
if (!dry) console.log('提示：重启桥（或等它下次热加载）后界面即显示完整画像。');
