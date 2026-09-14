// 角色库只读工具组（qq_character_list / qq_character_read / qq_character_pack / qq_character_search）
// 的内部纯函数测试。**按真实结构**：一个角色 = 一个子目录 = 一个"角色包"（不是一堆平铺的 .md）。
//
// 跑法：cd qq-bridge && node tests/character-library.test.js
// 说明：
// - 把 src/mcp-napcat-safe.js 当模块直接 import（QQB_MCP_NO_LISTEN=1 → 只加载、不连 MCP stdio），
//   断言的就是四个工具真正调用的那批函数（工具回调只是薄壳）。
// - 只打印路径 / 计数 / 文件名，**不打印任何角色卡正文**（主人的私人内容）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQB_MCP_NO_LISTEN = '1';
const lib = await import('../src/mcp-napcat-safe.js');

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`);
  }
};
const skip = (name, why) => console.log(`SKIP  ${name} (${why})`);

// ── 造一个假角色库：结构照真实库（<包>/<档>.md + <包>/sources/wiki.md + <包>/manifest.json + 库根散装 .md） ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-charpack-'));
const ROOT = path.join(TMP, 'characters');
const OUTSIDE = path.join(TMP, 'outside');
const mk = (...p) => fs.mkdirSync(path.join(ROOT, ...p), { recursive: true });
const w = (rel, text) => fs.writeFileSync(path.join(ROOT, ...rel.split('/')), text);

// 中文 3 字节/字：给每份档塞够体积，好让"截断"用例真的会截断
const PAD = `\n${'设定补充。'.repeat(50)}\n`;
const manifest = (name, extra = {}) => JSON.stringify({ slug: name, name, version: '2.0', game: 'ATRI -My Dear Moments-', dimensions: ['profile', 'personality'], ...extra }, null, 2);

mk('atri', 'sources');
mk('nopack');                       // 没有 SKILL.md：默认档要回落到 manifest.json
mk('tiny');                         // 只剩 profile.md：兜底挑一份
mk('big');                          // 用来测 pack 的截断
mk('depthpack', 'a', 'b', 'c');      // 包内层数：a/b/ok.md 允许，a/b/c/too-deep.md 拒绝
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'OUTSIDE-SECRET-CONTENT');

w('ATRI_MAIN_PROMPT.md', `# ATRI 主人格系统提示词\n散装主提示词\n${PAD}`);   // 库根下散装文件
w('notes.txt', '散装文本卡：猫娘入门笔记\n');
w('huge.md', `# 超大散装卡\n${'猫娘'.repeat(20000)}\n`);                     // > 32KB

w('atri/SKILL.md', `---\nname: atri\nversion: 2.0\n---\n技能正文：傲娇\n${PAD}`);
w('atri/ULTIMATE_ROLEPLAY_PROMPT.md', `# 亚托莉 终极扮演系统提示词\nv2 正文\n${PAD}`);
w('atri/ULTIMATE_ROLEPLAY_PROMPT_v3.0.md', `# 亚托莉 终极扮演系统提示词 v3\nv3 正文\n${PAD}`);
w('atri/personality.md', `# 性格\n${PAD}`);
w('atri/profile.md', `# 角色档案：亚托莉\n${PAD}`);
w('atri/interaction.md', `# 互动\n${PAD}`);
w('atri/relations.md', `# 关系\n${PAD}`);
w('atri/memory.md', `# 记忆\n${PAD}`);
w('atri/conflicts.md', `# 冲突\n${PAD}`);
w('atri/manifest.json', manifest('atri'));
w('atri/sources/wiki.md', `# Wiki 来源\n来自 wiki 的一手资料：猫娘\n${PAD}`);

w('nopack/manifest.json', manifest('nopack'));
w('nopack/personality.md', `# 没有 SKILL 的性格档\n${PAD}`);
w('nopack/profile.md', `# 档案\n${PAD}`);

w('tiny/profile.md', `# 只有一个 profile 的包\n${PAD}`);

