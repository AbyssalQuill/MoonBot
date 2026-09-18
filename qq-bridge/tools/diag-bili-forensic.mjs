/* 取证：把最近 N 条消息里所有跟 bilibili / b23.tv 有关的消息挖出来，
 * 原样打印它的**全部 segment**（text / json / image …）以及 real_seq，
 * 用来判定"B 站卡"到底是 ①我们手拼的 Ark 还是 ②分享文案 + QQ 链接预览。
 *
 * 用法：node diag-bili-forensic.mjs [uid] [count]
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const uid = process.argv[2] || '1736784911';
const count = Number(process.argv[3] || 300);

const post = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  return r.json();
};

const j = await post('get_friend_msg_history', { user_id: String(uid), count });
const msgs = j?.data?.messages ?? [];
console.log(`uid=${uid} 共 ${msgs.length} 条（status=${j?.status} ${j?.message || ''}）\n`);

const fmt = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?');
const RE = /b23\.tv|bilibili|BV[0-9A-Za-z]{10}|哔哩/i;

let hit = 0;
let prevSeq = -1;
for (const m of msgs) {
  const segs = Array.isArray(m?.message) ? m.message : [];
  const flat = JSON.stringify(segs);
  const raw = String(m?.raw_message ?? '');
  if (!RE.test(flat) && !RE.test(raw)) { prevSeq = Math.max(prevSeq, Number(m?.real_seq ?? -1)); continue; }
  hit += 1;
  const seq = Number(m?.real_seq ?? -1);
  const advanced = prevSeq >= 0 ? seq > prevSeq : null;
  prevSeq = Math.max(prevSeq, seq);
  console.log('='.repeat(100));
  console.log(`msgId=${m?.message_id} 时间=${fmt(m?.time)}(UTC) sender=${m?.sender?.user_id ?? '?'}`
    + ` real_seq=${seq} seq前进=${advanced === null ? '?' : advanced}`);
  console.log(`raw_message = ${raw.slice(0, 300)}`);
  for (const s of segs) {
    if (s?.type === 'json') {
      let p = s?.data?.data ?? s?.data;
      try { p = JSON.parse(p); } catch { /* 保持字符串 */ }
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* ignore */ } }
      console.log(`--- segment type=json  app=${p?.app ?? '?'} view=${p?.view ?? '?'} ---`);
      console.log(JSON.stringify(p, null, 2));
    } else {
      console.log(`--- segment type=${s?.type} --- ${JSON.stringify(s?.data ?? {}).slice(0, 800)}`);
    }
  }
  console.log('');
}
console.log(`\n命中 ${hit} 条`);
