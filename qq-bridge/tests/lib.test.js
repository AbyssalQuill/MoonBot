// 纯函数库冒烟测试（重构期间每步都跑：node tests/lib.test.js）
import assert from 'node:assert/strict';
import path from 'node:path';
import { BJ_WEEK, beijingTs, pad2, bjMinToText, bjMinutes, beijingDateKey, parseClockMin } from '../src/lib/time.js';
import { randInt, chance } from '../src/lib/rand.js';
import { clamp, lerp } from '../src/lib/math.js';
import { isCjkChar, splitCjk } from '../src/lib/cjk.js';
import { isCjkChar as hanOnly, splitByCjkSpaces, isCjkLikeChar, convertExampleSpacesToComma } from '../src/lib/cjk-split.js';
import { clampGap, computeGaps, MIN_GAP_MS } from '../src/lib/send-gaps.js';
import { normalizeLoopSignature, isDuplicateSendText } from '../src/lib/loop-guard.js';
import { faceIdFromArtifactContent, resolveArtifactFaceId } from '../src/lib/qq-face-parse.js';
import { compressImageBuffer, finalizeImageBuffer } from '../src/lib/image-compress.js';
import { isSafeLocalMediaPath, isProbablySafeImageFileRef } from '../src/lib/media-guard.js';
import { EXPLICIT_END_RE, hasExplicitEnd, isSleepingConfig, normalizeSpeakerIds } from '../src/lib/sleep-guard.js';
import { isEmojiLikeCp, stripImeEmoji } from '../src/lib/emoji.js';
import { singleLineForQQ, splitLongSegment } from '../src/lib/segment.js';
import { mimeFromBuffer, mimeFromUrl, base64FromMaybe } from '../src/lib/media-meta.js';
import { KNOWN_AGENT_TOKENS, redactSensitiveText, redactSensitive, sanitizeToolArgs, escapeCqText, unquoteJsonString } from '../src/lib/text-safe.js';
import { normalizeOwnerQQ, normalizeIdList, allowed } from '../src/lib/config.js';
import { readRoleState, writeRoleState, sanitizeRoleName, listRoles } from '../src/lib/role-access.js';
import { sleep, withTimeout } from '../src/lib/async.js';
import { convKey, canonicalKey } from '../src/lib/keys.js';
import { SILENT_MARKER, isSilentMarker, SEND_TOOL_RE, isSendToolName } from '../src/lib/markers.js';

// time（P3 迁移后语义 = bridge.js main 内活体，1:1）
assert.equal(pad2(3), '03');
assert.equal(bjMinToText(0), '00:00');
assert.equal(bjMinToText(60 * 13 + 5), '13:05');
assert.equal(bjMinToText(-5), '-1:-5');            // 迁移源行为：负数不归一化且 padStart 对负号串不补零
assert.equal(bjMinToText(1445), '00:05');          // 跨日
assert.equal(beijingTs(0), '1970-01-01 周四 08:00:00');
assert.equal(bjMinutes(0), 480);                   // epoch +8h = 08:00 → 480 分
assert.equal(BJ_WEEK.length, 7);
assert.equal(beijingDateKey(new Date(0)), '1970-01-01');
assert.equal(parseClockMin('18:00'), 1080);
assert.equal(parseClockMin('18点'), 1080);
assert.equal(parseClockMin('19点半'), 1170);
assert.equal(parseClockMin('25:00'), 1500);        // 允许跨日值到 47:59
assert.equal(parseClockMin('99:00'), null);
assert.equal(parseClockMin('abc'), null);

// rand（含 P3 迁移的 min>max 守卫）
for (let i = 0; i < 200; i++) {
  const v = randInt(1, 3);
  assert.ok(v >= 1 && v <= 3, `randInt out of range: ${v}`);
}
for (let i = 0; i < 200; i++) {
  const v = randInt(5, 1); // 倒序参数应被守卫交换
  assert.ok(v >= 1 && v <= 5, `randInt guard failed: ${v}`);
}
assert.equal(randInt(7, 7), 7);
let hit = false;
for (let i = 0; i < 500 && !hit; i++) if (chance(1)) hit = true;
assert.ok(hit, 'chance(1) should eventually hit');

// math
assert.equal(clamp(5, 1, 3), 3);
assert.equal(clamp(-1, 1, 3), 1);
assert.equal(lerp(0, 10, 0.5), 5);

