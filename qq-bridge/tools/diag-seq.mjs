/* 对比"机器人发的卡"与"主人真机分享的卡"的 seq —— 判断我们的卡到底有没有被服务端收下。
 *
 * 依据：QQ 的每条消息在会话里有**递增的 seq**（`message_seq` / `real_seq`）。
 * 客户端"乐观写入本地库"的消息拿不到服务端分配的新 seq；真送达的会拿到递增的 seq。
 * 所以：**如果机器人发的卡 seq 一直卡在同一个值不动、而主人的卡在涨，就说明我们的卡没送达。**
 *
 * 用法（cwd = /root/qq-bridge）：node diag-seq.mjs [uid] [count]
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const uid = process.argv[2] || '1736784911';
const count = Number(process.argv[3] || 20);

const r = await fetch(`${HTTP}/get_friend_msg_history`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: String(uid), count }),
  signal: AbortSignal.timeout(20000)
});
const j = await r.json();
const msgs = j?.data?.messages ?? [];
const fmt = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(11, 19) : '?');

console.log('时间    谁      类型     message_seq   real_seq    real_id       类型');
console.log('-'.repeat(88));
for (const m of msgs) {
  const segs = Array.isArray(m?.message) ? m.message : [];
  const isJson = segs.some((s) => s?.type === 'json');
  const isImg = segs.some((s) => s?.type === 'image');
  const isRec = segs.some((s) => s?.type === 'record');
  const kind = isJson ? '卡片' : isImg ? '图片' : isRec ? '语音' : '文本';
  const who = String(m?.sender?.user_id ?? '') === '3199924964' ? '机器人' : '主人 ';
  console.log(
    `${fmt(m?.time)}  ${who}  ${kind}  `
    + `${String(m?.message_seq ?? '?').padStart(10)}  ${String(m?.real_seq ?? '?').padStart(9)}  `
    + `${String(m?.real_id ?? '?').padStart(12)}`
  );
}
console.log('\n看点：机器人发的卡如果 real_seq 全是同一个值，而主人的在递增 → 我们的卡没被服务端收下。');
