// OneBot 消息段解析 + 文件内容读取（自 bridge.js 迁移，行为不变）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { forwardIdFromData } from '../forward.js';
import { safeFetchBuffer } from '../safe-fetch.js';
// 【2026-09-21 表情包理解】原生表情渲染成 `[表情:名字(id)]`，让模型读到情绪而不是一个数字
import { faceNameById } from '../qq-faces.js';

export async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      /* 【2026-09-21 表情包理解】原生表情原来渲染成 `[表情123]`：模型只看到一个数字，读不出情绪。
       * 本地 id→中文名表里有 123 = 什么心情，于是渲染成 `[表情:偷笑(123)]` ——
       * 这个格式本来就是 lib/qq-face-parse.js 明确支持的反解格式（发回来照样能翻成真表情），
       * 所以既让模型"读得懂"，又不会在转述时变成纯文本。查不到名字时保持原样（`[表情123]`）。 */
      case 'face': {
        const fid = d.id ?? '';
        const fname = faceNameById(fid);
        out.push(fname ? `[表情:${fname}(${fid})]` : `[表情${fid}]`);
        break;
      }
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(fileMarker(d.name, d.size)); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              /* 【2026-09-22】被引用的内容里带图片/表情时，把**被引用那条的 message id 一并报出来**
               * （`[引用 某某#123456：[图片]]`）：主人"引用着自己的图 + 让我转进群"的场景里，
               * 图在被引用那条里，模型只有当前这条的 id —— 没有这个 id 就只能联网搜一张差不多的。
               * 普通引用（纯文字）格式一字不变，避免影响既有判据与用例。 */
              const quotedHasMedia = /\[(图片|表情|视频|语音|文件)/.test(String(info.text ?? ''));
              if (info.sender) parts.push(quotedHasMedia && d.id != null ? `${info.sender}#${String(d.id)}` : info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': {
        // 富文本卡片（网易云音乐/B站/链接分享/群聊邀请/个人名片等）：解析出可读内容
        const cardText = parseJsonCardText(d.data ?? d.content ?? '');
        // 【2026-09-18】顺手把原始卡片 JSON 存下来（取证用，见 noteIncomingCard 注释）
        try { noteIncomingCard(seg, cardText); } catch { /* ignore */ }
        out.push(cardText ? `[${cardText}]` : '[卡片消息]');
        break;
      }
      case 'music': {
        // 音乐分享段（自定义/QQ音乐/网易云）：title - singer + url
        const mTitle = String(d.title ?? '').trim();
        const mSinger = String(d.singer ?? d.artist ?? '').trim();
        const mUrl = String(d.url ?? '').trim();
        const body = [mTitle, mSinger].filter(Boolean).join(' - ');
        out.push(body || mUrl ? `[音乐分享${body ? ' ' + body : ''}${mUrl ? ' ' + mUrl : ''}]` : '[音乐分享]');
        break;
      }
      case 'share': {
        // 链接分享段：标题 + 描述 + 链接
        const sTitle = String(d.title ?? '').trim();
        const sDesc = String(d.content ?? d.desc ?? '').trim();
        const sUrl = String(d.url ?? '').trim();
        const parts = [sTitle, sDesc, sUrl].filter(Boolean);
        out.push(parts.length ? `[分享 ${parts.join(' ')}]` : '[链接分享]');
        break;
      }
      case 'contact': {
        // 个人名片/群名片段：QQ 号或群号
        const cType = d.type === 'group' ? '群' : 'QQ';
        const cId = String(d.id ?? '').trim();
        out.push(`[${cType}名片${cId ? ' ' + cId : ''}]`);
        break;
      }
      case 'location': {
        // 位置分享段：标题 + 描述 + 坐标
        const locTitle = String(d.title ?? '').trim();
        const locDesc = String(d.content ?? '').trim();
        const locLat = String(d.lat ?? '').trim();
        const locLon = String(d.lon ?? '').trim();
        const locParts = [locTitle, locDesc].filter(Boolean);
        if (locLat || locLon) locParts.push(`(${locLat},${locLon})`);
        out.push(`[位置${locParts.length ? ' ' + locParts.join(' ') : ''}]`);
        break;
      }
      case 'redbag': {
        // 红包段
        const rbTitle = String(d.title ?? d.prompt ?? '').trim();
        out.push(`[红包${rbTitle ? ' ' + rbTitle : ''}]`);
        break;
      }
      case 'dice': out.push('[骰子]'); break;
      case 'rps': out.push('[猜拳]'); break;
      case 'gift': {
        const giftName = String(d.name ?? d.gift_name ?? '').trim();
        out.push(`[礼物${giftName ? ' ' + giftName : ''}]`);
        break;
      }
      case 'cardimage': out.push('[卡片图片]'); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 解析 QQ 富文本卡片（json 消息段）为可读文本。
// 覆盖：小程序（miniapp）卡片、图文/位置卡片、音乐卡片、链接分享、群聊邀请、其他通用卡片。
//
// 【为什么改成"按字段名扫全部子对象"——三张线上真卡踩出来的坑】
// 1) 不能按 app 写死，也不能只扫 meta 的第一个子对象：子对象名五花八门
//    （小程序卡是 detail_1、图文/位置卡是 news、音乐卡是 music、还有 multi_1…），
//    所以下面遍历 meta 下**所有**子对象，按“字段名语义”分桶收集后再按优先级挑。
// 2) 小程序卡（app=com.tencent.miniapp_01，meta.detail_1）里 `title` 是**应用名**（"哔哩哔哩"），
//    真正的内容标题在 `desc`（视频标题）。照通用规则把 title 当标题，模型就只能看到应用名。
// 3) 同一张卡里 `url` 是 QQ 服务端的 hash 短链（m.q.qq.com/a/s/93777ccbcc6d9423b5670af29890d82d），
//    模型既打不开也看不懂，纯噪声；真正能点开的是 `qqdocurl`（https://b23.tv/WZVnINP）。
//    所以链接按 qqdocurl > jumpUrl > url > href 取，并显式丢掉 m.q.qq.com/a/s/ 这类 hash 短链。
// 4) 封面在 `preview`；但只有“卡片形态”（小程序卡）才把封面写进正文，
//    否则 icon/tagIcon 这类应用小图标会混进普通卡片的文案里变成噪声。
/* 【2026-09-18 取证用】把收到的原始卡片 JSON 落一份盘。
 *
 * 为什么需要：主人要机器人发"B站那种卡片"，但手写的 structmsg/news 在 QQ 上显示成
 * "该消息类型暂不支持查看" —— 我们**没有**真卡的原始 JSON 可参照（桥只存解析后的文本，
 * 日志里也没有）。而主人自己从 B 站分享进 QQ 的那张卡是**真卡**，它的 Ark JSON 就是标准答案。
 * 这里把每张收到的卡片原样追加到 state/incoming-cards.jsonl（一行一条 JSON，含时间/来源/原始段），
 * 之后照它复刻即可。纯取证，不参与任何解析逻辑，失败也不影响消息处理。 */
function noteIncomingCard(rawSeg, parsedText) {
  try {
    const dir = path.join(process.cwd(), 'state');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'incoming-cards.jsonl');
    fs.appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      type: rawSeg?.type ?? '',
      parsed: String(parsedText ?? '').slice(0, 300),
      raw: rawSeg?.data ?? null,
    }) + '\n');
    const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (all.length > 200) fs.writeFileSync(file, all.slice(-200).join('\n') + '\n');
  } catch { /* 取证失败绝不能影响消息处理 */ }
}

