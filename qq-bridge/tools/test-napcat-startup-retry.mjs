// 回归：【NapCat 还没起来时桥不能自己死】
//
// 现场（2026-09-12 13:29/13:30 真机）：onebot-ws 的语义是"首次 open 之前 close → reject(NAPCAT_CONN)"，
// main() 里 await 一抛 → process.exit(1)。于是"一键启动整套"里只要 NapCat 慢几秒/正在扫码，
// 桥就在 2 秒内自杀，界面显示"已拉起"但机器人根本不收消息 —— 我实测连死两次（05:29:30 / 05:29:59）。
//
// 现在：首次连接失败带退避重试；预算用完也**不退出**，保留控制台并后台每 15s 再试。
// 本测试在**临时沙箱**里跑（复制 src + 自造 config.json + 把 HOME 指到沙箱），
// 用死端口当 NapCat，断言：①真的在重试 ②预算用完仍在跑 ③控制台端口仍能监听。全程不碰线上。
//
// 用法：node tools/test-napcat-startup-retry.mjs
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qbh-napcat-retry-'));
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-retry-sandbox', private: true, type: 'module' }));
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
const DEAD_WS = 3999;          // 没有任何东西在这监听 → 每次连接都会失败
const CONSOLE_PORT = 3199;
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify({
  ownerQQ: '10001',                          // 沙箱用的假主人（loadConfig 要求合法正整数）
  consolePort: CONSOLE_PORT,
  napcat: { wsUrl: `ws://127.0.0.1:${DEAD_WS}`, accessToken: '' },
  social: { napcatStartupBudgetMs: 3000 },   // 缩短预算，测试才跑得快
}, null, 2));

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const fin = (v) => { try { s.destroy(); } catch {} resolve(v); };
  s.setTimeout(500);
  s.once('connect', () => fin(true));
  s.once('timeout', () => fin(false));
  s.once('error', () => fin(false));
});

const child = spawn(process.execPath, [path.join(sandbox, 'src', 'bridge.js')], {
  cwd: sandbox,
  env: { ...process.env, USERPROFILE: sandbox, HOME: sandbox },   // 隔离：别让沙箱读到线上的 managed home
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });

const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  await sleep(500);
  if (child.exitCode !== null) break;
  // 预算 3s → 重试若干次后应打印"仍未连上"；一旦出现就再等 3 秒确认它活着
  if (/启动预算内仍未连上/.test(out) && Date.now() - t0 > 6000) break;
}

const exited = child.exitCode !== null;
const retries = (out.match(/第 \d+ 次连接未成功/g) || []).length;
const gaveUpGracefully = /启动预算内仍未连上：桥继续运行/.test(out);
const aliveAfter = !exited;
// 控制台是在 NapCat 连接步骤之后才起的：给它最多 10 秒（这一步本来就排在后面，不是缺陷）
let consoleUp = false;
for (let i = 0; i < 20 && aliveAfter; i++) {
  if (await portOpen(CONSOLE_PORT)) { consoleUp = true; break; }
  await sleep(500);
}

check('① 首次连接失败后确实在重试（≥2 次）', retries >= 2, `重试 ${retries} 次`);
check('② 预算用完后没有自杀（旧行为是 2 秒内 exit 1）', aliveAfter, exited ? `exitCode=${child.exitCode}` : '仍在运行');
check('③ 打印了"继续运行 + 后台重试"的说明', gaveUpGracefully);
check('④ 控制台端口仍在监听（管理器「打开」不会白屏）', consoleUp, `port ${CONSOLE_PORT}`);
check('⑤ 没有"启动失败/端口被占用 → 退出"这类致命行', !/启动失败:|已被占用，退出|exit\(1\)/.test(out));
check('⑥ 没有崩栈（uncaught 痕迹）', !/uncaughtException|UnhandledPromiseRejection/i.test(out));
// ⑦ 用**时间差**判断（比固定字符窗口可靠）：放弃 NapCat 到控制台起来之间不能隔很久
const tGiveUp = Number((out.match(/(\d\d:\d\d:\d\d) \[bridge\] \[napcat\] 启动预算内仍未连上/) || [])[1]?.split(':').reduce((a, b) => a * 60 + Number(b), 0)) || 0;
const tConsole = Number((out.match(/(\d\d:\d\d:\d\d) \[bridge\] 本地控制台已启动/) || [])[1]?.split(':').reduce((a, b) => a * 60 + Number(b), 0)) || 0;
check('⑦ 控制台在放弃 NapCat 之后 5 秒内起来（不再被 getLoginInfo 拖 30s）',
  tGiveUp > 0 && tConsole >= tGiveUp && (tConsole - tGiveUp) <= 5,
  `gap=${tConsole && tGiveUp ? (tConsole - tGiveUp) + 's' : '无法解析时间'}`);

console.log('\n—— 沙箱日志（NapCat / 控制台 相关行）——');
for (const line of out.split('\n').filter((l) => /napcat|控制台|控制台服务|console|监听|启动失败|Error/i.test(l)).slice(0, 24)) console.log('  ' + line.slice(0, 170));

try { child.kill(); } catch { /* ignore */ }
await sleep(300);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
