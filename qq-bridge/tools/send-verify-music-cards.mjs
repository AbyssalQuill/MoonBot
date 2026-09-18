/* 发两张音乐卡 + **立刻回读消息记录确认真的落库**（不是只看发送回执）。
 *
 * 为什么要回读：OneBot 的发送回执经常是 `EventChecker Failed`（事件确认失败但消息其实已发出），
 * 桥按"已送达"处理；反过来也可能出现"回执看着成功、消息没进记录"。唯一可信的判据是去
 * NapCat 的消息记录里把这条捞出来 —— 顺带能看到它最终存的 Ark 长什么样。
 *
 * 用法（cwd = /root/qq-bridge）：node send-verify-music-cards.mjs [key]
 */
import { readFileSync } from 'node:fs';

const KEY = process.argv[2] || 'private:1736784911';
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const [, uid] = KEY.split(':');

const { createMediaDomain } = await import('/root/qq-bridge/src/core/media.js');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const { buildMusicCard, musicSearch, sendRich } = createMediaDomain(cfg);

const jobs = [
  ['qq', '晴天 周杰伦', '004Fs2FP1EvZYc'],
  ['163', '愿与愁 林俊杰', '2041026502']
];

const post = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  return r.json();
};

const sentOk = [];
for (const [platform, keyword, fallbackId] of jobs) {
  console.log('='.repeat(78));
  const found = await musicSearch(keyword, platform === '163' ? 'netease' : 'qqmusic', 3);
  const hit = found?.results?.[0] ?? null;
  const plan = await buildMusicCard(platform, hit?.id || fallbackId, hit ? { title: hit.title, artist: hit.artist } : {});
  const ark = plan?.primary?.type === 'json' ? JSON.parse(plan.primary.data.data) : null;
  console.log(`${platform} 《${plan?.title ?? keyword}》  形状=${ark ? ark.app + ' view=' + ark.view : plan?.primary?.type}`);
  if (!plan?.primary) { console.log('  ❌ 没有卡片段'); continue; }
  try {
    const sent = await sendRich(KEY, plan.primary, {});
    console.log('  发送回执 messageId =', sent?.messageId ?? '(无)');
    sentOk.push({ platform, title: plan.title, preview: ark?.meta?.news?.preview });
  } catch (error) {
    console.log('  ❌ 发送抛错：', error?.message ?? error);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

// ── 回读：把最近 6 条里属于刚刚这两张的挑出来 ───────────────────────────────
console.log('\n=== 回读消息记录（确认真的落库）===');
const j = await post('get_friend_msg_history', { user_id: String(uid), count: 8 });
const msgs = j?.data?.messages ?? [];
const now = Math.floor(Date.now() / 1000);
for (const m of msgs) {
  if (Number(m?.time) < now - 300) continue;   // 只看最近 5 分钟
  let ark = null;
  for (const s of (Array.isArray(m?.message) ? m.message : [])) if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
  const t = new Date(Number(m.time) * 1000).toISOString().replace('T', ' ').slice(11, 19);
  if (!ark) {
    const txt = (Array.isArray(m?.message) ? m.message : []).filter((s) => s?.type === 'text').map((s) => s.data.text).join('');
    console.log(`  ${t}  文本: ${txt.slice(0, 60)}`);
    continue;
  }
  let p = null; try { p = JSON.parse(ark); } catch {}
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
  console.log(`  ${t}  ★卡片 app=${p?.app} title=${p?.meta?.news?.title ?? '?'} preview=${String(p?.meta?.news?.preview ?? '').slice(0, 80)}`);
}
console.log('\n结论：上面若能看到刚发的两首（QQ音乐《晴天》/ 网易云《愿与愁》）就是真落库了。');