// ── 卡片字段的语义分组：只认字段名、不认 app，这样没见过的卡片也能读 ──────────
// 为什么用“集合 + 优先级表”而不是 `m.title ?? m.desc ?? …`：
// 未知卡片里同一个字段名可能出现在多个子对象（detail_1 / detail_2 / news…），
// 先全部收进桶里，再由下面的优先级规则挑，能同时做到“通用”和“可控”。
const CARD_TITLE_FIELDS = new Set(['title', 'name', 'songname', 'worktitle']);
const CARD_DESC_FIELDS = new Set(['desc', 'content', 'summary', 'artist', 'singer']);
const CARD_SOURCE_FIELDS = new Set(['tag', 'sourcename', 'appname']);
const CARD_IMAGE_FIELDS = new Set(['preview', 'icon', 'tagicon', 'cover', 'picurl']);
// 链接优先级（从高到低）：qqdocurl 是分享方可控的真链，jumpUrl 次之，url/href 常是 QQ 中转。
const CARD_LINK_FIELDS = ['qqdocurl', 'jumpurl', 'url', 'href'];
// 封面优先级：preview 才是 QQ 卡片约定的封面，icon/tagIcon 只是应用小图标。
const CARD_COVER_ORDER = ['preview', 'cover', 'picurl', 'icon', 'tagicon'];

