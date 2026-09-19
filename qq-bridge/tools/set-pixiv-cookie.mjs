/* 写入/清除/自检 pixiv 登录 cookie（只为"按画师名字搜人"这一件事）。
 *
 * 为什么单独做个小工具：cookie 是账号凭证，**不能出现在命令行里**（ps 能看到、shell history 会留）。
 * 所以这个脚本从**文件**读，写完把文件删掉，全程只回显掩码值。
 *
 * 用法（在桥的机器上）：
 *   node qq-bridge/tools/set-pixiv-cookie.mjs --file /root/.pixiv-cookie.txt   # 写入并自检
 *   node qq-bridge/tools/set-pixiv-cookie.mjs --check                          # 只自检当前配置
 *   node qq-bridge/tools/set-pixiv-cookie.mjs --clear                          # 清掉 cookie
 *
 * 自检依据（见 lib/pixiv.js 的 pixivLoginState）：作品 80643572 匿名时 urls.original 是 null，
 * 带上有效 cookie 后非空 —— 所以"能拿到原图地址"就是登录态真的生效的证据，而不是"我填了个值"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanPixivCookie, configPixivCookie, pixivLoginState, pixivLoggedIn, pixivSearchUsersByName } from '../src/lib/pixiv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');
const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
const mask = (s) => (!s ? '(空)' : `${s.slice(0, 12)}…${s.slice(-4)}（长度 ${s.length}）`);

function readConfig() {
  let text = fs.readFileSync(CONFIG_PATH, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}
function writeConfig(cfg) {
  const bak = `${CONFIG_PATH}.bak-cookie-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  fs.copyFileSync(CONFIG_PATH, bak);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return bak;
}

if (argv.includes('--clear')) {
  const cfg = readConfig();
  const had = Boolean(cfg?.pixiv?.cookie);
  if (cfg.pixiv) delete cfg.pixiv.cookie;
  const bak = writeConfig(cfg);
  console.log(`已清除 pixiv.cookie（之前${had ? '有' : '没有'}值）。备份：${bak}`);
  console.log(`现在 pixivLoggedIn=${pixivLoggedIn()}`);
  process.exit(0);
}

let wrote = '';
if (argv.includes('--file')) {
  const src = argOf('--file');
  if (!src) { console.error('--file 后面要给文件路径'); process.exit(1); }
  const raw = fs.readFileSync(src, 'utf8');
  const cookie = cleanPixivCookie(raw);
  if (!cookie) { console.error(`从 ${src} 里没读出一条可用的 cookie（空？含不可打印字符？）`); process.exit(1); }
  const cfg = readConfig();
  cfg.pixiv = { ...(cfg.pixiv ?? {}), cookie };
  const bak = writeConfig(cfg);
  wrote = cookie;
  console.log(`已写入 pixiv.cookie：${mask(cookie)}`);
  console.log(`（config.json 备份：${bak}）`);
  try { fs.unlinkSync(src); console.log(`已删除临时文件 ${src}`); } catch (e) { console.log(`临时文件删除失败（请手动删）：${e?.message}`); }
}

console.log(`\n当前配置的 cookie：${mask(configPixivCookie() || wrote)}  pixivLoggedIn=${pixivLoggedIn()}`);
if (!pixivLoggedIn()) { console.log('没配 cookie —— "按名字搜画师"会明确报不支持，其余功能不受影响。'); process.exit(0); }

console.log('\n=== 登录态自检 ===');
const st = await pixivLoginState();
console.log(`  configured=${st.configured} loggedIn=${st.loggedIn} —— ${st.evidence}`);
if (!st.loggedIn) {
  console.log('  ⇒ cookie 没生效/已过期。重新登录 pixiv 再复制一次即可（浏览器里退出登录会让旧 cookie 立刻失效）。');
  process.exit(2);
}

console.log('\n=== 按名字搜画师（真跑一次）===');
try {
  const r = await pixivSearchUsersByName(argOf('--name') || '米山舞');
  console.log(`  端点 ${r.endpoint}，共 ${r.users.length} 个候选：`);
  for (const u of r.users.slice(0, 8)) console.log(`    ${u.id.padEnd(11)} ${u.name}${u.works ? `（${u.works} 件）` : ''} ${u.pageUrl}`);
  console.log('  ⇒ 接口可用：按名字搜画师已接通。');
} catch (e) {
  console.log('  ' + String(e?.message ?? e));
  console.log('  ⇒ 登录态是好的，但用户搜索接口这条路没走通（以上是每个候选端点的原话，可直接据此换路由）。');
  process.exit(3);
}
