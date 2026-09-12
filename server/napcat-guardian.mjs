/* ============================================================================
 * NapCat 守卫进程（2026-09-13，主人要求："应用进程关闭时，NapCat 进程也要关闭"）
 *
 * 为什么必须是**独立进程**：
 *   关窗时 Electron 壳执行的是 `taskkill /pid <后端> /T /F` —— 管理器是**被强杀**的，
 *   它自己一行清理代码都跑不到；而 NapCat 是用 wscript 拉起的游离进程（`NapCatWinBootMain.exe`
 *   再注入 `QQ.exe`），不在 taskkill /T 的进程树里，所以会留在后台。
 *   于是"谁来负责关门"只能交给一个**活过后端**的小进程。
 *
 * 协议：
 *   · 后端启动时拉起本进程（detached），并把 {pid, parentPid} 写进 guard 文件；
 *   · 本进程每 2 秒看一次父进程是否还活着；
 *   · 父进程没了 → 等 GRACE_MS（默认 6s，给"管理器重启"留出窗口）→ **重新核对 guard 文件**：
 *       文件里的 pid 已经不是我（说明新后端起来了、并已接管守卫）→ 静默退出，什么都不杀；
 *       文件里的 pid 还是我 → 说明是"应用关了/崩了"，这时才动手：
 *         ① 按托管目录前缀停 NapCat（NapCatWinBootMain / QQ，绝不碰 Program Files 里的正版 QQ）
 *         ② 停桥（命令行含 bridge.js 的 node/qbm-node）
 *         ③ 停隔离 DSH（命令行含 `--port <dshPort>`）
 *      然后把动作写进日志并退出。
 *
 * 安全边界（都很重要）：
 *   · 只有"父进程是应用本体(MoonBot.exe)"时后端才会拉起本进程 —— 别的启动方式（wscript 拉完就退出、
 *     双击 qbm-node、cmd 启动）不会被误判成"应用关了"，所以不会开机就把 NapCat 杀掉；
 *   · 目录参数由后端传进来（同一套 napcatManagedDirs 逻辑），并且只按**路径前缀**匹配进程；
 *   · `--dirs` 为空时什么都不杀（宁可不动，也不误杀）。
 *
 * 用法（后端自动调用，也可手工跑）：
 *   node napcat-guardian.mjs --parent <pid> --guard-file <path> --dirs '<json数组>' --dsh-port 10721
 * ========================================================================== */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

const parentPid = Number(argOf('parent', '0'));
const guardFile = argOf('guard-file', '');
// ⚠️ 这三个"要收谁"的参数**没有默认值**：给默认值就等于"没传参也会去杀真东西"。
// 踩过的坑：调试时只传了 --parent，别的走默认（dsh-port=10721），60 秒宽限期一到就把**真隔离 DSH** 收了。
// 现在缺哪个就跳过哪一段清理，宁可少收，绝不误杀。
const dshPort = Number(argOf('dsh-port', '')) || 0;
const bridgeScript = argOf('bridge-script', '');   // 本安装的 bridge.js **绝对路径**（只杀这一份，不碰别的安装/别的测试）
const graceMs = Number(argOf('grace', '6000')) || 6000;
let dirs = [];
try { dirs = JSON.parse(argOf('dirs', '[]')) || []; } catch { dirs = []; }
const logFile = argOf('log', '');

const log = (msg) => {
  const line = `[${new Date().toISOString()}] [napcat-guardian] ${msg}`;
  console.log(line);
  if (logFile) { try { writeFileSync(logFile, line + '\n', { flag: 'a' }); } catch { /* ignore */ } }
};

/** PID 是否还活着（Windows 上 Node 的 signal 0 就是"存在性检查"） */
function alive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** guard 文件里现在记的是谁（用来判断"我是否仍是当前守卫"） */
function currentGuardPid() {
  try { return Number(JSON.parse(readFileSync(guardFile, 'utf8')).pid) || 0; } catch { return 0; }
}

function ps(command) {
  try { spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'ignore', windowsHide: true, timeout: 20000 }); } catch { /* 尽力而为 */ }
}