// QQ 服务端 hash 短链（https://m.q.qq.com/a/s/93777c…，真卡里也常给成不带协议的 m.q.qq.com/a/s/…）。
// 为什么要判定它：这种链接对模型完全无信息量（只有一串 hash），还会盖住真正的可点链接，
// 所以进桶前就丢掉；真的没有别的链接时，宁可正文里不出现链接。
function isQqHashShortLink(value) {
  return /^(?:https?:\/\/)?m\.q\.qq\.com\/a\/s\//i.test(String(value ?? '').trim());
}

// 扫 meta 下所有子对象，把标量字段按语义分桶。
// 只收标量：嵌套对象（如 miniapp 的 detail_1.host = {uin,nick}）里是分享者信息，不是卡片内容。
function collectCardFields(meta) {
  const found = { title: [], desc: [], source: [], image: [], otherUrl: [] };
  const linkByField = new Map(); // 小写字段名 -> 值（同名字段取第一次出现的）
  for (const key of Object.keys(meta ?? {})) {
    const sub = meta[key];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
    for (const field of Object.keys(sub)) {
      const raw = sub[field];
      if (raw == null || typeof raw === 'object') continue;
      const value = String(raw).trim();
      if (!value) continue;
      const f = field.toLowerCase();
      if (CARD_TITLE_FIELDS.has(f)) { found.title.push(value); continue; }
      if (CARD_DESC_FIELDS.has(f)) { found.desc.push(value); continue; }
      if (CARD_SOURCE_FIELDS.has(f)) { found.source.push(value); continue; }
      if (CARD_IMAGE_FIELDS.has(f)) { found.image.push([f, value]); continue; }
      if (CARD_LINK_FIELDS.includes(f)) {
        if (isQqHashShortLink(value)) continue;
        if (!linkByField.has(f)) linkByField.set(f, value);
        continue;
      }
      // 兜底：musicUrl / shareUrl / docUrl 之类任何以 url 结尾的字段，
      // 优先级排在四个已知链接字段之后（所以先单独存，最后才用）。
      if (/url$/.test(f) && !isQqHashShortLink(value)) found.otherUrl.push(value);
    }
  }
  return { found, linkByField };
}

