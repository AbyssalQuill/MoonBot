/* 实发验证：**真的发一条 B 站视频到私聊**，再从 NapCat 消息记录里把这条捞回来，
 * 判定它到底是「com.tencent.miniapp_01 原生小程序卡」还是「纯文本链接」。
 *
 * 为什么必须发真的：函数级自检 `verify-video-card-target.mjs` 会**自己编一个封面**
 * （`cover: picked.cover || 'https://i0.hdslb.com/bfs/archive/0d3b…jpg'`），
 * 于是它永远走不到"风控拿不到封面"那条真实的失败路径 —— 自检全绿而线上发出去的是链接，
 * 断点就在这。唯一可信的判据是**发出去、再回读**。
 *
 * 调用的这条链与 `src/core/console-server.js` 里 `type === 'video'` 那段**逐句对齐**：
 *   resolveVideo → buildVideoCard → fetchMiniAppArk（有 Ark 就用 Ark 当 seg；
 *   没有 Ark 但有封面就发封面图；都没有就 seg=null）→ sendMusicCardWithFallback 降级梯子。
 *
 * 用法（cwd = /root/qq-bridge）：
 *   node tools/send-verify-video-card.mjs [url] [key]
 * 默认 https://b23.tv/BV13Xb56NEEZ → private:1736784911
 */
import { readFileSync } from 'node:fs';

const VURL = process.argv[2] || 'https://b23.tv/BV13Xb56NEEZ';
const KEY = process.argv[3] || 'private:1736784911';
const [, uid] = KEY.split(':');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const HTTP = String(cfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = String(cfg.napcat?.accessToken || '');

const { resolveVideo, buildVideoCard, fetchMiniAppArk } = await import('/root/qq-bridge/src/core/video.js');
const { createMediaDomain, sendMusicCardWithFallback } = await import('/root/qq-bridge/src/core/media.js');
const { sendRich } = createMediaDomain(cfg);

const napcatPost = async (ep, body) => {
  const r = await fetch(`${HTTP}/${ep}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return r.json();
};

/** 当前已送达水位（回读里最大的 real_seq） */
const seqBefore = await (async () => {
  const j = await napcatPost('get_friend_msg_history', { user_id: String(uid), count: 5 });
  return Math.max(-1, ...(j?.data?.messages ?? []).map((m) => Number(m?.real_seq ?? -1)));
})();
console.log(`发送前 real_seq 水位 = ${seqBefore}`);

console.log('\n========== 1) resolveVideo ==========');
const info = await resolveVideo(VURL);
/* 设 VIDEO_FORCE_NO_COVER=1 就**故意把封面抹掉**，用来验证"风控拿不到封面时"的兜底：
 * 修好 wbi/view 之后封面正常了，这条真实失败路径平时跑不出来，只能这样人为复现。 */
if (process.env.VIDEO_FORCE_NO_COVER === '1') {
  info.cover = '';
  console.log('（已按 VIDEO_FORCE_NO_COVER=1 抹掉封面，模拟 bilibili 风控）');
}
console.log(`title=${JSON.stringify(info?.title)}  author=${JSON.stringify(info?.author)}`);
console.log(`cover=${info?.cover ? info.cover : '【空！】'}  source=${info?.source}  duration=${info?.durationText} play=${info?.playText}`);

console.log('\n========== 2) buildVideoCard ==========');
const plan = buildVideoCard(info, { url: String(info?.url || VURL) });
console.log(`style=${plan.style}  primary=${plan.primary ? '有' : 'null'}  note=${plan.note}`);

console.log('\n========== 3) fetchMiniAppArk（与 console-server 同一处调用）==========');
const ark = await fetchMiniAppArk(info, { httpUrl: HTTP, token: TOKEN });
let seg = null;
if (ark) {
  plan.primary = ark;
  plan.style = 'miniapp';
  seg = ark;
  const s = JSON.parse(ark.data.data);
  console.log(`拿到 Ark：app=${s.app} view=${s.view} qqdocurl=${s.meta?.detail_1?.qqdocurl ?? '(无)'} token=${s.config?.token ? '非空' : '空'}`);
} else if (plan.style === 'share' && info?.cover) {
  seg = { type: 'image', data: { file: info.cover } };
  plan.coverSent = true;
  console.log('没有 Ark，但有封面 → 退化成先发封面图');
} else {
  console.log('没有 Ark，也没有封面 → seg=null，梯子会直接发分享链接文本');
}
console.log(`本次实际要发的 seg = ${seg ? seg.type : 'null（走 link 档）'}`);

console.log('\n========== 4) 真发 ==========');
const ladder = await sendMusicCardWithFallback({
  key: KEY,
  plan,
  seg,
  options: {},
  sendRichFn: sendRich,
  sendText: async (text) => {
    const r = await napcatPost('send_private_msg', { user_id: Number(uid), message: [{ type: 'text', data: { text } }] });
    return { messageId: r?.data?.message_id ?? null };
  },
});
console.log(`发送结果：card=${ladder.card} messageId=${ladder.messageId}${ladder.degradedFrom ? ' 降级原因=' + (ladder.degradedFrom?.message ?? ladder.degradedFrom) : ''}`);

console.log('\n========== 5) 回读刚发出去的那条 ==========');
await new Promise((r) => setTimeout(r, 3000));
const j = await napcatPost('get_friend_msg_history', { user_id: String(uid), count: 6 });
const msgs = (j?.data?.messages ?? []).slice().sort((a, b) => Number(a.time) - Number(b.time));
const newest = msgs[msgs.length - 1];
if (!newest) { console.log('❌ 回读不到任何消息'); process.exit(1); }
const fmt = (t) => new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19);
const seq = Number(newest.real_seq ?? -1);
console.log(`msgId=${newest.message_id} 时间=${fmt(newest.time)}(UTC) sender=${newest?.sender?.user_id ?? '?'}`
  + ` real_seq=${seq} 前进=${seq > seqBefore ? '是（真送达）' : '否（本地幽灵）'}`);
console.log(`raw_message = ${String(newest?.raw_message ?? '').slice(0, 400)}`);
let cardApp = null;
for (const s of (Array.isArray(newest?.message) ? newest.message : [])) {
  if (s?.type === 'json') {
    let p = s?.data?.data ?? s?.data;
    try { p = JSON.parse(p); } catch { /* 保持 */ }
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* ignore */ } }
    cardApp = p?.app ?? null;
    console.log(`--- segment type=json  app=${cardApp} view=${p?.view}`);
    console.log(`    detail_1.url      = ${p?.meta?.detail_1?.url ?? '(无)'}`);
    console.log(`    detail_1.preview  = ${String(p?.meta?.detail_1?.preview ?? '(无)').slice(0, 100)}`);
    console.log(`    detail_1.qqdocurl = ${p?.meta?.detail_1?.qqdocurl ?? '(无)'}`);
    console.log(`    detail_1.desc     = ${p?.meta?.detail_1?.desc ?? '(无)'}`);
    console.log(`    config.token      = ${p?.config?.token ? '非空' : '【空】'}`);
  } else {
    console.log(`--- segment type=${s?.type} ${JSON.stringify(s?.data ?? {}).slice(0, 300)}`);
  }
}
console.log(`\n结论：${cardApp === 'com.tencent.miniapp_01' ? '✅ 是原生小程序卡片' : '❌ 不是卡片（' + (cardApp || '只有文本段') + '）'}`);
