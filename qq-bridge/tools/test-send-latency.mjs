// 离线验证 sendMessages 的发送耗时：把 napcat.httpUrl 指向本机桩服务，测真实发送路径的耗时。
// 目的：证明「首条不等线性节拍」确实生效，且省下来的就是那段 sleep。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = 'D:\\MoonBot\\resources\\runtime\\qq-bridge';

const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
console.log('config social.send =', JSON.stringify(cfg.social.send));

const PORT = 34567;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1000 + Math.floor(Math.random() * 1000) } }));
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

process.chdir(ROOT);
const mod = await import('file:///' + path.join(ROOT, 'src/core/qq-send.js').replace(/\\/g, '/'));
const { initQqSendCore, sendMessages } = mod;
initQqSendCore({ ...cfg, napcat: { ...cfg.napcat, httpUrl: `http://127.0.0.1:${PORT}`, accessToken: '' } });

const key = 'private:999999';
const t = async (label, msgs) => {
  const t0 = Date.now();
  try { await sendMessages(key, msgs, [], null, null, []); } catch (e) { console.log('  (发送抛错:', e.message, ')'); }
  const d = Date.now() - t0;
  console.log(`${label.padEnd(34)} ${String(d).padStart(6)} ms`);
  return d;
};

// 先连发 12 次把"会话连续发送计数"顶到 cap（模拟热聊状态）
for (let i = 0; i < 12; i++) await sendMessages(key, ['warmup'], [], null, null, []);
console.log('（已连发 12 条把线性计数顶到上限）');

await t('单条发送（第 1 条）', ['你好呀']);
await t('单条发送（再一条）', ['在的']);
await t('一次两条（第 1 条应即时）', ['第一句', '第二句']);
await t('一次三条', ['a', 'b', 'c']);

server.close();
process.exit(0);