export function parseJsonCardText(jsonData) {
  let data = null;
  if (typeof jsonData === 'string') {
    try { data = JSON.parse(jsonData); } catch { return null; }
  } else if (jsonData && typeof jsonData === 'object') {
    data = jsonData;
  }
  if (!data || typeof data !== 'object') return null;
  const app = String(data.app ?? '').toLowerCase();
  const prompt = String(data.prompt ?? '').trim();
  const desc = String(data.desc ?? '').trim();
  const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};

  // 1) 收齐 meta 下所有子对象的字段（见文件头注释第 1 条）
  const { found, linkByField } = collectCardFields(meta);

  // 2) 链接：qqdocurl > jumpUrl > url > href（hash 短链已在 collectCardFields 里丢掉），
  //    四个已知字段都没有时才回落到 musicUrl/shareUrl 之类的兜底字段。
  let url = '';
  for (const field of CARD_LINK_FIELDS) {
    if (linkByField.has(field)) { url = linkByField.get(field); break; }
  }
  if (!url) url = found.otherUrl[0] ?? '';

  // 3) 封面：preview 优先于 icon/tagIcon（后者是应用小图标）
  let cover = '';
  for (const field of CARD_COVER_ORDER) {
    const hit = found.image.find(([k]) => k === field);
    if (hit) { cover = hit[1]; break; }
  }

  // 4) 小程序卡（miniapp 模板）：title=应用名、desc=真标题，这里把两者摆正
  //    —— 不做这一步，模型看到的就只是“哔哩哔哩”四个字，看不到视频标题。
  const detail1 = meta.detail_1 && typeof meta.detail_1 === 'object' ? meta.detail_1 : null;
  const isMiniApp = /miniapp/i.test(app) || /miniapp/i.test(String(data.view ?? '')) || !!(detail1 && detail1.appid);
  const rawTitle = found.title[0] ?? '';
  const rawDesc = found.desc[0] ?? '';
  // 应用名挪到“来源”位（source），标题位留给真标题。
  const source = found.source[0] || (isMiniApp ? rawTitle : '');
  const title = isMiniApp ? (rawDesc || rawTitle) : rawTitle;
  const sub = isMiniApp ? '' : rawDesc;
  // 标签表匹配串：把真链接也算进去——很多卡片的 app 是模板名（com.tencent.tuwen.lua），
  // 只能靠链接域名（b23.tv / y.qq.com / music.163.com）认出是哪家平台。
  const hint = [prompt, app, title, sub, source].filter(Boolean).join(' ');
  // 统一拼装：前缀 + 标题 + 描述 + 来源 + 链接（小程序卡额外带封面）——顺序沿用旧实现，
  // 只是多了一个来源位，保证老卡片输出的词序不变。
  const build = (prefix) => {
    const parts = [];
    const push = (value, soft = false) => {
      const s = String(value ?? '').trim();
      if (!s) return;
      // 与前缀重复时跳过：小程序卡的应用名（“哔哩哔哩”）常常就等于平台标签，
      // 不去重就会输出“哔哩哔哩 哔哩哔哩 <标题>”。
      if (s.toLowerCase() === String(prefix).toLowerCase()) return;
      // 软去重（来源类字段用）：来源“高德”已被标题/描述“高德地图”包含时不再重复。
      if (soft && parts.some((p) => p.includes(s))) return;
      if (!parts.includes(s)) parts.push(s);
    };
    push(title || desc || prompt);
    push(sub);
    push(desc);
    // 来源放描述之后、链接之前：有平台标签前缀时它基本都等于前缀而被丢掉；
    // 放在描述后面才能用“已被包含”判断吃掉高德这类重复（desc="高德地图"、tag="高德"）。
    push(source, true);
    push(url);
    // 封面只在“卡片形态”（小程序卡）时进正文：模型才知道这条消息还带一张图；
    // 普通卡片不带，避免把 icon/tagIcon 这类应用小图标混进消息正文。
    if (isMiniApp) push(cover);
    return [prefix, ...parts].filter(Boolean).join(' ').trim();
  };
  // 群聊邀请卡片：提示语/应用名含邀请加入群聊
  if (/邀请.{0,6}加入群聊|邀请你.{0,6}群|加入群聊|group.?invite|joingroup|group_join/i.test(hint)) {
    return build('群聊邀请');
  }
  // 常见卡片标签表：按 (应用名/内容特征, 标签) 匹配，命中即输出「标签 标题 描述 链接」
  const cardTagRules = [
    [/netease|cloudmusic|163music/i, '网易云音乐'],
    [/qqmusic|qq.?music|y\.qq\.com/i, 'QQ音乐'],
    [/kugou|kuwo|酷狗|酷我/i, '音乐'],
    [/bili|bilibili|b23\.tv|哔哩哔哩|b站/i, '哔哩哔哩'],
    [/qzone|qzone\.com|空间/i, 'QQ空间'],
    [/weibo|sina/i, '微博'],
    [/douyin|aweme|抖音/i, '抖音'],
    [/kuaishou|快手/i, '快手'],
    [/zhihu/i, '知乎'],
    [/douban/i, '豆瓣'],
    [/xiaohongshu|xhs|小红书/i, '小红书'],
    [/taobao|tmall|淘宝|天猫/i, '淘宝'],
    [/jd\.com|jingdong|京东/i, '京东'],
    [/pinduoduo|拼多多/i, '拼多多'],
    [/meituan|美团/i, '美团'],
    [/dianping|点评/i, '大众点评'],
    [/news\.qq|tencent\.news|腾讯新闻/i, '腾讯新闻'],
    [/toutiao|头条/i, '今日头条'],
    [/weather|tianqi|天气/i, '天气'],
    [/location|位置|定位/i, '位置'],
    [/calling|通话|audio.?video/i, '通话'],
    [/vote|投票/i, '投票'],
    [/bilibili|bili|哔哩/i, '哔哩哔哩'],
  ];
  // 命中标签表：输出「平台标签 + 标题 + 描述 + 链接」。
  // 标签表本身保持不变（网易云/QQ音乐等既有输出格式不能退化），只是上面的字段来源更准了。
  for (const [rule, label] of cardTagRules) {
    if (rule.test(`${app} ${url} ${hint}`)) return build(label);
  }
  // 其他卡片：标题 + 来源 + 描述 + 链接（没有可读字段时退回下面的老兜底）
  if (title || sub || source || url || desc) return build('卡片');
  if (prompt) return `卡片 ${prompt}`;
  return null;
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、default按需工具、控制台/日志使用。
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: d.subType != null ? String(d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}

