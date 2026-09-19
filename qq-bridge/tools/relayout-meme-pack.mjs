/**
 * 把一份（或一整个根目录下的多份）meme pack 规整成统一结构并重建 index.db：
 *   <pack>/
 *     manifest.json                 { id, name, version, description, tags[], layout, count }
 *     index.db                      SQLite: memes(path PK, file_name, tag, caption, keywords[, file_hash, mtime, captioned_at])
 *     memes/<tag>/<tag>-NN.<ext>    图片按 tag 分子目录（webp/png/jpg/jpeg/gif 都收）
 *
 * 为什么必须重建 db：`qq_meme_search` 拿 index.db 搜、`qq_send_meme` 拿表里的 **path** 发图 ——
 * 改了文件名不同步改表，就会出现"搜得到、发不出"。所以本脚本把"改文件名 + 重写表 + 对账"做成原子的一步。
 *
 * 【2026-09-20 修三个上线级错误】
 *   1) 旧版本建的表**没有 path 列**，还把 `memes/<tag>/xx.webp` 塞进 file_name —— 而 qq_send_meme 执行的是
 *      `SELECT path FROM memes WHERE file_name = ?`，重排完直接"搜得到、发不出"。现在 path 是主键（相对 pack 根，
 *      一律 '/' 分隔），并在结尾**真跑一遍桥侧的两条 SQL** 自检（不是"看着像对"）。
 *   2) 旧版本用"文件名拆词"重写 caption/keywords，会覆盖掉已有的人工/模型描述。现在按 老表 path → 老表 file_name
 *      → 去扩展名同名 依次认领老行，**原样保留** caption/keywords/file_hash/mtime/captioned_at；只有表里没有的
 *      新图才用文件名兜底生成描述。同一行老数据只允许被一张图认领（按 stem 认领算"弱认领"，只在精确匹配没占用时才用）。
 *   3) 同 pack 内**同名不同文件**会让 qq_send_meme 的 file_name 句柄产生歧义。现在落盘前先查重：内容完全相同的
 *      副本挪进 `.dedup/`（不删，可回滚；带点的目录不会被再收集），内容不同的**直接报错退出且一个文件都不动**。
 *
 * 用法：
 *   node tools/relayout-meme-pack.mjs <packDir>   [--dry]        # 单包
 *   node tools/relayout-meme-pack.mjs <packsRoot> --all [--dry]  # 根目录下每一份 pack
 * 幂等：已经是 memes/<tag>/ 结构的，只重写表与 manifest，不动文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif']);
const TAG_HINT = ['happy', 'angry', 'sad', 'shy', 'confused', 'surprised', 'sigh', 'sleep', 'daily', 'love', 'work'];
const DB_SIDE_FILES = new Set(['index.db', 'index.db-wal', 'index.db-shm']);
const DEDUP_DIR = '.dedup';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const all = argv.includes('--all');
const target = path.resolve(argv.find((a) => !a.startsWith('--')) || '');
if (!target || !fs.existsSync(target)) { console.error('dir not found: ' + target); process.exit(2); }

const norm = (p) => String(p || '').replace(/\\/g, '/');
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 老表长什么样：可能任何一列都不存在（更早的版本 / 手工放的 db），所以一律按"有的列"读 */
function readOldTable(dbPath) {
  if (!fs.existsSync(dbPath)) return { cols: [], rows: [] };
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return { cols: [], rows: [] }; }
  try {
    const cols = db.prepare('PRAGMA table_info(memes)').all().map((r) => String(r.name));
    if (!cols.length) return { cols: [], rows: [] };
    return { cols, rows: db.prepare('SELECT * FROM memes').all() };
  } catch {
    return { cols: [], rows: [] };
  } finally {
    try { db.close(); } catch { /* 只读句柄，关不掉也不影响后面重建 */ }
  }
}

/** 收集图片：支持 memes/<tag>/*.ext（新结构）、<tag>/*.ext、以及平铺 <tag>_NN.ext */
function collect(packDir) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;                 // .dedup / 隐藏目录不进收集
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, rel ? `${rel}/${e.name}` : e.name); continue; }
      if (DB_SIDE_FILES.has(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!EXTS.has(ext)) continue;
      const parts = rel ? rel.split('/') : [];
      const tagFromDir = parts.filter((x) => x !== 'memes').pop() || '';
      const base = path.basename(e.name, ext);
      const tagFromName = (base.match(/^([a-z]+)[-_]/i) || [])[1] || '';
      const tag = String(tagFromDir || tagFromName || 'daily').toLowerCase();
      out.push({ src: p, name: e.name, base, ext, tag, rel: rel ? `${rel}/${e.name}` : e.name });
    }
  };
  walk(packDir, '');
  return out;
}

