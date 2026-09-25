// 「私聊 4 分半不回复」回归（2026-09-22 线上现场，见 inbox-marks.js 顶部）：
//   批次交进 next-step 之后，如果保持循环还继续持有（回 again:true），DSH 的 turn-stopping 钩子
//   就一直不返回 → 走不到"next-step 非空 → 跑下一步" → 那批消息没人回答（实测卡 4 分半，
//   直到 idleCloseMs 30 分钟放行）。判据必须是"交了但还没被模型消费"→ 立刻放行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.join(process.cwd(), 'src');
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

console.log('== ① 记账语义（inbox-marks） ==');
const marks = await import(pathToFileURL(path.join(SRC, 'core', 'inbox-marks.js')).href);
const SID = 'session-test-1';
ok('初始不认为有待消费批次', marks.inboxDeliveryPending(SID) === false);
marks.noteStepEnd(SID);
marks.noteInboxDelivery(SID);          // 先有步结束，再有交付（真实顺序：step/end 时发车）
ok('交付晚于最近一次步结束 → 待消费', marks.inboxDeliveryPending(SID) === true);
marks.noteStepEnd(SID);                // 模型跑完下一步
ok('模型跑过新的步之后 → 不再待消费（保持循环照常工作）', marks.inboxDeliveryPending(SID) === false);
marks.noteInboxDelivery(SID);
marks.clearInboxMarks(SID);            // turn/end
ok('回合结束清账 → 不待消费', marks.inboxDeliveryPending(SID) === false);
ok('未知会话/空 sid 都是 false（不抛）', marks.inboxDeliveryPending('') === false && marks.inboxDeliveryPending('nope') === false);
marks.noteInboxDelivery(SID);
const snap = marks.inboxMarksSnapshot();
ok('快照能看出交付时间戳与 pending', !!snap[SID] && snap[SID].pending === true, JSON.stringify(snap[SID] || {}));
marks.clearInboxMarks(SID);

console.log('== ② 三处调用点都在（保持循环 / 步边界 / 即时 steer / 回合结束） ==');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const hold = read('core/turn-hold.js');
const wake = read('core/wake-send.js');
const mux = read('core/mux.js');
ok('保持循环咨询 inboxDeliveryPending(sid)', /inboxDeliveryPending\(sid\)/.test(hold));
ok('只在"没有待交批次"时放行（手头还有消息时必须照常 steer）',
  /if \(!collectMidTurnBatch\(st\)\.length && inboxDeliveryPending\(sid\)\)/.test(hold));
ok('放行分支不带 again:true（让插件返回、DSH 去跑下一步）',
  /\{ close: false, reason: 'steered', exchanges \}/.test(hold));
const idxPending = hold.indexOf('if (!collectMidTurnBatch(st).length && inboxDeliveryPending(sid))');
const idxBudget = hold.indexOf("reason: 'keep-holding'");
ok('待消费判据排在"预算到期继续持有"之前（否则永远走不到它）', idxPending > 0 && idxBudget > 0 && idxPending < idxBudget,
  `pending@${idxPending} budget@${idxBudget}`);
ok('步边界发车先记 step/end（放在任何提前 return 之前）',
  hold.indexOf('noteStepEnd(sidText)') < hold.indexOf('if (!isHoldManaged(k, t)) return false;'));
ok('步边界发车成功后记一笔交付', /noteInboxDelivery\(sidText\)/.test(hold));
ok('即时 steer 成功路径也记一笔交付', /noteInboxDelivery\(sessionId\)/.test(wake));
ok('turn/end 清账', /clearInboxMarks\(frame\.sessionId\)/.test(mux));
ok('wake-send 真的 import 了 inbox-marks', /import \{ noteInboxDelivery \} from '\.\/inbox-marks\.js'/.test(wake));
ok('mux 真的 import 了 inbox-marks', /import \{ clearInboxMarks \} from '\.\/inbox-marks\.js'/.test(mux));

console.log('== ③ 不许再出现"交了却不放行"的旧写法 ==');
// 旧写法：预算到期无条件 keep-holding（即在没有待消费判据保护的情况下继续持有）
const budgetBlock = hold.slice(hold.indexOf('if (now() >= budgetEnd)'), hold.indexOf('if (now() >= budgetEnd)') + 320);
ok('预算到期分支前面有 pending 判据兜着', idxPending < hold.indexOf('if (now() >= budgetEnd)'));
ok('keep-holding 仍保留 again:true（正常"等更多消息"的场景不变）', /reason: 'keep-holding', again: true/.test(budgetBlock));

console.log('== ④ 答过一轮就早点收回合（主人报：出了 OK 之后界面挂着「思考中 15 分」）==');
/* 现场（服务端 bridge.log 2026-09-22 14:57~15:02）：模型发完气泡、mark_read 也做了，回合却一直在
 * 保持循环里每 55s 回一次 keep-holding，idleCloseMs 默认 1800s → DSH 的钩子不返回，界面一直显示
 * "深度求索中"。修法：本回合已经说过话（turnHasBubble）且静默超过 answeredIdleCloseMs（默认 90s）
 * → 收回合。下面这几条把"判据存在、参数正确、排序正确"都钉住。 */
ok('保持循环里有 answeredIdleCloseMs 判据', /answeredIdleCloseMs/.test(hold));
/* 2026-09-23 更新：原来这里断言的是 `|| 90000` 这个写法本身。但那个写法有两个坑叠在一起：
 *   · 显式的 0 是 falsy，会被 `||` 当成"没配"而还原成 90000；
 *   · 守卫又写成 `answeredIdleMs > 0`，于是 0 只让这条判据永不触发 → 退回 idleCloseMs。
 * 需求："私聊答完就立刻收回合"，所以改成 isFinite 判定 + 显式 0 语义。
 * 缺省仍回落 90000（行为不变），但断言不该再钉死具体写法，改为钉住这三件事。 */
ok('配置缺省/非法时仍回落 90000（行为不变）', /:\s*90000;/.test(hold));
ok('不再用 `|| 90000` 兜底（0 会被 falsy 吞掉）', !/\|\|\s*90000\)/.test(hold));
ok('显式 0 = 答完即刻收，支持"回了就停"', /answeredIdleMs === 0/.test(hold));
ok('用 turnHasBubble(key, sid, st) 三参判"本回合说过话"', /turnHasBubble\(key, sid, st\)/.test(hold));
ok('放行理由叫 answered-idle（日志里一眼能认）', /finish\('answered-idle'\)/.test(hold));
ok('这条判据排在 30 分钟 idleCloseMs 之前（否则永远走不到它）',
  hold.indexOf("finish('answered-idle')") > 0 &&
  hold.indexOf("finish('answered-idle')") < hold.indexOf('if (now() - lastActivity >= idleCloseMs)'));
ok('turn-hold 从 session-state 引入 turnHasBubble',
  /import \{[^}]*turnHasBubble[^}]*\} from '\.\/session-state\.js'/.test(hold));

console.log(`\nALL PASS  pass=${pass} fail=${process.exitCode ? 1 : 0}`);
