/* 把最近 N 条里"机器人发的卡"逐条标出来：seq 涨了（真送达）还是没涨（本地幽灵）。
 * 目的：确认"手写 Ark（随机 token）"是不是**从来没送达过** —— 包括位置卡。
 *
 * 用法（cwd = /root/qq-bridge）：node diag-seq-history.mjs [uid] [count]
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const uid = process.argv[2] || '1736784911';
const count = Number(process.argv[3] || 200);

const r = await fetch(`${HTTP}/get_friend_msg_history`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: String(uid), count }),
  signal: AbortSignal.timeout(25000)
});
const j = await r.json();
const msgs = j?.data?.messages ?? [];
const fmt = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(5, 19) : '?');

let prevSeq = -1;
let okCount = 0, ghostCount = 0;
console.log(`共 ${msgs.length} 条。只列机器人发的卡片，并标注 seq 有没有前进。\n`);
console.log('时间              app                          封面域名            seq      判定');
console.log('-'.repeat(96));
for (const m of msgs) {
  const segs = Array.isArray(m?.message) ? m.message : [];
  const isBot = String(m?.sender?.user_id ?? '') === '3199924964';
  const seq = Number(m?.real_seq ?? -1);
  const advanced = prevSeq >= 0 ? seq > prevSeq : null;
  prevSeq = Math.max(prevSeq, seq);
  if (!isBot) continue;
  let ark = null;
  for (const s of segs) if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
  if (!ark) continue;
  let p = null; try { p = JSON.parse(ark); } catch {}
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
  const news = p?.meta?.news ?? p?.meta?.music ?? {};
  const host = String(news.preview ?? '').match(/^https?:\/\/([^/]+)\//);
  const verdict = advanced === null ? '?' : advanced ? '✅ 送达' : '❌ 本地幽灵';
  if (advanced) okCount += 1; else if (advanced === false) ghostCount += 1;
  console.log(
    `${fmt(m?.time)}  ${String(p?.app ?? '?').padEnd(28)} ${String(host ? host[1] : '-').padEnd(18)} `
    + `${String(seq).padStart(7)}  ${verdict}`
  );
}
console.log(`\n机器人卡片合计：送达 ${okCount} 条，本地幽灵 ${ghostCount} 条`);
console.log('（位置卡也是手写 tuwen —— 它如果也全是"本地幽灵"，说明手写这条路从来没通过）');
