/* 直接看消息本身的发送状态（`sendStatus` / `sendStatusExtInfo`），
 * 判断"到底发出去了没有" —— 这比 OneBot 回执和本地库都可信。
 *
 * 为什么要它：私聊里什么都没有，但 NapCat 的本地库里有这些卡片。
 * 本地库写了 ≠ 送达：QQ 客户端会先把消息落本地（乐观写入），服务端拒收时本地仍留记录。
 * QQ 自己的 RawMessage 里带 `sendStatus`（实测：2 = 已发送成功；其它值是失败/发送中），
 * 拿它跟真机手动分享进来的卡（一定送达）对照，就能一眼看出我们的卡是不是被拒了。
 *
 * 用法（cwd = /root/qq-bridge）：node diag-send-status.mjs [uid] [count]
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const uid = process.argv[2] || '1736784911';
const count = Number(process.argv[3] || 16);

/* NapCat 的 OneBot 历史接口不返回 sendStatus，所以走原生 NT 接口取原始消息。 */
const post = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  return r.json();
};

const j = await post('get_friend_msg_history', { user_id: String(uid), count });
const msgs = j?.data?.messages ?? [];
console.log(`私聊 uid=${uid}，${msgs.length} 条；逐条看发送状态\n`);

const fmt = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(11, 19) : '?');

for (const m of msgs) {
  const segs = Array.isArray(m?.message) ? m.message : [];
  const kinds = segs.map((s) => s?.type).join('+');
  let ark = null;
  for (const s of segs) if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
  let parsed = null; try { parsed = JSON.parse(ark); } catch {}
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {} }
  const who = String(m?.sender?.user_id ?? '?');
  const mine = who === '3199924964';
  console.log(
    `${fmt(m?.time)}  ${mine ? '机器人发' : '主人发 '}  ${String(kinds).padEnd(10)}`
    + `  sendStatus=${m?.send_status ?? m?.sendStatus ?? '(字段没有)'}`
    + (parsed ? `  app=${parsed.app}` : '')
    + (parsed?.meta?.news ? `  news.title=${parsed.meta.news.title}` : '')
    + (parsed?.meta?.music ? `  music.title=${parsed.meta.music.title}` : '')
    + (ark === null && segs.some((s) => s?.type === 'text') ? `  文本=${segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('').slice(0, 40)}` : '')
  );
}

console.log('\n（sendStatus 字段在这个接口里可能不返回；若全是"字段没有"，就看下面的原始 JSON 抽样）');
const sample = msgs.slice(-3).map((m) => JSON.stringify(m).slice(0, 400));
console.log('\n最后 3 条原始 JSON 片段：');
for (const s of sample) console.log('  ' + s);
