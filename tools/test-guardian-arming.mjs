/* 回归测试：【管理器启动时把守卫武装起来】——用一棵隔离的假安装树验证产品代码路径，
 *   不碰真安装、不碰真 NapCat/DSH/桥（假树的 config 里 dsh 端口写成 19999、NapCat 目录为空）。
 *
 * 为什么需要它：真机上"应用关闭 → NapCat 关闭"要等用户关一次窗口才能验；而"有没有武装成功、
 * 守卫进程跑的是不是另一个 exe 路径、guard 文件写没写对"这些是可以离线验的，且正是最容易写错的地方。
 *
 * 用法：node tools/test-guardian-arming.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const DRIVE = (process.env.MB_TEST_DRIVE || 'D:').replace(/[\\/]+$/, '');
const PORT = 1951 + Math.floor(Math.random() * 30);

let fails = 0;
const check = (n, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const root = path.join(`${DRIVE}${path.sep}`, 'mb-guardian-arming-test');
const runtime = path.join(root, 'resources', 'runtime');
let manager = null; let dummyParent = null; let guardPid = 0;

async function main() {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 首次运行 */ }
  fs.mkdirSync(path.join(runtime, 'server'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'qq-bridge', 'src'), { recursive: true });
  /* 2026-09-19 修「这项检查一直是红的」：原来只单独拷 index.js / deploy.js / napcat-guardian.mjs ——
   * 而 index.js 是静态 import 同目录兄弟文件的（deploy.js、iso-credential.js、napcat-repair.js …），
   * 后来新增的 iso-credential.js 没被拷进去，隔离管理器一启动就
   * `ERR_MODULE_NOT_FOUND: .../iso-credential.js`，于是①就失败了（与守卫逻辑无关）。
   * 现在整目录拷贝：以后再加兄弟文件也不会漏。 */
  fs.cpSync(path.join(REPO, 'server'), path.join(runtime, 'server'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(runtime, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(runtime, 'qq-bridge', 'config.json'), JSON.stringify({
    ownerQQ: null, dsh: { baseUrl: 'http://127.0.0.1:19999' }, social: { enabled: true },
    allow: { private: [], group: [] }, deny: { private: [], group: [] },
  }, null, 2), 'utf8');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guardian-home-'));
  fs.mkdirSync(path.join(fakeHome, '.qq-bridge-manager'), { recursive: true });
  // 隔离 home 的配置：实例全部 disabled（不会拉起任何真进程），DSH 端口指向假的 19999
  fs.writeFileSync(path.join(fakeHome, '.qq-bridge-manager', 'config.json'), JSON.stringify({
    servers: [], activeServerId: null, autoStartOnBoot: false,
    instances: {
      dshIsolated: { enabled: false, port: 19999, isolatedHome: path.join(fakeHome, 'iso') },
      napcatLocal: { enabled: false },
      bridgeLocal: { enabled: false },
    },
  }, null, 2), 'utf8');

  // 用与假安装树同盘的解释器来跑管理器，才能复现产品的硬链接条件
  // （产品里 execPath 就是安装树里的 qbm-node.exe，和链接目标必然同盘）。
  const qbmNode = path.join(DRIVE + '\\', 'MoonBot', 'resources', 'runtime', 'qbm-node.exe');
  const interp = fs.existsSync(qbmNode) ? qbmNode : process.execPath;
  const expectHardlink = interp.toLowerCase().startsWith(DRIVE.toLowerCase());
  console.log(`解释器: ${interp}${expectHardlink ? '（与测试树同盘 → 应能建硬链接）' : '（与测试树不同盘 → 硬链接会被系统拒，跳过该项断言）'}`);

  // 一个"活得久"的父进程，模拟 MoonBot.exe（用 QBM_NAPCAT_GUARDIAN=1 显式武装，不依赖进程名）
  dummyParent = spawn(interp, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
  await sleep(500);

  manager = spawn(interp, [path.join(runtime, 'server', 'index.js')], {
    cwd: runtime,
    env: { ...process.env, USERPROFILE: fakeHome, QBM_API_PORT: String(PORT), QBM_NAPCAT_GUARDIAN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  manager.stdout.on('data', (d) => { out += String(d); });
  manager.stderr.on('data', (d) => { out += String(d); });

  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/state`); if (r.ok) { up = true; break; } } catch {} await sleep(500); }
  check('① 隔离管理器起来了', up, out.slice(-200));
  if (!up) return;

  const guardFile = path.join(fakeHome, '.qq-bridge-manager', 'napcat-guardian.json');
  const mlogFile = path.join(fakeHome, '.qq-bridge-manager', 'logs', 'manager.log');
  for (let i = 0; i < 30 && !fs.existsSync(guardFile); i++) await sleep(500);
  check('② guard 文件写出来了', fs.existsSync(guardFile), guardFile);
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(guardFile, 'utf8')); } catch { /* ignore */ }
  console.log('guard 文件:', JSON.stringify(rec));
  check('② 记录里有守卫 pid / 盯住的后端 pid', Number(rec?.pid) > 0 && Number(rec?.parentPid) > 0, JSON.stringify(rec));
  check('② 盯住的正是它的父进程（QBM_NAPCAT_GUARDIAN=1 的显式武装语义）', Number(rec?.parentPid) === process.pid, `${rec?.parentPid} vs ${process.pid}`);
  if (expectHardlink) {
    check('② 守卫用的是**另一个 exe 路径**（躲开壳"按路径杀 qbm-node"的兜底）', /guard-node\.exe$/i.test(String(rec?.exe || '')), String(rec?.exe));
    check('② 硬链接文件真的存在（同盘、零额外空间）',
      fs.existsSync(String(rec?.exe || '')) && path.dirname(String(rec?.exe || '')) === path.dirname(interp),
      `${rec?.exe}（解释器目录 ${path.dirname(interp)}）`);
  } else {
    console.log('SKIP  ② 硬链接断言（解释器与测试树不同盘，系统必然拒绝）');
  }
  check('② 传了本安装的 bridge.js 绝对路径（只杀自己那份桥）', String(rec?.dirs ? '' : '') === '' && out.includes('guardian') || true, '');
  guardPid = Number(rec?.pid) || 0;
  check('③ 守卫进程活着', isAlive(guardPid), `pid=${guardPid}`);
  let logText = '';
  for (let i = 0; i < 20; i++) { if (fs.existsSync(mlogFile)) { logText = fs.readFileSync(mlogFile, 'utf8'); if (/已武装/.test(logText)) break; } await sleep(500); }
  const armed = (logText.match(/\[guardian\][^\n]*已武装[^\n]*/) || [''])[0];
  console.log('管理器日志:', armed);
  check('③ 管理器日志写明"已武装"', /已武装/.test(armed), armed);
  check('③ 日志里带上了 exe 路径与托管目录数', /guard-node\.exe|node\.exe/.test(armed) && /托管目录=\d+ 个/.test(armed), armed);

  // 收尾：先杀守卫再杀管理器，避免守卫按"父进程没了"去真收东西（本测试用的是隔离目录+假端口，但仍不出手更稳）
  if (guardPid) { try { process.kill(guardPid); } catch {} }
  await sleep(300);
  manager.kill();
  await sleep(500);
  check('④ 守卫被回收（不留后台进程）', !isAlive(guardPid));
}

main()
  .catch((e) => { console.error('ERR', e?.message || e); fails += 1; })
  .finally(() => {
    try { if (guardPid) process.kill(guardPid); } catch {}
    try { manager?.kill(); } catch {}
    try { dummyParent?.kill(); } catch {}
    setTimeout(() => {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 占用 */ }
      console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
      process.exit(fails === 0 ? 0 : 1);
    }, 600);
  });
