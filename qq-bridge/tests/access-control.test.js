// 访问控制契约测试（2026-09-19 主人要求"确保落地"的那条）：
//   · 允许名单里有 → 放行
//   · 拉黑名单里有 → 拒绝（拉黑优先）
//   · **允许名单是空的 + allowAllWhenEmpty 没勾（false）→ 一律不放行**（默认拒绝，主人要的语义）
//   · 允许名单是空的 + 勾了（true）→ 全部放行
//   · 允许名单非空 + 目标不在名单里 → 不放行（哪怕 allowAllWhenEmpty=true 也不能开后门）
//
// 为什么单独立一个测试：这条规则是"机器人会不会在陌生人群里说话"的总闸，历史上它只靠
// 桥里几处 if 各自实现；现在这里把契约钉死，改动任何一处都要先过它。
import { allowed, normalizeIdList, normalizeOwnerQQ } from '../src/lib/config.js';

let pass = 0;
let fail = 0;
const ok = (label, cond) => { if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}`); } };
const cfg = (allow, deny, allowAllWhenEmpty) => ({ allow, deny, allowAllWhenEmpty });

console.log('=== 1. 空名单 + 没勾"全部放行" → 一律不放行（默认拒绝）===');
const empty = cfg({ private: [], groups: [] }, { private: [], groups: [] }, false);
ok('私聊：空名单不勾 → 拒绝', allowed('private', 1736784911, empty) === false);
ok('群聊：空名单不勾 → 拒绝', allowed('group', 868756515, empty) === false);
ok('数字与字符串 id 一视同仁', allowed('group', '868756515', empty) === false);

console.log('\n=== 2. 空名单 + 勾了"全部放行" → 都放行 ===');
const open = cfg({ private: [], groups: [] }, { private: [], groups: [] }, true);
ok('私聊：空名单勾了 → 放行', allowed('private', 1736784911, open) === true);
ok('群聊：空名单勾了 → 放行', allowed('group', 12345, open) === true);

console.log('\n=== 3. 名单非空 → 只放行名单里的（勾了也不开后门）===');
const listed = cfg({ private: [1736784911], groups: [868756515] }, { private: [], groups: [] }, true);
ok('名单里的群 → 放行', allowed('group', 868756515, listed) === true);
ok('名单外的群 → 拒绝（即使 allowAllWhenEmpty=true）', allowed('group', 999, listed) === false);
ok('名单里的私聊 → 放行', allowed('private', 1736784911, listed) === true);
ok('名单外的私聊 → 拒绝', allowed('private', 999, listed) === false);

console.log('\n=== 4. 拉黑优先 ===');
const denied = cfg({ private: [1], groups: [2] }, { private: [1], groups: [2] }, true);
ok('同时在允许与拉黑里 → 拒绝', allowed('group', 2, denied) === false);
ok('私聊同理', allowed('private', 1, denied) === false);

console.log('\n=== 4b. 分侧放行（2026-09-19 主人要求"私聊全部放行"）===');
const onlyPrivate = { allow: { private: [], groups: [] }, deny: { private: [], groups: [] }, allowAllWhenEmpty: false, allowAllPrivate: true, allowAllGroups: false };
ok('只勾"私聊全部放行" → 私聊放行', allowed('private', 1736784911, onlyPrivate) === true);
ok('只勾"私聊全部放行" → 群聊仍然拒绝', allowed('group', 868756515, onlyPrivate) === false);
const onlyGroup = { ...onlyPrivate, allowAllPrivate: false, allowAllGroups: true };
ok('只勾"群聊全部放行" → 群聊放行、私聊拒绝', allowed('group', 1, onlyGroup) === true && allowed('private', 1, onlyGroup) === false);
ok('分侧开关不影响黑名单（拉黑优先）', allowed('private', 999, { ...onlyPrivate, deny: { private: [999], groups: [] } }) === false);
ok('名单非空时，分侧开关不开后门', allowed('private', 5, { ...onlyPrivate, allow: { private: [1], groups: [] } }) === false);
ok('全局开关仍然两边都放', allowed('group', 1, { ...onlyPrivate, allowAllWhenEmpty: true }) === true);
ok('分侧与全局是"或"关系：全局关、私聊开 → 私聊放行', allowed('private', 7, { ...onlyPrivate, allowAllWhenEmpty: false }) === true);
ok('三个都不勾 → 私聊也拒绝', allowed('private', 7, { ...onlyPrivate, allowAllPrivate: false }) === false);

console.log('\n=== 5. 兼容单数键名（历史配置写过 group / private）===');
const singular = { allow: { private: [], group: [777] }, deny: { private: [], group: [] }, allowAllWhenEmpty: false };
ok('cfg.allow.group 也能命中', allowed('group', 777, singular) === true);

console.log('\n=== 6. 规范化函数 ===');
ok('normalizeIdList 只留正整数', JSON.stringify(normalizeIdList(['1', ' 22 ', 'x', '', 3])) === JSON.stringify(['1', '22', '3']));
ok('normalizeIdList 非数组 → 空表', normalizeIdList('123').length === 0);
ok('ownerQQ 空值 → null', normalizeOwnerQQ('') === null && normalizeOwnerQQ(null) === null);
ok('ownerQQ 非数字 → 抛错', (() => { try { normalizeOwnerQQ('abc'); return false; } catch { return true; } })());

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
