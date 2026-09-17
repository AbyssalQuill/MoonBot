// video.js 实机自测：解析链接 → 取信息 → 拼卡片，把中间每一步都打出来。
// 用法: node tools/test-video.mjs [urlOrBv ...]
//   不带参数则用内置样例（含一个短链、一个裸 BV、一个抖音短链占位）
import { parseVideoUrl, extractVideoUrls, resolveVideo, buildVideoCard, videoSearch } from '../src/core/video.js';

const DEFAULTS = [
  'https://www.bilibili.com/video/BV1GJ411x7h7',
  'BV1GJ411x7h7',
  'https://b23.tv/BV1GJ411x7h7',
  '看看这个 https://www.bilibili.com/video/BV1GJ411x7h7 挺有意思',
];

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;

console.log('===== 1) 链接识别 =====');
for (const t of targets) {
  const p = parseVideoUrl(t.replace(/^看看这个\s*/, ''));
  console.log(`  ${t}\n    -> ${p ? JSON.stringify(p) : '认不出'}`);
}
console.log('  extractVideoUrls("看看这个 ... 挺有意思") =', JSON.stringify(extractVideoUrls(targets[targets.length - 1])));

console.log('\n===== 2) 解析视频信息 =====');
for (const t of targets) {
  const p = parseVideoUrl(t.replace(/^看看这个\s*/, ''));
  if (!p) continue;
  console.log(`--- ${t}`);
  try {
    const info = await resolveVideo(t.replace(/^看看这个\s*/, ''));
    console.log('  platform :', info.platform, '| id', info.id, '| source', info.source);
    console.log('  title    :', info.title);
    console.log('  author   :', info.author || '(空)');
    console.log('  duration :', info.durationText || '(空)');
    console.log('  play     :', info.playText || '(空)');
    console.log('  cover    :', info.cover || '(空)');
    console.log('  desc     :', (info.description || '').slice(0, 120));
  } catch (e) {
    console.log('  解析失败:', e.message, e.degraded ? '(可降级为纯链接)' : '');
  }
}

console.log('\n===== 3) 拼卡片 =====');
try {
  const info = await resolveVideo('https://www.bilibili.com/video/BV1GJ411x7h7');
  const card = buildVideoCard(info);
  console.log('  title   :', card.title);
  console.log('  note    :', card.note);
  console.log('  link    :', card.link);
  const payload = JSON.parse(card.primary.data.data);
  console.log('  card app:', payload.app, '| view:', payload.view, '| tag:', payload.meta.news.tag);
  console.log('  card len:', card.primary.data.data.length, '字节');
} catch (e) {
  console.log('  拼卡片失败:', e.message);
}

console.log('\n===== 4) 关键词搜视频 =====');
try {
  const r = await videoSearch('鲸鱼', { limit: 5 });
  console.log('  via', r.via, '共', r.results.length, '条');
  for (const x of r.results) console.log(`    ${x.bvid}  ${x.duration}  ${x.playText}播放  ${x.title.slice(0, 48)}  [${x.author}]`);
} catch (e) {
  console.log('  搜索失败:', e.message);
}
