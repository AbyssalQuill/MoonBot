// 上下文治理（src/lib/dsh-compaction.js）自检：
//   ① 归一化必须永远守住 DSH 的两条硬约束（否则插件拒绝加载、DSH 起不来）：
//        · compaction-basic：retainRatio < thresholdRatio
//        · tool-result-pruner：headChars + 标记 + tailChars ≤ thresholdChars
//   ② 写出来的 YAML 片段是 DSH 认的形状（同 id overlay + config 字段名一字不差）；
//   ③ 合并进 cordis.patch.yml 时**只动标记之间那段**，用户自己的 overlay 一字不动；
//   ④ 幂等：同样的配置写第二遍返回 changed=false（不白写盘、不触发 DSH 无谓的 patch reload）；
//   ⑤ 与真实 DSH 的常量对齐：标记字符串、默认值都要跟装的这版 dsh 对得上。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeCompaction, buildCompactionRows, buildCompactionBlock,
  mergeCompactionIntoPatch, syncDshCompactionPatch,
  COMPACTION_BEGIN, COMPACTION_END, PRUNE_MARKER,
} from '../src/lib/dsh-compaction.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); failed += 1; }
}

const DSH = 'C:/Users/17367/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

console.log('== ① 归一化：永远守住 DSH 的硬约束 ==');
{
  const cases = [
    ['默认', {}],
    ['retain 大于 threshold（会被 DSH 拒载）', { thresholdRatio: 0.05, retainRatio: 0.9 }],
    ['retain 等于 threshold', { thresholdRatio: 0.05, retainRatio: 0.05 }],
    ['retain 负数', { retainRatio: -1 }],
    ['threshold 太大', { thresholdRatio: 5 }],
    ['threshold 太小', { thresholdRatio: 0.000001 }],
    ['工具预算过小', { toolResultMaxChars: 10 }],
    ['工具预算不是数字', { toolResultMaxChars: 'abc' }],
    ['全是垃圾', { thresholdRatio: 'x', retainRatio: null, toolResultMaxChars: {} }],
  ];
  for (const [label, raw] of cases) {
    const p = normalizeCompaction(raw);
    check(`${label}：0 < retainRatio(${p.retainRatio}) < thresholdRatio(${p.thresholdRatio})`, () => {
      assert.ok(p.retainRatio > 0, 'retainRatio 必须为正');
      assert.ok(p.retainRatio < p.thresholdRatio, 'retainRatio 必须小于 thresholdRatio');
    });
    check(`${label}：head + 标记 + tail ≤ ${p.toolResultMaxChars}`, () => {
      const emitted = p.headChars + PRUNE_MARKER.length + p.tailChars;
      assert.ok(emitted <= p.toolResultMaxChars, `emitted=${emitted} > threshold=${p.toolResultMaxChars}`);
    });
    check(`${label}：三个值都是有限数字/整数`, () => {
      assert.ok(Number.isFinite(p.thresholdRatio) && p.thresholdRatio > 0);
      assert.ok(Number.isInteger(p.toolResultMaxChars) && p.toolResultMaxChars >= 300);
      assert.ok(Number.isInteger(p.headChars) && p.headChars >= 0);
      assert.ok(Number.isInteger(p.tailChars) && p.tailChars >= 0);
    });
  }
  check('enabled 缺省为 true，显式 false 才关', () => {
    assert.equal(normalizeCompaction({}).enabled, true);
    assert.equal(normalizeCompaction({ enabled: false }).enabled, false);
  });
  /* 【2026-09-22 第四次重算：门禁改成"实测口径"】
   * 前三次（0.06 / 0.12 / 0.08）都在看"每次请求平均花费 vs 上下文大小"这个粗口径，把两类请求混在一桶：
   *   ① 常规步（前缀命中缓存，只按缓存价 ≈ 0.022 ¥/M 计费）；② 重建步（压缩/轮换/长时间空闲之后，
   *   整段上下文按未命中重读 ≈ ¥0.036 一次）。分开量之后结论反过来了：
   *     上下文 50~70k → ¥0.0033/次；70~90k → ¥0.0043；90~120k → ¥0.0040；120~160k → ¥0.0051
   *   —— 上下文本体几乎不花钱，钱花在"重建次数 × 上下文"上，所以**少压缩才省钱**。
   *   模型（步数×(0.0020+0.022/M×平均上下文) + 每天重建次数×重建单价）：0.08 → ¥3.34/天、
   *   0.12 → ¥2.67、**0.16 → ¥2.53**、0.18 → ¥2.53、0.25 → ¥2.66；稳健区间 0.14~0.20。
   * 门禁因此改成：**下限**仍高于固定开销（否则每步压缩），**上限** 0.35（再高就等于不治理，
   * 一旦上下文真的顶到 1M 会直接溢出），并要求缺省值落在实测最省区间内。复算：tools/compaction-threshold.mjs。 */
  const WINDOW = 1048576;
  const FIXED_OVERHEAD = 27500;    // system + 工具表，实测（旧值；压缩后实际更小，用它当保守下限）
  const OPT_BAND = [0.12, 0.20];   // 实测最省的稳健区间（差 ≤2%）
  check(`① 缺省阈值落在实测最省区间 [${OPT_BAND[0] * 100}%, ${OPT_BAND[1] * 100}%] 且高于固定开销 ${FIXED_OVERHEAD}`, () => {
    const p = normalizeCompaction({});
    const t = p.thresholdRatio * WINDOW;
    assert.ok(t >= FIXED_OVERHEAD * 1.5, `阈值太低：${Math.round(t)} token（会被固定开销顶穿 → 每步压缩）`);
    assert.ok(p.thresholdRatio >= OPT_BAND[0] && p.thresholdRatio <= OPT_BAND[1], `缺省 ${p.thresholdRatio} 不在实测最省区间 ${OPT_BAND} 内`);
  });
  check('② 低于下限的值一律被夹回；缺省不再是 0.08（实测证明它比 0.16 贵 20%+）', () => {
    assert.ok(normalizeCompaction({}).thresholdRatio > 0.08, '缺省仍是 0.08 → 没有吃上第四次重算的结论');
    for (const v of [0.06, 0.02, 0.005]) {
      const p = normalizeCompaction({ thresholdRatio: v, retainRatio: 0.01 });
      assert.ok(p.thresholdRatio * WINDOW >= 78000, `阈值 ${v} 没被夹够：${Math.round(p.thresholdRatio * WINDOW)} token`);
    }
  });
  check('③ 压缩后（保留段 + 固定开销）离阈值至少还有 2.5 万 token', () => {
    const p = normalizeCompaction({});
    const after = p.retainRatio * WINDOW + FIXED_OVERHEAD;
    const headroom = p.thresholdRatio * WINDOW - after;
    assert.ok(headroom >= 25000, `余量只有 ${Math.round(headroom)} token → 会"压完立刻又压"`);
  });
  check('④ 出厂 config.example.json 的默认值与代码缺省一致', () => {
    const example = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf8'));
    const p = normalizeCompaction({});
    assert.equal(example.dshCompaction.thresholdRatio, p.thresholdRatio);
    assert.equal(example.dshCompaction.retainRatio, p.retainRatio);
    assert.equal(example.dshCompaction.toolResultMaxChars, p.toolResultMaxChars);
  });
}

