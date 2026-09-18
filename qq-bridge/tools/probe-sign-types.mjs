/* 问 NapCat 的音乐签名服务：**不同的 type 分别签出什么版式**。
 *
 * 背景：真机分享的卡是 `com.tencent.tuwen.lua` + `view=news`（主人实测能显示、能送达），
 * 而我们手写的那种卡用随机 token，QQ 服务端很可能直接**拒收**（本地库写了、对方收不到）。
 * 签名服务签出来的卡是能送达的 —— 所以正确的做法是**让签名服务去签 news 版式**，
 * 而不是自己去拼 Ark。这个脚本就是去试它认哪些 type。
 *
 * 用法（cwd = /root/qq-bridge）：node probe-sign-types.mjs
 */
const SIGN = process.env.QQBRIDGE_MUSIC_SIGN || 'http://106.55.0.102:10087/';

/* 用真卡的字段填（封面用腾讯/网易云的公开图，歌词、歌手都有），只改 type 看输出。 */
const base = {
  url: 'https://i.y.qq.com/v8/playsong.html?platform=11&appshare=android_qq&appversion=20080008&hosteuin=null&songmid=004Fs2FP1EvZYc&type=0&appsongtype=1&_wv=1&source=qq&ADTAG=qfshare',
  audio: 'https://isure6.stream.qqmusic.qq.com/C600002DMfDx1macLz.m4a',
  title: '晴天',
  singer: '周杰伦',
  image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg',
  content: 'QQ音乐'
};

const types = ['custom', 'qq', '163', 'news', 'tuwen', 'music', 'share', ''];

for (const t of types) {
  const body = t ? { type: t, ...base } : { ...base };
  let out;
  try {
    const res = await fetch(SIGN, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000)
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch {} }
    if (!j) { out = `HTTP ${res.status} 非 JSON：${text.slice(0, 100)}`; }
    else {
      const news = j?.meta?.news;
      out = `app=${j.app} view=${j.view} bizsrc=${j.bizsrc}`
        + (news ? `  news.title=${news.title} preview=${String(news.preview).slice(0, 60)}` : '')
        + (j?.meta?.music ? `  music.preview=${String(j.meta.music.preview ?? '').slice(0, 60)}` : '');
    }
  } catch (error) {
    out = `ERR ${error?.message ?? error}`;
  }
  console.log(String(JSON.stringify(t || '(无 type)')).padEnd(12), '→', out);
}
