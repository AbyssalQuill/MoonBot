#!/usr/bin/env node
/**
 * 富文本卡片解析自检 —— 纯离线，不需要桥接 / DSH / 网络，不需要任何 npm 依赖。
 *
 * 用法（工作目录：仓库根，或任意目录都可以，导入用相对本文件的路径）：
 *   node qq-bridge/tools/test-card-parse.mjs
 *
 * 夹具是**线上抓到的真卡**（主人从手机 QQ 分享进来的原样 Ark JSON），只把
 * `token` / 昵称这类无意义字段做了脱敏，占位符（如 "<真正的视频标题>"）换成了等长的真实文案：
 *   1) 小程序卡 B站视频 app=com.tencent.miniapp_01 —— title 是**应用名**，真标题在 desc，
 *      真链接是 qqdocurl，url 是 QQ 服务端 hash 短链（必须被过滤掉）；
 *   2) 图文卡 高德位置 app=com.tencent.tuwen.lua —— 真标题 title、来源 desc/tag、真链接 jumpUrl；
 *   3) 音乐卡 app=com.tencent.music.lua view=music —— 既有「平台 歌名 歌手 链接」格式不能退化；
 *   4) 没有可用字段的压缩卡（只剩 prompt）—— 必须退回老兜底，且不抛异常。
 *
 * 断言重点：解析结果**包含**真标题与真链接，**不包含** m.q.qq.com hash 短链。
 */