console.log('\n== ② 生成的 YAML 是 DSH 认的形状 ==');
{
  const rows = buildCompactionRows(normalizeCompaction({}));
  check('两行 overlay 的 id 与 dsh-base 里挂载的 id 完全一致', () => {
    assert.match(rows, /^- id: compaction-basic$/m);
    assert.match(rows, /^- id: tool-result-pruner$/m);
  });
  /* 【关键回归】web profile 下 dsh-web-app 的 patch 把这两行设成 disabled: true ——
   * 少了 disabled: false，配置写得再对也一行不跑（真机复现过：配置对、压力超阈值，日志里 0 条 prune）。 */
  check('两行都带 disabled: false（web profile 里必须显式重新打开）', () => {
    assert.match(rows, /^- id: compaction-basic\n  disabled: false$/m);
    assert.match(rows, /^- id: tool-result-pruner\n  disabled: false$/m);
  });
  check('与真实 dsh-web-app 的禁用行为对齐（它确实禁用了这两行）', () => {
    const webPatch = path.join(DSH, 'dsh-web-app', 'cordis.patch.yml');
    if (!fs.existsSync(webPatch)) { console.log('        （没找到 dsh-web-app，跳过）'); return; }
    const src = fs.readFileSync(webPatch, 'utf8');
    for (const id of ['compaction-basic', 'tool-result-pruner']) {
      const m = new RegExp(`- id: ${id}\\n  disabled: true`);
      assert.match(src, m, `${id} 在 dsh-web-app 的 patch 里没有被禁用？那这条注释该更新了`);
    }
  });
  check('compaction-basic 的字段名是 DSH 的字段名', () => {
    for (const k of ['auto', 'thresholdRatio', 'retainRatio', 'maxTokens', 'compactionRetries', 'maxOverflowRetries']) {
      assert.match(rows, new RegExp(`^    ${k}: `, 'm'), `缺字段 ${k}`);
    }
  });
  check('tool-result-pruner 的字段名是 DSH 的字段名', () => {
    for (const k of ['thresholdChars', 'headChars', 'tailChars']) assert.match(rows, new RegExp(`^    ${k}: \\d+$`, 'm'), `缺字段 ${k}`);
  });
  check('没有 DSH 会拒绝的未知键（只出现白名单字段）', () => {
    const keys = [...rows.matchAll(/^ {4}([a-zA-Z]+):/gm)].map((m) => m[1]);
    const allowed = new Set(['auto', 'thresholdRatio', 'retainRatio', 'maxTokens', 'compactionRetries', 'maxOverflowRetries', 'summarizationProvider', 'summarizationModel', 'thresholdChars', 'headChars', 'tailChars']);
    for (const k of keys) assert.ok(allowed.has(k), `未知字段 ${k}`);
  });
  /* 【2026-09-19 主人定稿：摘要一律用会话主模型】不再支持单独指定 summarizationProvider/Model
   * （单独换服务商 = 另一条额度 + 另一份缓存，实测省不下钱还多一处凭据）。
   * 老配置里若还留着这两个键，只提示、不写进 patch —— 这条断言就是钉住"别又把它写回去"。 */
  check('指定的摘要模型被忽略（统一用主模型），并且有提示', () => {
    const p = normalizeCompaction({ summarizationProvider: 'p', summarizationModel: 'm' });
    const rows2 = buildCompactionRows(p);
    assert.equal(/summarization/.test(rows2), false, 'summarization* 不该出现在 YAML 里');
    assert.ok(p.notes.some((n) => /summarizationProvider/.test(n)), '被忽略时要有 notes 说明');
    assert.equal(/summarization/.test(buildCompactionRows(normalizeCompaction({ summarizationModel: 'x' }))), false);
  });
  check('enabled=false 时块里没有配置行（不覆盖 DSH 默认）', () => {
    const { text } = buildCompactionBlock({ enabled: false });
    assert.equal(/- id: compaction-basic/.test(text), false);
    assert.ok(text.includes(COMPACTION_BEGIN) && text.includes(COMPACTION_END));
  });
}

