// 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。
// 用法：node scripts/send-test-group.mjs <群名关键词> [消息内容]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneBotWsClient, qqTextSeg } from '../src/lib/onebot-ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const { wsUrl, accessToken, wsAccessToken } = cfg.napcat ?? cfg.napcat ?? {};
const token = wsAccessToken || accessToken || '';

const keyword = process.argv[2] ?? '机器人测试';
const message = process.argv[3] ?? '【桥接测试】我是 DSH agent，通过 NapCat 桥接接入本群。收到请回复～';

const bot = new OneBotWsClient({ url: wsUrl, accessToken: token, reconnect: false });
const timer = setTimeout(() => { console.error('❌ 连接超时'); try { bot.dispose(); } catch {} process.exit(1); }, 15000);
try {
  await bot.connect();
  console.log('✅ 已连接 NapCat 网关');
  const groups = await bot.api('get_group_list', {});
  const list = Array.isArray(groups) ? groups : (groups?.data ?? []);
  console.log(`共 ${list.length} 个群：`, list.map((g) => `${g.group_id}(${g.group_name})`).join('、'));
  const target = list.find((g) => String(g.group_name ?? '').includes(keyword));
  if (!target) { console.error(`❌ 未找到群名包含「${keyword}」的群`); process.exit(1); }
  const sent = await bot.sendGroupMessage(target.group_id, qqTextSeg(message));
  console.log(`✅ 已发送到 ${target.group_id}(${target.group_name})，message_id=${sent?.message_id ?? sent}`);
} catch (e) {
  console.error('❌ 发送失败：', e?.message ?? e);
  process.exit(1);
} finally {
  clearTimeout(timer);
  bot.dispose();
}
