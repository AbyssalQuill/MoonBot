// NapCat 完整性自修（server/napcat-repair.js）自检 —— 真机事故的回归闸门。
//
// 事故现场：装到别人机器上启动即崩
//   ERR_MODULE_NOT_FOUND: Cannot find module '...\conout-D9oph_Le.js' imported from '...\napcat.mjs'
// 根因是 payload 里 napcat.mjs 与被引用分片不同源（打包仓库实测：runtime-full 引用 D9oph_Le，
// 目录里只有旧的 wiJ7YKRd）。这个测试用临时目录 + 真造的 zip 把「查得出 / 补得回」钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  relativeSpecifiers, checkNapcatApp, findShellZip, repairNapcatApp, ensureNapcatApps, findNapcatApps,
} from '../server/napcat-repair.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); failed += 1; }
}

console.log('== ① 从 mjs 里认出"落地成文件"的相对导入 ==');
check('静态/副作用/动态/require/再导出 都认，外部包与目录导入不认', () => {
  const specs = relativeSpecifiers(`
    import { a } from "./chunk-abc.js";
    import x from './sub/mod.mjs';
    import "./side-effect.js";
    export { y } from "./reexport.js";
    const y = await import("./dyn-1.js");
    const z = require("./req.json");
    import fs from "node:fs";
    import pkg from "some-pkg";
    import dir from "./some-dir";
    import bare from "./no-ext";
  `);
  assert.deepEqual(specs.sort(), ['./chunk-abc.js', './dyn-1.js', './reexport.js', './req.json', './side-effect.js', './sub/mod.mjs']);
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-repair-'));
try {
  const onekey = path.join(root, 'napcat-onekey');
  const appDir = path.join(onekey, 'NapCat.44498.Shell', 'versions', '9.9.26-44498', 'resources', 'app', 'napcat');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'napcat.mjs'), [
    'import "./conout-OKHASH1.js";',
    'import { x } from "./conout-MISSING2.js";',
    'export default 1;',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(appDir, 'conout-OKHASH1.js'), 'export const ok = 1;\n', 'utf8');

  console.log('\n== ② 缺文件要能查出来 ==');
  check('checkNapcatApp 报出缺失的那个', () => {
    const r = checkNapcatApp(path.join(appDir, 'napcat.mjs'));
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['./conout-MISSING2.js']);
  });
  check('findNapcatApps 能扫到这份 mjs', () => {
    const apps = findNapcatApps(root);
    assert.equal(apps.length, 1);
  });
  check('ensureNapcatApps(fix=false) 不写盘、只报告', () => {
    const r = ensureNapcatApps({ root, fix: false });
    assert.equal(r.checked, 1);
    assert.equal(r.broken, 1);
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(appDir, 'conout-MISSING2.js')), false);
  });
  check('找不到 zip 时明确说"无法自修"而不是静默', () => {
    assert.equal(findShellZip(appDir), null);
    const r = repairNapcatApp(path.join(appDir, 'napcat.mjs'));
    assert.equal(r.ok, false);
    assert.match(r.error, /找不到 NapCat\.Shell\.zip/);
  });

  console.log('\n== ③ 有 zip 时能补回来（缺哪个解哪个） ==');
  // 真造一个 zip：用系统 tar（Windows 10+ 自带）压出 zip，成员名就是内容哈希
  const stage = path.join(root, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'conout-MISSING2.js'), 'export const repaired = true;\n', 'utf8');
  const zipPath = path.join(onekey, 'NapCat.Shell.zip');
  const tar = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', stage, 'conout-MISSING2.js'], { encoding: 'utf8', windowsHide: true });
  const zipOk = tar.status === 0 && fs.existsSync(zipPath);
  if (!zipOk) {
    console.log(`  SKIP  造不出 zip（tar exit=${tar.status} ${(tar.stderr || '').slice(0, 120)}），跳过自修断言`);
  } else {
    // 7z.exe：从真 payload 里借一个（打包仓库/运行时都有）；借不到就跳过
    const sevenZipSrc = [
      'C:/Users/17367/Desktop/QQ-Bridge-packaging/full/app/napcat-onekey/7z.exe',
      'D:/MoonBot/resources/runtime/napcat-onekey/7z.exe',
    ].find((p) => fs.existsSync(p));
    if (!sevenZipSrc) {
      console.log('  SKIP  找不到 7z.exe');
    } else {
      fs.copyFileSync(sevenZipSrc, path.join(onekey, '7z.exe'));
      const dllSrc = path.join(path.dirname(sevenZipSrc), '7z.dll');
      if (fs.existsSync(dllSrc)) fs.copyFileSync(dllSrc, path.join(onekey, '7z.dll'));   // 7z.exe 缺了这个 dll 会 'Can't load module: 7z.dll'
      check('findShellZip 找到了 zip 与 7z.exe', () => {
        const z = findShellZip(appDir);
        assert.ok(z && z.zip === zipPath && fs.existsSync(z.sevenZip));
      });
      const r = repairNapcatApp(path.join(appDir, 'napcat.mjs'));
      check('自修成功且报告补了 1 个文件', () => {
        assert.equal(r.ok, true, r.error);
        assert.equal(r.repaired, 1);
      });
      check('文件内容确实来自 zip', () => {
        const txt = fs.readFileSync(path.join(appDir, 'conout-MISSING2.js'), 'utf8');
        assert.match(txt, /repaired = true/);
      });
      check('再查一遍是 OK（幂等）', () => {
        assert.equal(checkNapcatApp(path.join(appDir, 'napcat.mjs')).ok, true);
        const again = ensureNapcatApps({ root });
        assert.equal(again.ok, true);
        assert.equal(again.broken, 0);
      });
      check('zip 里没有那个成员时不会假装成功', () => {
        const mjs2 = path.join(appDir, 'napcat2');
        fs.mkdirSync(mjs2, { recursive: true });
        fs.writeFileSync(path.join(mjs2, 'napcat.mjs'), 'import "./conout-NOTINZIP.js";', 'utf8');
        const bad = repairNapcatApp(path.join(mjs2, 'napcat.mjs'));
        assert.equal(bad.ok, false);
        assert.equal(fs.existsSync(path.join(mjs2, 'conout-NOTINZIP.js')), false);
      });
    }
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 占用忽略 */ }
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（通过 ${passed}，失败 ${failed}）`);
process.exit(failed === 0 ? 0 : 1);
