/* 线上实测「QQ 音乐卡手机端有没有封面」的**端到端**脚本（只读，不发消息）。
 *
 * 用法（在 VPS 上）：node /root/qq-bridge/test-qq-card-sign.mjs <songmid>
 *
 * 它做两件事：
 *   1) 用桥自己的 `buildMusicCard('qq', mid)` 走一遍真实解析 → 拿到真正会发出去的那张卡（含 image）。
 *   2) 把这张卡原样 POST 给签名服务（musicSignUrl，线上默认 http://106.55.0.102:10087/），
 *      看它到底有没有拼出 Ark（`app` 是不是音乐卡、`preview` 落在哪个域名）。
 *
 * 判定口径（接 2026-09-19 的对照实测）：
 *   · 签名服务**取不到**我们给的 image → 它返回的卡片会退掉 → preview 空 / app 不是音乐卡。
 *   · 取得到 → 它会**把图转存到 qq.ugcimg.cn**，preview 那个域名就是"真卡"用的域名。
 * 所以这里 `preview` 命中 qq.ugcimg.cn 就等于**手机端会显示封面**。
 */
const MID = process.argv[2] || '0039MnYb0qxYhV';
const KEYWORD = process.argv[3] || '起风了';
const SIGN = process.env.QQBRIDGE_MUSIC_SIGN || 'http://106.55.0.102:10087/';

import { readFileSync } from 'node:fs';

const { createMediaDomain } = await import('/root/qq-bridge/src/core/media.js');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const { buildMusicCard, musicSearch } = createMediaDomain(cfg);

/* 【为什么要先搜一次】QQ 音乐的解析接口现在**只认歌名/歌手**（光给 songmid 解析不出来，
 * 日志：`没有歌名/歌手，无法解析可播放直链`）。真流程是模型先调 `qq_music_search` 拿到
 * title/artist，再拿 mid 去拼卡。这里照抄真流程，测出来的才是**线上真正会发出去的那张卡**。 */
console.log(`=== 0) 先按关键词搜一次（${KEYWORD}）===`);
const found = await musicSearch(KEYWORD, 'qqmusic', 3);
const hit = found?.results?.[0] ?? null;
if (!hit) {
  console.log('搜索没有结果，脚本没法继续。');
  process.exit(0);
}
console.log('命中  :', hit.title, '-', hit.artist, '| mid', hit.id);
console.log('搜索给的封面:', hit.cover);

const card = await buildMusicCard('qq', hit.id, { title: hit.title, artist: hit.artist });
const data = card?.primary?.data ?? null;

console.log('=== 1) 桥自己拼出来的卡 ===');
console.log('note   :', card?.note ?? '(无)');
console.log('type   :', data?.type ?? '(没有 primary —— 说明连封面都没拿到，退纯链接了)');
console.log('title  :', data?.title ?? '(无)');
console.log('image  :', data?.image ?? '(无)');
console.log('audio  :', data?.audio ? data.audio.slice(0, 90) + '…' : '(没有可播放直链，只有封面+歌页链接)');

if (!data) {
  console.log('\n>>> 没有卡片可测（退化成官方分享链接了）。');
  process.exit(0);
}

console.log('\n=== 2) 交给签名服务 ===');
let res;
try {
  res = await fetch(SIGN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30000)
  });
} catch (error) {
  console.log('请求签名服务失败：', error?.message ?? error);
  process.exit(1);
}
const text = await res.text();
console.log('HTTP', res.status, 'len', text.length);

let json = null;
try { json = JSON.parse(text); } catch { /* 有些返回不是 JSON */ }
/* 【坑】签名服务的返回体是**被 JSON 编码过一次的字符串**（`"{\"app\":\"com.tencent.music.lua\"…"`），
 * 只 parse 一层会拿到字符串、`json.app` 取不到 → 会误判成"卡片没拼出来"。这里再 parse 一层。 */
if (typeof json === 'string') {
  try { json = JSON.parse(json); } catch { /* 保持原样 */ }
}
const flat = JSON.stringify(json ?? text);

const app = json?.app ?? (flat.match(/"app"\s*:\s*"([^"]+)"/) || [])[1] ?? '(没解析出 app)';
console.log('app    :', app);

const previews = [...new Set([...flat.matchAll(/https?:\\?\/\\?\/[^"',\s]+/g)].map((m) => m[0].replace(/\\\//g, '/')))];
console.log('返回里的 URL：');
for (const u of previews.slice(0, 12)) console.log('   ', u.slice(0, 130));

const hosted = previews.some((u) => /qq\.ugcimg\.cn\//i.test(u));
const isMusic = /music|miniapp/i.test(String(app));
console.log('\n=== 结论 ===');
console.log('签名服务拼出音乐卡 :', isMusic ? '是 ✅' : '否 ❌');
console.log('封面转存到 qq.ugcimg.cn :', hosted ? '是 ✅ → 手机端会显示封面' : '否 ❌ → 手机端没封面');
if (!isMusic) console.log('（app=' + app + '——卡片没拼出来，桥会把这张卡降级成纯链接）');
console.log('\n原始返回前 600 字：\n' + (json ? JSON.stringify(json) : text).slice(0, 600));
