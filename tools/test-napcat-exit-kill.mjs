/* 回归测试：【关闭界面时结束 NapCat】开关（instances.napcatLocal.killOnExit）的退出收尾行为
 *   （主人 2026-09-18 要求："napcat配置界面加一个本地启动后关闭界面终结napcat进程的选项，支持自由开关"）
 *
 * ⚠️ 这个测试**绝不碰真 NapCat、真 QQ，也不读主人的真配置**，做法是三件"假的"套在一起：
 *   · **假 NapCat**：把 node.exe 硬链接成 `NapCatWinBootMain.exe` 放进"假 OneKey 目录" —— 进程名与真 NapCat
 *     同名，于是"按进程名 + 路径前缀匹配"那套逻辑可以原样跑通，但它不会登录任何 QQ；
 *   · **假 HOME**：给子进程喂 USERPROFILE/HOME=临时目录 → `os.homedir()` 指过去 → 配置
 *     （~/.qq-bridge-manager/config.json）、托管目录（~/Downloads/NapCat.Shell.Windows.OneKey）全在临时目录里；
 *   · **假运行时根目录**：把 server/index.js 与 server/deploy.js 复制到临时目录再导入 →
 *     `RUNTIME_ROOT`（= index.js 的上级目录）也指向临时目录，于是 `findNapcatOneKeyAll()` 里
 *     "仓库里的 napcat-onekey / 本机已安装的 MoonBot"那些**真实候选目录一个都不会被扫到**。
 *     这一层是必须的：第二档兜底是按"托管目录前缀"直接 Stop-Process 的，若托管目录里混进真 OneKey 目录，
 *     而主人恰好正跑着 NapCat，跑一次测试就会把真进程收掉（第一版测试就写出了这个隐患，现已堵死）。
 *   再加上 `QBM_NO_LISTEN=1`：不监听端口、不自动武装守卫、不自动拉起任何实例，
 *   只借用它的 process.on('exit') 收尾逻辑（那正是"管理器进程退出"这条路径本身）。
 *
 * 覆盖：
 *   ① 开关开 + 本进程拉起过（登记了 pid）→ 退出时假 NapCat 被精确收掉（taskkill /pid /T /F）
 *   ② 开关关 → 退出时一根手指都不碰，假 NapCat 必须还活着（主人要求：关着 = 保持不影响的现状）
 *   ③ 开关开但**本次没拉起过** → 也要一根手指都不碰（否则会误杀用户在同一个 OneKey 目录里自己启动的那份）；
 *      这一条特意把"假 OneKey 目录里真的跑着一个 NapCatWinBootMain"摆在面前：代码一旦走错就会咬钩
 *   ④ 开关开、拉起过但没登记到 pid → 走第二档"按 OneKey 目录前缀兜底"（启动后几秒就被关掉的情形）
 *   ⑤ 守卫的 --kill-napcat 0：只跳过 NapCat，桥 / 隔离 DSH 的清理照旧（开关不该顺手废掉守卫本职）
 *
 * 用法：node tools/test-napcat-exit-kill.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const GUARDIAN = path.join(ROOT, 'server', 'napcat-guardian.mjs');

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/* ---------- 假运行时根目录（.runtime/ 已在 .gitignore 里，跑完即删）---------- */
const SANDBOX = path.join(ROOT, '.runtime', `.exit-kill-test-${Date.now().toString(36)}`);
fs.mkdirSync(path.join(SANDBOX, 'server'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'server', 'index.js'), path.join(SANDBOX, 'server', 'index.js'));
fs.copyFileSync(path.join(ROOT, 'server', 'deploy.js'), path.join(SANDBOX, 'server', 'deploy.js'));
const INDEX = pathToFileURL(path.join(SANDBOX, 'server', 'index.js')).href;
const cleanup = () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ } };
process.on('exit', cleanup);

/** 硬链接 node.exe（同盘零拷贝）；跨盘失败时退回复制 */
function linkNodeExe(dest) {
  try { fs.linkSync(process.execPath, dest); }
  catch { fs.copyFileSync(process.execPath, dest); }
}

