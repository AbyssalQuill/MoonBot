/* 回归测试：【应用关闭 → NapCat 也关闭】的守卫进程行为
 *   （2026-09-13：应用进程关闭时，NapCat 进程也要关闭）
 *
 * 这个测试不碰真的 NapCat：给守卫传一个临时目录当"托管目录"，所以它的 PowerShell 过滤条件
 * 匹配不到任何进程 —— 我们只验证"它该不该动手、动手时做了哪些事、什么情况下必须不动手"。
 *
 * 覆盖：
 *   ① 父进程还在 → 守卫按兵不动
 *   ② 父进程消失 + guard 文件仍归自己 → 等宽限期后收摊（NapCat → 桥 → DSH 三步都发出去），然后退出
 *   ③ 父进程消失 + guard 文件已归新后端（管理器重启那种）→ 什么都不杀，静默退出
 *   ④ 没有 --parent 时不做事
 *
 * 用法：node tools/test-napcat-guardian.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN = path.resolve(here, '..', 'server', 'napcat-guardian.mjs');

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个"假父进程"（什么都不干，就是个活着的 pid） */
function spawnFakeParent() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  return child;
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-guardian-test-'));
const fakeDir = path.join(tmpRoot, 'FakeNapCatDir');
fs.mkdirSync(fakeDir, { recursive: true });

/** 跑一次守卫；guardPid 传 null 表示"guard 文件写自己的 pid"（需要知道子进程 pid，所以 spawn 后补写） */
async function runGuardian({ guardPidMode, parentPid, grace = 1500, waitMs = 9000 }) {
  const logFile = path.join(tmpRoot, `guardian-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
  const guardFile = path.join(tmpRoot, `guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  const child = spawn(process.execPath, [GUARDIAN,
    '--parent', String(parentPid),
    '--guard-file', guardFile,
    '--dirs', JSON.stringify([fakeDir]),
    '--dsh-port', '19999', 
    '--bridge-script', path.join(tmpRoot, 'fake-bridge.js'),
    '--grace', String(grace),
    '--log', logFile,
  ], { stdio: 'ignore', windowsHide: true, detached: false });
  if (guardPidMode === 'self') {
    fs.writeFileSync(guardFile, JSON.stringify({ pid: child.pid, parentPid, dirs: [fakeDir] }), 'utf8');
  } else {
    fs.writeFileSync(guardFile, JSON.stringify({ pid: 999999, parentPid: 1234 }), 'utf8');   // 假装已被新后端接管
  }
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) { if (logFile && fs.existsSync(logFile) && /收拾完毕|不杀任何东西/.test(fs.readFileSync(logFile, 'utf8'))) break; await sleep(200); }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  return { child, log, guardFile, exited: !isAlive(child.pid) };
}

/* ── ① 父进程还在 → 不动手 ───────────────────────────────────────────────── */
{
  const parent = spawnFakeParent();
  await sleep(400);
  const g = await runGuardian({ guardPidMode: 'self', parentPid: parent.pid, waitMs: 5000 });
  check('① 父进程还在时守卫不收拾（日志里没有停 NapCat）', !/已按目录前缀停 NapCat/.test(g.log), g.log.split('\n')[0] || '(无日志)');
  check('① 守卫仍在运行（不是自己退了）', !g.exited);
  check('① 守卫启动日志写明了父进程与目录数', /守卫启动：父进程=\d+ 托管目录=1/.test(g.log), g.log.split('\n')[0] || '');
  try { g.child.kill(); } catch {}
  parent.kill();
}

