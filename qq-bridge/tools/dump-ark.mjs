/* 把真正发出去的音乐卡从 NapCat 的消息记录里挖出来，打印它**原样的 Ark JSON**。
 * 手机端渲染封面只认 Ark 里的 `preview`，所以要判断"手机上为什么没图"，
 * 唯一可信的证据就是这条消息里实际存着的那个 URL（而不是我们以为发出去的那个）。
 *
 * 用法：node dump-ark.mjs [QQ号] [条数]
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const uid = process.argv[2] || '1736784911';
const count = Number(process.argv[3] || 40);

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
const msgs = j?.data?.messages ?? j?.data?.message ?? [];
console.log(`拿到 ${msgs.length} 条私聊消息（status=${j?.status} ${j?.message || ''}）\n`);

const fmt = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?');

for (const m of msgs) {
  const segs = Array.isArray(m?.message) ? m.message : [];
  const texts = [];
  let ark = null;
  for (const s of segs) {
    if (s?.type === 'text') texts.push(String(s?.data?.text ?? ''));
    if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
    if (s?.type === 'image') texts.push(`[图 ${String(s?.data?.file ?? '').slice(0, 60)}]`);
  }
  const preview = m?.raw_message ?? '';
  const isCard = ark && /music|miniapp|tuwen/i.test(String(ark));
  const line = texts.join('').replace(/\s+/g, ' ').slice(0, 90);
  if (!isCard) {
    console.log(`${fmt(m?.time)} msgId=${m?.message_id} 文本: ${line || String(preview).slice(0, 80)}`);
    continue;
  }
  let parsed = null;
  try { parsed = JSON.parse(ark); } catch { /* 保持字符串 */ }
  const flat = JSON.stringify(parsed ?? ark);
  const urls = [...new Set([...flat.matchAll(/https?:\\?\/\\?\/[^"',\s\\]+/g)].map((x) => x[0].replace(/\\\//g, '/')))];
  const prev = parsed?.meta && Object.values(parsed.meta)[0]?.preview;
  console.log(`${fmt(m?.time)} msgId=${m?.message_id} ★卡片 app=${parsed?.app ?? '?'}`);
  console.log(`           文本: ${line}`);
  console.log(`           preview = ${prev ?? '(无 preview 字段)'}`);
  console.log(`           卡里的 URL：`);
  for (const u of urls.slice(0, 8)) console.log(`              ${u.slice(0, 140)}`);
  console.log('');
}