// cjk
assert.ok(isCjkChar('鲸'));
assert.ok(isCjkChar('，'));
assert.ok(!isCjkChar('a'));
const parts = splitCjk('你好 world！');
assert.ok(parts.includes('你') && parts.includes('好'));
assert.ok(parts.some((p) => p.trim() === 'world'));

// cjk-split（一代按空格分条语义：只认汉字）
assert.equal(hanOnly('鲸'), true);
assert.equal(hanOnly('，'), false);
assert.deepEqual(splitByCjkSpaces('你好 世界 hello world'), ['你好', '世界', 'hello world']);
assert.deepEqual(splitByCjkSpaces('single'), ['single']);
// 二代角色卡语义：汉字 + CJK 标点（U+3000-303F；全角逗号 U+FF0C 不在其列）
assert.equal(isCjkLikeChar('鲸'), true);
assert.equal(isCjkLikeChar('、'), true);
assert.equal(isCjkLikeChar('，'), false);
assert.equal(convertExampleSpacesToComma('你好 世界 hello world'), '你好，世界，hello world');
assert.equal(convertExampleSpacesToComma('hello world'), 'hello world');
assert.equal(convertExampleSpacesToComma('你好 / ok'), '你好 / ok'); // 斜杠旁空格不替换

// send-gaps（发送节奏纯函数）
// 2026-09-11 重整后：下限不再来自配置，而是硬性的 MIN_GAP_MS=100
// （原先由 burstIntervalMinMs 提供的 1800ms 下限已删除，改成 0 也能真的接近即时）。
assert.equal(MIN_GAP_MS, 100);
assert.equal(clampGap(50, {}), 100);             // 低于硬下限 → 夹到 MIN_GAP_MS
assert.equal(clampGap(20000, {}), 10000);        // 高于上限 → 夹到 10000
assert.equal(clampGap(1000, {}), 1000);
assert.equal(clampGap(0, {}), 100);              // 显式 0：真的按 0 算，只受硬下限约束
assert.equal(clampGap(0, { maxGapMs: 0 }), 100); // 配置 0 不再被当成“没配”
assert.deepEqual(computeGaps(['a'], 'auto', 0, null, {}), []);                       // <2 条 → []
const fixed = computeGaps(['a', 'b', 'c'], 'fixed', 1000, null, {});
assert.equal(fixed.length, 2);
assert.ok(fixed.every((d) => d === 1000));
const byLen = computeGaps(['hello', 'x'], 'byLength', 0, null, { gapJitterRatio: 0 }); // 0 是 falsy → 仍走默认抖动 0.3（迁移源行为）
assert.equal(byLen.length, 1);
assert.ok(byLen[0] >= 4200 * 0.7 && byLen[0] <= 4200 * 1.3, `byLength 抖动越界: ${byLen[0]}`);
// 显式把底与每字增量都配成 0 → 退到硬下限，实现“秒回”
const instant = computeGaps(['a', 'b'], 'byLength', 0, null, { gapBaseMs: 0, gapPerCharMs: 0, gapJitterRatio: 0 });
assert.deepEqual(instant, [100]);

// loop-guard（复读签名归一化 + 防循环重复判定）
assert.equal(normalizeLoopSignature('  你好 你好 ，，！！ \n'), '你好 你好 ，！');
assert.equal(normalizeLoopSignature('a'.repeat(200)).length, 120);
assert.equal(normalizeLoopSignature(''), '');
assert.equal(isDuplicateSendText('a', 'b'), false);          // 短文本不算
assert.equal(isDuplicateSendText('一二三四五', '一二三四五x'), true); // 包含
assert.equal(isDuplicateSendText('同一句话', '同一句话'), true);

// qq-face-parse（占位内容 → QQ 原生 face id）
assert.equal(faceIdFromArtifactContent('QQ表情:害羞(148)'), 148);
assert.equal(faceIdFromArtifactContent('表情:148'), 148);
assert.equal(faceIdFromArtifactContent('纯文字'), null);
assert.equal(resolveArtifactFaceId('QQ表情:148'), 148);  // 数字路径不触 qq-faces 名库
assert.equal(resolveArtifactFaceId(''), null);

