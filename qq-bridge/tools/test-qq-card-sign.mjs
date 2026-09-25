/* 线上实测「音乐卡手机端有没有封面」的端到端脚本（只读，不发消息）。
 *
 * 用法（在 VPS 上，cwd = /root/qq-bridge）：
 *     node test-qq-card-sign.mjs qq  <songmid>  [关键词]
 *     node test-qq-card-sign.mjs 163 <songid>   [关键词]
 *
 * 它做三件事：
 *   1) 走真流程（先搜一次拿到 title/artist，再拼卡）→ 拿到真正会发出去的那张卡（含 image）。
 *   2) 把这张卡原样 POST 给签名服务（musicSignUrl，线上默认 http://106.55.0.102:10087/）。
 *   3) 对比：我们交出去的 image vs 签名服务最终写进 Ark 的 preview。
 *
 * ── 判定口径（2026-09-19 从真消息记录反推出来的，别凭直觉）──────────────────────
 * 好：preview 与我们给的 image 一模一样（原样透传）。
 *           真机验证过的卡就是这么来的（05:25:10 / 05:27:54，现场确认"正常"）：
 *             preview = https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg
 * 坏：preview 被改写成 `https://qq.ugcimg.cn/v1/<超长串>` —— 签名服务把图转存了。
 *           真机验证过的那张没图的卡正是这样（08:04:18）。这种链接手机端不渲染。
 *           触发条件：交出去的 image 是第三方图片代理的 URL（曾被转存的都长这样）。
 *
 * 踩过的坑：签名服务返回体是被 JSON 编码过一次的字符串（`"{\"app\":\"…\"}"`），
 * 只 parse 一层会拿到字符串、取不到 app/preview → 会把每一张卡都误判成"卡片构造失败"。
 * 本脚本 parse 两层。当年那份"封面 host 决定成败"的对照表就是栽在这个坑上。
 */
const PLATFORM = process.argv[2] || 'qq';
const ID = process.argv[3] || '0039MnYb0qxYhV';
const KEYWORD = process.argv[4] || '起风了';
const SIGN = process.env.QQBRIDGE_MUSIC_SIGN || 'http://106.55.0.102:10087/';

import { readFileSync } from 'node:fs';

const { createMediaDomain } = await import('/root/qq-bridge/src/core/media.js');
const cfg = JSON.parse(readFileSync('/root/qq-bridge/config.json', 'utf8'));
const { buildMusicCard, musicSearch } = createMediaDomain(cfg);

/* 为什么要先搜一次：解析接口现在只认歌名/歌手（光给 id 解析不出来）。真流程就是模型先搜、
 * 再拿 id 去拼卡，这里照抄，测出来的才是线上真正会发出去的那张。 */
console.log(`=== 0) 先按关键词搜一次（${KEYWORD}）===`);
const found = await musicSearch(KEYWORD, PLATFORM === '163' ? 'netease' : 'qqmusic', 3);
const hit = found?.results?.[0] ?? null;
if (hit) console.log('搜索命中  :', hit.title, '-', hit.artist, '| id', hit.id, '| 封面', hit.cover);
else console.log('（搜索无结果，直接用给定的 id 拼卡）');

const card = await buildMusicCard(PLATFORM, hit?.id || ID, hit ? { title: hit.title, artist: hit.artist } : {});
const data = card?.primary?.data ?? null;

console.log('\n=== 1) 桥自己拼出来的卡 ===');
console.log('note   :', card?.note ?? '(无)');
console.log('type   :', data?.type ?? '(没有 primary —— 连封面都没拿到，退纯链接了)');
console.log('title  :', data?.title ?? '(无)');
console.log('image  :', data?.image ?? '(无)');
console.log('audio  :', data?.audio ? data.audio.slice(0, 90) + '…' : '(没有可播放直链)');

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
    signal: AbortSignal.timeout(60000)
  });
} catch (error) {
  console.log('请求签名服务失败：', error?.message ?? error);
  process.exit(1);
}
const text = await res.text();
console.log('HTTP', res.status, 'len', text.length, `（耗时超 45s 就是超时降级那条路）`);

let json = null;
try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
if (typeof json === 'string') { try { json = JSON.parse(json); } catch { /* 保持原样 */ } }

const app = json?.app ?? (text.match(/"app"\s*:\s*"([^"]+)"/) || [])[1] ?? '(没解析出 app)';
const preview = json?.meta?.music?.preview ?? (text.match(/"preview"\s*:\s*"([^"]+)"/) || [])[1] ?? null;
console.log('app      :', app);
console.log('preview  :', preview ? preview.slice(0, 120) : '(卡片里没有 preview 字段)');

console.log('\n=== 结论 ===');
const isMusic = /music/i.test(String(app));
console.log('签名服务拼出音乐卡     :', isMusic ? '是 ✅' : `否 ❌（app=${app}）`);
if (preview) {
  const hosted = /qq\.ugcimg\.cn\//i.test(preview);
  const passthrough = String(data.image) === String(preview);
  if (hosted) {
    console.log('封面被签名服务转存      : 是 ❌ → 手机端不会显示（这就是"没图"的那张）');
    console.log('  ⇒ 说明交出去的 image 它不肯原样用，八成是第三方图片代理的 URL');
  } else if (passthrough) {
    console.log('封面原样透传           : 是 ✅ → 与真机验证过能显示的那张一致');
  } else {
    console.log('封面被改成别的 URL      : ⚠️ 自己看一眼上面两行');
  }
  const m = String(preview).match(/^https?:\/\/([^/]+)\//);
  console.log('preview 域名           :', m ? m[1] : '?');
} else {
  console.log('封面                   : ❌ 卡片里没有 preview');
}
console.log('\n原始返回前 400 字：\n' + (json ? JSON.stringify(json) : text).slice(0, 400));