w('big/SKILL.md', `# 大 skill\n${'设定'.repeat(10000)}\n`);                 // ≈60KB → 4KB 上限必被截断
w('big/personality.md', `# 性格\n${PAD}`);

w('depthpack/a/b/ok.md', '# 包内两层\n允许\n');
w('depthpack/a/b/c/too-deep.md', '# 包内三层\n不该被扫到\n');

const inPacks = (r, name) => r.packs.some((p) => p.name === name);

// ── 1. 列角色包 ──
check('列角色包：包名/文件数/总大小/mtime/manifest 名字+简介；散装文件标 (loose file)；manifest.json 计入包内文件数', () => {
  const r = lib.listCharacterPacks(ROOT, { limit: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.totalPacks, 5, `packs=${r.packs.map((p) => p.name).join(',')}`);
  assert.ok(inPacks(r, 'atri') && inPacks(r, 'nopack') && inPacks(r, 'tiny') && inPacks(r, 'big') && inPacks(r, 'depthpack'));
  const atri = r.packs.find((p) => p.name === 'atri');
  assert.equal(atri.fileCount, 11, `atri 包内文件数=${atri.fileCount}`);       // 10 份 .md + manifest.json
  assert.ok(atri.totalBytes > 0 && atri.mtimeMs > 0);
  assert.equal(atri.manifest.ok, true);
  assert.equal(atri.manifest.name, 'atri');
  assert.equal(atri.manifest.version, '2.0');
  assert.ok(atri.manifest.summary.includes('My Dear Moments'), `summary=${atri.manifest.summary}`);
  assert.equal(atri.mainFile, 'SKILL.md');
  assert.equal(r.loose.map((f) => f.name).sort().join(','), 'ATRI_MAIN_PROMPT.md,huge.md,notes.txt');
  const text = lib.characterListText(500, undefined, ROOT);
  assert.ok(text.includes('(loose file)'), '散装文件要标 (loose file)');
  assert.ok(text.includes('atri/ | 11 file(s)'), text.split('\n').slice(0, 6).join(' | '));
  assert.ok(text.includes('manifest: atri v2.0'), '要带出 manifest 名字/版本');
});

check('列角色包：limit 生效；目录不存在 → 空结果 + 原因（不抛异常）', () => {
  const limited = lib.listCharacterPacks(ROOT, { limit: 2 });
  assert.equal(limited.packs.length, 2);
  assert.equal(limited.totalPacks, 5);
  const missingDir = path.join(TMP, 'no-such-lib');
  const r = lib.listCharacterPacks(missingDir, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'directory-not-found');
  assert.deepEqual(r.packs, []);
  assert.deepEqual(r.loose, []);
  assert.equal(r.total, 0);
  const text = lib.characterListText(500, undefined, path.join(TMP, 'no-such-lib'));
  assert.ok(text.includes('Character library unavailable'));
  assert.ok(text.includes('Reason:'));
  assert.ok(text.includes('0 pack(s)/file(s) returned'));
  assert.ok(text.includes('social.charactersDir'));
});

check('列单个角色包的文件（qq_character_read 的 file 索引）；散装文件名 → 明确说 not-a-pack', () => {
  const r = lib.listPackFiles(ROOT, 'atri');
  assert.equal(r.ok, true);
  assert.equal(r.character, 'atri');
  const rels = r.files.map((f) => f.rel);
  assert.ok(rels.includes('SKILL.md') && rels.includes('sources/wiki.md') && rels.includes('manifest.json'));
  assert.equal(r.mainFile, 'SKILL.md');
  assert.ok(r.files.every((f) => f.size > 0));
  const text = lib.characterListText(500, 'atri', ROOT);
  assert.ok(text.includes('Character pack: atri/ (11 file(s)'));
  assert.ok(text.includes('atri/sources/wiki.md'));
  const loose = lib.listPackFiles(ROOT, 'ATRI_MAIN_PROMPT.md');
  assert.equal(loose.ok, false);
  assert.equal(loose.reason, 'not-a-pack');
  assert.ok(lib.characterListText(500, 'ATRI_MAIN_PROMPT.md', ROOT).includes('is a loose card file at the library root'));
});

// ── 2. qq_character_read：默认档 / 指定档 / 散装文件 ──
check('读：不传 file → 默认 SKILL.md；没有 SKILL.md 的包按 manifest → ULTIMATE → personality 回落', () => {
  const a = lib.readCharacterFile(ROOT, 'atri', undefined, {});
  assert.equal(a.ok, true);
  assert.equal(a.kind, 'pack-file');
  assert.equal(a.file, 'SKILL.md');
  assert.equal(a.defaultFile, true);
  assert.equal(a.packFileCount, 11);

  const n = lib.readCharacterFile(ROOT, 'nopack', undefined, {});
  assert.equal(n.ok, true);
  assert.equal(n.file, 'manifest.json', '没有 SKILL.md 时回落 manifest.json');

  mk('noult');
  w('noult/manifest.json', manifest('noult'));
  const n2 = lib.readCharacterFile(ROOT, 'noult', undefined, {});
  assert.equal(n2.ok, true);
  assert.equal(n2.file, 'manifest.json');
  const t = lib.readCharacterFile(ROOT, 'tiny', undefined, {});
  assert.equal(t.ok, true);
  assert.equal(t.file, 'profile.md', '兜底挑排序第一份');
});

check('读：指定 file（含包内一层 sources/wiki.md）能读到内容；包内没有 → not-in-pack 并列出可用文件', () => {
  const body = fs.readFileSync(path.join(ROOT, 'atri', 'sources', 'wiki.md'), 'utf8');
  const r = lib.readCharacterFile(ROOT, 'atri', 'sources/wiki.md', {});
  assert.equal(r.ok, true);
  assert.equal(r.file, 'sources/wiki.md');
  assert.equal(r.parts[0].text, body, '未截断时应逐字一致');
  assert.equal(r.parts[0].rel, 'atri/sources/wiki.md');
  assert.equal(r.defaultFile, false);

  const miss = lib.readCharacterFile(ROOT, 'atri', 'nope.md', {});
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'not-in-pack');
  assert.ok(miss.files.includes('SKILL.md'));
  const text = lib.characterReadText('atri', 'nope.md', undefined, ROOT);
  assert.ok(text.includes('is not in character pack "atri"'));
  assert.ok(text.includes('Files in this pack:'), '拒绝时要列出包里有哪些文件');
});