// image-compress（sharp 缺失/小图降级路径必须原样返回）
const tiny = Buffer.from('tiny-image');
assert.equal(await compressImageBuffer(tiny), tiny);
const fin = await finalizeImageBuffer(tiny, 'image/png');
assert.equal(fin.buffer, tiny);
assert.equal(fin.mimeType, 'image/png');

// media-guard
assert.equal(isProbablySafeImageFileRef('abc.png'), true);
assert.equal(isProbablySafeImageFileRef('a/b.png'), false);
assert.equal(isProbablySafeImageFileRef('C:\\evil.png'), false);
assert.equal(isProbablySafeImageFileRef('file:///etc/passwd'), false);
assert.equal(isProbablySafeImageFileRef('../x.png'), false);
assert.equal(isProbablySafeImageFileRef(''), false);
assert.equal(isSafeLocalMediaPath(path.join(process.cwd(), 'src', 'bridge.js'), process.cwd()), true);
assert.equal(isSafeLocalMediaPath('Z:\\nonexistent\\definitely-missing.bin', process.cwd()), false);

// emoji（输入法 emoji 剥离，保留 [CQ:] 与 U+FE0E 颜文字）
assert.equal(stripImeEmoji('好的 😀 ok'), '好的 ok');
assert.equal(stripImeEmoji('✌︎'), '✌︎');
assert.equal(stripImeEmoji('[CQ:face,id=1] 😀'), '[CQ:face,id=1]');
assert.equal(isEmojiLikeCp(0x1F600), true);
assert.equal(isEmojiLikeCp(0x41), false);

// segment（单行化）
assert.equal(singleLineForQQ('a\n  b'), 'a b');
assert.equal(singleLineForQQ('  hi  '), 'hi');
assert.equal(singleLineForQQ(''), '');
const splitParts = splitLongSegment('a'.repeat(600), 500);
assert.equal(splitParts.length, 2);
assert.ok(splitParts.every((p) => p.length <= 500));
assert.deepEqual(splitLongSegment('short text', 500), ['short text']);
assert.deepEqual(splitLongSegment('', 500), []);

// media-meta（魔数/URL/base64 识别）
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
assert.equal(mimeFromBuffer(png), 'image/png');
assert.equal(mimeFromBuffer(Buffer.alloc(12)), 'image/jpeg');
assert.equal(mimeFromUrl('http://x/a.PNG'), 'image/png');
assert.equal(mimeFromUrl('not-a-url', 'image/jpeg'), 'image/jpeg');
assert.equal(base64FromMaybe('base64://aGk='), 'aGk=');
assert.equal(base64FromMaybe('data:image/png;base64,aGk='), 'aGk=');
assert.equal(base64FromMaybe('aGk='), 'aGk=');
assert.equal(base64FromMaybe('https://x'), null);
assert.equal(base64FromMaybe(null), null);

// text-safe（脱敏；KNOWN_AGENT_TOKENS 活绑定共享实例）
KNOWN_AGENT_TOKENS.add('sekret-token-xyz');
assert.equal(redactSensitiveText('sekret-token-xyz 你好'), '*** 你好');
KNOWN_AGENT_TOKENS.delete('sekret-token-xyz');
assert.equal(redactSensitiveText('sekret-token-xyz 你好'), 'sekret-token-xyz 你好');
const redacted = redactSensitive({ token: 'a', b: { password: 'p' }, arr: [1, 'keep'] });
assert.equal(redacted.token, '***');
assert.equal(redacted.b.password, '***');
assert.deepEqual(redacted.arr, [1, 'keep']);
assert.equal(sanitizeToolArgs('{"token":"a","msg":"hi"}'), '{"token":"***","msg":"hi"}');
assert.equal(sanitizeToolArgs(null), null);

// 出站文本清洗
assert.equal(escapeCqText('x\\ny [CQ:face]'), 'x\ny [CQ：face]');
assert.equal(escapeCqText('```a\\tb```'), '```a\\tb```'); // 代码块内 \t 不还原
assert.equal(escapeCqText('普通文本'), '普通文本');
assert.equal(unquoteJsonString('"你好"'), '你好');
assert.equal(unquoteJsonString('你好'), '你好');
assert.equal(unquoteJsonString(123), 123);

