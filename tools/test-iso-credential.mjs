// 隔离 DSH 凭据文件改写逻辑自检（server/iso-credential.js）。
//
// 为什么值得单测：这段代码直接改 DSH 启动时读的那份文件，写错一个字 DSH 就起不来。
// 用**逐字节比对**来断言"只动了该动的那一行"，而不是"看起来差不多"。
// DSH 的格式规矩（来自 @deepseek-ai/dsh-credentials-local/lib/index.js，与线上同一份）：
//   version 必须存在；顶层只允许 version/refs/records；refs 的键是 POSIX 名、值非空。
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  credentialRefsBlock, mergeCredentialText, credentialStatusFromText, validateCredentialDocument,
} from '../server/iso-credential.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); failed += 1; }
}

// 真实文件的形状（值都是假的；结构照抄线上那份：缩进 2 格挂在 refs 下）
const BASELINE = [
  'version: 1',
  'records:',
  '  - kind: api-key',
  '    payload:',
  '      version: 1',
  '      secret: AAAAFAKEsecretAAAAAAAAAAAAAAAAAAAAAAAAA',
  'refs:',
  '  XIAOMI_TOKEN_PLAN_CN_API_KEY: FAKE-xiaomi-0000000000000000000000000000000000000000',
  '',
  '  DEEPSEEK_API_KEY: sk-FAKEDEEPSEEK000000000000000000000',
  '  MIMO_API_KEY: FAKE-mimo-0000000000000000000000000000000000000000000',
  '',
].join('\n');

console.log('== ① refs 块定位 ==');
check('找到 refs 块与缩进', () => {
  const b = credentialRefsBlock(BASELINE.split('\n'));
  assert.equal(b.rIdx, 6);
  assert.equal(b.indent, '  ');
  assert.equal(BASELINE.split('\n')[b.last], '  MIMO_API_KEY: FAKE-mimo-0000000000000000000000000000000000000000000');
});
check('没有 refs 段 → null', () => assert.equal(credentialRefsBlock(['version: 1', 'records:']), null));

console.log('\n== ② 改已有条目：只动那一行、缩进原样保留 ==');
{
  const r = mergeCredentialText(BASELINE, 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'NEWKEY-1234567890');
  check('ok 且 existed', () => { assert.equal(r.ok, true); assert.equal(r.existed, true); });
  const before = BASELINE.split('\n');
  const after = r.text.split('\n');
  check('行数不变', () => assert.equal(after.length, before.length));
  check('该行被替换成了 2 空格缩进的新值', () => assert.equal(after[7], '  XIAOMI_TOKEN_PLAN_CN_API_KEY: NEWKEY-1234567890'));
  check('其它每一行逐字节不变', () => {
    for (let i = 0; i < before.length; i += 1) if (i !== 7) assert.equal(after[i], before[i], `第 ${i} 行被改动了`);
  });
  check('结果仍合 DSH 格式', () => assert.equal(validateCredentialDocument(r.text).ok, true));
}

console.log('\n== ③ 新增条目：插进 refs 块、用兄弟缩进 ==');
{
  const r = mergeCredentialText(BASELINE, 'NEW_PROVIDER_API_KEY', 'brand-new-value');
  check('existed=false', () => assert.equal(r.existed, false));
  const after = r.text.split('\n');
  check('插在 refs 块最后一条之后', () => assert.equal(after[11], '  NEW_PROVIDER_API_KEY: brand-new-value'));
  check('顶格键仍然是那几个（没有多出未知顶层键）', () => {
    const top = after.filter((l) => l.trim() && l.match(/^\s*/)[0].length === 0).map((l) => l.split(':')[0]);
    assert.deepEqual(top, ['version', 'records', 'refs']);
  });
  check('结果合 DSH 格式', () => assert.equal(validateCredentialDocument(r.text).ok, true));
  check('状态读得到新键', () => {
    const st = credentialStatusFromText(r.text, 'NEW_PROVIDER_API_KEY');
    assert.deepEqual(st, { set: true, len: 'brand-new-value'.length });
  });
}

console.log('\n== ④ 空 refs 块：按 YAML 惯例缩进 2 格插进去 ==');
{
  const empty = 'version: 1\nrecords:\nrefs:\n';
  const r = mergeCredentialText(empty, 'FOO_API_KEY', 'v');
  check('结果 = version/records/refs + 2 空格条目', () => assert.equal(r.text, 'version: 1\nrecords:\nrefs:\n  FOO_API_KEY: v\n'));
  check('合 DSH 格式', () => assert.equal(validateCredentialDocument(r.text).ok, true));
}

