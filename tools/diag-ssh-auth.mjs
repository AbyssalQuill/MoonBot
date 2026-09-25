// SSH 认证诊断：用**管理器里保存的那份配置**直接连一次，把"到底卡在哪一步"问清楚。
//
// 为什么需要它：界面上只回一句 `All configured authentication methods failed`（ssh2 的原话），
// 它把"密码错 / 没带密码 / 服务器只允许密钥 / 账号被锁"全糊成同一句话，用户根本没法判断。
// 本脚本逐个变量试（原样 / 去首尾空白 / 去掉换行），并打印服务器通告的认证方式与 ssh2 的原始错误，
// **绝不打印密码本身**，只打印长度与字符类别。
//
// 用法：node tools/diag-ssh-auth.mjs [host]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ssh2';

const cfgPath = join(homedir(), '.qq-bridge-manager', 'config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
const wantHost = process.argv[2] || null;
const servers = (cfg.servers || []).filter((s) => !wantHost || s.host === wantHost);
if (!servers.length) { console.error('配置里没有匹配的服务器'); process.exit(1); }

const describe = (pw) => {
  if (pw == null) return '(未设置)';
  const s = String(pw);
  return `长度=${s.length} 首尾有空白=${s !== s.trim()} 含空格=${/\s/.test(s)} 含非ASCII=${/[^\x20-\x7E]/.test(s)} 含引号=${/['"]/.test(s)}`;
};

const tryConnect = (server, password, label, privateKey = null) => new Promise((resolve) => {
  const conn = new Client();
  const done = (r) => { try { conn.end(); } catch {} resolve(r); };
  const timer = setTimeout(() => done({ ok: false, err: '连接超时（15s）' }), 15000);
  const secrets = [password, server.passphrase].filter((x) => typeof x === 'string' && x.length >= 3);
  const mask = (m) => {
    let s = String(m);
    for (const sec of secrets) s = s.split(sec).join('***');
    return s;
  };
  const log = [];
  conn.on('ready', () => { clearTimeout(timer); done({ ok: true, log }); });
  conn.on('error', (err) => { clearTimeout(timer); done({ ok: false, err: err?.message || String(err), level: err?.level, log }); });
  conn.connect({
    host: server.host, port: server.port || 22, username: server.username,
    password,
    /* 2026-09-23 修：原来这里**没有 privateKey** —— 于是"私钥认证"那条分支实际跑的是
     * "不带任何凭据"的握手，必然回 `All configured authentication methods failed`，
     * 把一把可用的密钥报成坏的（实测同一把钥匙走 deploy.connectOne 是 READY 的）。
     * 用户照着这个结论去换密钥/改 authorized_keys，真正的部署问题反而被掩盖。 */
    privateKey: privateKey ?? undefined,
    passphrase: server.passphrase || undefined,
    tryKeyboard: true,          // 服务器用 keyboard-interactive 时，没有这个就一定失败
    readyTimeout: 10000,
    keepaliveInterval: 30000,
    debug: (m) => {
      const s = mask(m);
      // 只留认证/协商相关的行，避免噪声；密码已被遮蔽
      if (/userauth|auth|ident|banner|fail|denied|method/i.test(s)) log.push(s);
    },
  });
});

for (const s of servers) {
  console.log(`\n=== ${s.name || s.id}  ${s.username}@${s.host}:${s.port || 22} ===`);
  console.log(`authType=${s.authType}  密码 ${describe(s.password)}  私钥=${s.privateKey || '(无)'}  口令=${s.passphrase ? '有' : '(无)'}`);

  if (s.authType === 'key' && s.privateKey) {
    let key = null;
    try { key = readFileSync(s.privateKey); } catch (e) { console.log('读私钥失败: ' + e.message); }
    if (key) {
      const r = await tryConnect({ ...s, password: undefined }, undefined, 'key', key);
      console.log(`私钥认证: ${r.ok ? '成功 ✅' : '失败 ❌  ' + r.err}`);
      if (!r.ok && r.log?.length) { console.log('  —— ssh2 原始日志（已遮蔽敏感串）——'); for (const l of r.log.slice(-12)) console.log('  ' + l); }
    }
    continue;
  }

  // 默认只试一次：每次失败都是一次认证失败，服务器上的 fail2ban 很容易因此把本机 IP 封掉
  // （2026-09-12 实测：三个变体试完，几分钟后连 TCP 都超时了）。要逐个变体试，显式加 --variants。
  const variants = process.argv.includes('--variants')
    ? [
      ['原样', s.password],
      ['去掉首尾空白', String(s.password ?? '').trim()],
      ['去掉所有空白', String(s.password ?? '').replace(/\s+/g, '')],
    ]
    : [['原样（单次，避免触发 fail2ban）', s.password]];
  for (const [label, pw] of variants) {
    const r = await tryConnect({ ...s, password: pw }, pw, label);
    console.log(`密码认证（${label}）: ${r.ok ? '成功 ✅' : '失败 ❌  ' + r.err}`);
    if (process.env.SSH_DEBUG) for (const line of (r.log || []).slice(-14)) console.log('    [ssh2] ' + line.slice(0, 200));
    if (r.ok) {
      console.log(`\n>>> 结论：用「${label}」能连上。保存里的密码与可用密码不一致（多半是粘贴时带了空白/换行）。`);
      process.exit(0);
    }
  }
  console.log('\n>>> 三种变体全部失败：服务器通告的认证方式与"密码是否正确"需要你确认（本机探测：publickey,password）。');
}
process.exit(2);
