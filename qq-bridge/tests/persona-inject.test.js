// 回归测试：人设/发言规则"已合成进系统提示词 → 唤醒正文不再重复注入"的判定与合成侧记录。
//
// 【为什么有这个测试】2026-09-20 主人看着首连正文说："既然都合并到系统提示词了，那这些有的可以省略吧"。
// 那时 [PERSONA]+[SPEECH RULES]（10KB 量级）在**每条首连正文**里重复一遍，而系统提示词里已经有同一份。
// 判定必须两条都成立才省略：① preset 里合成的那份就是当前版本；② 这个会话没有"待补注入"标记
// （人设刚改过 / 桥停机期间改过 → 老会话的系统提示词是旧版，必须补一次）。
//
// 用法：cd qq-bridge && node tests/persona-inject.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const mod = (rel) => pathToFileURL(path.join(SRC, rel)).href;

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const { shouldInjectPersonaBlock } = await import(mod('core/wake-send.js'));
const compose = await import(mod('lib/preset-compose.js'));

console.log('=== 判定：什么时候还要在唤醒正文里带人设 ===');
check('preset 里是当前版本 + 会话没标记 → 省略（这就是本次修复的目标）', () => {
  assert.equal(shouldInjectPersonaBlock({ composedStamp: 'a|b', currentStamp: 'a|b', needsReinject: false }), false);
});
check('preset 里是当前版本，但会话被标记要补（人设刚改过）→ 注入一次', () => {
  assert.equal(shouldInjectPersonaBlock({ composedStamp: 'a|b', currentStamp: 'a|b', needsReinject: true }), true);
});
check('preset 里那份过时了（刚改完人设还没合成）→ 注入', () => {
  assert.equal(shouldInjectPersonaBlock({ composedStamp: 'old|old', currentStamp: 'new|new', needsReinject: false }), true);
});
check('没有任何合成记录（老版本升上来 / 合成失败）→ 保守注入', () => {
  assert.equal(shouldInjectPersonaBlock({ composedStamp: '', currentStamp: 'a|b' }), true);
  assert.equal(shouldInjectPersonaBlock({}), true);
});
check('两处都空（人设文件都不存在）→ 仍然注入（交给 buildRuntimeOverrideBlock 决定内容）', () => {
  assert.equal(shouldInjectPersonaBlock({ composedStamp: '', currentStamp: '' }), true);
});

console.log('\n=== 合成侧：overrideStampOf 的格式与稳定性 ===');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-persona-'));
try {
  const bridgeRoot = path.join(sandbox, 'qq-bridge');
  fs.mkdirSync(bridgeRoot, { recursive: true });
  check('空目录 → 两段都空（形如 "|"）', () => {
    assert.equal(compose.overrideStampOf(bridgeRoot), '|');
  });
  fs.writeFileSync(path.join(bridgeRoot, 'persona.md'), '# 人设\n你是小鲸鱼。\n');
  fs.writeFileSync(path.join(bridgeRoot, 'speech-rules.md'), '# 规则\n短句。\n');
  check('格式与 wake-send 的 runtimeOverrideStamp 一致：mtimeMs:size|mtimeMs:size', () => {
    const s = compose.overrideStampOf(bridgeRoot);
    assert.match(s, /^\d+(\.\d+)?:\d+\|\d+(\.\d+)?:\d+$/, s);
    assert.equal(s, compose.overrideStampOf(bridgeRoot), '同一状态两次算出同一个版本号');
  });
  check('文件一变版本号就变（人设改完能重新注入的根据）', async () => {
    const before = compose.overrideStampOf(bridgeRoot);
    fs.appendFileSync(path.join(bridgeRoot, 'persona.md'), '\n补充一行。\n');
    const after = compose.overrideStampOf(bridgeRoot);
    assert.notEqual(before, after);
  });

  console.log('\n=== 合成侧：syncPresetOverrides 会记下"preset 里是哪一版" ===');
  const home = path.join(sandbox, 'home');
  const presetDir = path.join(home, '.agent-presets', 'default');
  fs.mkdirSync(presetDir, { recursive: true });
  const presetFile = path.join(presetDir, 'agent.cordis.yml');
  fs.writeFileSync(presetFile, [
    'plugins:',
    '  - id: persona',
    '    config:',
    '      text: |-',
    '        built-in register only.',
    '  - id: other',
    '    config:',
    '      x: 1',
    '',
  ].join('\n'), 'utf8');

  const r = compose.syncPresetOverrides({ home, root: bridgeRoot });
  check('合成成功且写进了标记段', () => {
    assert.equal(r.ok, true, r.error ?? '');
    const text = fs.readFileSync(presetFile, 'utf8');
    assert.ok(text.includes(compose.COMPOSE_BEGIN) && text.includes(compose.COMPOSE_END));
    assert.ok(text.includes('你是小鲸鱼'), '人设正文进了 preset');
    assert.ok(text.includes('短句'), '发言规则进了 preset');
    assert.ok(text.includes('- id: other'), '标记之外的原有内容原样保留');
  });
  check('getComposedPersonaStamp() === overrideStampOf(root)（正文判定靠它）', () => {
    assert.equal(compose.getComposedPersonaStamp(), compose.overrideStampOf(bridgeRoot));
  });
  check('再合成一次幂等，版本号不变', () => {
    const stamp1 = compose.getComposedPersonaStamp();
    compose.syncPresetOverrides({ home, root: bridgeRoot });
    assert.equal(compose.getComposedPersonaStamp(), stamp1);
  });
  check('改了人设文件后再合成 → 版本号跟着变（→ 会话会被判成"系统提示词那份过时了"）', () => {
    const before = compose.getComposedPersonaStamp();
    fs.appendFileSync(path.join(bridgeRoot, 'speech-rules.md'), '\n再加一条。\n');
    compose.syncPresetOverrides({ home, root: bridgeRoot });
    assert.notEqual(compose.getComposedPersonaStamp(), before);
  });
} finally {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'ALL PASS'}  (${pass} passed, ${failures.length} failed)`);
process.exit(failures.length ? 1 : 0);
