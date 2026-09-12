// 只读探针：TCP 连通性 + SSH banner（**不做任何认证尝试**，因此不可能触发 fail2ban）。
// 用途：分辨"端口/网络问题"与"凭据问题"，并看清 22 与 50470 是不是同一个 sshd。
// 用法：node tools/probe-ssh-banner.mjs [host] [port,port...]
import net from 'node:net';

const host = process.argv[2] || 'YOUR_SERVER_IP';
const ports = (process.argv[3] || '22,50470').split(',').map((x) => Number(x.trim())).filter(Boolean);

const probe = (port) => new Promise((resolve) => {
  const t0 = Date.now();
  const sock = net.connect({ host, port });
  let connectedAt = 0;
  let banner = '';
  const fin = (state) => { try { sock.destroy(); } catch { /* ignore */ } resolve({ port, state, connectMs: connectedAt ? connectedAt - t0 : 0, bannerMs: banner ? Date.now() - t0 : 0, banner }); };
  sock.setTimeout(12000);
  sock.once('connect', () => { connectedAt = Date.now(); });
  sock.on('data', (d) => { banner += d.toString('utf8'); if (!/SSH-/.test(banner) && banner.length > 0) fin('connected-but-not-ssh'); if (banner.includes('\n')) fin('ssh-banner'); if (banner.length > 200) fin('ssh-banner'); });
  sock.once('timeout', () => fin(connectedAt ? 'connected-no-banner' : 'connect-timeout'));
  sock.once('error', (e) => fin('error:' + e.code));
});

console.log(`host=${host}`);
for (const p of ports) {
  const r = await probe(p);
  console.log(`port ${String(r.port).padStart(5)}  ${r.state.padEnd(22)} TCP=${r.connectMs || '-'}ms  banner@${r.bannerMs || '-'}ms  ${r.banner.trim().slice(0, 60)}`);
}