console.log('\n== ⑤ 删除：只删那一行，其它一字不动 ==');
{
  const r = mergeCredentialText(BASELINE, 'DEEPSEEK_API_KEY', null);
  check('existed=true', () => assert.equal(r.existed, true));
  const before = BASELINE.split('\n');
  const after = r.text.split('\n');
  check('少了一行', () => assert.equal(after.length, before.length - 1));
  check('删的是那一条', () => assert.equal(after.some((l) => /DEEPSEEK_API_KEY/.test(l)), false));
  check('其它行原样', () => {
    const rest = before.filter((l) => !/DEEPSEEK_API_KEY/.test(l));
    assert.deepEqual(after, rest);
  });
  check('删不存在的键 → 原样返回且 existed=false', () => {
    const r2 = mergeCredentialText(BASELINE, 'NOT_THERE_API_KEY', null);
    assert.equal(r2.existed, false);
    assert.equal(r2.text, BASELINE);
  });
}

console.log('\n== ⑥ 顶格残留（历史坏数据）：搬回 refs 块里 ==');
{
  const broken = BASELINE.replace('  XIAOMI_TOKEN_PLAN_CN_API_KEY: FAKE-xiaomi-0000000000000000000000000000000000000000\n', '')
    + 'XIAOMI_TOKEN_PLAN_CN_API_KEY: FAKE-xiaomi-old\n';
  check('坏数据确实是不合规的（顶层未知键）', () => assert.equal(validateCredentialDocument(broken).ok, false));
  const r = mergeCredentialText(broken, 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'FIXED-VALUE');
  check('搬回 refs 且缩进 2 格', () => assert.equal(r.text.includes('\n  XIAOMI_TOKEN_PLAN_CN_API_KEY: FIXED-VALUE\n'), true));
  check('顶格那份被删掉（没有第二处）', () => assert.equal(r.text.split('\n').filter((l) => /XIAOMI_TOKEN_PLAN_CN_API_KEY/.test(l)).length, 1));
  check('修完合 DSH 格式', () => assert.equal(validateCredentialDocument(r.text).ok, true));
}

console.log('\n== ⑦ 格式不对就拒绝改写（宁可不生效，也不能把 DSH 弄成起不来） ==');
{
  const flat = 'XIAOMI_TOKEN_PLAN_CN_API_KEY: old-flat-value\n';
  const r = mergeCredentialText(flat, 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'new');
  check('扁平格式 → ok:false 且原文不动', () => { assert.equal(r.ok, false); assert.equal(r.text, flat); assert.match(r.error, /DSH/); });
  const r2 = mergeCredentialText('version: 1\nrecords:\n', 'FOO_API_KEY', 'v');
  check('缺 refs → ok:false', () => assert.equal(r2.ok, false));
}

