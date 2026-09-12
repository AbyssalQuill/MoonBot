// 查询 NapCat（OneBot）网关与 QQ 会话状态：HTTP API + WebSocket。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneBotWsClient } from '../src/lib/onebot-ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, httpUrl, accessToken, wsAccessToken } = cfg.napcat ?? cfg.napcat ?? {};
const token = wsAccessToken || accessToken || '';
const baseHttp = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');

console.log('配置:');
console.log(`  wsUrl   = ${wsUrl}`);
console.log(`  httpUrl = ${baseHttp}`);
console.log(`  token   = ${token ? '已配置' : '未配置'}`);

// 1) HTTP API 检查（MCP 工具走这里，426 是最常见问题）
try {
  const res = await fetch(`${baseHttp}/get_login_info`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000)
  });
  if (res.status === 426) {
    console.error('\n❌ HTTP 426: httpUrl 指向了 WebSocket 端口。');
    console.error(`   当前 httpUrl = ${baseHttp}`);
    console.error('   请改为 OneBot HTTP API 端口（默认 http://127.0.0.1:3000），不要填 WebSocket 端口（默认 3001）。');
    process.exit(1);
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.status === 'ok') {
    console.log(`✅ HTTP API 正常：登录账号 ${body.data?.user_id}（${body.data?.nickname ?? ''}）`);
  } else {
    console.error(`❌ HTTP API 异常：${res.status} ${body?.wording ?? body?.message ?? ''}`);
  }
} catch (e) {
  console.error('❌ HTTP API 请求失败：', e?.message ?? e);
}

// 2) WebSocket 连接与版本检查
const bot = new OneBotWsClient({ url: wsUrl, accessToken: token, reconnect: false });
const timer = setTimeout(() => { console.error('❌ WebSocket 连接超时'); try { bot.dispose(); } catch {} process.exit(1); }, 12000);
try {
  await bot.connect();
  console.log('✅ WebSocket 已连接');
  const ver = await bot.api('get_version', {});
  console.log(`✅ 网关版本：${JSON.stringify(ver)}`);
  const groups = await bot.api('get_group_list', {});
  const list = Array.isArray(groups) ? groups : (groups?.data ?? []);
  console.log(`✅ 群列表 ${list.length} 个：${list.slice(0, 5).map((g) => `${g.group_id}(${g.group_name})`).join('、')}${list.length > 5 ? '…' : ''}`);
} catch (e) {
  console.error('❌ WebSocket 检查失败：', e?.message ?? e);
} finally {
  clearTimeout(timer);
  bot.dispose();
}