/**
 * 同 pack 内同名文件的处理（必须在任何落盘动作之前决定，否则会出现"文件动了、表没动"）。
 * 内容相同 → 留一张（优先留老表认的那张，其次路径字典序最小），其余挪进 .dedup/。
 * 内容不同 → 抛错，调用方一个文件都不许动。
 */
function planDuplicates(items, preferredRel) {
  const byName = new Map();
  for (const it of items) { if (!byName.has(it.name)) byName.set(it.name, []); byName.get(it.name).push(it); }
  const survivors = [];
  const quarantined = [];
  const conflicts = [];
  for (const [name, list] of byName) {
    if (list.length === 1) { survivors.push(list[0]); continue; }
    const hashed = list.map((it) => ({ ...it, hash: sha256(it.src) }));
    const uniq = new Set(hashed.map((h) => h.hash));
    if (uniq.size > 1) { conflicts.push({ name, hashes: uniq.size, rels: list.map((i) => i.rel) }); continue; }
    hashed.sort((a, b) => {
      const pa = preferredRel.has(norm(a.rel)) ? 0 : 1;
      const pb = preferredRel.has(norm(b.rel)) ? 0 : 1;
      return pa - pb || a.rel.localeCompare(b.rel);
    });
    survivors.push(hashed[0]);
    for (const extra of hashed.slice(1)) quarantined.push(extra);
  }
  return { survivors, quarantined, conflicts };
}