/** 造一个只属于本次测试的 HOME：里面有"假 OneKey 目录"，返回 { home, shellDir, logFile, fakeExe } */
function makeFakeHome({ killOnExit }) {
  const home = fs.mkdtempSync(path.join(SANDBOX, 'home-'));
  const dir = path.join(home, '.qq-bridge-manager');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    servers: [], activeServerId: null, autoStartOnBoot: false,
    instances: {
      dshIsolated: { enabled: false },
      napcatLocal: { enabled: false, killOnExit, webuiPort: 6099 },
      bridgeLocal: { enabled: false },
    },
  }, null, 2), 'utf8');
  // 假 OneKey 目录：findNapcatOneKeyAll() 会扫 <home>/Downloads/NapCat.Shell.Windows.OneKey/<shell>
  const shellDir = path.join(home, 'Downloads', 'NapCat.Shell.Windows.OneKey', 'NapCat.44498.Shell');
  fs.mkdirSync(shellDir, { recursive: true });
  const fakeExe = path.join(shellDir, 'NapCatWinBootMain.exe');
  linkNodeExe(fakeExe);
  return { home, shellDir, logFile: path.join(dir, 'logs', 'manager.log'), fakeExe };
}

/** 起一个"假 NapCat"（活 2 分钟，等测试来收） */
function spawnFakeNapcat(fakeExe) {
  return spawn(fakeExe, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
}

/** 跑一次"后端退出"：导入假运行时根目录下的 server/index.js（不监听），按需登记假 NapCat 的 pid，然后正常退出 */
function runBackendExit({ home, registerPid, withLaunchMark = true }) {
  const code = `
    import { __testRegisterNapcatLaunch } from ${JSON.stringify(INDEX)};
    ${withLaunchMark ? `__testRegisterNapcatLaunch(${registerPid || 0});` : ''}
    console.log('backend ready');
    setTimeout(() => process.exit(0), 300);
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 关键：换掉 HOME，让 loadConfig()/CONFIG_DIR 全落在假 HOME 里（真配置一个字节都不动）
      env: { ...process.env, USERPROFILE: home, HOME: home, QBM_NO_LISTEN: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('exit', (code2) => resolve({ code: code2, out, err }));
  });
}

const readLog = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const killlog = (log) => log.split('\n').filter((l) => /exit-kill/.test(l)).join('\n') || '(无)';

console.log('【关闭界面时结束 NapCat】回归测试（假 NapCat / 假 HOME / 假运行时根目录，绝不碰真 NapCat 与真配置）');
console.log('─'.repeat(72));

/* ── ① 开关开 + 本次拉起过 → 精确收掉 ─────────────────────────────────────── */
{
  const { home, logFile, fakeExe } = makeFakeHome({ killOnExit: true });
  const fake = spawnFakeNapcat(fakeExe);
  await sleep(900);
  check('① 假 NapCat 起来了（进程名= NapCatWinBootMain）', isAlive(fake.pid), `pid=${fake.pid}`);
  const r = await runBackendExit({ home, registerPid: fake.pid });
  await sleep(1500);
  const log = readLog(logFile);
  console.log('--- ① 管理器日志（exit-kill 部分）---');
  console.log(killlog(log));
  check('① 后端正常退出（exit=0）', r.code === 0, `exit=${r.code} ${r.err.slice(0, 160)}`);
  check('① 退出时按登记 pid 精确结束了假 NapCat', /\[exit-kill\] 已结束 pid=/.test(log), '');
  check('① 假 NapCat 确实已经不在', !isAlive(fake.pid), `pid=${fake.pid}`);
  try { fake.kill(); } catch { /* 已死 */ }
}

/* ── ② 开关关 → 完全不碰 ─────────────────────────────────────────────────── */
{
  const { home, logFile, fakeExe } = makeFakeHome({ killOnExit: false });
  const fake = spawnFakeNapcat(fakeExe);
  await sleep(900);
  const r = await runBackendExit({ home, registerPid: fake.pid });
  await sleep(1500);
  const log = readLog(logFile);
  console.log('--- ② 管理器日志（exit-kill 部分）---');
  console.log(killlog(log));
  check('② 后端正常退出（exit=0）', r.code === 0, `exit=${r.code}`);
  check('② 开关关时日志写明"不动 NapCat"', /已关闭（killOnExit=false）/.test(log), '');
  check('② **假 NapCat 还活着**（退出管理器不影响它，与现状一致）', isAlive(fake.pid), `pid=${fake.pid}`);
  check('② 没有任何 taskkill / 兜底清理动作', !/已结束 pid=/.test(log) && !/兜底清理已执行/.test(log), '');
  try { fake.kill(); } catch { /* ignore */ }
}

/* ── ③ 开关开但本次没拉起过 → 也不许碰（诱饵摆在假 OneKey 目录里）────────────── */
{
  const { home, logFile, fakeExe } = makeFakeHome({ killOnExit: true });
  const fake = spawnFakeNapcat(fakeExe);
  await sleep(900);
  const r = await runBackendExit({ home, registerPid: 0, withLaunchMark: false });   // 连"拉起过"的标记都没有
  await sleep(1800);
  const log = readLog(logFile);
  check('③ 后端正常退出（exit=0）', r.code === 0, `exit=${r.code}`);
  check('③ 本次没拉起过 → 不做任何收尾（连日志都不该有动作）', !/\[exit-kill\]/.test(log), log.split('\n').filter(Boolean).pop() || '(无日志)');
  check('③ **假 OneKey 目录里的假 NapCat 还活着**（绝不误杀别处启动的那份）', isAlive(fake.pid), `pid=${fake.pid}`);
  try { fake.kill(); } catch { /* ignore */ }
}

/* ── ④ 开关开、拉起过但没登记到 pid → 第二档"按 OneKey 目录前缀兜底"───────────
 *  场景：启动后几秒就被关掉，PID 登记窗口还没抓到进程（这时第一档是空的）。 */
{
  const { home, logFile, fakeExe } = makeFakeHome({ killOnExit: true });
  const fake = spawnFakeNapcat(fakeExe);
  await sleep(900);
  const r = await runBackendExit({ home, registerPid: 0 });    // 只标"拉起过"，不登记 pid
  await sleep(2500);
  const log = readLog(logFile);
  console.log('--- ④ 管理器日志（exit-kill 部分）---');
  console.log(killlog(log));
  check('④ 后端正常退出（exit=0）', r.code === 0, `exit=${r.code}`);
  check('④ 没登记到 pid 时退回按 OneKey 目录前缀兜底', /退回按 OneKey 目录前缀兜底/.test(log), '');
  check('④ 兜底日志里列的托管目录全在沙箱里（不含仓库/已安装的那套真 OneKey 目录）',
    /兜底：.*\.exit-kill-test-/.test(log) && !/napcat-onekey|AppData\\Local\\Programs/.test(log), '');
  check('④ 兜底把假 OneKey 目录里的假 NapCat 收掉了', !isAlive(fake.pid), `pid=${fake.pid}`);
  try { fake.kill(); } catch { /* 已死 */ }
}

/* ── ⑤ 守卫 --kill-napcat 0：跳过 NapCat，桥/DSH 照旧 ───────────────────── */
{
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  await sleep(400);
  const logFile = path.join(SANDBOX, `guardian-${Date.now()}.log`);
  const guardFile = path.join(SANDBOX, `guard-${Date.now()}.json`);
  const child = spawn(process.execPath, [GUARDIAN, '--parent', String(parent.pid), '--guard-file', guardFile,
    '--dirs', JSON.stringify([path.join(SANDBOX, 'fake-dir-for-guardian')]), '--dsh-port', '19999',
    '--bridge-script', path.join(SANDBOX, 'fake-bridge.js'), '--grace', '1000',
    '--kill-napcat', '0', '--log', logFile], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(guardFile, JSON.stringify({ pid: child.pid, parentPid: parent.pid }), 'utf8');
  await sleep(2200);
  parent.kill();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { if (/收拾完毕/.test(readLog(logFile))) break; await sleep(200); }
  const log = readLog(logFile);
  console.log('--- ⑤ 守卫日志（--kill-napcat 0）---');
  console.log(log.trim() || '(无)');
  check('⑤ 守卫启动日志写明 收NapCat=false', /收NapCat=false/.test(log), '');
  check('⑤ 明确跳过 NapCat 清理', /跳过 NapCat|不动 NapCat/.test(log) && !/已按目录前缀停 NapCat/.test(log), '');
  check('⑤ 桥与隔离 DSH 仍照旧收（开关不废掉守卫本职）', /已停桥接进程/.test(log) && /已停隔离 DSH（--port 19999）/.test(log), '');
  check('⑤ 守卫收摊后退出', !isAlive(child.pid));
  try { parent.kill(); } catch { /* ignore */ }
}

cleanup();
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