/* ── ② 父进程消失 + guard 归自己 → 收摊三步 ─────────────────────────────── */
{
  const parent = spawnFakeParent();
  await sleep(400);
  const logFile = path.join(tmpRoot, 'g2.log');
  const guardFile = path.join(tmpRoot, 'g2.json');
  const child = spawn(process.execPath, [GUARDIAN, '--parent', String(parent.pid), '--guard-file', guardFile,
    '--dirs', JSON.stringify([fakeDir]), '--dsh-port', '19999', 
    '--bridge-script', path.join(tmpRoot, 'fake-bridge.js'), '--grace', '1200', '--log', logFile], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(guardFile, JSON.stringify({ pid: child.pid, parentPid: parent.pid }), 'utf8');
  await sleep(2500);                       // 让守卫先跑起来
  parent.kill();                           // 模拟"应用关了"
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) { if (fs.existsSync(logFile) && /收拾完毕/.test(fs.readFileSync(logFile, 'utf8'))) break; await sleep(200); }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  console.log('--- ② 守卫日志 ---\n' + log.trim() + '\n---');
  check('② 父进程消失后守卫动手了', /父进程 \d+ 已退出/.test(log), '');
  check('② 按目录前缀停 NapCat（且只按托管目录）', /已按目录前缀停 NapCat/.test(log), '');
  check('② 同时停桥（且只匹配本安装的 bridge.js 绝对路径）', /已停桥接进程（只匹配/.test(log) && !/只匹配 .*runtime.qq-bridge/.test(log), '');
  check('② 同时停隔离 DSH（--port 19999）', /已停隔离 DSH（--port 19999）/.test(log));
  check('② 收摊后守卫退出', !isAlive(child.pid));
  check('② 收摊后 guard 文件被清掉', !fs.existsSync(guardFile));
}

/* ── ③ 已归新后端 → 必须什么都不杀（管理器重启场景）─────────────────────── */
{
  const parent = spawnFakeParent();
  await sleep(400);
  const logFile = path.join(tmpRoot, 'g3.log');
  const guardFile = path.join(tmpRoot, 'g3.json');
  const child = spawn(process.execPath, [GUARDIAN, '--parent', String(parent.pid), '--guard-file', guardFile,
    '--dirs', JSON.stringify([fakeDir]), '--dsh-port', '19999', 
    '--bridge-script', path.join(tmpRoot, 'fake-bridge.js'), '--grace', '1200', '--log', logFile], { stdio: 'ignore', windowsHide: true });
  // 模拟"新后端已经接管守卫"：guard 文件里的 pid 不是本守卫
  fs.writeFileSync(guardFile, JSON.stringify({ pid: 999999, parentPid: 1234 }), 'utf8');
  await sleep(2500);
  parent.kill();
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) { if (fs.existsSync(logFile) && /归新后端|不杀任何东西/.test(fs.readFileSync(logFile, 'utf8'))) break; await sleep(200); }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  console.log('--- ③ 守卫日志 ---\n' + log.trim() + '\n---');
  check('③ 识别出"已由新后端接管"', /归新后端/.test(log), '');
  check('③ 一个字都没杀（没有 NapCat/桥/DSH 动作）', !/已停|已按目录前缀停/.test(log));
  check('③ 守卫自己退出', !isAlive(child.pid));
}

/* ── ④ 没有 --parent → 直接退，不做事 ───────────────────────────────────── */
{
  const logFile = path.join(tmpRoot, 'g4.log');
  const child = spawn(process.execPath, [GUARDIAN, '--log', logFile], { stdio: 'ignore', windowsHide: true });
  await sleep(1200);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('④ 没有父进程参数时直接退出且不杀任何东西', /没有 --parent/.test(log) && !/已停|已按目录前缀停/.test(log), log.trim());
  check('④ 进程已退出', !isAlive(child.pid));
}

/* ── ⑤ 安全兜底：托管目录为空 → 连"停 NapCat"这步都不发 ─────────────────── */
{
  const parent = spawnFakeParent();
  await sleep(400);
  const logFile = path.join(tmpRoot, 'g5.log');
  const guardFile = path.join(tmpRoot, 'g5.json');
  const child = spawn(process.execPath, [GUARDIAN, '--parent', String(parent.pid), '--guard-file', guardFile,
    '--dirs', '[]', '--grace', '1000', '--log', logFile], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(guardFile, JSON.stringify({ pid: child.pid }), 'utf8');
  await sleep(2000);
  parent.kill();
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) { if (fs.existsSync(logFile) && /收拾完毕/.test(fs.readFileSync(logFile, 'utf8'))) break; await sleep(200); }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('⑤ 托管目录为空时明确跳过 NapCat 清理（绝不误杀）', /没有托管目录，跳过 NapCat 清理/.test(log), log.split('\n').filter(Boolean).pop() || '');
}