/** ⚠️ 每一处按“命令行/路径”匹配的清理都必须**排除本进程自己**。
 *  踩过的坑：桥的匹配串（--bridge-script 的路径）**就写在本守卫自己的命令行里**，
 *  于是那句 PowerShell 把守卫自己也匹配上了 → 刚停完 NapCat 就自杀（退出码 0xFFFFFFFF），
 *  后面的桥/DSH 清理与收尾全都没跑。 */
const NOT_SELF = `$_.ProcessId -ne ${process.pid}`;

/** ① 停 NapCat：只按托管目录前缀匹配 NapCatWinBootMain / QQ */
function stopNapcat() {
  if (!dirs.length) { log('没有托管目录，跳过 NapCat 清理（绝不误杀）'); return; }
  const where = dirs.map((p) => `$_.Path -like '${String(p).replace(/'/g, "''")}*'`).join(' -or ');
  ps(`Get-Process NapCatWinBootMain,QQ -ErrorAction SilentlyContinue | Where-Object { ${NOT_SELF} -and (${where}) } | Stop-Process -Force`);
  log(`已按目录前缀停 NapCat：${dirs.join(' | ')}`);
}

/** ② 停桥：**只按本安装的 bridge.js 绝对路径匹配**。
 *  ⚠️ 一开始写的是 `CommandLine -like '*bridge.js*'` —— 那会把**同一台机器上任何一份**桥都杀掉，
 *  包括别的安装、以及回归测试自己在跑的临时桥（实测踩到：测试跑一次就把真桥带走了，靠管理器自启才回来）。 */
function stopBridge() {
  if (!bridgeScript) { log('没有 --bridge-script，跳过桥清理（只动自己的那份）'); return; }
  const marker = String(bridgeScript).replace(/'/g, "''");
  ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='qbm-node.exe'" | Where-Object { ${NOT_SELF} -and $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  log(`已停桥接进程（只匹配 ${bridgeScript}）`);
}

/** ③ 停隔离 DSH（命令行含 --port <dshPort>）；没给端口就跳过（绝不用默认端口去猜） */
function stopDsh() {
  if (!dshPort) { log('没有 --dsh-port，跳过 DSH 清理（绝不用默认端口去猜）'); return; }
  ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='qbm-node.exe'" | Where-Object { ${NOT_SELF} -and $_.CommandLine -like '*--port ${dshPort}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  log(`已停隔离 DSH（--port ${dshPort}）`);
}

function shutdownAll(reason) {
  log(`父进程 ${parentPid} 已退出（${reason}）→ 开始收起整套：NapCat → 桥 → 隔离 DSH`);
  stopNapcat();
  stopBridge();
  stopDsh();
  try { if (guardFile && existsSync(guardFile)) rmSync(guardFile, { force: true }); } catch { /* ignore */ }
  log('收拾完毕，守卫进程退出');
}

// ---- 主循环：父进程在就每 2s 看一眼；父进程没了先等宽限期再二次核对 ----
if (!parentPid) { log('没有 --parent，直接退出（不做任何事）'); process.exit(0); }
log(`守卫启动：父进程=${parentPid} 托管目录=${dirs.length} 个 宽限=${graceMs}ms guardFile=${guardFile || '(未指定)'}`);

let acted = false;
// ⚠️ 千万不能 unref：本进程"活着盯住父进程"就是它的存在意义。上一版手滑写成 unref，
// 事件循环立刻空掉、进程几毫秒就自己退了 —— 表现是"父进程关了它也不动手"。
const timer = setInterval(() => {
  if (alive(parentPid)) return;
  clearInterval(timer);
  setTimeout(() => {
    if (acted) return;
    acted = true;
    const owner = currentGuardPid();
    if (owner && owner !== process.pid) {
      log(`guard 文件已归新后端（pid=${owner}）所有 → 说明是"管理器重启"，不杀任何东西`);
      process.exit(0);
    }
    shutdownAll('父进程不存在且没有新后端接管');
    process.exit(0);
  }, graceMs);
  log(`父进程 ${parentPid} 不在了，${graceMs}ms 后复核 guard 文件再决定是否动手`);
}, 2000);
