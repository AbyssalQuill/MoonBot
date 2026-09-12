// OneBot 消息段解析 + 文件内容读取（自 bridge.js 迁移，行为不变）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { forwardIdFromData } from '../forward.js';
import { safeFetchBuffer } from '../safe-fetch.js';

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
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
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
              if (info.sender) parts.push(info.sender);
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
// 覆盖：网易云音乐卡片、B站卡片、链接分享、群聊邀请、其他通用卡片。
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
  let title = '';
  let sub = '';
  let url = '';
  for (const key of Object.keys(meta)) {
    const m = meta[key];
    if (!m || typeof m !== 'object') continue;
    if (!title) title = String(m.title ?? m.name ?? m.songName ?? '').trim();
    if (!sub) sub = String(m.desc ?? m.content ?? m.summary ?? m.artist ?? '').trim();
    if (!url) url = String(m.jumpUrl ?? m.url ?? m.href ?? '').trim();
    if (title && sub && url) break;
  }
  const hint = `${prompt} ${app} ${title} ${sub}`;
  // 群聊邀请卡片：提示语/应用名含邀请加入群聊
  if (/邀请.{0,6}加入群聊|邀请你.{0,6}群|加入群聊|group.?invite|joingroup|group_join/i.test(hint)) {
    const parts = [];
    if (title) parts.push(title);
    if (sub && sub !== title) parts.push(sub);
    if (desc && desc !== title && desc !== sub) parts.push(desc);
    if (url) parts.push(url);
    return `群聊邀请 ${parts.join(' ')}`.trim();
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
  for (const [rule, label] of cardTagRules) {
    if (rule.test(`${app} ${url} ${hint}`)) {
      const parts = [title || desc || prompt || label];
      if (sub && sub !== parts[0]) parts.push(sub);
      if (desc && desc !== parts[0] && desc !== sub) parts.push(desc);
      if (url) parts.push(url);
      return `${label} ${parts.join(' ')}`.trim();
    }
  }
  // 其他卡片：标题 + 描述 + 链接
  const parts = [];
  if (title) parts.push(title);
  if (sub && sub !== title) parts.push(sub);
  if (desc && desc !== title && desc !== sub) parts.push(desc);
  if (url) parts.push(url);
  if (parts.length) return `卡片 ${parts.join(' ')}`.trim();
  if (prompt) return `卡片 ${prompt}`.trim();
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

// 从 OneBot 消息段中提取文件段元数据（md/txt/word 等），供“读取文件内容”能力使用。
// 不下载字节，只记录定位信息：file=OneBot 文件标识（用于 get_file）、url=直链、name=文件名。
export function extractFilesFromSegments(segments) {
  const files = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type !== 'file') continue;
    const d = seg.data ?? {};
    files.push({
      name: String(d.name ?? d.file ?? ''),
      fileId: String(d.file ?? ''),
      url: String(d.url ?? ''),
      size: d.size != null ? Number(d.size) : null
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