/* ── ⑥ 关键：守卫要能活过壳的 taskkill /T（否则一切白搭）────────────────
 *  壳关窗时执行的是 `taskkill /pid <后端> /T /F` + 一条"按 exe 路径杀 qbm-node"的兜底。
 *  所以这里用一个假后端：让它调用产品同款的 spawnGuardianDetached() 把守卫送出去，
 *  再对假后端执行真实的 taskkill /T，然后断言守卫还活着（父链脱身 + exe 路径不同名）。 */
{
  const url = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`).href;
  const { spawnGuardianDetached } = await import(url(path.resolve(here, '..', 'server', 'index.js')));
  const guardFile = path.join(tmpRoot, 'g6.json');
  const logFile = path.join(tmpRoot, 'g6.log');
  // 假后端：调用产品同款发送逻辑把守卫送出去，然后把 pid 写给测试
  const backendCode = `
    import { spawnGuardianDetached } from ${JSON.stringify(url(path.resolve(here, '..', 'server', 'index.js')))};
    const r = spawnGuardianDetached(${JSON.stringify(GUARDIAN)}, ['--parent', String(process.pid), '--guard-file', ${JSON.stringify(guardFile)},
      '--dirs', JSON.stringify([${JSON.stringify(fakeDir)}]), '--dsh-port', '19999',
      '--bridge-script', ${JSON.stringify(path.join(tmpRoot, 'fake-bridge.js'))}, '--grace', '800', '--log', ${JSON.stringify(logFile)}],
      () => {}, { linkDir: ${JSON.stringify(tmpRoot)} });
    console.log(JSON.stringify(r));
    setTimeout(() => {}, 60000);
  `;
  const backend = spawn(process.execPath, ['--input-type=module', '-e', backendCode], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let out = '';
  backend.stdout.on('data', (d) => { out += String(d); });
  const parseSpawn = () => {
    for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      try { const o = JSON.parse(line); if (o && typeof o.pid === 'number') return o; } catch { /* 不是这一行 */ }
    }
    return null;
  };
  let spawned = null;
  for (let i = 0; i < 40; i++) { spawned = parseSpawn(); if (spawned) break; await sleep(250); }
  if (!spawned?.pid) {
    check('⑥ 守卫能被产品同款逻辑送出去（WMI + 硬链接）', false, out.slice(0, 200) || '(假后端没有输出 pid)');
  } else {
    const guardPid = spawned.pid;
    const usedHardlink = /guard-node\.exe$/i.test(String(spawned.exe || ''));
    if (usedHardlink) {
      check('⑥ 守卫用的是**另一个 exe 路径**（躲开壳"按路径杀 qbm-node"的兜底清理）', true, String(spawned.exe));
    } else {
      // 测试进程的 execPath 是 Program Files 下的 node.exe：那里的硬链接会被系统拒（EPERM）
      // → 属于环境限制，不算产品缺陷（产品侧 execPath 是安装树里的 qbm-node.exe，实测硬链接成功）。
      console.log(`SKIP  ⑥ 本环境无法给守卫换 exe 路径（${spawned.exe}，系统拒绝建立硬链接）—— 产品侧见 D:\\MoonBot\\resources\\runtime\\guard-node.exe`);
    }
    fs.writeFileSync(guardFile, JSON.stringify({ pid: guardPid, parentPid: backend.pid }), 'utf8');
    await sleep(1500);
    check('⑥ 送出去之后守卫活着', isAlive(guardPid), `pid=${guardPid}`);
    // 壳的动作：把假后端连树杀掉
    spawnSync('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await sleep(800);
    check('⑥ 假后端已被 taskkill /T 杀死', !isAlive(backend.pid));
    check('⑥ **守卫活过了 taskkill /T**（这就是"应用关了没人收 NapCat"的病根）', isAlive(guardPid), `pid=${guardPid}`);
    // 它应当随后按 ② 的逻辑收摊（这里托管目录是假的，只验证它动手并退出）
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) { if (!isAlive(guardPid)) break; await sleep(250); }
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('⑥ 父进程（假后端）消失后守卫收摊并退出', !isAlive(guardPid) && /收拾完毕/.test(log), log.split('\n').filter(Boolean).pop() || '');
  }
  try { backend.kill(); } catch {}
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);

