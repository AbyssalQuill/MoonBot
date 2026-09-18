/* 把指定的几条消息的 **完整 Ark JSON** 原样打出来，用于逐字段比对
 * "手机上能显示封面的卡" 与 "不能显示的卡" 到底差在哪。
 *
 * 用法：node dump-ark-raw.mjs <msgId> [msgId...]
 *      （对端 QQ 号用 CHAT_UID 覆盖，默认 1736784911）
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const UID = process.env.CHAT_UID || '1736784911';
const want = new Set(process.argv.slice(2).map(String));

const post = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  return r.json();
};

const j = await post('get_friend_msg_history', { user_id: String(UID), count: 200 });
const msgs = j?.data?.messages ?? [];
console.log(`私聊 uid=${UID}，共 ${msgs.length} 条，要找 ${want.size} 条\n`);

for (const m of msgs) {
  if (!want.has(String(m?.message_id))) continue;
  const t = m?.time ? new Date(Number(m.time) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?';
  let ark = null;
  for (const s of (Array.isArray(m?.message) ? m.message : [])) {
    if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
  }
  console.log('='.repeat(100));
  console.log(`msgId=${m?.message_id}  时间=${t} (UTC)  sender=${m?.sender?.user_id ?? '?'}`);
  if (!ark) { console.log('（不是 json 卡片）'); continue; }
  let parsed = null;
  try { parsed = JSON.parse(ark); } catch {}
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {} }
  console.log(JSON.stringify(parsed ?? ark, null, 2));
  console.log('');
}
