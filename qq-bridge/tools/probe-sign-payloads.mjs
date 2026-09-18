/* 签名服务到底什么条件下签出 `tuwen.lua`（news 版式）而不是 `music.lua`？
 *
 * 已知：05:21:08 那张 **tuwen 卡是真送达的**，而它的 token 有效 ——
 * 手写 Ark（随机 token）无论怎么改字段都是"本地幽灵"（V1~V4 实测全灭）。
 * 所以拿到**签名服务签的 tuwen** 才是正路；而它刚才只肯签 music.lua。
 *
 * 我的上一次探测 payload 里带了 `audio`/`singer`/`content`（音乐味很足）——
 * 猜测签名服务是**看 payload 长什么样**来决定版式的。这里按不同字段组合逐个试。
 *
 * 用法（cwd = /root/qq-bridge）：node probe-sign-payloads.mjs
 */
const SIGN = process.env.QQBRIDGE_MUSIC_SIGN || 'http://106.55.0.102:10087/';

const cases = [
  ['带 audio + singer（= 音乐卡路径）', { type: 'custom', url: 'https://y.qq.com/n/ryqq/songDetail/004Fs2FP1EvZYc', audio: 'https://isure6.stream.qqmusic.qq.com/C600002DMfDx1macLz.m4a', title: '晴天', singer: '周杰伦', image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg', content: 'QQ音乐' }],
  ['去掉 audio', { type: 'custom', url: 'https://y.qq.com/n/ryqq/songDetail/004Fs2FP1EvZYc', title: '晴天', singer: '周杰伦', image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg', content: 'QQ音乐' }],
  ['去掉 audio，desc 代替 singer', { type: 'custom', url: 'https://y.qq.com/n/ryqq/songDetail/004Fs2FP1EvZYc', title: '晴天', desc: '周杰伦', image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg' }],
  ['只给 url+title+image', { type: 'custom', url: 'https://y.qq.com/n/ryqq/songDetail/004Fs2FP1EvZYc', title: '晴天', image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg' }],
  ['audio 给空串', { type: 'custom', url: 'https://y.qq.com/n/ryqq/songDetail/004Fs2FP1EvZYc', audio: '', title: '晴天', singer: '周杰伦', image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg' }],
  ['type=news + 无 audio', { type: 'news', url: 'https://y.qq.com/n/ryqq/songDetail/004Fs2FP1EvZYc', title: '晴天', desc: '周杰伦', image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg' }],
  ['type=custom, url 用手机播放页(带&)', { type: 'custom', url: 'https://i.y.qq.com/v8/playsong.html?platform=11&appshare=android_qq&appversion=20080008&hosteuin=null&songmid=004Fs2FP1EvZYc&type=0&appsongtype=1&_wv=1&source=qq&ADTAG=qfshare', title: '晴天', singer: '周杰伦', image: 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg' }]
];

for (const [label, body] of cases) {
  try {
    const res = await fetch(SIGN, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000)
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch {} }
    if (!j) { console.log(label.padEnd(42), '→ 非 JSON:', text.slice(0, 90)); continue; }
    const m = j?.meta?.news ?? j?.meta?.music ?? {};
    console.log(
      label.padEnd(42),
      `→ app=${j.app} view=${j.view} bizsrc=${j.bizsrc}`,
      ` preview=${String(m.preview ?? '').slice(0, 50)}`,
      ` token=${String(j?.config?.token ?? '').slice(0, 10)}…`
    );
  } catch (error) {
    console.log(label.padEnd(42), '→ ERR', error?.message ?? error);
  }
}
