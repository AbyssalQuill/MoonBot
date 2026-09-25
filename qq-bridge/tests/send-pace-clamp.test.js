// 回归测试：打字节拍的安全钳制（config.js: clampSendPace）
//
// 现场（2026-09-22 报障："感觉现在唤醒后要响应一段时间，不知道是不是因为 mcp 压缩工具"）：
//   线上服务器的 config.json 里 social.send = { linearPerCharMs: 650, linearCapMs: 15000 }，
//   于是"一次回复里第 2 条气泡起 = 本条字数 × 650ms"：17 个字 = 11.0 秒。DSH 会话日志里每条
//   qq_send_message 的结果都写着这个数（delays 5237 / 8050 / 9388 / 10989 / 11753 ms），
//   118 次发送共执行 990 秒。同一段窗口里 napcat_get_tool_schema 一次都没被调用（MCP 压缩代理
//   0 次额外往返），每步首个 token 0.7~1.7s（模型思考也正常）—— 慢的就是这个节拍。
//   这些键模型自己在私聊里就能改（console-server.js 的可调项名单），只改文件挡不住下一次自调，
//   所以把钳制放进 loadConfig：perChar ∈ [60, 320]、cap ∈ [800, 6000]。
//
// 用法：node tests/send-pace-clamp.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-paceclamp-'));
fs.cpSync(path.join(here, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-paceclamp-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });

const cfgPath = path.join(sandbox, 'config.json');
const writeCfg = (send) => fs.writeFileSync(cfgPath, JSON.stringify({ ownerQQ: '123456789', social: { send } }, null, 2));

const url = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;

// 抓日志（lib/log.js 走 console.log）——钳制必须留痕，否则下次又只能靠读会话日志反推
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
const cfgMod = await import(url('core/config.js'));

let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fails += 1;
  origLog(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

console.log('=== ① 线上那份"卡住级"的节拍必须被夹回来 ===');
writeCfg({ linearEnabled: true, linearPerCharMs: 650, linearMinMs: 450, linearCapMs: 15000, linearJitterRatio: 0.25, linearResetMs: 20000 });
logs.length = 0;
const c1 = cfgMod.loadConfig();
check('① linearPerCharMs 650 → 320（17 个字等 11s → 5.4s 封顶于 cap）', c1.social.send.linearPerCharMs === 320, String(c1.social.send.linearPerCharMs));
check('① linearCapMs 15000 → 6000', c1.social.send.linearCapMs === 6000, String(c1.social.send.linearCapMs));
check('① linearMinMs 450 在范围内、不动', c1.social.send.linearMinMs === 450, String(c1.social.send.linearMinMs));
check('① 上限被夹到不大于 cap（否则永远顶在上限）', Number(c1.social.send.linearMinMs) <= Number(c1.social.send.linearCapMs));
check('① 钳制留了日志（附图/节拍这类"看不见的行为"必须看得见）', logs.some((l) => /打字节拍钳制：linearPerCharMs 650 → 320/.test(l)), logs.slice(0, 2).join(' | '));

console.log('=== ② 真实节奏公式：钳制后一次回复的气泡间隔 ===');
const perChar = c1.social.send.linearPerCharMs;
const cap = c1.social.send.linearCapMs;
const delay17 = Math.min(cap, Math.round(17 * perChar));
check('② 17 个字的气泡：650ms/字=11.0s → 钳制后 ≤5.4s 且 ≤6000', delay17 <= 6000 && delay17 <= 17 * 320, `delay(${delay17}ms)`);
check('② 10 个字的气泡 ≤3.2s（"1.2~4s like typing"这条推荐口径仍然成立）', Math.min(cap, 10 * perChar) <= 4000, `${Math.min(cap, 10 * perChar)}ms`);

console.log('=== ③ 正常值 / 关掉节拍 / 非法值：一个都不许被动到 ===');
writeCfg({ linearEnabled: true, linearPerCharMs: 150, linearMinMs: 250, linearCapMs: 4000, linearJitterRatio: 0.25, linearResetMs: 60000 });
const c3 = cfgMod.loadConfig();
check('③ 仓库默认 150/250/4000 原样通过', c3.social.send.linearPerCharMs === 150 && c3.social.send.linearCapMs === 4000 && c3.social.send.linearMinMs === 250, JSON.stringify({ p: c3.social.send.linearPerCharMs, c: c3.social.send.linearCapMs }));
writeCfg({ linearEnabled: false, linearPerCharMs: 650, linearMinMs: 450, linearCapMs: 15000 });
const c4 = cfgMod.loadConfig();
check('③ linearEnabled:false（完全不延迟）仍然是关的 —— 钳制不越权改开关', c4.social.send.linearEnabled === false);
check('③ 关掉节拍时数值照样夹回来（下次打开不会突然变成卡住）', c4.social.send.linearPerCharMs === 320 && c4.social.send.linearCapMs === 6000);
writeCfg({ linearPerCharMs: 0, linearCapMs: 0 });
const c5 = cfgMod.loadConfig();
check('③ 显式 0（不想有任何延迟）被抬到安全下限 60/800 —— 语义仍是"极快"，不是"很慢"', c5.social.send.linearPerCharMs === 60 && c5.social.send.linearCapMs === 800, JSON.stringify({ p: c5.social.send.linearPerCharMs, c: c5.social.send.linearCapMs }));
writeCfg({ linearPerCharMs: 'abc', linearCapMs: null });
const c6 = cfgMod.loadConfig();
check('③ 非数字值不参与钳制、也不写坏配置', c6.social.send.linearPerCharMs === 'abc' && c6.social.send.linearCapMs === null);
check('③ 纯函数也可直接调（管理端/工具侧复用同一套边界）', typeof cfgMod.clampSendPace === 'function' && cfgMod.clampSendPace({ linearPerCharMs: 9999 }).linearPerCharMs === 320);

console.log = origLog;
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
