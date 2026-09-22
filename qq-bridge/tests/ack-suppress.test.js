// 「发完话别再补一句 OK」回归（2026-09-22 主人报："模型不是每次都是 OK，无伤大雅但是可以强化"）：
//   ① 判定器只认"整条就是一句发送回执"，正常短回复（嗯/好/在/收到）与带实义的句子一律不认；
//   ② 加粗/行内代码包裹（`**OK**`、`` `OK` ``）照样认，句末标点不影响；
//   ③ 发送端点真的接上了这道闸门，并且以"本回合已发过气泡"为前提（turnHasBubble），首条回复永不拦；
//   ④ 拦下时回给模型的 note 说明"不用补别的话"，避免它换一句再来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.join(process.cwd(), 'src');
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); } else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

const ack = await import(pathToFileURL(path.join(SRC, 'lib', 'ack-text.js')).href);
const isAck = ack.isAckOnlyText;

console.log('== ① 认得出来的"发送回执" ==');
for (const t of ['OK', 'ok', 'Ok.', 'OK！', 'okay', 'done', '好的', '好嘞', '好了', '已发送', '已发出', '发送成功', '发送完毕', '已经发送', '已回复', '已完成']) {
  ok(`"${t}" 是回执`, isAck(t) === true, String(isAck(t)));
}

console.log('== ② 正常回复绝不能被误伤 ==');
for (const t of ['嗯', '好', '在', '收到', '行', '好的，我这就去办', '好，那我先睡了，晚安', 'OK 那我们就这么定，明天见', '已完成的三件事我列一下：…', '我发好了', '发好了']) {
  ok(`"${t}" 不是回执`, isAck(t) === false, String(isAck(t)));
}
ok('空正文不是回执', isAck('') === false && isAck('   ') === false);
ok('超长正文不是回执', isAck('OK'.padEnd(13, '!')) === false);

console.log('== ③ Markdown 包裹与句末标点 ==');
ok('**OK** 认', isAck('**OK**') === true);
ok('`OK` 认', isAck('`OK`') === true);
ok('_好的。_ 认', isAck('_好的。_') === true);
ok('"' + '好的！' + '" 认（全角感叹号）', isAck('好的！') === true);

console.log('== ④ 发送端点接上了闸门 ==');
const cs = fs.readFileSync(path.join(SRC, 'core', 'console-server.js'), 'utf8');
ok('从 lib/ack-text.js 引入判定器', /import \{ isAckOnlyText \} from '\.\.\/lib\/ack-text\.js'/.test(cs));
ok('从 session-state 引入 turnHasBubble', /silentTurnQueue, turnHasBubble,/.test(cs));
ok('闸门判据 = 回执 + 本回合已发过气泡', /if \(isAckOnlyText\(message\) && turnHasBubble\(key, state\.sessions\?\.\[key\], st\)\)/.test(cs));
ok('拦下时以 ok:true 回执（不是报错）', /ackSuppressed: true/.test(cs));
ok('回执里告诉模型"不用补别的话"', /请直接结束本回合，不用补别的话/.test(cs));
ok('拦下会写日志与活动记录', /\[send\] 收尾回执已拦下（本回合已发过内容）/.test(cs) && /\[send\] 收尾回执未发出（本回合已发过内容）/.test(cs));

console.log(`\nALL PASS  pass=${pass} fail=${process.exitCode ? 1 : 0}`);
