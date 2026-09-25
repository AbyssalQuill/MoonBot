// 试一把本机已有的 SSH 私钥能不能登上这台服务器（只读探测，不改任何东西）。
// 动机：用户报"密码认证：All configured authentication methods failed"，而服务器通告的是 publickey,password。
// 如果他平时是用密钥登录的（很常见，尤其是 root 密码被锁的机器 —— 那种情况下 sshd 照样列出 password，
// 但任何密码都必然被拒），那正确解法不是猜密码，而是把管理器也切到密钥认证。
// 本脚本把 ~/.ssh 下所有私钥都试一遍，只打印"哪把能用"，不打印任何密钥内容。
//
// 用法：node tools/diag-ssh-keys.mjs [host] [user] [port]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ssh2';

const host = process.argv[2] || 'YOUR_SERVER_IP';
const user = process.argv[3] || 'root';
const port = Number(process.argv[4]) || 22;

const sshDir = join(homedir(), '.ssh');
if (!existsSync(sshDir)) { console.log('没有 ~/.ssh 目录'); process.exit(2); }
const cands = readdirSync(sshDir).filter((f) => !/\.(pub|ppk|old|bak)$/i.test(f) && !/^(known_hosts|config|authorized_keys)/i.test(f));

const tryKey = (file, passphrase) => new Promise((resolve) => {
  let key;
  try { key = readFileSync(join(sshDir, file)); } catch { return resolve({ ok: false, err: '读不到文件' }); }
  const conn = new Client();
  const done = (r) => { try { conn.end(); } catch { /* ignore */ } resolve(r); };
  const timer = setTimeout(() => done({ ok: false, err: '超时' }), 15000);
  conn.on('ready', () => { clearTimeout(timer); done({ ok: true }); });
  conn.on('error', (e) => { clearTimeout(timer); done({ ok: false, err: e?.message || String(e) }); });
  const opts = { host, port, username: user, privateKey: key, readyTimeout: 10000 };
  if (passphrase) opts.passphrase = passphrase;
  try { conn.connect(opts); } catch (e) { clearTimeout(timer); done({ ok: false, err: e.message }); }
});

console.log(`目标 ${user}@${host}:${port}；~/.ssh 下候选私钥 ${cands.length} 个\n`);
let winner = null;
for (const f of cands) {
  const r = await tryKey(f);
  console.log(`${r.ok ? '可用 ✅' : '不可用 ❌'}  ${f}${r.ok ? '' : '  ' + r.err}`);
  if (r.ok && !winner) winner = join(sshDir, f);
}
if (winner) {
  console.log(`\n>>> 结论：这把私钥能直接登录 —— 在管理器里把该服务器的认证方式改成「密钥」，私钥路径填：\n    ${winner}`);
  process.exit(0);
}
console.log('\n>>> 本机现有私钥都登不上。要么服务器 authorized_keys 里没有这些公钥，要么需要带口令的私钥。');
process.exit(1);
