/**
 * 内置表情包（meme pack）**上传接口**的集成自测：对着真跑起来的 `server/index.js` 打 HTTP，不做任何 mock。
 *
 * 为什么必须隔离：`server/index.js` 的 `RUNTIME_ROOT` 是**按文件位置**推导的（`<runtime>/server/index.js`），
 * 环境变量改不动它。所以本脚本把 `server/index.js` 复制进沙箱 `.meme-import-test-<ts>/server/`，
 * 再把 `USERPROFILE` 指向沙箱 home、`QBM_NO_LISTEN=1` 只导出 `app`（不监听、不 autostart、不武装守卫），
 * 由本脚本自己 `listen(0)` 拿一个临时端口。于是：
 *   · 包、索引、config.json 全在沙箱里，**绝不碰现网 runtime 与仓库 meme/**（脚本结尾还会断言出厂包没被动过）；
 *   · 上传后的"自动重启桥"会被 `localBridgeRestartCheck()` 挡掉 —— 本脚本**断言它确实被挡掉**，
 *     因为那条分支里的 `killByCmdline('bridge.js')` 会按命令行关键字杀掉本机所有 node/qbm-node 进程。
 *
 * 用法：node tools/test-meme-pack-import.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SANDBOX = path.join(REPO, `.meme-import-test-${Date.now()}`);
const HOME = path.join(SANDBOX, 'home');
const BRIDGE = path.join(SANDBOX, 'qq-bridge');
const CFG = path.join(BRIDGE, 'config.json');
const FACTORY_PACK = path.join(SANDBOX, 'meme', 'factory-demo');
const UPLOAD_ROOT = path.join(SANDBOX, 'meme-packs');
/** 出厂包（真仓库里那份）在测试前后的指纹：用来证明这次自测没碰它 */
const REAL_FACTORY = path.join(REPO, 'meme', 'whale-fanart-001');

let fails = 0;
let steps = 0;
const check = (name, ok, extra = '') => {
  steps += 1;
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);
const img = (tag) => Buffer.from(`RIFF0000WEBPVP8 ${tag}`);

// ─────────────────────────── 最小 ZIP 写入器（不引依赖；stored + deflate 两条路都覆盖） ───────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');           // 一律按 UTF-8 写名字并置 flag 0x0800（真实表情包文件名多为中文）
    const raw = Buffer.from(e.data);
    const deflated = zlib.deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;    // 大的走 deflate，小的走 stored —— 两条路都被测到
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += lh.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cdBuf, eocd]);
}

// ─────────────────────────── 沙箱搭建 ───────────────────────────
const fingerprint = (p) => {
  try { const st = fs.statSync(p); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return '-'; }
};
const realFactoryBefore = fingerprint(path.join(REAL_FACTORY, 'index.db'));