function relayout(packDir) {
  const manifestPath = path.join(packDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  const tagsFromManifest = Array.isArray(manifest.tags) ? manifest.tags : [];
  const dbPath = path.join(packDir, 'index.db');

  const collected = collect(packDir);
  if (!collected.length) { console.error(`[pack] ${path.basename(packDir)}: 没有图片，跳过`); return { ok: false, skipped: true }; }
  const kept = fs.readdirSync(packDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !EXTS.has(path.extname(e.name).toLowerCase()) && e.name !== 'manifest.json' && !DB_SIDE_FILES.has(e.name))
    .map((e) => e.name);

  // ---------- 老表 ----------
  const old = readOldTable(dbPath);
  const preferredRel = new Set(old.rows.map((r) => norm(r.path)).filter(Boolean));

  // ---------- 同名查重（落盘前） ----------
  const { survivors, quarantined, conflicts } = planDuplicates(collected, preferredRel);
  if (conflicts.length) {
    console.error(`[pack] ${path.basename(packDir)}: 有 ${conflicts.length} 组"同名但内容不同"的图 —— 发图句柄会歧义，未做任何改动。请先改名：`);
    for (const c of conflicts) console.error(`  ${c.name}  (${c.hashes} 种内容)\n    ${c.rels.join('\n    ')}`);
    return { ok: false };
  }
  if (quarantined.length) {
    console.log(`[pack] 同名且内容完全相同的副本 ${quarantined.length} 张 → 挪到 ${DEDUP_DIR}/（不删，可回滚）`);
    for (const q of quarantined) console.log(`  dup ${q.rel}`);
  }

  // ---------- 认领老行：精确（path / file_name）优先，未被占用的才允许按 stem 弱认领 ----------
  const byPath = new Map();
  const byName = new Map();
  const byStem = new Map();
  for (const r of old.rows) {
    const rel = norm(r.path);
    if (rel) byPath.set(rel, r);
    const fn = String(r.file_name || (rel ? path.basename(rel) : '') || '');
    if (fn) {
      byName.set(fn, r);
      byStem.set(path.basename(fn, path.extname(fn)), r);
    }
  }
  const claimedRows = new Set();
  const exact = new Map();
  for (const it of survivors) {
    const row = byPath.get(norm(it.rel)) || byName.get(it.name) || null;
    if (row && !claimedRows.has(row)) { exact.set(it, row); claimedRows.add(row); }
  }
  for (const it of survivors) {
    if (exact.has(it)) continue;
    const row = byStem.get(it.base);
    if (row && !claimedRows.has(row)) { exact.set(it, { ...row, __weak: true }); claimedRows.add(row); }
  }
  const weakClaims = [...exact.values()].filter((r) => r.__weak).length;
  const orphanRows = old.rows.filter((r) => !claimedRows.has(r));
  if (orphanRows.length) {
    console.log(`[pack] 老表里 ${orphanRows.length} 行对应的图不在磁盘上（陈旧行，重建时丢弃）：`);
    for (const r of orphanRows.slice(0, 5)) console.log(`  stale ${norm(r.path) || r.file_name}`);
    if (orphanRows.length > 5) console.log(`  ... 其余 ${orphanRows.length - 5} 行`);
  }

  // ---------- 分 tag、编号；已在新结构里的文件保持原名（避免无意义地改一遍） ----------
  const byTag = new Map();
  for (const it of survivors) { if (!byTag.has(it.tag)) byTag.set(it.tag, []); byTag.get(it.tag).push(it); }
  const finalName = (it, idx) => (/^memes\//.test(norm(it.rel)) ? it.name : `${it.tag}-${String(idx + 1).padStart(2, '0')}${it.ext}`);
  const plan = [];
  let preserved = 0;
  let generated = 0;
  for (const [tag, list] of byTag) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((it, i) => {
      const name = finalName(it, i);
      const row = exact.get(it) || null;
      const oldCaption = row ? String(row.caption ?? '').trim() : '';
      const oldKeywords = row ? String(row.keywords ?? '').trim() : '';
      if (oldCaption) preserved += 1; else generated += 1;
      plan.push({
        ...it,
        tag,
        target: path.join(packDir, 'memes', tag, name),
        targetRel: `memes/${tag}/${name}`,
        file_name: name,
        caption: oldCaption || `${tag} ${it.base.replace(/[-_]+/g, ' ')}`.trim(),
        keywords: oldKeywords || [...new Set([tag, ...it.base.split(/[-_]+/).filter((w) => w && !/^\d+$/.test(w)), ...tagsFromManifest.slice(0, 4)])].join(' '),
        file_hash: row?.file_hash ?? sha256(it.src),
        mtime: Number.isFinite(Number(row?.mtime)) ? Number(row.mtime) : fs.statSync(it.src).mtimeMs / 1000,
        captioned_at: Number.isFinite(Number(row?.captioned_at)) ? Number(row.captioned_at) : null,
        claimed: !!row,
        weak: !!(row && row.__weak),
      });
    });
  }

  // 落盘前的最后一道闸：包内文件名必须唯一（uq 索引也是这个契约）
  const nameCount = new Map();
  for (const p of plan) nameCount.set(p.file_name, (nameCount.get(p.file_name) || 0) + 1);
  const stillDup = [...nameCount.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  if (stillDup.length) {
    console.error(`[pack] 归一化后仍有重名文件，未做任何改动：${stillDup.join(', ')}`);
    return { ok: false };
  }

  console.log(`[pack] ${path.basename(packDir)}: ${survivors.length} 张图 / ${byTag.size} 个 tag${quarantined.length ? `（另有 ${quarantined.length} 张同名副本已隔离）` : ''}`);
  for (const [tag, list] of byTag) console.log(`        ${tag}: ${list.length}`);
  console.log(`[pack] 老表 ${old.rows.length} 行 → 精确认领 ${plan.filter((p) => p.claimed && !p.weak).length} 张${weakClaims ? `（含 ${weakClaims} 张按文件名词干弱认领）` : ''}；保留描述 ${preserved} 张，新图兜底生成 ${generated} 张`);
  if (kept.length) console.log(`[pack] 跳过非图片文件（原样保留）: ${kept.join(', ')}`);

  if (dry) {
    for (const p of plan) {
      const moved = path.resolve(p.src) !== path.resolve(p.target);
      console.log(`  ${moved ? (p.rel || p.name) + '  ->  ' : '(原位) '}${p.targetRel}   caption=${JSON.stringify(p.caption)}`);
    }
    return { ok: true, dry: true, count: plan.length, preserved, generated, deduped: quarantined.length };
  }

  // 1) 隔离同名副本（挪，不删）
  for (const q of quarantined) {
    const dst = path.join(packDir, DEDUP_DIR, q.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(q.src, dst);
    console.log(`  quarantined ${q.rel} -> ${norm(path.relative(packDir, dst))}`);
  }
  // 2) 落位
  for (const p of plan) {
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    if (path.resolve(p.src) !== path.resolve(p.target)) { fs.renameSync(p.src, p.target); console.log(`  moved ${p.rel} -> ${p.targetRel}`); }
  }
  // 3) 清掉空的旧目录（只删空目录）
  const prune = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'memes') continue;
      const sub = path.join(dir, e.name);
      prune(sub);
      if (!fs.readdirSync(sub).length) { fs.rmdirSync(sub); console.log(`  removed empty dir ${norm(path.relative(packDir, sub))}/`); }
    }
  };
  prune(packDir);

  // 4) 重建 index.db（先写临时文件再改名，中途失败不会留下半截表）
  const tmpDb = `${dbPath}.tmp-${process.pid}`;
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, tmpDb]) { try { fs.rmSync(f, { force: true }); } catch { /* 不存在就算了 */ } }
  const db = new DatabaseSync(tmpDb);
  db.exec(`CREATE TABLE memes (
    path         TEXT PRIMARY KEY,
    file_name    TEXT NOT NULL,
    tag          TEXT NOT NULL,
    caption      TEXT NOT NULL DEFAULT '',
    keywords     TEXT NOT NULL DEFAULT '',
    file_hash    TEXT,
    mtime        REAL,
    captioned_at REAL
  )`);
  db.exec('CREATE UNIQUE INDEX idx_memes_file_name ON memes(file_name)');
  db.exec('CREATE INDEX idx_memes_tag ON memes(tag)');
  const ins = db.prepare('INSERT OR REPLACE INTO memes (path, file_name, tag, caption, keywords, file_hash, mtime, captioned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const p of plan) ins.run(p.targetRel, p.file_name, p.tag, p.caption, p.keywords, p.file_hash, p.mtime, p.captioned_at);
  db.close();
  fs.renameSync(tmpDb, dbPath);

  // 5) manifest v2
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

  // 6) 对账：表里每行都要有图、每张图都要在表里、path 真的指得到文件
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const rows = check.prepare('SELECT file_name, path FROM memes').all();
  const present = new Set(plan.map((p) => p.targetRel));
  const missingFile = rows.filter((r) => !present.has(norm(r.path)) || !fs.existsSync(path.join(packDir, norm(r.path))));
  const missingRow = [...present].filter((f) => !rows.some((r) => norm(r.path) === f));
  const dupName = rows.length !== new Set(rows.map((r) => r.file_name)).size;

  // 7) 桥侧两条 SQL 的真自检（qq_meme_search / qq_send_meme 就是这么查的）
  const probeTag = plan[0].tag;
  const probe = check.prepare('SELECT file_name, tag, caption, keywords FROM memes WHERE (caption LIKE ? OR keywords LIKE ?) LIMIT 3').all('%' + probeTag + '%', '%' + probeTag + '%');
  const byNameProbe = check.prepare('SELECT path FROM memes WHERE file_name = ?').get(plan[0].file_name);
  check.close();

  console.log(`[pack] index.db rows = ${rows.length} ; files = ${present.size}`);
  let failed = false;
  if (missingFile.length || missingRow.length || dupName) {
    console.error(`[pack] 对账失败：表里有图缺失 ${missingFile.length} 条，磁盘有图未入表 ${missingRow.length} 条${dupName ? '，file_name 有重复' : ''}`);
    if (missingFile.length) console.error('  missing files: ' + missingFile.slice(0, 5).map((r) => r.path).join(', '));
    if (missingRow.length) console.error('  missing rows : ' + missingRow.slice(0, 5).join(', '));
    failed = true;
  }
  if (!probe.length) { console.error('[pack] 桥侧自检失败：按 tag 搜不到任何行（qq_meme_search 会回"没找到"）'); failed = true; }
  if (!byNameProbe || !fs.existsSync(path.join(packDir, norm(byNameProbe.path)))) {
    console.error('[pack] 桥侧自检失败：`SELECT path FROM memes WHERE file_name = ?` 取不到可用路径（qq_send_meme 会"搜得到、发不出"）');
    failed = true;
  }
  if (failed) return { ok: false };

  console.log(`[pack] OK  ${nextManifest.tags.length} 个 tag / ${rows.length} 张；表↔磁盘一致，桥侧两条查询自检通过（tag 提示词: ${TAG_HINT.join(' ')}）`);
  return { ok: true, count: rows.length, preserved, generated, deduped: quarantined.length };
}

const packDirs = all
  ? fs.readdirSync(target, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(target, e.name))
  : [target];
if (!packDirs.length) { console.error('no pack dirs under ' + target); process.exit(2); }

const results = [];
for (const dir of packDirs) {
  console.log(`\n=== ${dir} ===`);
  results.push(relayout(dir));
}
const bad = results.filter((r) => r.ok === false).length;
console.log(`\n[relayout] 处理 ${packDirs.length} 份，成功 ${results.filter((r) => r.ok).length}，失败 ${bad}${dry ? '（dry-run，未落盘）' : ''}`);
process.exit(bad ? 1 : 0);
