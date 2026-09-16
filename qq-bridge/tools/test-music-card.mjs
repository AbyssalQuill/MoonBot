#!/usr/bin/env node
/**
 * 音乐卡片自检（手机端封面空白那条线）——纯命令行，不需要桥接/DSH 在跑。
 *
 * 做什么：
 *   1) 用**真实代码**（src/core/media.js 的 buildMusicCard / musicResolve / musicSearch）离线打印
 *      "最终发给 NapCat 的 music 段"（含封面 URL），也就是修复后的卡片结构；
 *   2) 对打印出来的封面 URL 发**真实 https 请求**，验证可达性（状态码 + content-type + 字节数）；
 *   3) 对照老路径（把 id 直接丢给签名服务）返回的封面，量出修复前后的封面体积差（手机端白框的根因证据）；
 *   4) 顺带验证音乐搜索返回的封面不再是"歌手默认头像"占位图。
 *
 * 用法：node tools/test-music-card.mjs
 * 说明：只做只读网络请求，不发送任何 QQ 消息，不打印任何令牌。
 */
import {
  createMediaDomain,
  normalizeCoverUrl,
  normalizeMediaUrl,
  sendMusicCardWithFallback
} from '../src/core/media.js';

// 现场线上真实发过的三个 id（来源：D:\MoonBot\resources\runtime\qq-bridge\state\tool-calls.jsonl
// 今天 11:53 / 11:58 / 12:00 三次 qq_send_rich，模型只传了 {type:music, musicType:163, musicId}）
const LIVE_IDS = ['1893321422', '3381504830', '3386967464'];
const SIGN_URL = 'https://ss.xingzhige.com/music_card/card';   // NapCat musicSignUrl 为空时的默认签名服务

const media = createMediaDomain({});
let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); } else { fail += 1; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
}
function line(t = '') { console.log(t); }

console.log('=== 0. URL 归一化（纯函数，离线） ===');
ok(normalizeCoverUrl('http://p2.music.126.net/a==/1.jpg') === 'https://p2.music.126.net/a==/1.jpg?param=300y300',
  'http 封面 → https + 300×300 缩略参数', normalizeCoverUrl('http://p2.music.126.net/a==/1.jpg'));
ok(normalizeCoverUrl('https://p2.music.126.net/a==/1.jpg?param=500y500') === 'https://p2.music.126.net/a==/1.jpg?param=500y500',
  '已有 param 的不重复追加');
ok(normalizeCoverUrl('https://y.gtimg.cn/music/photo_new/T002R300x300M000x.jpg') === 'https://y.gtimg.cn/music/photo_new/T002R300x300M000x.jpg',
  '非网易云 CDN 不加 param（别人家的参数语义不同）', normalizeCoverUrl('https://y.gtimg.cn/music/photo_new/T002R300x300M000x.jpg'));
ok(normalizeMediaUrl('http://m701.music.126.net/x.mp3') === 'https://m701.music.126.net/x.mp3', 'http 音频 → https');

console.log('\n=== 1. buildMusicCard 打印"最终发出的卡片结构"（真实代码路径） ===');
const cards = [];
for (const id of LIVE_IDS) {
  const plan = await media.buildMusicCard('163', id, {});
  cards.push({ id, plan });
  line(`--- 线上 id=${id} ---`);
  line(`  title    : ${plan.title}`);
  line(`  primary  : ${JSON.stringify(plan.primary)}`);
  line(`  native   : ${JSON.stringify(plan.native)}`);
  line(`  link 兜底: ${plan.link}`);
  line(`  note     : ${plan.note}`);
  const d = plan.primary?.data || {};
  ok(d.type === '163', '卡片仍是结构化 163（tag=网易云音乐 / appid=100495085 同款模板）');
  ok(typeof d.image === 'string' && d.image.startsWith('https://'), '封面是 https', String(d.image || ''));
  ok(/\?param=300y300$/.test(String(d.image || '')), '封面带 300×300 缩略参数');
  ok(d.url && d.audio && d.title, '卡片自带 url/title/audio（不再依赖签名服务自己解析）');
  ok(typeof plan.link === 'string' && plan.link.includes('music.163.com'), '始终带一条可用的分享链接兜底', plan.link);
  ok(!('id' in d), '故意不带 id：带 id 时签名服务会换成未缩尺寸原图（见第 3 节）');
}

