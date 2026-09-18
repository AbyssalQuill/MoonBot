/* 用**桥自己的发送路径**发两张音乐卡到指定会话，用来肉眼验收（形状对不对、手机端出不出图）。
 *
 * 用法（cwd = /root/qq-bridge）：node send-test-music-cards.mjs [key]
 *   key 默认 private:1736784911
 *
 * 走的是真路径：musicSearch → buildMusicCard → sendRich（与模型调 qq_send_rich 时同一个函数），
 * 所以发出去的东西和线上完全一致，不是"另拼一张给你看"。
 */
import { readFileSync } from 'node:fs';

const KEY = process.argv[2] || 'private:1736784911';
const { createMediaDomain } = await import('/root/qq-bridge/src/core/media.js');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const media = createMediaDomain(cfg);
const { buildMusicCard, musicSearch, sendRich } = media;

const jobs = [
  ['qq', '晴天 周杰伦', '004Fs2FP1EvZYc'],
  ['163', '愿与愁 林俊杰', '2041026502']
];

for (const [platform, keyword, fallbackId] of jobs) {
  console.log('='.repeat(80));
  console.log(`${platform}  《${keyword}》`);
  const found = await musicSearch(keyword, platform === '163' ? 'netease' : 'qqmusic', 3);
  const hit = found?.results?.[0] ?? null;
  console.log('  搜到 :', hit ? `${hit.title} - ${hit.artist} (id=${hit.id})` : '(无，用兜底 id)');
  const plan = await buildMusicCard(platform, hit?.id || fallbackId, hit ? { title: hit.title, artist: hit.artist } : {});
  console.log('  note :', plan?.note ?? '(无)');
  if (!plan?.primary) { console.log('  ❌ 没有卡片段，只发链接'); continue; }
  const ark = plan.primary.type === 'json' ? JSON.parse(plan.primary.data.data) : null;
  console.log('  形状 :', ark ? `${ark.app} view=${ark.view} meta=${Object.keys(ark.meta).join(',')}` : plan.primary.type);
  if (ark) console.log('  封面 :', String(ark.meta.news.preview).slice(0, 100));
  try {
    const sent = await sendRich(KEY, plan.primary, {});
    console.log('  ✅ 已发送 messageId =', sent?.messageId ?? '(无)', sent?.deduped ? '（被去重挡下）' : '');
  } catch (error) {
    console.log('  ❌ 发送失败：', error?.message ?? error);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log('\n发完了。');
