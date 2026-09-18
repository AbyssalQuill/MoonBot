/* 用"送达/幽灵"当读数，逐个变量找出**哪个字段让 QQ 拒收**。
 *
 * 为什么可以放心跑：**幽灵对主人是完全不可见的**（服务端没收，对方什么都看不到），
 * 所以失败的组合不产生任何打扰；真正送达的那几条才会显示出来 —— 那正好就是要的结果。
 *
 * 已知：
 *   ✅ 05:21:08 那张 tuwen 卡**送达了**，它比我的卡多了 `extra.uin` 与 `meta.news.uin`
 *      （值 3929684621，和签名服务输出里的 uin 一致），而它的 jumpUrl **不带 `&`**。
 *   ❌ 我 08:33/08:40 的四张全幽灵：没有 uin，jumpUrl 是 `i.y.qq.com/v8/playsong.html?...&...&...`。
 *
 * 本脚本一次发 4 个变体，然后回读 real_seq 判定谁真的出去了。
 *
 * 用法（cwd = /root/qq-bridge）：node probe-tuwen-variants.mjs [key]
 */
import { readFileSync } from 'node:fs';

const KEY = process.argv[2] || 'private:1736784911';
const TOKEN = process.env.NAPCAT_TOKEN || '061228';
const HTTP = process.env.NAPCAT_HTTP || 'http://127.0.0.1:3000';
const [, uid] = KEY.split(':');

const { createMediaDomain } = await import('/root/qq-bridge/src/core/media.js');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const { sendRich } = createMediaDomain(cfg);

const hex = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const PREVIEW = 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg';
const JUMP_PLAIN = 'https://y.qq.com/n/ryqq/songDetail/004Fs2FP1EvZYc';
const JUMP_AMP = 'https://i.y.qq.com/v8/playsong.html?platform=11&appshare=android_qq&appversion=20080008&hosteuin=null&songmid=004Fs2FP1EvZYc&type=0&appsongtype=1&_wv=1&source=qq&ADTAG=qfshare';

function build({ title, jumpUrl, uin }) {
  const ctime = Math.floor(Date.now() / 1000);
  const news = {
    app_type: 1, appid: 100497308, ctime, desc: '周杰伦', jumpUrl, preview: PREVIEW,
    tag: 'QQ音乐', tagIcon: 'https://p.qpic.cn/qqconnect/0/app_100497308_1626060999/100?max-age=2592000&t=0',
    title
  };
  const extra = { app_type: 1, appid: 100497308 };
  if (uin) { news.uin = uin; extra.uin = uin; }
  const card = {
    app: 'com.tencent.tuwen.lua', bizsrc: 'qqconnect.sdkshare',
    config: { ctime, forward: 1, token: hex(), type: 'normal' },
    extra, meta: { news }, prompt: `[分享]${title}`, ver: '0.0.0.0',
    view: 'news'
  };
  return { type: 'json', data: { data: JSON.stringify(card) } };
}

const variants = [
  ['V1 uin=3199924964 + jumpUrl 不带 &', { title: '测V1', jumpUrl: JUMP_PLAIN, uin: '3199924964' }],
  ['V2 uin=3929684621 + jumpUrl 不带 &', { title: '测V2', jumpUrl: JUMP_PLAIN, uin: '3929684621' }],
  ['V3 uin=3929684621 + jumpUrl 带 &', { title: '测V3', jumpUrl: JUMP_AMP, uin: '3929684621' }],
  ['V4 无 uin + jumpUrl 不带 &（对照）', { title: '测V4', jumpUrl: JUMP_PLAIN, uin: '' }]
];

const mark = Date.now();
for (const [label, opt] of variants) {
  try {
    await sendRich(KEY, build(opt), {});
    console.log('已投递：', label);
  } catch (error) {
    console.log('投递抛错：', label, error?.message ?? error);
  }
  await new Promise((r) => setTimeout(r, 2500));
}

// ── 回读判定 ────────────────────────────────────────────────────────────────
await new Promise((r) => setTimeout(r, 3000));
const r = await fetch(`${HTTP}/get_friend_msg_history`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: String(uid), count: 20 }),
  signal: AbortSignal.timeout(20000)
});
const msgs = (await r.json())?.data?.messages ?? [];
console.log('\n=== 回读结果（real_seq 是否前进）===');
let prev = -1;
for (const m of msgs) {
  if (Number(m?.time) * 1000 < mark - 15000) { prev = Math.max(prev, Number(m?.real_seq ?? -1)); continue; }
  let ark = null;
  for (const s of (Array.isArray(m?.message) ? m.message : [])) if (s?.type === 'json') ark = s?.data?.data ?? s?.data ?? null;
  if (!ark) continue;
  let p = null; try { p = JSON.parse(ark); } catch {}
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
  const seq = Number(m?.real_seq ?? -1);
  const sent = seq > prev;
  prev = Math.max(prev, seq);
  console.log(`  ${String(p?.meta?.news?.title ?? '?').padEnd(8)} real_seq=${String(seq).padStart(6)}  ${sent ? '✅ 送达' : '❌ 幽灵'}`);
}
console.log('\n注意：判定用"seq 有没有前进"，而不是把每条跟一个固定基准比 ——');
console.log('因为送达的那条会给后面所有幽灵都"垫高"基准，逐条比较才不会被带偏。');
