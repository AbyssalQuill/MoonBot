/* 回归测试：【拉起 NapCat 守卫时不许弹出任何可见的控制台黑窗】（2026-09-13 主人要求）
 *
 * 背景（实测根因）：守卫必须"脱离管理器进程树"才能活过壳的 `taskkill /T`，所以是用 WMI
 * （Win32_Process.Create）建的。但 WMI 建进程时**没指定窗口显示方式**，Windows 就会给这个控制台
 * 程序新建并**显示**一个控制台窗口 —— 真机表现是：一开应用就多出一个 Windows Terminal 黑窗，
 * 里面正是守卫那行"守卫启动：父进程=… 托管目录=…"。
 * 修法（两条都实测过）：`Win32_ProcessStartup.CreateFlags=CREATE_NO_WINDOW` 无效（Create 返回 21），
 * 而 `Win32_ProcessStartup.ShowWindow=0`(SW_HIDE) 有效。
 *
 * 本测试直接调用产品里导出的 spawnGuardianDetached()，然后枚举顶层窗口，断言：
 *   ① 进程起来了（pid>0 且活着）；② **没有新增任何"可见"的控制台/终端窗口**；
 *   ③ 守卫真的跑了（日志有"守卫启动"）；④ 故意不传 --dirs/--dsh-port/--bridge-script 时，
 *      它只记三行"跳过"，什么都不杀（安全边界没被破坏）。
 *
 * 用法：node tools/test-guardian-hidden-window.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let fails = 0;
const check = (n, ok, extra = '') => { if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); };

/* ---- 枚举顶层控制台/终端窗口（PowerShell + Add-Type，用 -EncodedCommand 传，避开引号与编码坑） ---- */
const PS = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class MBWinProbe {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> List() {
    var res = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      string cn = sb.ToString();
      if (cn.IndexOf("Console", StringComparison.OrdinalIgnoreCase) >= 0 || cn.IndexOf("CASCADIA", StringComparison.OrdinalIgnoreCase) >= 0) {
        int pid; GetWindowThreadProcessId(h, out pid);
        var tb = new StringBuilder(256);
        GetWindowText(h, tb, 256);
        res.Add(pid + "|" + cn + "|" + (IsWindowVisible(h) ? "VISIBLE" : "hidden") + "|" + tb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
([MBWinProbe]::List() -join [char]10)
`;

function runPs(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(out); }, timeoutMs);
  });
}

async function snapshot() {
  const out = await runPs(PS);
  const rows = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\|/.test(s));
  const wt = Number((await runPs('(Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | Measure-Object).Count')).trim()) || 0;
  const win = rows.map((r) => { const [pid, cls, vis, title] = r.split('|'); return { pid: Number(pid), cls, vis, title }; });
  return { windows: win, visible: win.filter((w) => w.vis === 'VISIBLE'), wt };
}

function diffVisible(a, b) {
  const key = (w) => `${w.pid}|${w.cls}|${w.title}`;
  const setA = new Set(a.map(key));
  return b.filter((w) => !setA.has(key(w)));
}

async function main() {
  console.log('=== 守卫黑窗回归：spawnGuardianDetached() 不许弹可见控制台窗口 ===');
  const guardianScript = path.join(REPO, 'server', 'napcat-guardian.mjs');
  if (!fs.existsSync(guardianScript)) { console.log('找不到 server/napcat-guardian.mjs'); process.exit(1); }

  const before = await snapshot();
  console.log(`基线：可见控制台窗口 ${before.visible.length} 个，WindowsTerminal 进程 ${before.wt} 个`);

  // 与 node.exe 同盘的临时目录：硬链接才建得出来（跨盘会 EXDEV）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-guard-win-'));
  const guardFile = path.join(tmp, 'guard.json');
  const logFile = path.join(tmp, 'guardian.log');

  process.env.QBM_NO_LISTEN = '1';
  const mod = await import(pathToFileURL(path.join(REPO, 'server', 'index.js')).href);
  check('server/index.js 导出了 spawnGuardianDetached', typeof mod.spawnGuardianDetached === 'function');

  // 故意**不传** --dirs / --dsh-port / --bridge-script：守卫必须三样都跳过，什么都不杀
  const logs = [];
  const r = mod.spawnGuardianDetached(guardianScript, [
    '--parent', '999999',                 // 不存在的父进程 → 它会走"父进程没了"的分支
    '--guard-file', guardFile,
    '--log', logFile,
    '--grace', '500',
  ], (m) => logs.push(m), { linkDir: tmp });

  console.log(`spawnGuardianDetached() -> pid=${r.pid} exe=${r.exe}${r.error ? ' error=' + r.error : ''}`);
  check('返回了有效进程号', r.pid > 0);
  await sleep(700);
  check('守卫进程活着', isAlive(r.pid));

  const after = await snapshot();
  const newVisible = diffVisible(before.visible, after.visible);
  if (newVisible.length) for (const w of newVisible) console.log(`  新可见窗口 -> pid=${w.pid} ${w.cls} "${w.title}"`);
  check('没有新增可见控制台/终端窗口', newVisible.length === 0, newVisible.length ? `新增 ${newVisible.length} 个` : '');
  check('没有新增 WindowsTerminal 窗口', after.wt <= before.wt, `before=${before.wt} after=${after.wt}`);

  const own = after.windows.filter((w) => w.pid === r.pid);
  console.log(`守卫自己名下的控制台窗口：${own.length ? own.map((w) => w.cls + '/' + w.vis).join(', ') : '（没有，说明连控制台都没建）'}`);
  check('守卫名下没有"可见"窗口', own.every((w) => w.vis !== 'VISIBLE'));

  // 守卫自己的日志：证明它真的跑起来了，并且三样清理都跳过了
  await sleep(3200);                       // 2s 轮询 + 500ms 宽限
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { /* ignore */ }
  check('守卫写出了启动日志', /守卫启动：父进程=999999/.test(text));
  check('守卫认定父进程已退出', /父进程 999999 已退出/.test(text));
  check('没传 --dirs → 跳过 NapCat 清理（绝不误杀）', /没有托管目录，跳过 NapCat 清理/.test(text));
  check('没传 --bridge-script → 跳过桥清理', /没有 --bridge-script/.test(text));
  check('没传 --dsh-port → 跳过 DSH 清理', /没有 --dsh-port/.test(text));
  check('收拾完毕并退出', /收拾完毕，守卫进程退出/.test(text));
  console.log('守卫日志：\n' + text.trim().split('\n').map((l) => '    ' + l).join('\n'));

  await sleep(400);
  check('守卫已自行退出（没有留下常驻进程）', !isAlive(r.pid));

  const final = await snapshot();
  const lateVisible = diffVisible(before.visible, final.visible);
  check('整段过程结束后仍没有新增可见窗口', lateVisible.length === 0);

  try { if (isAlive(r.pid)) process.kill(r.pid); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.log('EXCEPTION', e?.stack || e); process.exit(1); });
