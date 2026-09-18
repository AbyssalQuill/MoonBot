/* 校对音乐分享卡拼出来的**形状**（不发消息）。
 *
 * 判据是"像不像真机分享那张卡"——真卡的原始 Ark 是主人 2026-09-18 从手机 App
 * 分享进 QQ 时抓下来的（两张，见 tools/dump-ark-raw.mjs 的输出）：
 *
 *   app   = com.tencent.tuwen.lua      ← 不是 music.lua
 *   view  = news                       ← 不是 music
 *   meta  = { news: {…} }              ← 不是 music
 *   bizsrc= qqconnect.sdkshare         ← 不是 qqconnect.sdkshare_music
 *   news  = { app_type, appid, ctime, desc(歌手), jumpUrl(手机播放页),
 *             preview(封面), tag, tagIcon, title }（真卡还带 uin）
 *
 * 用法（cwd = /root/qq-bridge）：node test-music-card-shape.mjs
 */
import { readFileSync } from 'node:fs';

const { createMediaDomain, buildShareNewsCard, qqMobilePlayUrl, neteaseMobileSongUrl } =
  await import('/root/qq-bridge/src/core/media.js');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const { buildMusicCard, musicSearch } = createMediaDomain(cfg);

const EXPECT = {
  app: 'com.tencent.tuwen.lua',
  view: 'news',
  bizsrc: 'qqconnect.sdkshare'
};

async function check(label, platform, keyword, id) {
  console.log('='.repeat(92));
  console.log(`${label}   （关键词 ${keyword}）`);
  const found = await musicSearch(keyword, platform === '163' ? 'netease' : 'qqmusic', 3);
  const hit = found?.results?.[0] ?? null;
  const card = await buildMusicCard(platform, hit?.id || id, hit ? { title: hit.title, artist: hit.artist } : {});
  console.log('note  :', card?.note ?? '(无)');
  const seg = card?.primary;
  if (!seg) { console.log('❌ 没有卡片段（退纯链接了）'); return; }
  console.log('段类型 :', seg.type);
  if (seg.type !== 'json') { console.log('❌ 不是图文卡（tuwen/news）—— 手机端这台不会画封面'); return; }
  const ark = JSON.parse(seg.data.data);
  const news = ark?.meta?.news ?? {};
  let ok = true;
  for (const [k, v] of Object.entries(EXPECT)) {
    const good = ark?.[k] === v;
    if (!good) ok = false;
    console.log(`  ${good ? '✅' : '❌'} ${k} = ${ark?.[k]}${good ? '' : `  （应为 ${v}）`}`);
  }
  console.log('  title   =', news.title);
  console.log('  desc    =', news.desc);
  console.log('  tag     =', news.tag, ' appid =', news.appid, ' tagIcon =', String(news.tagIcon).slice(0, 60));
  console.log('  jumpUrl =', String(news.jumpUrl).slice(0, 110));
  console.log('  preview =', String(news.preview).slice(0, 110));
  const mobile = platform === '163' ? /^https:\/\/y\.music\.163\.com\/m\/song/.test(String(news.jumpUrl))
    : /^https:\/\/i\.y\.qq\.com\/v8\/playsong\.html/.test(String(news.jumpUrl));
  console.log(`  ${mobile ? '✅' : '❌'} jumpUrl 是**手机播放页**（真卡用的那种；桌面歌页会被"将要访问"拦一层）`);
  console.log(`  token   = ${String(ark?.config?.token).slice(0, 12)}…（随机 32 位，真卡那张是分享方签的，我们签不出来）`);
  console.log(ok && mobile ? '\n>>> 形状与真机分享一致 ✅' : '\n>>> 形状对不上 ❌');
}

await check('QQ 音乐', 'qq', '起风了', '0039MnYb0qxYhV');
await check('网易云  ', '163', '精神创伤', '3385901059');
