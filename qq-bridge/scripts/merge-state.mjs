// state 合并器(merge-state.mjs): 把「源 state 目录」合并进「目标 state 目录」,输出到 outDir。
// 规则(只合并累积型数据,不碰运行瞬时文件):
//   JSON 对象(*.json 且顶层为对象): 按键递归合并;数组字段按键内元素指纹去重合并;标量冲突取目标侧(目标优先,源缺失键补齐)
//   JSON 数组(顶层数组): 按元素指纹去重并集
//   *.jsonl: 按行指纹去重并集
//   memory.db: 三表行级合并(SQLite ATTACH),冲突键保留两侧不重复 + 更新时间较新者
//   bridge.lock / *.log / console-token 等瞬时文件: 跳过
// 用法: qbm-node scripts/merge-state.mjs <srcStateDir> <dstStateDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const [, , srcDir, dstDir, outDir] = process.argv;
if (!srcDir || !dstDir || !outDir) {
  console.error('用法: merge-state.mjs <srcStateDir> <dstStateDir> <outDir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const SKIP = new Set(['bridge.lock', 'console-token']);
const log = (...a) => console.log(...a);

function fingerprint(v) {
  if (v && typeof v === 'object') {
    // 有稳定 id/resId/uid/message_id/msg_seq 时优先用它们, 否则整串 hash
    for (const k of ['id', 'resId', 'message_id', 'uid', 'conv_key', 'msg_seq', 'sessionId', 'rpcId', 'eventId']) {
      if (v[k] !== undefined && v[k] !== null) return `${k}=${v[k]}`;
    }
    return 'h:' + crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
  }
  return 'v:' + String(v);
}

function mergeArray(target, source) {
  const seen = new Set(target.map(fingerprint));
  const out = [...target];
  for (const it of source) {
    const f = fingerprint(it);
    if (!seen.has(f)) { seen.add(f); out.push(it); }
  }
  return out;
}

function isPlainObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** 递归合并: 目标优先, 源补充缺失键; 数组去重并集。 */
function mergeJsonValue(target, source) {
  if (Array.isArray(source)) {
    if (Array.isArray(target)) return mergeArray(target, source);
    return mergeArray([], source); // 目标非数组 → 用源(尽量不丢)
  }
  if (isPlainObj(source)) {
    if (!isPlainObj(target)) return { ...source };
    const out = { ...target };
    for (const [k, sv] of Object.entries(source)) {
      out[k] = k in out ? mergeJsonValue(out[k], sv) : sv;
    }
    return out;
  }
  // 标量: 目标非空则保留目标, 否则取源
  if (target === undefined || target === null || target === '') return source;
  return target;
}

function parseJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; }
}
function writeJson(p, v) {
  fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
}