check('读：库根散装文件（character 直接给文件名）；同时给了 file 会被忽略并说明', () => {
  const r = lib.readCharacterFile(ROOT, 'ATRI_MAIN_PROMPT.md', undefined, {});
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'loose-file');
  assert.equal(r.fileIgnored, false);
  const ignored = lib.readCharacterFile(ROOT, 'ATRI_MAIN_PROMPT.md', 'SKILL.md', {});
  assert.equal(ignored.ok, true);
  assert.equal(ignored.kind, 'loose-file');
  assert.equal(ignored.fileIgnored, true);
  assert.ok(lib.characterReadText('ATRI_MAIN_PROMPT.md', 'SKILL.md', undefined, ROOT).includes('was ignored'));
});

check('读：>32KB 的档被截断到 32KB 并如实标注（工具文本里说清）', () => {
  const r = lib.readCharacterFile(ROOT, 'huge.md', undefined, {});
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.limitBytes, 32768);
  assert.ok(r.totalBytes <= 32768, `bytes=${r.totalBytes}`);
  assert.ok(r.totalSize > 32768, `size=${r.totalSize}`);
  assert.ok(!r.parts[0].text.endsWith('\uFFFD'), '截断不能在多字节字符中间留下乱码');
  const text = lib.characterReadText('huge.md', undefined, undefined, ROOT);
  assert.ok(text.includes('TRUNCATED at 32768 B (32 KB)'), '必须如实说被截断到 32KB');
  assert.ok(text.includes('maxBytes up to 131072'));
  const bigger = lib.readCharacterFile(ROOT, 'huge.md', undefined, { maxBytes: 131072 });
  assert.ok(bigger.totalBytes > 32768, '显式放宽 maxBytes 后应读到更多');
  assert.equal(lib.readCharacterFile(ROOT, 'huge.md', undefined, { maxBytes: 999999 }).limitBytes, 131072, 'maxBytes 有硬上限');
});