console.log('\n== ⑧ 真磁盘端到端：临时 home 里写一份，逐字节验证只动一行 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'iso-cred-test-'));
  const file = join(dir, '.credentials.yaml');
  try {
    writeFileSync(file, BASELINE, 'utf8');
    const before = readFileSync(file, 'utf8');
    const r = mergeCredentialText(before, 'MIMO_API_KEY', 'rotated-mimo-key');
    writeFileSync(file, r.text, 'utf8');
    const after = readFileSync(file, 'utf8');
    check('磁盘上 refs 里的 MIMO 行是新的、缩进 2 格', () => assert.equal(after.includes('\n  MIMO_API_KEY: rotated-mimo-key\n'), true));
    check('磁盘上除该行外逐字节一致', () => {
      const a = after.split('\n'); const b = before.split('\n');
      const skip = b.findIndex((l) => /MIMO_API_KEY/.test(l));
      for (let i = 0; i < b.length; i += 1) if (i !== skip) assert.equal(a[i], b[i], `第 ${i} 行变了`);
    });
    check('磁盘文件仍是 DSH 认的结构', () => assert.equal(validateCredentialDocument(after).ok, true));
    check('文件确实存在且非空', () => { assert.equal(existsSync(file), true); assert.ok(after.length > 50); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('\n== ⑨ 状态读取只回布尔与长度（绝不回值） ==');
{
  const st = credentialStatusFromText(BASELINE, 'DEEPSEEK_API_KEY');
  const expected = 'sk-FAKEDEEPSEEK000000000000000000000'.length;
  check(`set=true，len 是 ${expected}`, () => assert.deepEqual(st, { set: true, len: expected }));
  check('对象里没有值字段', () => assert.deepEqual(Object.keys(st).sort(), ['len', 'set']));
  check('不存在的键 → set=false, len=0', () => assert.deepEqual(credentialStatusFromText(BASELINE, 'NOPE_API_KEY'), { set: false, len: 0 }));
  check('空值 → set=false', () => assert.deepEqual(credentialStatusFromText('refs:\n  FOO_API_KEY:\n', 'FOO_API_KEY'), { set: false, len: 0 }));
  check('带引号的值按去引号后的长度算', () => assert.deepEqual(credentialStatusFromText('refs:\n  FOO_API_KEY: "abc"\n', 'FOO_API_KEY'), { set: true, len: 3 }));
}

console.log('\n== ⑩ 用 DSH 装的那个真 yaml 库解析改写结果（最强的"没写坏"证据） ==');
{
  // DSH 自己依赖的 yaml 包（与线上同一份）；找不到就明说跳过，不假装通过
  const yamlPaths = [
    'yaml',
    'C:/Users/17367/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/yaml/dist/index.js',
    'D:/MoonBot/resources/runtime/node_modules/yaml/dist/index.js',
  ];
  let YAML = null;
  let used = '';
  for (const p of yamlPaths) {
    try { YAML = await import(p.startsWith('C:') || p.startsWith('D:') ? `file:///${p}` : p); used = p; break; }
    catch { /* 试下一个 */ }
  }
  if (!YAML?.parse) {
    console.log('  SKIP  找不到 yaml 包，跳过真解析校验（其余断言仍然有效）');
  } else {
    console.log(`  （用 ${used} 解析）`);
    const cases = [
      ['普通 key', 'FAKE-xiaomi-0000000000000000000000000000000000000000'],
      ['带冒号空格', 'abc: def'],
      ['以井号开头', '#hashtag-key'],
      ['含引号与反斜杠', 'a"b\\c'],
      ['以 & 开头（YAML 锚点字符）', '&anchor'],
      ['纯数字', '1234567890'],
      ['小数', '1.5'],
      ['科学计数法字形', '1e5'],
      ['布尔字样 true', 'true'],
      ['null 字样', 'null'],
      ['日期字形', '2026-09-19'],
      ['含 # 在中间', 'key#part'],
      ['负号数字', '-5'],
      ['十六进制字形', '0x1f'],
      ['inf 字样', '.inf'],
      ['时分字形', '1:30'],
      ['下划线开头的普通 key', 'sk_live_abcdef123456'],
    ];
    for (const [label, value] of cases) {
      const r = mergeCredentialText(BASELINE, 'TEST_API_KEY', value);
      const doc = YAML.parse(r.text);
      check(`${label}：refs.TEST_API_KEY 解析回原值`, () => assert.equal(doc.refs.TEST_API_KEY, value));
      check(`${label}：顶层键仍是 version/refs/records`, () => assert.deepEqual(Object.keys(doc).sort(), ['records', 'refs', 'version']));
      check(`${label}：状态长度 = 原值长度`, () => assert.equal(credentialStatusFromText(r.text, 'TEST_API_KEY').len, value.length));
    }
    // 已有的真 key 也必须解析回原值（说明改动没有把别人的密钥挪位/改义）
    const r = mergeCredentialText(BASELINE, 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'rotated');
    const doc = YAML.parse(r.text);
    check('兄弟条目 DEEPSEEK/MIMO 解析回原值', () => {
      assert.equal(doc.refs.DEEPSEEK_API_KEY, 'sk-FAKEDEEPSEEK000000000000000000000');
      assert.equal(doc.refs.MIMO_API_KEY, 'FAKE-mimo-0000000000000000000000000000000000000000000');
    });
    check('records 段没被动（secret 原样）', () => assert.equal(doc.records[0].payload.secret, 'AAAAFAKEsecretAAAAAAAAAAAAAAAAAAAAAAAAA'));
    check('每条基线都能被真解析器接受', () => { assert.doesNotThrow(() => YAML.parse(BASELINE)); });
  }
}

console.log('\n== ⑪ 包内一致性：index.js 用的是同一份实现 ==');
{
  const src = readFileSync(join(HERE, '..', 'server', 'index.js'), 'utf8');
  check('index.js 从 iso-credential.js 导入', () => assert.match(src, /from '\.\/iso-credential\.js'/));
  check('index.js 里没有第二份 mergeCredentialText 实现', () => assert.equal(/function mergeCredentialText/.test(src), false));
  check('index.js 里没有第二份 credentialStatusFromText 实现', () => assert.equal(/function credentialStatusFromText/.test(src), false));
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（通过 ${passed}，失败 ${failed}）`);
process.exit(failed === 0 ? 0 : 1);