console.log('\n== ③ 合并：只动标记之间，用户内容一字不动 ==');
{
  const userOverlay = [
    '# 我自己的 DSH overlay，别动我',
    "- id: my-plugin",
    '  config:',
    '    keep: yes',
    '',
  ].join('\n');
  const first = mergeCompactionIntoPatch(userOverlay, {});
  check('第一次合并：用户内容保留 + 追加了我们那段', () => {
    assert.ok(first.text.includes(userOverlay.trimEnd()), '用户内容被改动了');
    assert.ok(first.text.includes(COMPACTION_BEGIN));
    assert.equal(first.existed, true);
    assert.equal(first.changed, true);
  });
  const second = mergeCompactionIntoPatch(first.text, {});
  check('同样配置再合并：changed=false（幂等，不白写盘）', () => assert.equal(second.changed, false));
  const third = mergeCompactionIntoPatch(first.text, { thresholdRatio: 0.1 });
  check('改配置后：旧的阈值没了、新的在、用户内容仍在', () => {
    assert.equal(third.changed, true);
    assert.match(third.text, /thresholdRatio: 0\.1/);
    assert.equal(/thresholdRatio: 0\.06/.test(third.text), false);
    assert.ok(third.text.includes('keep: yes'));
  });
  check('标记只出现一次（不会越写越多）', () => {
    assert.equal(third.text.split(COMPACTION_BEGIN).length - 1, 1);
    assert.equal(third.text.split(COMPACTION_END).length - 1, 1);
  });
  const empty = mergeCompactionIntoPatch('', {});
  check('文件不存在/为空：新建带表头的文件', () => {
    assert.equal(empty.existed, false);
    assert.ok(empty.text.startsWith('# DSH home 级 patch'));
    assert.ok(empty.text.includes(COMPACTION_BEGIN));
  });
}