import { parseJsonCardText } from '../src/lib/message-parse.js';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`); }
};
const line = (t = '') => console.log(t);
const has = (out, s) => String(out ?? '').includes(s);

// ── 夹具 1：小程序卡（B站视频分享，线上真卡） ───────────────────────────────
const BILI_REAL_TITLE = '【硬核科普】三分钟看懂量子计算到底在算什么';
const BILI_REAL_URL = 'https://b23.tv/WZVnINP?share_medium=android&share_source=qq&bbid=X&ts=1789662714';
const BILI_HASH_URL = 'm.q.qq.com/a/s/93777ccbcc6d9423b5670af29890d82d';
const BILI_COVER = 'https://qq.ugcimg.cn/v1/3e8a2f7b9c4d5e6f.jpg';
const CARD_BILI_MINIAPP = {
  app: 'com.tencent.miniapp_01',
  view: 'view_8C8E89B49BE609866298ADDFF2DBABA4',
  config: { type: 'normal', forward: 1, ctime: 1789662714, token: 'TOKEN' },
  meta: {
    detail_1: {
      appid: '1109937557',
      appType: 0,
      title: '哔哩哔哩',                 // 注意：这是**应用名**，不是视频标题
      scene: 1036,
      desc: BILI_REAL_TITLE,             // 真标题在这里
      icon: 'https://p.qpic.cn/qqconnect/0/app_1109937557_1/100',
      preview: BILI_COVER,               // 封面
      url: BILI_HASH_URL,                // QQ 服务端 hash 短链：对模型没用，必须丢
      qqdocurl: BILI_REAL_URL,           // 真正可点开的链接
      shareTemplateId: '8C8E89B49BE609866298ADDFF2DBABA4',
      host: { uin: 1736784911, nick: '分享者昵称' }   // 嵌套对象：不是卡片内容，应被忽略
    }
  }
};

// ── 夹具 2：图文卡（高德位置分享，线上真卡） ────────────────────────────────
const AMAP_REAL_URL = 'https://surl.amap.com/fnlA5Augeq';
const CARD_AMAP_NEWS = {
  app: 'com.tencent.tuwen.lua',
  bizsrc: 'qqconnect.sdkshare',
  config: { ctime: 1789662714, forward: 1, token: 'TOKEN', type: 'normal' },
  extra: { app_type: 1, appid: 100571486 },
  meta: {
    news: {
      app_type: 1,
      appid: 100571486,
      desc: '高德地图',
      jumpUrl: AMAP_REAL_URL,
      preview: 'https://qq.ugcimg.cn/v1/amap-preview-0f1e2d.jpg',
      tag: '高德',
      tagIcon: 'https://p.qpic.cn/qqconnect/0/app_100571486_1/100',
      title: '天安门广场'
    }
  }
};

// ── 夹具 3：音乐卡（QQ音乐 / 网易云，view=music） ───────────────────────────
const MUSIC_REAL_URL = 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV';
const CARD_QQ_MUSIC = {
  app: 'com.tencent.music.lua',
  view: 'music',
  config: { type: 'normal', forward: 1, token: 'TOKEN' },
  prompt: '[分享] 夜曲',
  meta: {
    music: {
      appid: 100497308,
      title: '夜曲',
      desc: '周杰伦',
      jumpUrl: MUSIC_REAL_URL,
      musicUrl: 'https://ws.stream.qqmusic.qq.com/C4000039MnYb0qxYhV.m4a',
      preview: 'https://y.gtimg.cn/music/photo_new/T002R300x300M0000039MnYb0qxYhV.jpg',
      tag: 'QQ音乐',
      tagIcon: 'https://p.qpic.cn/qqconnect/0/app_100497308_1/100'
    }
  }
};
const NETEASE_REAL_URL = 'https://music.163.com/#/song?id=1893321422';
const CARD_NETEASE_MUSIC = {
  app: 'com.tencent.music.lua',
  view: 'music',
  config: { type: 'normal', forward: 1, token: 'TOKEN' },
  meta: {
    music: {
      appid: 100495085,
      title: '大鱼 (钢琴版)',
      desc: '轻音乐馆',
      jumpUrl: NETEASE_REAL_URL,
      preview: 'https://p2.music.126.net/xxxx/109951.jpg',
      tag: '网易云音乐'
    }
  }
};

// ── 夹具 4：没有任何可用字段的卡（QQ 压缩过的分享卡只剩 prompt） ─────────────
const CARD_EMPTY = {
  app: 'com.tencent.structmsg',
  config: { type: 'normal', forward: 1, token: 'TOKEN' },
  prompt: '[QQ小程序]哎呀，卡片被压缩了，请到手机端查看'
};

line('=== 0. 夹具真卡 → 解析结果（原样打印，人眼可核对） ===');
const outBili = parseJsonCardText(JSON.stringify(CARD_BILI_MINIAPP)); // OneBot 实际给的是 JSON 字符串
const outAmap = parseJsonCardText(CARD_AMAP_NEWS);                    // 也允许直接给对象
const outQqMusic = parseJsonCardText(CARD_QQ_MUSIC);
const outNetease = parseJsonCardText(CARD_NETEASE_MUSIC);
const outEmpty = parseJsonCardText(CARD_EMPTY);
line(`  小程序卡(B站) : ${outBili}`);
line(`  图文卡(高德)  : ${outAmap}`);
line(`  音乐卡(QQ音乐): ${outQqMusic}`);
line(`  音乐卡(网易云): ${outNetease}`);
line(`  压缩卡(无字段): ${outEmpty}`);

line('\n=== 1. 小程序卡：应用名 + 真标题 + 真链接（不含 hash 短链）===');
ok(has(outBili, '哔哩哔哩'), '读到应用名（title）', '哔哩哔哩');
ok(has(outBili, BILI_REAL_TITLE), '读到真标题（desc，不是应用名）', BILI_REAL_TITLE);
ok(!outBili.startsWith('哔哩哔哩 哔哩哔哩'), '应用名没有当成标题重复输出');
ok(has(outBili, BILI_REAL_URL), '读到真链接（qqdocurl，优先于 url）', BILI_REAL_URL);
ok(has(outBili, BILI_COVER), '带上封面（preview）', BILI_COVER);
ok(!has(outBili, 'm.q.qq.com'), '过滤掉 QQ 服务端 hash 短链域名');
ok(!has(outBili, '93777ccbcc6d9423b5670af29890d82d'), '过滤掉 hash 串本身');
ok(!has(outBili, '分享者昵称') && !has(outBili, '1736784911'), '不吃嵌套对象里的分享者信息（host.uin/nick）');
ok(outBili.split(/\s+/).length <= 6, '输出是一行紧凑字符串（空格分隔的段数受控）', `${outBili.split(/\s+/).length} 段`);

line('\n=== 2. 图文卡（高德位置）：真标题 + 真链接，格式与旧版一致 ===');
ok(has(outAmap, '天安门广场'), '读到标题（title）');
ok(has(outAmap, AMAP_REAL_URL), '读到真链接（jumpUrl，不是 hash 短链）', AMAP_REAL_URL);
ok(has(outAmap, '高德地图'), '读到来源描述（desc）');
ok(!has(outAmap, '高德 高德地图'), '来源 tag 与 desc 重复时被去重');
ok(outAmap.startsWith('卡片 '), '没命中平台标签表时仍用「卡片 」前缀（老格式不变）', outAmap.slice(0, 12));
ok(!has(outAmap, 'm.q.qq.com'), '不含 hash 短链');

line('\n=== 3. 音乐卡：既有格式不退化 ===');
ok(outQqMusic === `QQ音乐 夜曲 周杰伦 ${MUSIC_REAL_URL}`, 'QQ音乐卡输出「平台 歌名 歌手 链接」（与旧实现逐字一致）', outQqMusic);
// 网易云卡的 tag 是中文“网易云音乐”，老规则 /netease|cloudmusic|163music/ 匹配不到它
// （旧实现同样匹配不到，所以没有「网易云音乐 」前缀——规则表本次不动）。
// 标题/歌手/链接的顺序与旧实现一致，只是多补了一个来源 tag（本次新增的“来源类字段”）。
ok(outNetease === `卡片 大鱼 (钢琴版) 轻音乐馆 网易云音乐 ${NETEASE_REAL_URL}`, '网易云卡：标题+歌手+链接顺序与旧实现一致，额外补上来源 tag', outNetease);
ok(has(outQqMusic, '周杰伦') && has(outNetease, '轻音乐馆'), '歌手/艺术家字段（singer/artist）读得到');
ok(!has(outQqMusic, 'musicUrl') && has(outQqMusic, MUSIC_REAL_URL), '链接取 jumpUrl 而不是音乐直链 musicUrl');
ok(!has(outQqMusic, 'y.gtimg.cn'), '普通卡片不把封面 icon/preview 混进正文（避免噪声）');

line('\n=== 4. 没有可读字段的卡：走老兜底，不抛异常 ===');
ok(outEmpty === `卡片 ${CARD_EMPTY.prompt}`, '只有 prompt 时返回「卡片 <prompt>」', outEmpty);
ok(parseJsonCardText({ app: 'com.tencent.structmsg' }) === null, '彻底空卡返回 null');
ok(parseJsonCardText({ app: 'x', meta: {} }) === null, 'meta 为空对象返回 null');
ok(parseJsonCardText({ app: 'x', meta: { detail_1: { host: { uin: 1, nick: 'n' } } } }) === null, '只有嵌套对象的卡返回 null');
ok(parseJsonCardText(null) === null && parseJsonCardText('') === null && parseJsonCardText('{坏 JSON') === null, 'null / 空串 / 坏 JSON 一律返回 null（不抛异常）');
ok(parseJsonCardText(12345) === null && parseJsonCardText([]) === null, '数字 / 数组输入返回 null');
ok(parseJsonCardText({ app: 'com.tencent.miniapp_01', meta: { detail_1: { appid: '1', title: '测试小程序', url: BILI_HASH_URL } } }) === '卡片 测试小程序',
  '小程序卡只有 hash 短链时：只输出应用名，不输出 hash 链接');

line('\n=== 5. 通用性：没见过字段名的新卡也能读出内容 ===');
const outUnknown = parseJsonCardText({
  app: 'com.tencent.unknown.template',
  view: 'view_whatever',
  meta: {
    detail_1: { workTitle: '某本小说', appName: '起点读书', cover: 'https://img.example.com/a.jpg', href: 'https://book.example.com/1' },
    detail_2: { name: '备用标题', picUrl: 'https://img.example.com/b.jpg' }
  }
});
ok(has(outUnknown, '某本小说') && has(outUnknown, 'https://book.example.com/1'), '按字段名（workTitle/href）读出标题与链接', outUnknown);
ok(has(outUnknown, '起点读书'), '来源字段 appName 也读得到');
ok(outUnknown.split(/\s+/).length <= 5, '子对象汇总后不重复堆字段（同名字段只取第一条）');

line(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
