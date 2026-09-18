/* 自测：**学过的黑话不能再变成候选**（2026-09-19 主人反馈的那条）。
 *
 * 背景：主人说「之前有的学习过了，还是有被选中并成为了候选」。查下来是两处叠加：
 *   ① `upsertSlangEntry` 用**完全字符串相等**匹配，模型换个写法（多空格、多标点、大小写、
 *      全角半角）就被当成新词 → 新建 candidate；
 *   ② 每轮抽取提示词**从不告诉模型库里已经有什么** → 它每轮都把老词再提一遍。
 *
 * 用法（在 qq-bridge 目录下）：node tools/test-slang-dedupe.mjs
 */
import {
  upsertSlangEntry, buildSlangRunCue, slangKey, SLANG_STATUS, createSlangEntry
} from '../src/slang-learner.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n     实际 ${JSON.stringify(got)}\n     期望 ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

console.log('=== 1. 归一化键只做"安全"的合并 ===');
eq('空格被忽略', slangKey('笑 死'), slangKey('笑死'));
eq('尾部标点被忽略', slangKey('笑死！'), slangKey('笑死'));
eq('英文大小写被忽略', slangKey('YYDS'), slangKey('yyds'));
eq('全角字母转半角', slangKey('ＹＹＤＳ'), slangKey('yyds'));
eq('真正不同的词**不**合并', slangKey('笑死') === slangKey('哭了'), false);

console.log('\n=== 2. 已确认的词条：再抽到只累加次数，状态不动 ===');
{
  const entries = [createSlangEntry({ content: '笑死', status: SLANG_STATUS.CONFIRMED, meaning: '很好笑' })];
  const r = upsertSlangEntry(entries, '笑死', { countIncrement: 1 });
  eq('没有新建词条', r.created, false);
  eq('状态仍是 confirmed', r.entry.status, SLANG_STATUS.CONFIRMED);
  eq('次数累加', r.entry.count, 2);
  eq('含义没被清掉', r.entry.meaning, '很好笑');
  eq('库长度不变', entries.length, 1);
}

console.log('\n=== 3. 换个写法（空格/标点/大小写）不再造出重复候选 ===');
{
  const entries = [createSlangEntry({ content: 'yyds', status: SLANG_STATUS.CONFIRMED })];
  const r = upsertSlangEntry(entries, ' YYDS！ ', { countIncrement: 1 });
  eq('没有新建词条', r.created, false);
  eq('状态仍是 confirmed', r.entry.status, SLANG_STATUS.CONFIRMED);
  eq('库长度仍是 1', entries.length, 1);
  eq('合并到了哪条（便于排查）', r.mergedInto, 'yyds');
}

console.log('\n=== 4. 已拒收的词条不能被抽回来变成候选 ===');
{
  const entries = [createSlangEntry({ content: '囧rz', status: SLANG_STATUS.REJECTED })];
  // 模拟"抽取路径传了 status:candidate"这种最坏情况
  const r = upsertSlangEntry(entries, '囧rz', { status: SLANG_STATUS.CANDIDATE, countIncrement: 1 });
  eq('状态仍是 rejected（不被降级）', r.entry.status, SLANG_STATUS.REJECTED);
  eq('库长度仍是 1', entries.length, 1);
}

console.log('\n=== 5. 真正的新词照常新建（别把功能改死）===');
{
  const entries = [createSlangEntry({ content: '笑死', status: SLANG_STATUS.CONFIRMED })];
  const r = upsertSlangEntry(entries, '云宫迅音', { countIncrement: 1 });
  eq('新建了词条', r.created, true);
  eq('新词条是 candidate', r.entry.status, SLANG_STATUS.CANDIDATE);
  eq('库长度变成 2', entries.length, 2);
}

console.log('\n=== 6. 每轮提示词里带上"库里已有什么" ===');
{
  const entries = [
    createSlangEntry({ content: '笑死', status: SLANG_STATUS.CONFIRMED }),
    createSlangEntry({ content: 'yyds', status: SLANG_STATUS.CANDIDATE })
  ];
  const cue = buildSlangRunCue({ sinceMs: 1, untilMs: 2, known: entries });
  eq('含 ALREADY IN LIBRARY 块', /ALREADY IN LIBRARY/.test(cue), true);
  eq('列了已确认的词', cue.includes('笑死'), true);
  eq('也列了候选的词（全部状态都算"已知"）', cue.includes('yyds'), true);
  eq('明确要求别再输出变体', /longer\/shorter variant/.test(cue), true);
  const noKnown = buildSlangRunCue({ sinceMs: 1, untilMs: 2 });
  eq('没传 known 时不出现这个块（保持原样）', /ALREADY IN LIBRARY/.test(noKnown), false);
}

console.log(`\n合计：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