console.log('\n== ④ 落盘（临时目录真写） ==');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compaction-'));
  try {
    const r1 = syncDshCompactionPatch({ home: dir, cfg: { thresholdRatio: 0.05, retainRatio: 0.009, toolResultMaxChars: 2000 } });
    check('第一次写盘 ok 且 changed', () => { assert.equal(r1.ok, true); assert.equal(r1.changed, true); });
    const text1 = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
    check('文件里是 2000/1200/400 的剪枝预算', () => {
      assert.match(text1, /thresholdChars: 2000/);
      assert.match(text1, /headChars: 1200/);
      assert.match(text1, /tailChars: 400/);
    });
    const r2 = syncDshCompactionPatch({ home: dir, cfg: { thresholdRatio: 0.05, retainRatio: 0.009, toolResultMaxChars: 2000 } });
    check('第二次同配置：ok 且 changed=false', () => { assert.equal(r2.ok, true); assert.equal(r2.changed, false); });
    const r3 = syncDshCompactionPatch({ home: dir, cfg: { enabled: false } });
    check('关掉后：块还在但配置行没了', () => {
      assert.equal(r3.ok, true);
      const t = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
      assert.ok(t.includes(COMPACTION_BEGIN));
      assert.equal(/- id: compaction-basic/.test(t), false);
    });
    const r4 = syncDshCompactionPatch({ home: '', cfg: {} });
    check('没有 home：明确失败而不是静默', () => { assert.equal(r4.ok, false); assert.match(r4.error, /home/); });
    const r5 = syncDshCompactionPatch({ home: path.join(dir, 'nope', 'deeper'), cfg: {} });
    check('目录不存在也会自己建（mkdir recursive）', () => {
      assert.equal(r5.ok, true);
      assert.ok(fs.existsSync(path.join(dir, 'nope', 'deeper', 'cordis.patch.yml')));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('\n== ⑤ 与真实 DSH 对齐（装的这版 dsh 的常量） ==');
{
  const pruner = path.join(DSH, 'dsh-compaction-tool-result-pruner', 'lib', 'index.js');
  if (!fs.existsSync(pruner)) console.log(`  SKIP  没找到 ${pruner}（换机器时跳过）`);
  else {
    const src = fs.readFileSync(pruner, 'utf8');
    check('剪枝标记与 DSH 里的一字不差', () => {
      const m = /const PRUNE_MARKER = ("(?:[^"\\]|\\.)*")/.exec(src);
      assert.ok(m, '在 DSH 源码里没找到 PRUNE_MARKER');
      assert.equal(JSON.parse(m[1]), PRUNE_MARKER);
    });
    check('我们写的字段名都在 DSH 的合法键集合里', () => {
      const m = /CONFIG_KEYS = ([^;]+);/.exec(src);
      assert.ok(m, '没找到 CONFIG_KEYS');
      for (const k of ['thresholdChars', 'headChars', 'tailChars']) assert.ok(m[1].includes(k), `${k} 不在 DSH 的合法键里`);
    });
    check('DSH 会拒绝 head+标记+tail > thresholdChars（所以我们才要夹）', () => assert.match(src, /must be at most thresholdChars/));
  }
  const basic = path.join(DSH, 'dsh-compaction-basic', 'lib', 'index.js');
  if (fs.existsSync(basic)) {
    const src = fs.readFileSync(basic, 'utf8');
    check('DSH 会拒绝 retainRatio >= thresholdRatio（所以我们才要夹）', () => assert.match(src, /must be less than the resolved thresholdRatio/));
    check('剪枝在阈值判断之后、摘要之前（剪完低于阈值就跳过摘要）', () => {
      assert.match(src, /pruneSession\(agent\.session\)/);
      assert.match(src, /if \(measurement\.totalTokens < spec\.thresholdTokens\) return null;/);
    });
  }
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（通过 ${passed}，失败 ${failed}）`);
process.exit(failed === 0 ? 0 : 1);