/* ── 文件段渲染（2026-09-22 主人要求：「[文件] [file] 这种文件类型也标出来吧，要模型不知道发的是图片」）──
 * 以前文件段只渲染成 `[文件名字]`，没有名字时就是光秃秃的 `[文件]`；唤醒正文里另加一个 ` [file]` 标记。
 * 模型看到"文件 + file"时读不出**这是什么类型的东西**，容易当成图片去调识图工具（现场就是这种误判）。
 * 现在统一成 `[文件:报告.pdf · PDF · 1.2 MB]`：名字、类型、大小都在，且**永远不是 `[图片]`**。
 * 三个调用点共用这里的实现（segmentsToText / forward.js / wake-send 的 [Unread] 行），避免各写一份漂移。 */
const FILE_KIND_BY_EXT = {
  pdf: 'PDF',
  doc: 'Word', docx: 'Word', rtf: 'Word', odt: 'Word',
  xls: 'Excel', xlsx: 'Excel', csv: '表格', ods: '表格',
  ppt: 'PPT', pptx: 'PPT', odp: 'PPT',
  txt: '文本', md: '文本', log: '日志', json: 'JSON', xml: 'XML', yml: 'YAML', yaml: 'YAML', ini: '配置', conf: '配置',
  zip: '压缩包', rar: '压缩包', '7z': '压缩包', tar: '压缩包', gz: '压缩包', bz2: '压缩包', xz: '压缩包',
  jpg: '图片文件', jpeg: '图片文件', png: '图片文件', gif: '图片文件', webp: '图片文件', bmp: '图片文件', svg: '图片文件', ico: '图片文件',
  mp4: '视频文件', mov: '视频文件', mkv: '视频文件', avi: '视频文件', webm: '视频文件',
  mp3: '音频文件', wav: '音频文件', flac: '音频文件', m4a: '音频文件', ogg: '音频文件', aac: '音频文件',
  apk: '安卓安装包', exe: '安装程序', msi: '安装程序', deb: '安装包', rpm: '安装包', dmg: '安装包',
  js: '代码', mjs: '代码', cjs: '代码', ts: '代码', tsx: '代码', jsx: '代码', py: '代码', java: '代码', c: '代码', h: '代码',
  cpp: '代码', cs: '代码', go: '代码', rs: '代码', rb: '代码', php: '代码', sh: '脚本', bat: '脚本', ps1: '脚本',
  html: '网页', htm: '网页', css: '样式', sql: 'SQL', db: '数据库', sqlite: '数据库', epub: '电子书', mobi: '电子书'
};

/** 文件名 → 类型标签（PDF / Word / 压缩包 / 代码 …）；认不出就回扩展名大写，没有扩展名回"未知类型"。 */
export function fileKindLabel(name) {
  const nm = String(name ?? '').trim();
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(nm);
  if (!m) return '未知类型';
  const ext = m[1].toLowerCase();
  return FILE_KIND_BY_EXT[ext] || ext.toUpperCase();
}

/** 字节数 → 人能读的短写法（1.2 MB / 384 KB / 512 B）；没有大小就回空串。 */
export function formatBytesShort(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)} KB`;
  return `${(v / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** 文件段的统一标记：`[文件:报告.pdf · PDF · 1.2 MB]`（无名字时写"未命名文件"，绝不留 `[文件]`）。 */
export function fileMarker(name, size) {
  const nm = String(name ?? '').trim() || '未命名文件';
  const parts = [nm, fileKindLabel(nm)];
  const sz = formatBytesShort(size);
  if (sz) parts.push(sz);
  return `[文件:${parts.join(' · ')}]`;
}

// 从 OneBot 消息段中提取文件段元数据（md/txt/word 等），供“读取文件内容”能力使用。
// 不下载字节，只记录定位信息：file=OneBot 文件标识（用于 get_file）、url=直链、name=文件名。
export function extractFilesFromSegments(segments) {
  const files = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type !== 'file') continue;
    const d = seg.data ?? {};
    const name = String(d.name ?? d.file ?? '');
    files.push({
      name,
      fileId: String(d.file ?? ''),
      url: String(d.url ?? ''),
      size: d.size != null ? Number(d.size) : null,
      /* 【2026-09-22】类型也随消息一起记下来：唤醒正文的 `[file:…]` 标记要用它，
       * 免得模型把"发过来的一个 PDF"当成图片（kind/ext 都在这里，老状态里没有时按名字现算）。 */
      ext: (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] || '').toLowerCase(),
      kind: fileKindLabel(name),
      marker: fileMarker(name, d.size)
    });
  }
  return files;
}

