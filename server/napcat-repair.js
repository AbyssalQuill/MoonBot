/**
 * NapCat 运行时完整性自检 / 自修 —— 2026-09-19 加。
 *
 * 【为什么必须有它】真机事故（别人装在 `D:\QQbot\9.19新版\MoonBot` 上）：
 *   ```
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\conout-D9oph_Le.js' imported from '...\napcat.mjs'
 *   ```
 * 根因不在那台机器上，而在**我们打出去的 payload**：`napcat.mjs` 是被引用文件（`conout-<hash>.js`，
 * 名字就是内容哈希）的宿主，只要这两者不是同一次构建出来的，就必然报这个错。实测打包仓库里
 * `moonbot-app\runtime-full` 的 napcat.mjs 引用 `conout-D9oph_Le.js`，而同目录只有旧的
 * `conout-wiJ7YKRd.js` —— 装到谁机器上都是启动即崩。
 *
 * 另外两种真实成因也走同一套自修：杀软误删单个 js、以及"更新时文件被占用导致复制不完整"
 * （安装器报"无法关闭…请手动关闭后重试"之后继续安装就会留下半新的树）。
 *
 * 【数据来源】同目录往上的 `NapCat.Shell.zip` + 随包 `7z.exe`：zip 是 NapCat 官方 one-key 包，
 * 成员名就是内容哈希，所以"缺哪个成员就解哪个成员"必然解出正确内容（不需要版本号对齐）。
 *
 * 【用法】
 *   · 运行期：管理端在拉起 NapCat 之前调 ensureNapcatApps()，缺文件就补、补不上就给出人话说明；
 *   · 安装期：NSIS 复制完文件后跑 `qbm-node.exe server/napcat-repair.js --fix`（同一个实现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(HERE, '..');

/** 从 napcat.mjs 文本里抠出所有"落地成文件"的相对导入。
 *  【2026-09-19 修漏】必须同时认**副作用导入**（`import "./x.js"`，没有 from）与**再导出**
 *  （`export … from "./x.js"`）—— 真机那个 `conout-*.js` 分片就是这种写法，
 *  只认 `from` 的正则会让检查器"看着通过、实际启动即崩"。 */
export function relativeSpecifiers(text) {
  const specs = new Set();
  const push = (s) => {
    if (!s || !/^\.{1,2}\//.test(s)) return;
    if (!/\.(js|mjs|cjs|json)$/i.test(s)) return;
    specs.add(s);
  };
  for (const m of String(text ?? '').matchAll(/\bfrom\s*["']([^"']+)["']/g)) push(m[1]);          // import/export … from "x"
  for (const m of String(text ?? '').matchAll(/\bimport\s*["']([^"']+)["']/g)) push(m[1]);        // 副作用导入 import "x"
  for (const m of String(text ?? '').matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) push(m[1]); // 动态 import()
  for (const m of String(text ?? '').matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) push(m[1]);
  return [...specs];
}

/** 扫出一个 runtime 目录下所有 napcat.mjs（payload 里可能在 napcat-onekey 与旧版 napcat 目录各有一份） */
export function findNapcatApps(root = RUNTIME_ROOT) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'napcat.mjs') out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** 单个 napcat 应用目录的一致性检查 */
export function checkNapcatApp(mjsPath) {
  const dir = path.dirname(mjsPath);
  let text = '';
  try { text = fs.readFileSync(mjsPath, 'utf8'); }
  catch (e) { return { ok: false, dir, mjs: mjsPath, refs: [], missing: [], error: `读不到 napcat.mjs：${e?.message ?? e}` }; }
  const refs = relativeSpecifiers(text);
  const missing = refs.filter((s) => !fs.existsSync(path.resolve(dir, s)));
  return { ok: missing.length === 0, dir, mjs: mjsPath, refs, missing, bytes: fs.statSync(mjsPath).size };
}