/* ---------------- memory.db 行合并 ---------------- */
// 表级逻辑键去重: 按业务唯一键合并(而非自增 id —— 两端 AUTOINCREMENT 空间重叠,
// 按 id 用 INSERT OR IGNORE 会把后写一端整段吞掉, 等同“远端全量胜出”)。
// 冲突择优: 表带时间列保留时间较新者(相等取后写=本地); 无时间列取后写(本地优先)。
// 自增主键重排, 彻底消除两端 id 重叠; 合并完成后重建全部索引(含部分唯一索引)。
const TABLE_LOGIC = {
  chat_messages: {
    key: (r) => {
      const m = String(r.message_id ?? '');
      return m !== ''
        ? `K\u0001${String(r.conv_key ?? '')}\u0001${m}`
        : `A\u0001${String(r.conv_key ?? '')}\u0001${String(r.sender_uid ?? '')}\u0001${String(r.direction ?? '')}\u0001${String(r.kind ?? '')}\u0001${String(r.content ?? '')}\u0001${Number(r.ts_ms) || 0}`;
    },
    ts: (r) => Number(r.ts_ms) || 0,
    renumber: true,
  },
  memory_entries: {
    key: (r) => `K\u0001${String(r.uid ?? '')}\u0001${String(r.category ?? '')}\u0001${String(r.content ?? '')}`,
    ts: (r) => Number(r.created_at) || 0,
    renumber: true,
  },
  profiles: {
    key: (r) => `K\u0001${String(r.uid ?? '')}`,
    ts: (r) => Number(r.updated_at) || 0,
    renumber: false,
  },
};
function mergeSqlite(srcDb, dstDb, outDb) {
  // 读出两库全部表结构/索引 + 行(内存去重, 免 ATTACH 转义问题)
  const structs = [srcDb, dstDb].map((p) => {
    const db = new DatabaseSync(p, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const defs = {};
    for (const t of tables) {
      const c = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
      const idxs = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(t);
      defs[t] = { sql: c?.sql, cols: db.prepare(`PRAGMA table_info("${t}")`).all().map((x) => x.name), rows: db.prepare(`SELECT * FROM "${t}"`).all(), idxs };
    }
    db.close();
    return defs;
  });
  const out = new DatabaseSync(outDb);
  // 以 dst 结构为骨架(缺失表用 src 补), 行按表级逻辑键去重择优
  const tableNames = new Set([...Object.keys(structs[0]), ...Object.keys(structs[1])]);
  for (const t of tableNames) {
    const def = structs[1][t] ?? structs[0][t];
    if (!def?.sql) continue;
    const cleanSql = def.sql.replace(/CREATE TABLE\s*(IF NOT EXISTS\s*)?/i, 'CREATE TABLE IF NOT EXISTS main.');
    try { out.exec(cleanSql); } catch (e) { console.log('create', t, 'skip:', e.message); continue; }
    const cols = def.cols;
    const spec = TABLE_LOGIC[t];
    const hasId = cols.includes('id');
    const chosen = new Map();
    const order = [];
    const prefer = (key, row) => {
      const prev = chosen.get(key);
      if (!prev) { chosen.set(key, row); order.push(key); return; }
      if (spec?.ts) {
        const tNew = spec.ts(row); const tOld = spec.ts(prev);
        if (tNew >= tOld) chosen.set(key, row); // 相等取后写(本地)
      } else { chosen.set(key, row); }
    };
    for (const side of structs) {
      const defS = side[t];
      if (!defS) continue;
      for (const row of defS.rows) prefer(spec ? spec.key(row) : cols.map((c) => String(row[c] ?? '')).join('\u0001'), row);
    }
    const colList = cols.map((c) => `"${c}"`).join(',');
    const qs = cols.map(() => '?').join(',');
    const ins = out.prepare(`INSERT INTO main."${t}" (${colList}) VALUES (${qs})`);
    let nid = 1; let inserted = 0;
    out.exec('BEGIN');
    for (const key of order) {
      const row = chosen.get(key);
      if (spec?.renumber && hasId) row.id = nid++;
      try { ins.run(...cols.map((c) => (row[c] ?? null))); inserted += 1; } catch (e) { console.log('  row skip', t, e.message); }
    }
    out.exec('COMMIT');
    // 重建索引(含部分唯一索引; 已逻辑键去重, 一般不会冲突)
    const seenIdx = new Set();
    for (const side of structs) {
      const defS = side[t];
      if (!defS) continue;
      for (const ix of defS.idxs ?? []) {
        if (!ix?.sql || seenIdx.has(ix.name)) continue;
        seenIdx.add(ix.name);
        try { out.exec(ix.sql.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+/i, 'CREATE $1INDEX IF NOT EXISTS ')); } catch (e) { console.log('  index skip', t, ix.name, e.message); }
      }
    }
    console.log(`  db 表 ${t}: ${cols.length} 列, 逻辑键去重后 ${inserted} 行`);
  }
  out.close();
}

/* ---------------- 主流程 ---------------- */
const srcFiles = new Map();
const dstFiles = new Map();
for (const [dir, map] of [[srcDir, srcFiles], [dstDir, dstFiles]]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    map.set(f, p);
  }
}

const allNames = new Set([...srcFiles.keys(), ...dstFiles.keys()]);
let mergedJson = 0, mergedLines = 0, skipped = 0, dbMerged = 0;
const summary = [];

// 子目录(agents/self-test/sticker-tmp 等会话工作目录): 保留目标(本地)侧原样, 远端子目录不拉取。
for (const sub of fs.existsSync(dstDir) ? fs.readdirSync(dstDir) : []) {
  const p = path.join(dstDir, sub);
  if (fs.statSync(p).isDirectory()) {
    fs.cpSync(p, path.join(outDir, sub), { recursive: true });
    summary.push(`${sub}/: 本地子目录原样保留`);
  }
}
// 目标侧不存在但源侧存在的目录: 忽略(会话工作目录不合并, 避免 DSH 会话路径混乱)

