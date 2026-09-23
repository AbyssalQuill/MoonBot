// 一次性反向自测：把"旧写法"注进 server/deploy.js 的临时副本，确认门禁真的会 FAIL，然后还原。
// 用法: node tools/_negative-test-guard.mjs
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEPLOY = path.join(REPO, 'server', 'deploy.js');
const BAK = DEPLOY + '.negtest-bak';

const original = readFileSync(DEPLOY, 'utf8');
copyFileSync(DEPLOY, BAK);
try {
  // 注入 2026-09-19 那种"看着成功其实没重启"的老形状
  const needle = "      pgrep -f 'node src/bridge.js' >/dev/null && echo bridge-up || echo bridge-down\n";
  writeFileSync(DEPLOY, original + '\n// negtest\n' + needle, 'utf8');
  const r = spawnSync(process.execPath, [path.join(HERE, 'check-remote-restart-uses-script.mjs')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.split(/\r?\n/).find((l) => l.includes('不留内联 start-bridge.sh')) || '(没找到那条检查)';
  console.log(`注入旧写法后：${line}`);
  console.log(`门禁退出码 = ${r.status}（期望非 0）`);
  console.log(r.status === 1 && line.startsWith('FAIL') ? '✅ 反向自测通过：门禁确实会抓到旧写法' : '❌ 反向自测失败：门禁没抓到，断言还不够严');
} finally {
  writeFileSync(DEPLOY, original, 'utf8');
  try { unlinkSync(BAK); } catch { /* ignore */ }
  const check = spawnSync(process.execPath, ['--check', DEPLOY], { encoding: 'utf8' });
  console.log(`还原完成；deploy.js 语法 exit=${check.status}`);
}
