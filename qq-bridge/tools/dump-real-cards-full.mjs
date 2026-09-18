/* 把私聊/群里**所有 B 站小程序卡**（appid=1109937557）的 Ark 原样、**完整**打出来，
 * 并按"是不是机器人发的"分组，用于逐字段对照"真卡 vs 我们发的卡"。
 *
 * 为什么需要它：find-real-cards.mjs 把 JSON 截断到 700 字符，qqdocurl / scene 正好被切掉；
 * 而"点进去不是那条视频"这个问题的全部线索就在这几个被切掉的字段里。
 *
 * 用法：node dump-real-cards-full.mjs [private:<uid>|group:<gid> ...] [count]
 * 默认：private:1736784911 group:868756515
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = (process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BOT = String(process.env.BOT_UIN || '3199924964');

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a)) || 400);
const targets = args.filter((a) => a.includes(':'));
if (!targets.length) targets.push('private:1736784911', 'group:868756515');

const post = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  return r.json();
};

const fmt = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?');

const seen = new Set();
let real = 0;
let mine = 0;

for (const t of targets) {
  const [kind, id] = t.split(':');
  const j = kind === 'group'
    ? await post('get_group_msg_history', { group_id: String(id), count })
    : await post('get_friend_msg_history', { user_id: String(id), count });
  const msgs = j?.data?.messages ?? [];
  console.log(`\n########## ${t}：${msgs.length} 条（status=${j?.status} ${j?.message || ''}）`);
  for (const m of msgs) {
    for (const s of (Array.isArray(m?.message) ? m.message : [])) {
      if (s?.type !== 'json') continue;
      let p = s?.data?.data ?? s?.data;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch { continue; } }
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch { continue; } }
      const d1 = p?.meta?.detail_1;
      if (!d1 || String(d1.appid) !== '1109937557') continue;   // 只看 B 站卡
      const key = String(m?.message_id ?? '') + '|' + String(d1.qqdocurl ?? '');
      if (seen.has(key)) continue;
      seen.add(key);
      const sender = String(m?.sender?.user_id ?? '');
      const isBot = sender === BOT;
      if (isBot) mine += 1; else real += 1;
      console.log('─'.repeat(100));
      console.log(`${isBot ? '【机器人】' : '【真人】'} ${fmt(m?.time)}  发送者=${sender}  real_seq=${m?.real_seq}`);
      console.log(`  detail_1.scene      = ${JSON.stringify(d1.scene)}`);
      console.log(`  detail_1.qqdocurl   = ${JSON.stringify(d1.qqdocurl)}`);
      console.log(`  detail_1.url        = ${JSON.stringify(d1.url)}`);
      console.log(`  miniappShareOrigin  = ${JSON.stringify(p?.miniappShareOrigin)}   miniappOpenRefer = ${JSON.stringify(p?.miniappOpenRefer)}`);
      console.log(`  prompt              = ${JSON.stringify(p?.prompt)}`);
      // 全字段原样（不截断）：真卡/我们的卡到底差在哪，只能靠这个
      console.log('  FULL = ' + JSON.stringify(p));
    }
  }
}

console.log(`\n合计：真人卡 ${real} 张，机器人卡 ${mine} 张`);