for (const name of allNames) {
  const isData = /\.(json|jsonl|db|sqlite)$/.test(name);
  // 瞬时/临时文件(bridge.lock、console-token、*.log、*.tmp/*.cjs/*.js/*.mjs/*.bak/*.old、agents 等):
  // 保留目标(dst)侧存在版本(若无则跳过, 不引入远端临时残file)
  if (SKIP.has(name) || /\.log$/.test(name) || /\.(lock|tmp|cjs|js|mjs|bak|old)$/.test(name) || name.startsWith('.') || !isData) {
    const winner = SKIP.has(name) || /\.log$/.test(name) || /\.(lock)$/.test(name) ? (dstFiles.get(name) ?? srcFiles.get(name)) : undefined;
    if (winner) { fs.copyFileSync(winner, path.join(outDir, name)); skipped += 1; }
    continue;
  }
  const srcP = srcFiles.get(name);
  const dstP = dstFiles.get(name);
  if (/\.(db|sqlite)$/.test(name)) {
    if (srcP && dstP) {
      mergeSqlite(srcP, dstP, path.join(outDir, name));
      dbMerged += 1;
      summary.push(`${name}: SQLite 行合并(src ${fs.statSync(srcP).size}B + dst ${fs.statSync(dstP).size}B)`);
    } else {
      fs.copyFileSync(srcP ?? dstP, path.join(outDir, name));
      summary.push(`${name}: 仅单侧存在, 原样保留`);
    }
    continue;
  }
  if (name.endsWith('.jsonl')) {
    const lines = [];
    const seen = new Set();
    for (const p of [srcP, dstP]) {
      if (!p || !fs.existsSync(p)) continue;
      for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const f = 'h:' + crypto.createHash('sha1').update(line).digest('hex');
        if (!seen.has(f)) { seen.add(f); lines.push(line); }
      }
    }
    lines.sort((a, b) => {
      try { const ta = JSON.parse(a).tsMs ?? JSON.parse(a).t ?? 0; const tb = JSON.parse(b).tsMs ?? JSON.parse(b).t ?? 0; return ta - tb; } catch { return 0; }
    });
    fs.writeFileSync(path.join(outDir, name), lines.join('\n') + '\n', 'utf8');
    mergedLines += 1;
    summary.push(`${name}: 行去重并集 ${lines.length} 行`);
    continue;
  }
  if (name.endsWith('.json')) {
    const srcExists = !!srcP && fs.existsSync(srcP);
    const dstExists = !!dstP && fs.existsSync(dstP);
    if (srcExists && dstExists) {
      const sv = parseJsonFile(srcP);
      const dv = parseJsonFile(dstP);
      if (sv !== undefined && dv !== undefined) {
        const merged = mergeJsonValue(dv, sv);
        writeJson(path.join(outDir, name), merged);
        mergedJson += 1;
        summary.push(`${name}: JSON 合并完成`);
        continue;
      }
      // 任一端解析失败: 保留解析成功的那端原文件(绝不丢真实文件)
      const keeper = sv !== undefined ? srcP : (dv !== undefined ? dstP : srcP);
      if (keeper) { fs.copyFileSync(keeper, path.join(outDir, name)); skipped += 1; summary.push(`${name}: 一侧 JSON 无法解析, 保留可解析端原样`); }
      continue;
    }
    // 只存在一端 → 原样保留
    const sole = dstExists ? dstP : srcP;
    if (sole) { fs.copyFileSync(sole, path.join(outDir, name)); skipped += 1; summary.push(`${name}: ${dstExists ? '本地' : '远端'}独有, 保留原样`); }
    continue;
  }
  // 其它单侧文件原样保留
  const p = dstP ?? srcP;
  if (p) { fs.copyFileSync(p, path.join(outDir, name)); summary.push(`${name}: 单侧文件保留`); }
}

console.log(`\n合并完成: JSON ${mergedJson}, jsonl ${mergedLines}, db ${dbMerged}, 跳过/瞬时 ${skipped}`);
for (const s of summary) console.log(' -', s);
process.exit(0);