fs.mkdirSync(SANDBOX, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(BRIDGE, 'tools'), { recursive: true });
// 整个 server/ 一起拷：index.js 还 import 了同目录的 deploy.js / napcat-guardian.mjs 等
fs.cpSync(path.join(REPO, 'server'), path.join(SANDBOX, 'server'), { recursive: true });
// 上传接口会用桥目录里的规整脚本；沙箱里放一份真的（和线上同源）
fs.copyFileSync(path.join(REPO, 'qq-bridge', 'tools', 'relayout-meme-pack.mjs'), path.join(BRIDGE, 'tools', 'relayout-meme-pack.mjs'));
// 带 BOM、带缩进、带若干与绑定无关的字段 —— 用来验"bind 只动 social.meme.personaPacks"
fs.writeFileSync(CFG, '\uFEFF' + JSON.stringify({
  ownerQQ: 1736784911,
  napcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'truefriend' },
  social: { enabled: true, sticker: { enabled: true, syncTtlMs: 60000 } }
}, null, 2) + '\n', 'utf8');
// 一份"出厂包"：2 张图，用真规整脚本建索引（这样 schema 与线上一致）
for (const [rel, data] of [['memes/happy/happy-01.webp', img('f1')], ['memes/demo/demo-01.webp', img('f2')]]) {
  const p = path.join(FACTORY_PACK, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
const relayout = spawnSync(process.execPath, [path.join(BRIDGE, 'tools', 'relayout-meme-pack.mjs'), FACTORY_PACK], { encoding: 'utf8' });
if (relayout.status !== 0) { console.error('沙箱出厂包规整失败：\n' + relayout.stdout + relayout.stderr); process.exit(2); }

process.env.USERPROFILE = HOME;      // homedir() 跟着它走 → 管理端配置目录也落进沙箱
process.env.QBM_NO_LISTEN = '1';     // 只导出 app：不监听端口、不 autostart、不武装守卫

let server = null;
const created = [];
try {
  const mod = await import(`file:///${path.join(SANDBOX, 'server', 'index.js').replace(/\\/g, '/')}`);
  server = await new Promise((resolve) => {
    const s = mod.app.listen(0, '127.0.0.1', () => resolve(s));
  });
const BASE = `http://127.0.0.1:${server.address().port}`;

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON 留 null */ }
  return { status: r.status, body: j };
};
const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
};
const b64 = (buf) => Buffer.from(buf).toString('base64');
const listDir = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listDir(p, out); else out.push(path.relative(dir, p).replace(/\\/g, '/'));
  }
  return out;
};
const readTable = (packDir) => {
  const db = new DatabaseSync(path.join(packDir, 'index.db'), { readOnly: true });
  try { return db.prepare('SELECT path, file_name, tag, caption FROM memes ORDER BY path').all(); }
  finally { db.close(); }
};

  // ─────────────────────── 1) 列表 ───────────────────────
  section('GET /api/bridge/meme-packs（真读 index.db）');
  const list = await get('/api/bridge/meme-packs');
  check('200 + success', list.status === 200 && list.body?.success === true, `status=${list.status}`);
  const packs = list.body?.packs ?? [];
  check('列出沙箱里的出厂包', packs.some((p) => p.id === 'factory-demo'), packs.map((p) => p.id).join(','));
  const fp = packs.find((p) => p.id === 'factory-demo');
  check('张数来自 index.db（2 行）', fp?.count === 2, `count=${fp?.count} imageCount=${fp?.imageCount} tags=${(fp?.tags ?? []).join(',')}`);
  check('来源标成 factory', fp?.source === 'factory', `source=${fp?.source}`);
  check('目录口径三处都回了', !!list.body?.dirs?.global && !!list.body?.dirs?.packs && Array.isArray(list.body?.dirs?.characters));

  // ─────────────────────── 2) zip 上传 ───────────────────────
  section('POST /api/bridge/meme-packs/upload（zip：2 张图 + 1 个非图 + __MACOSX + 中文名）');
  const zipPackId = 'zip-pack-' + Date.now();
  created.push(zipPackId);
  const zip = makeZip([
    { name: 'zip-pack/happy/开心-01.webp', data: img('z1') },
    { name: 'zip-pack/angry/angry-01.png', data: img('z2') },
    // 已经在 memes/<tag>/ 下的文件**保持原名**（规整脚本只给"不在 memes/ 下的"统一改名）
    { name: 'zip-pack/memes/daily/中文文件名保留.webp', data: img('z3') },
    { name: 'zip-pack/readme.txt', data: Buffer.from('not an image') },
    { name: '__MACOSX/zip-pack/._happy-01.webp', data: Buffer.from('junk') },
  ]);
  const up = await post('/api/bridge/meme-packs/upload', { packId: zipPackId, zip: { name: 'good.zip', data: b64(zip) } });
  check('200 + success', up.status === 200 && up.body?.success === true, `status=${up.status} msg=${up.body?.message ?? ''}`);
  check('逐文件报告：收到 5 / 入库 3 / 跳过 2', up.body?.report?.received === 5 && up.body?.report?.images === 3 && up.body?.report?.skipped === 2,
    `received=${up.body?.report?.received} images=${up.body?.report?.images} skipped=${up.body?.report?.skipped}`);
  check('跳过的名字里有 __MACOSX 与 readme.txt',
    ['__MACOSX', 'readme.txt'].every((k) => (up.body?.report?.skippedNames ?? []).some((n) => n.includes(k))),
    JSON.stringify(up.body?.report?.skippedNames));
  const zipDir = path.join(UPLOAD_ROOT, zipPackId);
  check('落在 <runtime>/meme-packs/<packId>', path.resolve(up.body?.dir ?? '') === path.resolve(zipDir), up.body?.dir);
  const zipRows = readTable(zipDir);
  check('index.db 有 3 行且 path 是相对路径', zipRows.length === 3 && zipRows.every((r) => /^memes\/[^/]+\/.+\.(webp|png|jpg|jpeg|gif)$/i.test(String(r.path))),
    JSON.stringify(zipRows.map((r) => r.path)));
  /* 上传的原始文件名不会丢：不在 memes/ 下的文件会被规整成 <tag>-NN，但**原名进了 caption/keywords**，
   * 所以照样能按原名搜到；已经在 memes/<tag>/ 下的文件连文件名都保持原样。 */
  check('被改名的图，原名仍在 caption/keywords 里（还能按原名搜到）',
    zipRows.some((r) => String(r.caption).includes('开心')),
    JSON.stringify(zipRows.map((r) => r.caption)));
  check('memes/<tag>/ 下的中文文件名原样保留',
    listDir(zipDir).some((f) => f.includes('中文文件名保留')),
    listDir(zipDir).join(','));
  check('磁盘上就是规整后的 memes/<tag>/ 结构', listDir(zipDir).filter((f) => /\.(webp|png)$/i.test(f)).length === 3, listDir(zipDir).join(','));
  check('没留下 .upload-* 临时目录', !fs.readdirSync(UPLOAD_ROOT, { withFileTypes: true }).some((e) => e.name.startsWith('.upload-')),
    fs.readdirSync(UPLOAD_ROOT).join(','));

  // ─────────────────────── 3) 文件夹上传（files[] + 相对路径） ───────────────────────
  section('POST /upload（文件夹：path 带相对路径）');
  const folderPackId = 'folder-pack-' + Date.now();
  created.push(folderPackId);
  const up2 = await post('/api/bridge/meme-packs/upload', {
    packId: folderPackId,
    files: [
      { path: `${folderPackId}/happy/a.webp`, data: b64(img('g1')) },
      { path: `${folderPackId}/happy/b.webp`, data: b64(img('g2')) },
      { path: `${folderPackId}/happy/c.webp`, data: b64(img('g3')) },
      { path: `${folderPackId}/.DS_Store`, data: b64(Buffer.from('junk')) }
    ]
  });
  check('200 + success', up2.status === 200 && up2.body?.success === true, `status=${up2.status} msg=${up2.body?.message ?? ''}`);
  check('入库 3 张、跳过 1 个（.DS_Store）', up2.body?.report?.images === 3 && up2.body?.report?.skipped === 1,
    `images=${up2.body?.report?.images} skipped=${up2.body?.report?.skipped} names=${JSON.stringify(up2.body?.report?.skippedNames)}`);
  check('count/tags 与库一致', up2.body?.count === 3 && (up2.body?.tags ?? []).includes('happy'), `count=${up2.body?.count} tags=${JSON.stringify(up2.body?.tags)}`);

  // ─────────────────────── 4) zip-slip 与坏输入（磁盘必须零痕迹） ───────────────────────
  section('坏输入：zip-slip / 无图片 / 包名非法 —— 一律 400 且磁盘零痕迹');
  const before = listDir(SANDBOX).length;
  const slipId = 'slip-pack-' + Date.now();
  const slip = await post('/api/bridge/meme-packs/upload', {
    packId: slipId,
    zip: { name: 'evil.zip', data: b64(makeZip([{ name: '../evil.webp', data: img('evil') }, { name: 'x/ok.webp', data: img('ok') }])) }
  });
  check('zip-slip → 400', slip.status === 400 && slip.body?.success === false, `status=${slip.status} msg=${slip.body?.message ?? ''}`);
  check('没有在 meme-packs 之上写出 evil.webp', !fs.existsSync(path.join(SANDBOX, 'evil.webp')) && !fs.existsSync(path.join(REPO, 'evil.webp')));
  check('没造出 slip-pack 目录', !fs.existsSync(path.join(UPLOAD_ROOT, slipId)));
  const noImg = await post('/api/bridge/meme-packs/upload', {
    packId: 'noimg-pack-' + Date.now(),
    zip: { name: 'noimg.zip', data: b64(makeZip([{ name: 'a/readme.txt', data: Buffer.from('x') }])) }
  });
  check('一个图片都没有 → 400', noImg.status === 400 && noImg.body?.success === false, `status=${noImg.status} msg=${noImg.body?.message ?? ''}`);
  const badId = await post('/api/bridge/meme-packs/upload', { packId: '../evil', files: [{ path: 'a.webp', data: b64(img('b')) }] });
  check('包名非法（含 ../）→ 400', badId.status === 400 && badId.body?.success === false, `status=${badId.status} msg=${badId.body?.message ?? ''}`);
  check('三次坏输入之后沙箱文件数没变（零痕迹）', listDir(SANDBOX).length === before, `${before} → ${listDir(SANDBOX).length}`);

  // ─────────────────────── 5) 删除：出厂包拒绝 / 上传包可删 ───────────────────────
  section('删除：出厂包只能禁用不能删；上传的包可以删');
  const delFactory = await post('/api/bridge/meme-packs/delete', { id: 'factory-demo' });
  check('出厂包删除被拒（400）', delFactory.status === 400 && delFactory.body?.success === false, `status=${delFactory.status} msg=${delFactory.body?.message ?? ''}`);
  check('出厂包目录还在', fs.existsSync(FACTORY_PACK));
  const delZip = await post('/api/bridge/meme-packs/delete', { id: zipPackId });
  check('上传的包删除成功', delZip.status === 200 && delZip.body?.success === true, `status=${delZip.status} msg=${delZip.body?.message ?? ''}`);
  check('删除后目录不再作为包存在（改名/移除）', !fs.existsSync(path.join(UPLOAD_ROOT, zipPackId, 'index.db')));
  created.splice(created.indexOf(zipPackId), 1);

  // ─────────────────────── 6) 角色绑定（写 config.json，只动 personaPacks） ───────────────────────
  section('POST /api/bridge/meme-packs/bind（写 social.meme.personaPacks）');
  const cfgBefore = fs.readFileSync(CFG, 'utf8');
  const bind = await post('/api/bridge/meme-packs/bind', { character: 'demo-role', packs: [folderPackId, 'unknown-pack-id'] });
  check('200 + success', bind.status === 200 && bind.body?.success === true, `status=${bind.status} msg=${bind.body?.message ?? ''}`);
  const cfgAfter = fs.readFileSync(CFG, 'utf8');
  check('保留 UTF-8 BOM', cfgAfter.charCodeAt(0) === 0xFEFF, `first=U+${cfgAfter.charCodeAt(0).toString(16).toUpperCase()}`);
  check('保留结尾换行', cfgAfter.endsWith('\n'));
  const parsed = JSON.parse(cfgAfter.replace(/^\uFEFF/, ''));
  /* 绑定时"还没上传的包 id"会**原样保留**（可以先绑后传），但要在返回里点名 —— 所以这里断言的是
   * 两个 id 都写进去了、且 unknown 里报出了那个不存在的。 */
  check('写进了 personaPacks[demo-role]（含"先绑后传"的那个 id）',
    JSON.stringify(parsed?.social?.meme?.personaPacks?.['demo-role']) === JSON.stringify([folderPackId, 'unknown-pack-id']),
    JSON.stringify(parsed?.social?.meme?.personaPacks));
  check('返回里点名了还没上传的包', (bind.body?.unknown ?? []).includes('unknown-pack-id'), JSON.stringify(bind.body?.unknown));
  check('其它字段一字未动', parsed.ownerQQ === 1736784911 && parsed.napcat?.accessToken === 'truefriend' && parsed.social?.sticker?.syncTtlMs === 60000
    && parsed.social?.enabled === true, JSON.stringify({ ownerQQ: parsed.ownerQQ, sticker: parsed.social?.sticker }));
  check('原来的键一个没丢', ['ownerQQ', 'napcat', 'social'].every((k) => k in parsed) && cfgBefore.includes('"ownerQQ"'));
  const list2 = await get('/api/bridge/meme-packs');
  check('GET 里 bindings 反映出绑定', JSON.stringify(list2.body?.bindings?.['demo-role']) === JSON.stringify([folderPackId, 'unknown-pack-id']), JSON.stringify(list2.body?.bindings));

  // ─────────────────────── 7) 角色库根目录：默认扫桥目录 + 配了就以配置为准 + 导入记当前角色 ───────────────────────
  section('角色库目录：默认扫桥目录 characters；配了 social.charactersDir 就以它为准；导入会记下当前角色');
  const factoryRole = path.join(BRIDGE, 'characters', 'factory-role');
  fs.mkdirSync(factoryRole, { recursive: true });
  fs.writeFileSync(path.join(factoryRole, 'SKILL.md'), '# factory-role\n出厂库里的演示角色。\n', 'utf8');
  fs.writeFileSync(path.join(factoryRole, 'manifest.json'), JSON.stringify({ name: '出厂演示角色' }), 'utf8');
  const userLib = path.join(SANDBOX, 'user-lib');
  const userRole = path.join(userLib, 'user-role');
  fs.mkdirSync(userRole, { recursive: true });
  fs.writeFileSync(path.join(userRole, 'SKILL.md'), '# user-role\n你自己库里的角色。\n', 'utf8');
  // 注意：这份**也要**带 manifest.json —— scanCharacters 有个"目录不是角色库（没有子目录带 manifest）
  // 且只有一个子目录 → 往下钻一层"的旧启发式，只放一个不带 manifest 的包会被它当成"外面那层壳"。
  fs.writeFileSync(path.join(userRole, 'manifest.json'), JSON.stringify({ name: '你自己库里的角色' }), 'utf8');

  const ch1 = await get('/api/bridge/characters');
  const slugs1 = (ch1.body?.characters ?? []).map((c) => c.slug);
  check('没配 charactersDir 时扫桥目录里的角色库', ch1.body?.ok === true && slugs1.includes('factory-role'), `dir=${ch1.body?.dir} slugs=${slugs1.join(',')}`);

  // 把 social.charactersDir 指到"用户自己那份" → 扫描根改用它与桥侧四个角色工具同一口径
  const cfgNow = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, ''));
  cfgNow.social = { ...(cfgNow.social ?? {}), charactersDir: userLib };
  fs.writeFileSync(CFG, JSON.stringify(cfgNow, null, 2) + '\n', 'utf8');
  const ch2 = await get('/api/bridge/characters');
  const slugs2 = (ch2.body?.characters ?? []).map((c) => c.slug);
  check('配了 social.charactersDir 之后完全以它为准', slugs2.includes('user-role') && !slugs2.includes('factory-role'), `dir=${ch2.body?.dir} slugs=${slugs2.join(',')}`);

  const imp = await post('/api/bridge/characters/import', { dir: userLib, slug: 'user-role', includeDims: true, apply: true });
  check('导入角色成功', imp.status === 200 && imp.body?.success === true, `status=${imp.status} msg=${imp.body?.message ?? ''}`);
  check('persona.md 真的写进去了', (() => {
    const p = path.join(BRIDGE, 'persona.md');
    try { return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('user-role'); } catch { return false; }
  })());
  const cfgAfterImport = JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, ''));
  check('导入顺手记下 social.meme.activePersona', cfgAfterImport?.social?.meme?.activePersona === 'user-role', JSON.stringify(cfgAfterImport?.social?.meme ?? null));
  check('导入只动这一格（charactersDir 与其它字段都在）',
    cfgAfterImport?.social?.charactersDir === userLib && cfgAfterImport.ownerQQ === 1736784911,
    JSON.stringify({ ownerQQ: cfgAfterImport.ownerQQ, charactersDir: cfgAfterImport?.social?.charactersDir }));
  check('返回里如实报了 activePersona 写入结果', imp.body?.activePersona?.written === true, JSON.stringify(imp.body?.activePersona ?? null));

  // ─────────────────────── 8) 安全：不上线桥、不动出厂包 ───────────────────────
  section('安全边界');
  const up3 = await post('/api/bridge/meme-packs/upload', {
    packId: 'restart-check-' + Date.now(),
    files: [{ path: 'r/a.webp', data: b64(img('r')) }]
  });
  check('上传成功（用于看 restart 字段）', up3.status === 200 && up3.body?.success === true, `status=${up3.status}`);
  check('沙箱里 restart 被挡掉（skipped，绝不 ok:true）', up3.body?.restart?.ok !== true, JSON.stringify(up3.body?.restart));
  created.push(up3.body?.packId);

  const realFactoryAfter = fingerprint(path.join(REAL_FACTORY, 'index.db'));
  check('仓库出厂包 index.db 没被动过（大小+mtime 指纹一致）', realFactoryBefore === realFactoryAfter, `${realFactoryBefore} → ${realFactoryAfter}`);
  check('仓库根没多出 evil.webp / 临时包目录', !fs.existsSync(path.join(REPO, 'evil.webp')) && !fs.existsSync(path.join(REPO, 'meme-packs', 'slip-pack-' + Date.now())));
} finally {
  if (server) await new Promise((r) => server.close(r));
  // 收尾：先删掉本测试造出来的包（它们可能带中文名，一律交给 PowerShell），再删整个沙箱
  for (const id of created) {
    const p = path.join(UPLOAD_ROOT, id);
    if (fs.existsSync(p)) spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Remove-Item -LiteralPath ${JSON.stringify(p)} -Recurse -Force`], { stdio: 'ignore' });
  }
  const base = path.basename(SANDBOX);
  if (!base.startsWith('.meme-import-test-') || /node_modules/i.test(SANDBOX)) {
    console.log(`清理已跳过（路径不像自测临时目录）：${SANDBOX}`);
  } else {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Remove-Item -LiteralPath ${JSON.stringify(SANDBOX)} -Recurse -Force`], { stdio: 'ignore' });
    console.log(`\n[cleanup] 沙箱已清理 exit=${r.status}；仍存在=${fs.existsSync(SANDBOX)}`);
    check('沙箱清理干净', !fs.existsSync(SANDBOX), SANDBOX);
    check('清理没伤到仓库 node_modules', fs.existsSync(path.join(REPO, 'node_modules')));
  }
}
console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}（${steps} 项检查）`);
process.exit(fails ? 1 : 0);