// ── 文件内容读取：下载 + 解析（供 /api/social/file-content 使用） ──────

export function execFileBuffer(file, args, maxBytes) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: maxBytes ?? 20 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err) reject(new Error(`执行 ${file} 失败：${err.message ?? err}`));
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''));
    });
  });
}

export function decodeTextBuffer(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gbk').decode(buf); } catch {}
  return buf.toString('utf8');
}

// 从 .docx（zip + word/document.xml）提取纯文本
export async function extractDocxText(buf) {
  const tmp = path.join(os.tmpdir(), `dsh-docx-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
  fs.writeFileSync(tmp, buf);
  try {
    const xml = await execFileBuffer('unzip', ['-p', tmp, 'word/document.xml'], 25 * 1024 * 1024);
    let text = String(xml)
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    return text.replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// 按扩展名解析文本内容；文本类 2 万字符截断。
export async function parseFileBuffer(buf, name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (['.docx', '.docm'].includes(ext)) {
    const text = await extractDocxText(buf);
    const truncated = text.length > 20000;
    return { text: truncated ? text.slice(0, 20000) + `\n…（内容过长已截断，共 ${text.length} 字符）` : text, truncated };
  }
  if (['.doc'].includes(ext)) {
    const text = buf.toString('utf8', 0, Math.min(buf.length, 200000)).replace(/[^\x20-\x7e\u4e00-\u9fff\uff00-\uffef\r\n\t]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return { text: text.slice(0, 20000) || '（未能提取出可读文本，旧版 .doc 为二进制格式）', truncated: text.length > 20000, note: '旧版 .doc 为二进制格式，提取的文本可能不完整' };
  }
  if (['.pdf'].includes(ext)) {
    return { text: '', note: 'PDF 暂不支持直接读取，可另存为 txt/md 后发送' };
  }
  // 文本类：md/txt/json/log/csv/js/py/ts/html 等
  let text = decodeTextBuffer(buf);
  // 二进制检测：大量 NUL/非文本字节按不支持处理
  if (text && /[\u0000]/.test(text) && buf.length > 0) {
    const printable = buf.filter((b) => (b >= 32 && b < 127) || b === 9 || b === 10 || b === 13).length;
    if (printable / buf.length < 0.5) {
      return { text: '', note: `「${ext || '未知'}」是二进制/不支持的文件格式` };
    }
  }
  const truncated = text.length > 20000;
  return { text: truncated ? text.slice(0, 20000) + `\n…（内容过长已截断，共 ${text.length} 字符）` : text, truncated };
}

// 下载文件字节：优先直链 url，否则 OneBot get_file 拿容器路径再 docker exec 读取。
export async function fetchFileBytes(file, napcatCfg) {
  const url = String(file.url || '');
  if (url && /^https?:\/\//i.test(url)) {
    const result = await safeFetchBuffer(url, 8 * 1024 * 1024);
    if (result && result.buffer && result.buffer.length > 0) return result.buffer;
  }
  const fileId = String(file.fileId || '');
  if (fileId) {
    const httpBase = String(napcatCfg?.httpUrl || 'http://127.0.0.1:3000');
    const token = String(napcatCfg?.accessToken || napcatCfg?.wsAccessToken || '');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const resp = await fetch(`${httpBase}/get_file?file=${encodeURIComponent(fileId)}`, { headers, signal: AbortSignal.timeout(20000) });
    if (resp.ok) {
      const data = await resp.json();
      const containerPath = data?.data?.file;
      if (containerPath && /^[\/\w.\- ]+$/.test(String(containerPath))) {
        const buf = await execFileBuffer('docker', ['exec', 'napcat', 'cat', String(containerPath)], 10 * 1024 * 1024);
        if (buf && buf.length > 0) return buf;
      }
      throw new Error(`get_file 未返回可用路径（${data?.message ?? '未知错误'}）`);
    }
    throw new Error(`get_file 请求失败（HTTP ${resp.status}）`);
  }
  throw new Error('文件缺少直链与 fileId，无法获取');
}

// 统一入口：读取一个文件的文本内容。
export async function readFileContent(file, napcatCfg) {
  const buf = await fetchFileBytes(file, napcatCfg);
  const parsed = await parseFileBuffer(buf, String(file.name || ''));
  return { ...parsed, size: buf.length };
}
