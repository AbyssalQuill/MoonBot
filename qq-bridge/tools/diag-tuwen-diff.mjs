/* 把"送达的 tuwen 卡"和"本地幽灵的 tuwen 卡"逐字段 diff —— 找出到底哪个字段让 QQ 拒收。
 *
 * 已知事实（用 real_seq 判定）：
 *   送达：05:21:08/05:21:20/05:21:28、07:51:40/07:52:02/07:52:53/07:53:19（都是 tuwen.lua）
 *   幽灵：05:26:00 起那批 wsrv 预览的、以及 08:33/08:40 我新拼的
 * 同样的 app/view/meta 结构，一边通一边不通 —— 差别一定在某个字段的**取值**里。
 *
 * 用法（cwd = /root/qq-bridge）：node diag-tuwen-diff.mjs
 */
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const uid = process.argv[2] || '1736784911';

const r = await fetch(`${HTTP}/get_friend_msg_history`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: String(uid), count: 200 }),
  signal: AbortSignal.timeout(25000)
});
const msgs = (await r.json())?.data?.messages ?? [];

const pick = (hms) => msgs.find((m) => {
  const t = new Date(Number(m?.time) * 1000).toISOString().replace('T', ' ').slice(11, 19);
  return t === hms;
});

const parse = (m) => {
  let ark = null;
  for (const s of (Array.isArray(m?.message) ? m.message : [])) if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
  if (!ark) return null;
  let p = null; try { p = JSON.parse(ark); } catch {}
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
  return p;
};

const good = parse(pick('05:21:08'));   // ✅ 送达
const bad = parse(pick('08:33:32'));    // ❌ 幽灵
const bad2 = parse(pick('08:40:05'));   // ❌ 幽灵
if (!good || !bad) { console.log('没找到目标消息。good=', !!good, 'bad=', !!bad); process.exit(1); }

const flatten = (o, p = '', out = {}) => {
  if (o && typeof o === 'object' && !Array.isArray(o)) { for (const k of Object.keys(o)) flatten(o[k], p ? `${p}.${k}` : k, out); }
  else out[p] = o;
  return out;
};
const A = flatten(good), B = flatten(bad), C = flatten(bad2);
const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();

console.log('字段'.padEnd(26), '✅送达(05:21:08)'.padEnd(40), '❌幽灵(08:33:32)');
console.log('-'.repeat(120));
for (const k of keys) {
  if (k === 'config.ctime' || k === 'meta.news.ctime') { console.log(k.padEnd(26), '(时间戳，跳过)'); continue; }
  const a = String(A[k] ?? '(无)');
  const b = String(B[k] ?? '(无)');
  const same = a === b;
  console.log(k.padEnd(26), a.slice(0, 38).padEnd(40), b.slice(0, 60), same ? '' : '   ← 不同');
}
console.log('\n第 2 张幽灵（08:40:05）只列与送达那张不同的字段：');
for (const k of keys) {
  const a = String(A[k] ?? '(无)'), c = String(C[k] ?? '(无)');
  if (a !== c) console.log('  ', k.padEnd(24), c.slice(0, 80));
}
