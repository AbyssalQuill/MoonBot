/* 在群里找**真人分享进来的真卡**（发送者不是机器人），把它的 Ark 原样打出来。
 *
 * 为什么需要它：手机端到底能渲染什么样的 Ark，唯一可信的参照就是"别人从 App 分享到 QQ、
 * 并且在手机上确实显示正常"的那张卡。机器人自己拼的卡都是我们写的字段，猜不出手机要什么。
 *
 * 用法：node find-real-cards.mjs <group_id> [count] [botUin]
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const gid = process.argv[2];
const count = Number(process.argv[3] || 200);
const BOT = String(process.argv[4] || '3199924964');

const post = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  return r.json();
};

const j = await post('get_group_msg_history', { group_id: String(gid), count });
const msgs = j?.data?.messages ?? [];
console.log(`群 ${gid}：拿到 ${msgs.length} 条（status=${j?.status} ${j?.message || ''}）`);

const fmt = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?');
let cards = 0;
let fromOthers = 0;

for (const m of msgs) {
  let ark = null;
  for (const s of (Array.isArray(m?.message) ? m.message : [])) {
    if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
  }
  if (!ark) continue;
  cards += 1;
  const sender = String(m?.sender?.user_id ?? '');
  if (sender === BOT) continue;   // 跳过机器人自己拼的
  fromOthers += 1;

  let parsed = null;
  try { parsed = JSON.parse(ark); } catch {}
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {} }
  const meta = parsed?.meta ? Object.values(parsed.meta)[0] : null;
  console.log('─'.repeat(96));
  console.log(`${fmt(m?.time)}  发送者=${sender}  app=${parsed?.app ?? '?'}  view=${parsed?.view ?? '?'}`);
  console.log(`  preview = ${meta?.preview ?? '(无)'}`);
  console.log(`  title   = ${meta?.title ?? meta?.desc ?? '(无)'}   tag=${meta?.tag ?? '-'}`);
  console.log('  ' + JSON.stringify(parsed).slice(0, 700));
}

console.log(`\n合计：卡片 ${cards} 张，其中 **非机器人** 发的 ${fromOthers} 张`);
