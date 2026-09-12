// 一次性连接测试：连接 NapCat 的 OneBot WebSocket 网关，
// 验证地址、端口、accessToken 是否正确。成功即打印 ✅ 并退出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneBotWsClient } from '../src/lib/onebot-ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, accessToken, wsAccessToken } = cfg.napcat ?? cfg.napcat ?? {};
const token = wsAccessToken || accessToken || '';

console.log(`测试连接 ${wsUrl}（token ${token ? '已配置' : '未配置'}）…`);

const bot = new OneBotWsClient({ url: wsUrl, accessToken: token, reconnect: false });
const timer = setTimeout(() => { console.error('❌ 连接超时'); try { bot.dispose(); } catch {} process.exit(1); }, 15000);
try {
  await bot.connect();
  console.log('✅ WebSocket 已连接（网关接受连接，token 正确）');
  const login = await bot.getLoginInfo();
  console.log(`✅ 登录账号：${login?.user_id}（${login?.nickname ?? ''}）`);
  console.log('连接测试通过');
} catch (e) {
  console.error('❌ 连接失败：', e?.message ?? e);
  process.exit(1);
} finally {
  clearTimeout(timer);
  bot.dispose();
}