check('读：包内允许 2 层（a/b/ok.md），第 3 层（a/b/c/too-deep.md）被拒', () => {
  const ok = lib.readCharacterFile(ROOT, 'depthpack', 'a/b/ok.md', {});
  assert.equal(ok.ok, true);
  assert.equal(ok.file, 'a/b/ok.md');
  const deep = lib.readCharacterFile(ROOT, 'depthpack', 'a/b/c/too-deep.md', {});
  assert.equal(deep.ok, false);
  assert.equal(deep.reason, 'rejected');
  assert.ok(/too deep/.test(deep.error), deep.error);
  assert.ok(!lib.listPackFiles(ROOT, 'depthpack').files.some((f) => f.rel.endsWith('too-deep.md')), '扫描也不该带出超层文件');
});

// ── 3. qq_character_pack：核心几份拼起来 ──
check('pack：核心顺序 SKILL → personality → profile → interaction → relations → memory → conflicts → ULTIMATE*(新版在前) → sources', () => {
  const r = lib.readCharacterPack(ROOT, 'atri', { maxBytes: 131072 });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'pack');
  assert.equal(r.fileCount, 11);
  assert.equal(r.bodyFileCount, 10, 'manifest.json 不进正文');
  assert.deepEqual(r.parts.map((p) => p.rel), [
    'atri/SKILL.md', 'atri/personality.md', 'atri/profile.md', 'atri/interaction.md', 'atri/relations.md',
    'atri/memory.md', 'atri/conflicts.md', 'atri/ULTIMATE_ROLEPLAY_PROMPT_v3.0.md',
    'atri/ULTIMATE_ROLEPLAY_PROMPT.md', 'atri/sources/wiki.md'
  ]);
  assert.equal(r.truncated, false);
  assert.ok(r.manifest.ok);
  const text = lib.characterPackText('atri', 131072, ROOT);
  assert.ok(text.includes('Character pack: atri/ (11 file(s)'));
  assert.ok(text.includes('Manifest: atri v2.0'));
  assert.ok(text.includes('===== FILE: atri/personality.md'));
  assert.ok(!text.includes('===== FILE: atri/manifest.json'), 'manifest 只当元信息，不进正文');
});