console.log('\n=== 2. 封面/音频真实请求验证（https 可达性） ===');
for (const { id, plan } of cards) {
  const d = plan.primary?.data || {};
  const head = async (url, headers = {}) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, ct: res.headers.get('content-type'), bytes: buf.length };
  };
  // 手机 QQ 取卡片资源时的典型请求头（顺便排查 CDN 热链拦截：拦了就白框）
  const mobileHeaders = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari/537.36 QQ/9.9.15', Referer: 'https://im.qq.com/' };
  try {
    const cover = await head(d.image, mobileHeaders);
    line(`  id=${id} 封面 https: HTTP ${cover.status} ${cover.ct} ${cover.bytes} B  ← ${d.image}`);
    ok(cover.status === 200 && String(cover.ct).startsWith('image/'), '封面 https 可取到图片（手机 QQ UA/Referer 下同样 200）', `${cover.bytes} B`);
    ok(cover.bytes < 600 * 1024, '封面是缩略图而不是原图（手机端加载得动）', `${(cover.bytes / 1024).toFixed(0)} KB`);
    const audio = await head(d.audio, mobileHeaders);
    line(`  id=${id} 音频 https: HTTP ${audio.status} ${audio.ct} ${audio.bytes} B`);
    ok(audio.status === 200 && String(audio.ct).startsWith('audio/'), '音频 https 可取到音频流');
  } catch (error) {
    ok(false, `id=${id} 封面/音频请求失败`, String(error?.message ?? error));
  }
}

console.log('\n=== 3. 对照：老路径（id 直接丢给签名服务）的封面有多大 ===');
for (const id of LIVE_IDS) {
  try {
    const res = await fetch(SIGN_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: '163', id }), signal: AbortSignal.timeout(20000)
    });
    const card = await res.json();
    const m = card?.meta?.music || {};
    let bytes = 0;
    try {
      const img = await fetch(m.preview, { signal: AbortSignal.timeout(20000) });
      bytes = new Uint8Array(await img.arrayBuffer()).length;
    } catch {}
    line(`  id=${id} 老卡片 preview = ${m.preview}`);
    line(`          体积=${bytes} B (${(bytes / 1024).toFixed(0)} KB) / musicUrl=${String(m.musicUrl).slice(0, 46)}…`);
    ok(String(m.preview).startsWith('https://'), '老卡片封面虽然也是 https（所以"协议"不是现场白框的直接原因）');
    ok(!/\?param=/.test(String(m.preview)), '但老卡片封面是**未缩尺寸原图**（体积不受控，手机端加载不出来就是白框）', `${(bytes / 1024).toFixed(0)} KB`);
    ok(String(m.musicUrl).startsWith('http://'), '老卡片音频还是明文 http + 带时间戳的会过期直链');
  } catch (error) {
    line(`  id=${id} 老路径对照失败（签名服务不可用？）：${error?.message ?? error}`);
  }
}

console.log('\n=== 4. 音乐搜索封面（不再是"歌手默认头像"占位图） ===');
try {
  const data = await media.musicSearch('稻香', 'netease', 2);
  for (const r of data.results) {
    line(`  ${r.title} / ${r.artist} → cover=${r.cover || '(空)'}`);
    if (r.cover) ok(r.cover.startsWith('https://'), '搜索封面是 https', r.cover);
  }
  ok(data.results.length > 0, '网易云搜索仍有结果');
  ok(data.results.every((r) => !String(r.cover).includes('6y-UleORITEDbvrOLV0Q8A')), '没有回落到 6y-UleORITEDbvrOLV0Q8A（歌手默认头像，旧代码的错图）');
} catch (error) {
  ok(false, '搜索失败', String(error?.message ?? error));
}

