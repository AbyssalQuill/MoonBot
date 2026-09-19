/**
 * 把一份 meme pack 规整成统一结构并重建 index.db：
 *   <pack>/
 *     manifest.json                 { id, name, version, description, tags[], layout, count }
 *     index.db                      SQLite: memes(file_name, tag, caption, keywords)
 *     memes/<tag>/<tag>-NN.<ext>    图片按 tag 分子目录（webp/png/jpg/jpeg/gif 都收）
 *
 * 为什么必须重建 db：`qq_meme_search` 是拿 index.db 搜、`qq_send_meme` 是拿表里的 file_name 发图 ——
 * 改了文件名不同步改表，就会出现"搜得到、发不出"。所以本脚本把"改文件名 + 重写表 + 对账"做成原子的一步。
 *
 * 用法：node tools/relayout-meme-pack.mjs <packDir> [--dry]
 * 幂等：已经是 memes/<tag>/ 结构的，只重写表与 manifest。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif']);
const TAG_HINT = ['happy', 'angry', 'sad', 'shy', 'confused', 'surprised', 'sigh', 'sleep', 'daily', 'love', 'work'];

const packDir = path.resolve(process.argv[2] || '');
const dry = process.argv.includes('--dry');
if (!packDir || !fs.existsSync(packDir)) { console.error('pack dir not found: ' + packDir); process.exit(2); }

const manifestPath = path.join(packDir, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const tagsFromManifest = Array.isArray(manifest.tags) ? manifest.tags : [];

/** 收集图片：支持 memes/<tag>/*.ext（新结构）、<tag>/*.ext、以及平铺 <tag>_NN.ext */
function collect() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, rel ? `${rel}/${e.name}` : e.name); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!EXTS.has(ext)) continue;
      const parts = rel ? rel.split('/') : [];
      const tagFromDir = parts.filter((x) => x !== 'memes').pop() || '';
      const base = path.basename(e.name, ext);
      const tagFromName = (base.match(/^([a-z]+)[-_]/i) || [])[1] || '';
      const tag = String(tagFromDir || tagFromName || 'daily').toLowerCase();
      out.push({ src: p, name: e.name, base, ext, tag, rel });
    }
  };
  walk(packDir, '');
  return out;
}

const items = collect();
if (!items.length) { console.error('no images found under ' + packDir); process.exit(2); }
const skipped = fs.readdirSync(packDir, { withFileTypes: true })
  .filter((e) => e.isFile() && !EXTS.has(path.extname(e.name).toLowerCase()) && !['manifest.json'].includes(e.name))
  .map((e) => e.name);

// 分 tag、编号；已在新结构里的文件保持原名（避免无意义地改一遍）
const byTag = new Map();
for (const it of items) { if (!byTag.has(it.tag)) byTag.set(it.tag, []); byTag.get(it.tag).push(it); }
const finalName = (it, idx) => (it.rel && /^memes\//.test(it.rel) ? it.name : `${it.tag}-${String(idx + 1).padStart(2, '0')}${it.ext}`);
const plan = [];
for (const [tag, list] of byTag) {
  list.sort((a, b) => a.name.localeCompare(b.name));
  list.forEach((it, i) => {
    const name = finalName(it, i);
    plan.push({ ...it, tag, target: path.join(packDir, 'memes', tag, name), targetRel: `memes/${tag}/${name}` });
  });
}

console.log(`[pack] ${path.basename(packDir)}: ${items.length} 张图 / ${byTag.size} 个 tag`);
for (const [tag, list] of byTag) console.log(`        ${tag}: ${list.length}`);
if (skipped.length) console.log(`[pack] 跳过非图片文件（原样保留）: ${skipped.join(', ')}`);
if (dry) { for (const p of plan) console.log(`  ${p.rel || p.name}  ->  ${p.targetRel}`); process.exit(0); }

// 1) 落位
for (const p of plan) {
  fs.mkdirSync(path.dirname(p.target), { recursive: true });
  if (path.resolve(p.src) !== path.resolve(p.target)) { fs.renameSync(p.src, p.target); console.log(`  moved ${p.rel || p.name} -> ${p.targetRel}`); }
}
// 2) 清掉空的旧目录
for (const e of fs.readdirSync(packDir, { withFileTypes: true })) {
  if (e.isDirectory() && e.name !== 'memes') {
    const left = fs.readdirSync(path.join(packDir, e.name));
    if (!left.length) { fs.rmdirSync(path.join(packDir, e.name)); console.log(`  removed empty dir ${e.name}/`); }
  }
}
// 3) 重建 index.db（caption/keywords 由文件名 + manifest 描述拆词）
const dbPath = path.join(packDir, 'index.db');
const tmpDb = `${dbPath}.tmp-${process.pid}`;
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, tmpDb]) { try { fs.rmSync(f, { force: true }); } catch {} }
const db = new DatabaseSync(tmpDb);
db.exec('CREATE TABLE memes (file_name TEXT PRIMARY KEY, tag TEXT, caption TEXT, keywords TEXT)');
const ins = db.prepare('INSERT OR REPLACE INTO memes (file_name, tag, caption, keywords) VALUES (?, ?, ?, ?)');
for (const p of plan) {
  const caption = `${p.tag} ${p.base.replace(/[-_]+/g, ' ')}`.trim();
  const keywords = [...new Set([p.tag, ...p.base.split(/[-_]+/).filter((w) => w && !/^\d+$/.test(w)), ...tagsFromManifest.slice(0, 4)])].join(' ');
  ins.run(p.targetRel, p.tag, caption, keywords);
}
db.close();
fs.renameSync(tmpDb, dbPath);

// 4) manifest v2
const nextManifest = {
  id: manifest.id || path.basename(packDir),
  name: manifest.name || path.basename(packDir),
  version: '2.0.0',
  description: manifest.description || '',
  layout: 'memes/<tag>/<tag>-NN.<ext>',
  count: plan.length,
  tags: [...byTag.keys()].sort(),
  license: manifest.license || 'UNKNOWN',
  ...(manifest.persona ? { persona: manifest.persona } : {}),
};
fs.writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8');

// 5) 对账：表里每行都要有图，每张图都要在表里
const check = new DatabaseSync(dbPath, { readOnly: true });
const rows = check.prepare('SELECT file_name FROM memes').all().map((r) => r.file_name);
check.close();
const onDisk = new Set(plan.map((p) => p.targetRel));
const rowSet = new Set(rows);
const missingFile = rows.filter((r) => !onDisk.has(r));
const missingRow = [...onDisk].filter((f) => !rowSet.has(f));
console.log(`[pack] index.db rows = ${rows.length} ; files = ${onDisk.size}`);
if (missingFile.length || missingRow.length) {
  console.error(`[pack] 对账失败：表里有图缺失 ${missingFile.length} 条，磁盘有图未入表 ${missingRow.length} 条`);
  if (missingFile.length) console.error('  missing files: ' + missingFile.slice(0, 5).join(', '));
  if (missingRow.length) console.error('  missing rows : ' + missingRow.slice(0, 5).join(', '));
  process.exit(1);
}
console.log(`[pack] OK  ${nextManifest.tags.length} 个 tag / ${rows.length} 张，表与磁盘一致（tag 提示词: ${TAG_HINT.join(' ')}）`);