check('pack：默认 24KB 封顶 + 说明截断在哪一份/哪些没装下；maxBytes 有硬上限', () => {
  const r = lib.readCharacterPack(ROOT, 'big', { maxBytes: 4096 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.limitBytes, 4096);
  assert.equal(r.cutIn, 'big/SKILL.md');
  assert.deepEqual(r.notIncluded, ['personality.md']);
  assert.ok(r.parts[0].truncated);
  const text = lib.characterPackText('big', 4096, ROOT);
  assert.ok(text.includes('TRUNCATED at 4096 B'), '要如实说截断');
  assert.ok(text.includes('cut off inside big/SKILL.md'), '要说明截断在哪一份');
  assert.ok(text.includes('Files not included (1): personality.md'));
  assert.equal(lib.readCharacterPack(ROOT, 'tiny', { maxBytes: 999999 }).limitBytes, 131072, '24KB 默认、128KB 硬上限');
  assert.equal(lib.readCharacterPack(ROOT, 'tiny', {}).limitBytes, 24576, '默认封顶 24KB');
});

check('pack：给的是散装文件名 → not-a-pack，并提示改用 qq_character_read', () => {
  const r = lib.readCharacterPack(ROOT, 'ATRI_MAIN_PROMPT.md', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-a-pack');
  assert.ok(lib.characterPackText('ATRI_MAIN_PROMPT.md', undefined, ROOT).includes('not a character pack'));
  const miss = lib.readCharacterPack(ROOT, 'no-such-pack', {});
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'not-found');
});

// ── 4. 防穿越（纯逻辑 + 工具路径两条都测） ──
check('防穿越：..、绝对路径、盘符、UNC、非法扩展名、超深 全部被拒', () => {
  const bad = [
    ['../secret.txt', /traversal/],
    ['..\\secret.txt', /traversal/],
    ['atri/../../outside/secret.txt', /traversal/],
    ['.', /traversal/],
    ['C:\\Windows\\win.ini', /absolute/],
    ['c:/windows/win.ini', /absolute/],
    ['\\\\server\\share\\x.md', /absolute/],
    ['/etc/passwd', /absolute/],
    ['atri/payload.exe', /only \.md \/ \.txt \/ \.json/],
    ['depthpack/a/b/c/too-deep.md', /too deep/]
  ];
  for (const [name, re] of bad) {
    const r = lib.resolveCharacterPath(ROOT, name);
    assert.equal(r.ok, false, `应被拒: ${name}`);
    assert.ok(re.test(r.error), `原因不对: ${name} → ${r.error}`);
  }
  const good = lib.resolveCharacterPath(ROOT, 'atri/sources/wiki.md');
  assert.equal(good.ok, true);
  assert.equal(good.abs, path.join(fs.realpathSync(ROOT), 'atri', 'sources', 'wiki.md'));
  assert.equal(lib.resolveCharacterPath(ROOT, 'atri/manifest.json').ok, true, '.json（manifest）允许读');
  assert.equal(lib.resolveCharacterPath(ROOT, 'atri\\profile.md').rel, 'atri/profile.md');
});

check('防穿越：character 只允许单段（给路径就拒），file 里的 .. / 绝对路径也拒，且不回正文', () => {
  const asPath = lib.readCharacterFile(ROOT, 'atri/SKILL.md', undefined, {});
  assert.equal(asPath.ok, false);
  assert.equal(asPath.reason, 'rejected');
  assert.ok(/use the file parameter/.test(asPath.error), asPath.error);
  const dotdot = lib.readCharacterFile(ROOT, 'atri', '../../outside/secret.txt', {});
  assert.equal(dotdot.ok, false);
  assert.equal(dotdot.reason, 'rejected');
  const abs = lib.readCharacterFile(ROOT, 'atri', 'C:\\Windows\\win.ini', {});
  assert.equal(abs.ok, false);
  assert.equal(abs.reason, 'rejected');
  const esc = lib.readCharacterFile(ROOT, '..\\outside\\secret.txt', undefined, {});
  assert.equal(esc.ok, false);
  assert.equal(esc.reason, 'rejected');
  const text = lib.characterReadText('atri', '../../outside/secret.txt', undefined, ROOT);
  assert.ok(text.includes('Cannot read character file'));
  assert.ok(!text.includes('OUTSIDE-SECRET-CONTENT'), '拒绝路径不许泄露库外文件内容');
  const packText = lib.characterPackText('..\\outside', undefined, ROOT);
  assert.ok(!packText.includes('OUTSIDE-SECRET-CONTENT'));
});

let junctionError = null;
try {
  fs.symlinkSync(OUTSIDE, path.join(ROOT, 'esc'), 'junction');
  fs.symlinkSync(OUTSIDE, path.join(ROOT, 'atri', 'link'), 'junction');
} catch (error) {
  junctionError = error?.code ?? error?.message;
}
if (junctionError) {
  skip('防穿越：符号链接/junction 逃逸', `本机无法创建 junction（${junctionError}）→ 该项未验证`);
} else {
  check('防穿越：junction 逃逸被拒（列表跳过、读取拒绝、不泄露库外内容）', () => {
    const r = lib.listCharacterPacks(ROOT, { limit: 500 });
    assert.equal(r.ok, true);
    assert.ok(!inPacks(r, 'esc'), 'junction 逃逸的目录不该被当成角色包');
    const read = lib.readCharacterFile(ROOT, 'esc', undefined, {});
    assert.equal(read.ok, false);
    assert.equal(read.reason, 'rejected');
    assert.ok(/outside the character library/.test(read.error), read.error);
    assert.ok(!lib.characterReadText('esc', undefined, undefined, ROOT).includes('OUTSIDE-SECRET-CONTENT'));
    assert.ok(!lib.characterPackText('esc', undefined, ROOT).includes('OUTSIDE-SECRET-CONTENT'));
    const atriFiles = lib.listPackFiles(ROOT, 'atri').files.map((f) => f.rel);
    assert.ok(!atriFiles.some((f) => f.startsWith('link/')), '包内的 junction 也要跳过');
  });
}

// ── 5. 搜索 ──
check('搜索：命中文件带 包 -> 文件 标注 + 短片段，且不返回全文', () => {
  const r = lib.searchCharacterCards(ROOT, '猫娘', { limit: 50 });
  assert.equal(r.ok, true);
  const rels = r.hits.map((h) => h.rel);
  assert.ok(rels.includes('atri/sources/wiki.md'), `hits=${rels.join(',')}`);
  assert.ok(rels.includes('notes.txt'));
  assert.ok(rels.includes('huge.md'));
  assert.ok(!rels.includes('atri/profile.md'), '没命中的不该出现');
  for (const h of r.hits) {
    assert.equal('text' in h, false, '搜索结果不许带全文');
    for (const s of h.snippets) assert.ok(s.startsWith('L') && s.length < 400);
  }
  const text = lib.characterSearchText('猫娘', 50, ROOT);
  assert.ok(text.includes('matching file(s) in'));
  assert.ok(text.includes('atri -> sources/wiki.md'), '要标出是哪个包的哪份文件');
  assert.ok(text.includes('Snippets only'));
});

check('搜索：空格分词 = AND；无命中 / 空关键词 / 目录不存在都有清楚回答', () => {
  const and = lib.searchCharacterCards(ROOT, '猫娘 入门笔记', { limit: 50 });
  assert.equal(and.hits.length, 1);
  assert.equal(and.hits[0].rel, 'notes.txt');
  assert.equal(lib.searchCharacterCards(ROOT, '不存在的关键词xyz', { limit: 50 }).total, 0);
  const empty = lib.searchCharacterCards(ROOT, '   ', { limit: 50 });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty-query');
  const missingDir = lib.searchCharacterCards(path.join(TMP, 'no-such-lib'), '猫娘', {});
  assert.equal(missingDir.ok, false);
  assert.equal(missingDir.reason, 'directory-not-found');
  assert.deepEqual(missingDir.hits, []);
  assert.ok(lib.characterSearchText('猫娘', 10, path.join(TMP, 'no-such-lib')).includes('Character library unavailable'));
  assert.ok(lib.characterSearchText('', 10, ROOT).includes('Search keyword is empty'));
});

// ── 6. 配置字段 ──
check('配置：social.charactersDir 优先，空/缺失回落默认值', () => {
  assert.equal(lib.resolveCharactersDir({}), lib.DEFAULT_CHARACTERS_DIR);
  assert.equal(lib.resolveCharactersDir({ social: {} }), lib.DEFAULT_CHARACTERS_DIR);
  assert.equal(lib.resolveCharactersDir({ social: { charactersDir: '   ' } }), lib.DEFAULT_CHARACTERS_DIR);
  assert.equal(lib.resolveCharactersDir({ social: { charactersDir: 'D:\\tmp\\chars' } }), path.resolve('D:\\tmp\\chars'));
  assert.equal(lib.DEFAULT_CHARACTERS_DIR, path.join(os.homedir(), 'Downloads', 'characters', 'characters'));
});

// ── 7. 真实角色库（存在就跑；只打印包名/计数，绝不打印正文） ──
const REAL = lib.DEFAULT_CHARACTERS_DIR;
if (fs.existsSync(REAL)) {
  check('真实角色库：包清单（前 10 个包名 + 总数，只打印名字/计数）', () => {
    const r = lib.listCharacterPacks(REAL, { limit: 500 });
    assert.equal(r.ok, true);
    assert.ok(r.totalPacks > 0);
    assert.ok(r.packs.every((p) => !/\.[a-z]+$/i.test(p.name)), '包名不该是文件名');
    console.log(`      dir = ${REAL}`);
    console.log(`      角色包 ${r.totalPacks} 个 / 文件 ${r.totalFiles} 个 / 库根散装文件 ${r.loose.length} 个`);
    console.log(`      前 10 个包名: ${r.packs.slice(0, 10).map((p) => `${p.name}(${p.fileCount}文件)`).join(', ')}`);
    for (const p of r.packs.slice(0, 10)) {
      console.log(`      · ${p.name}/ | ${p.fileCount} file(s) | ${p.totalBytes} B | default=${p.mainFile} | manifest=${p.manifest.ok ? `${p.manifest.name}${p.manifest.version ? ` ${p.manifest.version}` : ''}` : '(none)'}`);
    }
    console.log(`      库根散装: ${r.loose.map((f) => f.name).join(', ') || '(none)'}`);
  });

  check('真实角色库：读一个包的一份文件（默认 SKILL.md）+ 整包 pack（只断言计数/截断，不打印正文）', () => {
    const packs = lib.listCharacterPacks(REAL, { limit: 500 }).packs;
    const withSkill = packs.filter((p) => /^skill\.md$/i.test(p.mainFile));
    assert.ok(withSkill.length > 0, '真实库里应该有包以 SKILL.md 为默认档');
    const name = withSkill[0].name;
    const one = lib.readCharacterFile(REAL, name, undefined, {});
    assert.equal(one.ok, true);
    assert.equal(one.file, 'SKILL.md');
    assert.ok(one.parts[0].text.length > 0);
    assert.equal(one.parts[0].size, fs.statSync(path.join(REAL, name, 'SKILL.md')).size);
    const wiki = lib.readCharacterFile(REAL, name, 'sources/wiki.md', {});
    console.log(`      ${name}/SKILL.md 读到 ${one.parts[0].size} B（未截断）；sources/wiki.md ${wiki.ok ? `也读到 ${wiki.parts[0].size} B` : `该包没有（${wiki.reason}）`}`);
    const pack = lib.readCharacterPack(REAL, name, {});
    assert.equal(pack.ok, true);
    assert.ok(pack.parts.length >= 1);
    assert.ok(pack.totalBytes > 0);
    console.log(`      pack(${name}) → ${pack.includedCount}/${pack.bodyFileCount} 份、${pack.totalBytes} B${pack.truncated ? `、TRUNCATED（cutIn=${pack.cutIn}，未装下 ${pack.notIncluded.length} 份）` : ''}`);
    const big = lib.readCharacterPack(REAL, name, { maxBytes: 131072 });
    console.log(`      pack(${name}, maxBytes=128KB) → ${big.includedCount}/${big.bodyFileCount} 份、${big.totalBytes} B${big.truncated ? `、仍被截断（cutIn=${big.cutIn}）` : ''}`);
  });

  check('真实角色库：搜索只回计数与文件名（不打印片段）', () => {
    const r = lib.searchCharacterCards(REAL, '角色', { limit: 5 });
    assert.equal(r.ok, true);
    assert.ok(r.scanned > 0);
    console.log(`      搜 "角色"：扫描 ${r.scanned} 个文件、命中 ${r.total} 个（只打印文件名）`);
    for (const h of r.hits) console.log(`      · ${h.rel} (${h.matchCount} 行命中)`);
  });
} else {
  skip('真实角色库用例', `${REAL} 不存在`);
}

// ── 收尾 ──
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${failures.length ? 'FAILED' : 'ALL PASS'}  (${pass} passed, ${failures.length} failed)`);
if (failures.length) {
  for (const f of failures) console.log(`- ${f.name}: ${f.message}`);
  process.exit(1);
}