// config 规范化
assert.equal(normalizeOwnerQQ('123'), 123);
assert.equal(normalizeOwnerQQ(''), null);
assert.equal(normalizeOwnerQQ(undefined), null);
assert.throws(() => normalizeOwnerQQ('abc'));
assert.deepEqual(normalizeIdList(['1', 'x', '2']), ['1', '2']);
assert.deepEqual(normalizeIdList('nope'), []);

// config 访问控制（cfg 由调用方注入）
const baseCfg = { allow: { private: [], groups: ['123'] }, deny: { private: [], groups: [] }, allowAllWhenEmpty: true };
assert.equal(allowed('group', '123', baseCfg), true);
assert.equal(allowed('group', '999', baseCfg), false);        // 名单非空且不含
assert.equal(allowed('private', '5', baseCfg), true);         // 名单空 → allowAllWhenEmpty
assert.equal(allowed('group', '123', { ...baseCfg, deny: { groups: ['123'] } }), false); // 命中黑名单优先

// role-access 纯函数（文件读写不入单测）
assert.equal(sanitizeRoleName('傲娇@助手#1'), '傲娇助手1');
assert.equal(sanitizeRoleName(''), '');

// markers（行为标记/工具名谓词）
assert.equal(SILENT_MARKER, '[SILENT]');
assert.equal(isSilentMarker('[SILENT]'), true);
assert.equal(isSilentMarker('   [SILENT]  '), true);
assert.equal(isSilentMarker('随便说点什么'), false);
assert.equal(isSendToolName('mcp__napcat__qq_send_message'), true);
assert.equal(isSendToolName('mcp__napcat__qq_send_group_message'), true);
assert.equal(isSendToolName('qq_send_message'), true);           // v2 实名（压缩 MCP 无前缀）
assert.equal(isSendToolName('mcp__napcat__qq_send_message'), true); // 兼容任意 MCP 服务名前缀
assert.equal(isSendToolName('qq_get_recent_messages'), false);   // 只读工具不算发送
assert.equal(isSendToolName(null), false);

// keys（会话 key）
// 注：原先测的是已随 v2 模式一起删除的 canonicalV2Key，现改测仍然在用的 canonicalKey
// （同样的语义：只认 group/private + 正整数，去前导零，其余一律 null）。
assert.equal(convKey('group', 5), 'group:5');
assert.equal(canonicalKey('group:0123'), 'group:123');
assert.equal(canonicalKey('private:456'), 'private:456');
assert.equal(canonicalKey('private:0'), null);
assert.equal(canonicalKey('dm:1'), null);
assert.equal(canonicalKey('group:abc'), null);
assert.equal(canonicalKey(null), null);
assert.equal(canonicalKey(' group:77 '), 'group:77');

// async（sleep/withTimeout）
await sleep(5);
assert.equal(await withTimeout(Promise.resolve('ok'), 200, 't'), 'ok');
await assert.rejects(withTimeout(new Promise(() => {}), 30, '超时测试'), /操作超时\(30ms\)：超时测试/);

// sleep-guard（v2 模式已删除，函数去掉 V2 后缀：hasExplicitEnd / isSleepingConfig / normalizeSpeakerIds）
assert.equal(EXPLICIT_END_RE.test('去洗澡了'), true);
assert.equal(EXPLICIT_END_RE.test('明天见'), false);
assert.equal(hasExplicitEnd({ recentMessages: [{ isSelf: true, text: 'hi' }, { isSelf: false, tail: '晚安' }] }), true);
assert.equal(hasExplicitEnd({ recentMessages: [{ isSelf: true, text: 'hi' }] }), false);
assert.equal(hasExplicitEnd(null), false);
assert.equal(isSleepingConfig({ mode: 'diving' }), true);
assert.equal(isSleepingConfig({ mode: 'active' }), false);
assert.equal(isSleepingConfig({ triggers: { anyMessage: true } }), false);
assert.equal(isSleepingConfig(null), false);
assert.deepEqual(normalizeSpeakerIds(['123', 'abc', '123', '004', null]), ['123']);
assert.deepEqual(normalizeSpeakerIds('1, 2 3'), ['1', '2', '3']);
assert.deepEqual(normalizeSpeakerIds(undefined), []);
assert.equal(normalizeSpeakerIds(Array.from({ length: 25 }, (_, i) => String(i + 1))).length, 20); // 上限 20

console.log('lib 纯函数测试全部通过 ✓');