/** 往上找 NapCat.Shell.zip 与 7z.exe（one-key 目录里就有） */
export function findShellZip(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(d, 'NapCat.Shell.zip'))) {
      return { zip: path.join(d, 'NapCat.Shell.zip'), sevenZip: path.join(d, '7z.exe') };
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

/** 从 zip 里解出缺的成员（成员名=内容哈希，所以内容必然对得上） */
export function repairNapcatApp(mjsPath, { log = () => {} } = {}) {
  const check = checkNapcatApp(mjsPath);
  if (check.ok) return { ok: true, repaired: 0, missing: [] };
  const src = findShellZip(check.dir);
  if (!src) {
    return { ok: false, repaired: 0, missing: check.missing, error: `缺 ${check.missing.join(', ')}，且往上层找不到 NapCat.Shell.zip（无法自修）` };
  }
  if (!fs.existsSync(src.sevenZip)) {
    return { ok: false, repaired: 0, missing: check.missing, error: `找不到 ${src.sevenZip}（无法从 zip 解文件）` };
  }
  let repaired = 0;
  for (const spec of check.missing) {
    const member = spec.replace(/^\.\//, '');
    const r = spawnSync(src.sevenZip, ['e', src.zip, member, `-o${check.dir}`, '-y'], { encoding: 'utf8', windowsHide: true });
    const ok = r.status === 0 && fs.existsSync(path.join(check.dir, member));
    if (ok) { repaired += 1; log(`[napcat-repair] 已从 ${path.basename(src.zip)} 补回 ${member}`); }
    else log(`[napcat-repair] 补 ${member} 失败：${(r.stderr || r.stdout || `exit=${r.status}`).toString().slice(0, 200)}`);
  }
  const after = checkNapcatApp(mjsPath);
  return { ok: after.ok, repaired, missing: after.missing, error: after.ok ? '' : `仍有缺失：${after.missing.join(', ')}` };
}

/**
 * 全量自检 + 自修（管理端启动 NapCat 前调用；安装期也用它）。
 * @returns {{ok:boolean, checked:number, broken:number, repaired:number, detail:Array, error?:string}}
 */
export function ensureNapcatApps({ root = RUNTIME_ROOT, fix = true, log = () => {} } = {}) {
  const apps = findNapcatApps(root);
  const detail = [];
  let broken = 0;
  let repaired = 0;
  for (const mjs of apps) {
    const before = checkNapcatApp(mjs);
    if (before.ok) { detail.push({ mjs, status: 'ok', refs: before.refs.length }); continue; }
    broken += 1;
    log(`[napcat-repair] ${mjs} 缺 ${before.missing.length} 个被引用文件：${before.missing.join(', ')}`);
    if (!fix) { detail.push({ mjs, status: 'broken', missing: before.missing }); continue; }
    const r = repairNapcatApp(mjs, { log });
    repaired += r.repaired;
    detail.push({ mjs, status: r.ok ? 'repaired' : 'broken', missing: r.missing, error: r.error });
    if (!r.ok) log(`[napcat-repair] 自修未完成：${r.error}`);
  }
  const stillBroken = detail.filter((d) => d.status === 'broken');
  return {
    ok: stillBroken.length === 0,
    checked: apps.length,
    broken,
    repaired,
    detail,
    error: stillBroken.length ? `有 ${stillBroken.length} 个 NapCat 目录仍不完整：${stillBroken[0].error || ''}` : '',
  };
}

/* ── CLI（安装器收尾/排障用）：node server/napcat-repair.js [--check|--fix] [--root <dir>] ── */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const wantFix = args.includes('--fix');
  const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : RUNTIME_ROOT;
  const r = ensureNapcatApps({ root: path.resolve(rootArg), fix: wantFix, log: (m) => console.log(m) });
  console.log(`[napcat-repair] root=${path.resolve(rootArg)} 检查 ${r.checked} 个，坏 ${r.broken} 个，补回 ${r.repaired} 个 → ${r.ok ? 'OK' : '仍有问题：' + r.error}`);
  process.exit(r.ok ? 0 : 1);
}