console.log('\n=== 5. 降级梯子（stub 发送器，离线）：卡片失败必须还能落到链接 ===');
const plan = {
  title: '大鱼 (钢琴)',
  primary: { type: 'music', data: { type: '163', url: 'https://music.163.com/#/song?id=1893321422', image: 'https://p2.music.126.net/x.jpg?param=300y300', audio: 'https://m10.music.126.net/x.mp3', title: '大鱼 (钢琴)' } },
  native: { type: 'music', data: { type: '163', id: '1893321422' } },
  link: '大鱼 (钢琴) 轻音乐馆 https://music.163.com/#/song?id=1893321422'
};
const makeStubs = (behavior) => {
  const sent = [];
  const sendRichFn = async (k, seg) => {
    sent.push({ via: 'rich', seg });
    if (behavior.richFails(seg)) throw new Error('OneBot send_group_msg 失败: 签名失败(retcode=-1)');
    return { messageId: 111 };
  };
  const sendText = async (text) => { sent.push({ via: 'text', text }); return { messageId: 222 }; };
  return { sent, sendRichFn, sendText };
};

// 5a. 主卡片成功 → 不发链接
{
  const s = makeStubs({ richFails: () => false });
  const r = await sendMusicCardWithFallback({ key: 'private:1', plan, seg: plan.primary, sendRichFn: s.sendRichFn, sendText: s.sendText });
  ok(r.card === 'primary' && s.sent.length === 1 && s.sent[0].via === 'rich', '主卡片成功：只发一条卡片，不发链接', JSON.stringify(r.card));
}
// 5b. 主卡片失败、原生卡片成功 → 不发链接
{
  const s = makeStubs({ richFails: (seg) => 'image' in (seg.data || {}) });
  const r = await sendMusicCardWithFallback({ key: 'private:1', plan, seg: plan.primary, sendRichFn: s.sendRichFn, sendText: s.sendText });
  ok(r.card === 'native', '主卡片失败 → 退回 NapCat 原生 id 卡片', JSON.stringify(r.card));
  ok(s.sent.filter((x) => x.via === 'text').length === 0, '这一步还没有发链接（没有重复刷屏）');
}
// 5c. 两种卡片都失败 → 必须自动发链接（分享动作不整体失败）
{
  const s = makeStubs({ richFails: () => true });
  const r = await sendMusicCardWithFallback({ key: 'private:1', plan, seg: plan.primary, sendRichFn: s.sendRichFn, sendText: s.sendText });
  ok(r.card === 'link' && r.ok === true, '两种卡片都失败 → 自动退回官方链接（ok=true，不抛错）', JSON.stringify(r.card));
  ok(s.sent.some((x) => x.via === 'text' && x.text.includes('https://music.163.com/#/song?id=')), '发出去的确实是可点开的歌曲链接', s.sent.at(-1)?.text);
}
// 5d. 没有卡片段（custom 字段不全）→ 直接链接
{
  const s = makeStubs({ richFails: () => false });
  const r = await sendMusicCardWithFallback({ key: 'private:1', plan, seg: null, sendRichFn: s.sendRichFn, sendText: s.sendText });
  ok(r.card === 'link' && s.sent.length === 1 && s.sent[0].via === 'text', '没有卡片段 → 直接发链接兜底');
}
// 5e. 卡片失败且连链接都没有 → 才允许抛错（调用方会如实报失败）
{
  const s = makeStubs({ richFails: () => true });
  let threw = false;
  try { await sendMusicCardWithFallback({ key: 'private:1', plan: { title: 'x', primary: plan.primary, native: null, link: '' }, seg: plan.primary, sendRichFn: s.sendRichFn, sendText: s.sendText }); }
  catch { threw = true; }
  ok(threw, '卡片失败且无链接可退 → 抛错（如实失败，不假装成功）');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
