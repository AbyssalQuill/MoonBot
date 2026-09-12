// 表情包体系（default）本地知识库 + 发送
// 共享状态经 export let 活绑定（bridge 侧只读/走 updateStickerEntries 更新）；
// cfg 静态注入（initStickerCore），bot 运行期注入（setStickerBot）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STICKER_FILE } from '../lib/paths.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  markStickerUsed,
  applyStickerNote
} from '../sticker-lib.js';
import { validateFetchUrl } from '../safe-fetch.js';
import { sleep } from '../lib/async.js';
import { randInt } from '../lib/rand.js';
import { log } from '../lib/log.js';
import { enqueueSend } from './send-chain.js';
import { getSocialState } from './social-state.js';
import { fetchOneBotImage, fetchFaceMedia } from './media-pipe.js';

export let stickerEntries = loadStickerStore(STICKER_FILE);
export let stickerSyncedAt = 0; // 上次从 NapCat 拉取收藏表情的时间戳（毫秒）
let stickerCfg = null;
let botRef = null;
/** NapCat 是否支持 add_custom_face（收藏表情扩展动作）：探测一次后缓存 */
let collectFaceSupported = true;

/** 本地图库收藏（add_custom_face 不可用时的降级）：把图片字节存入 qq-bridge/stickers-upload 并写入本地库。
 *  返回 manual 条目（url=local://绝对路径），模型可用 qq_send_sticker 直接发；无字节或写入失败返回 null。 */
function saveStickerToLocalLibrary(imageBuffer, remark) {
  try {
    if (!imageBuffer || !imageBuffer.length) return null;
    const libDir = path.join(path.dirname(STICKER_FILE), '..', 'stickers-upload');
    fs.mkdirSync(libDir, { recursive: true });
    const id = `local-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    // 后缀固定 .img：本地上传图库一直是这个后缀，且 NapCat 按文件字节判图，改后缀属无依据的行为变更。
    // 原写法 `const ext = id % 1 === 0 ? '.img' : '.img';` 是死三元（id 是字符串 → id % 1 恒为 NaN → 恒取 .img），已删除。
    const file = id + '.img';
    const abs = path.join(libDir, file);
    fs.writeFileSync(abs, imageBuffer);
    const cleanRemark = String(remark ?? '').trim().slice(0, 60) || '本地收藏';
    const entry = {
      id,
      resId: id,
      url: 'local://' + abs,
      md5: crypto.createHash('md5').update(imageBuffer).digest('hex').toUpperCase(),
      desc: cleanRemark,
      localNote: '',
      tags: ['本地收藏'],
      usage: '',
      source: 'manual',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    stickerEntries = [...stickerEntries, entry];
    saveStickerStoreSafe();
    log(`[sticker] 已降级收藏到本地图库: ${cleanRemark} (${file})`);
    return entry;
  } catch (e) {
    log(`[sticker] 本地图库收藏失败: ${e?.message ?? e}`);
    return null;
  }
}

/** main 启动时调用：注入 cfg（此后不再变），并重读本地库 */
export function initStickerCore(cfg) {
  stickerCfg = cfg;
  stickerEntries = loadStickerStore(STICKER_FILE);
}

/** NapCat 网关就绪后注入 bot（NapCat client） */
export function setStickerBot(bot) {
  botRef = bot;
}

/** bridge 侧对收藏表情库的整体更新（applyStickerNote/markStickerUsed 后） */
export function updateStickerEntries(next) {
  stickerEntries = next;
}

export function stickerEnabled() {
  return stickerCfg.social?.sticker?.enabled !== false;
}

export function saveStickerStoreSafe() {
  try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
}

// 从 NapCat OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
// force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
export async function syncStickerLibrary(force = false) {
  if (stickerCfg.social?.sticker?.enabled === false) return null;
  const rawTtl = Number(stickerCfg.social?.sticker?.syncTtlMs);
  const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
  const now = Date.now();
  if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
    return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
  }
  try {
    const count = Math.min(500, Math.max(1, Number(stickerCfg.social?.sticker?.maxListCount) || 100));
    // NapCat 4.18：fetch_custom_face_detail 返回富对象（md5/resId/url/desc），
    // fetch_custom_face 只返回字符串 URL 数组（2026-09-06 实测 4.18.19）。优先 detail；
    // detail 不可用再回退 fetch_custom_face 并按 URL 推导 md5（尾段大写 MD5）。
    let payload = null;
    try { payload = await botRef.request('fetch_custom_face_detail', { count }); }
    catch (e0) {
      if (!String(e0?.message ?? '').includes('fetch_custom_face')) throw e0;
      payload = null;
    }
    if (payload === null || payload === undefined) {
      try { payload = await botRef.request('fetch_custom_face', { count }); }
      catch (e1) { payload = null; if (!String(e1?.message ?? '').includes('fetch_custom_face')) throw e1; }
    }
    if (payload === null || payload === undefined) throw new Error('fetch_custom_face(_detail) 不可用');
    const arr = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.data) ? payload.data
        : (Array.isArray(payload?.list) ? payload.list
          : (Array.isArray(payload?.faces) ? payload.faces
            : (Array.isArray(payload?.customFaceList) ? payload.customFaceList : null))));
    if (!Array.isArray(arr)) throw new Error('fetch_custom_face 返回结构无法识别，已放弃同步');
    // 从收藏 URL（…/0 或 …/<md5>_0_0）提取尾段大写 MD5；取不到才保留原值。
    const md5FromUrl = (u) => {
      const s = String(u ?? '');
      const m = /([0-9A-F]{32})(?:_0_0|\/0|\/|$)/i.exec(s);
      return m ? m[1].toUpperCase() : '';
    };
    const fetched = arr.map((f) => {
      const o = (f && typeof f === 'object') ? f : null;
      if (typeof f === 'string' && f.trim()) {
        // fetch_custom_face：纯 URL 字符串项 → url 本身即图片地址，id 取 md5
        const url = f.trim();
        const md5 = md5FromUrl(url);
        const emojiId = md5 || url;
        return { id: emojiId, emojiId, md5: md5 || emojiId, url, desc: '', size: '', name: '' };
      }
      const src = o || {};
      const rawUrl = String(src.url ?? src.qurl ?? src.file ?? '');
      const md5 = String(src.md5 ?? src.emojiMd5 ?? md5FromUrl(rawUrl) ?? '').trim().toUpperCase();
      const emojiId = String(src.emojiId ?? src.emoji_id ?? src.resId ?? src.id ?? md5 ?? rawUrl ?? '').trim();
      if (!emojiId && !rawUrl) return null;
      return {
        id: emojiId, emojiId,
        md5: md5 || emojiId,
        url: rawUrl,
        desc: String(src.desc ?? src.description ?? src.emojiName ?? '').slice(0, 60),
        size: src.size ? String(src.size) : '',
        name: String(src.name ?? src.emojiName ?? src.emoji_name ?? '').slice(0, 60)
      };
    }).filter(Boolean);
    // 【2026-09-12 修「收藏表情库被清空」】NapCat 刚重启/QQ 缓存还没就绪时，`fetch_custom_face` 会
    // **成功地返回空数组**（不是报错）。而下面的 `mergeStickerLibrary` 语义是"以 fetch 到的为准"，
    // 于是空数组会把本地整库抹掉 —— 实测 2026-09-12 01:29:57 启动时 19 条收藏表情被清成 0 条，
    // 之后再没有自动恢复（同步有 TTL，且只有在被调用时才会跑）。
    // 空结果绝不覆盖已有库：那不是"用户清空了收藏"，只是对面还没准备好。
    if (fetched.length === 0 && stickerEntries.length > 0) {
      stickerSyncedAt = Date.now();
      log(`[sticker] NapCat 本次返回 0 个收藏表情（多为 QQ 刚重启、缓存未就绪）—— 保留本地 ${stickerEntries.length} 条，不覆盖`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    }
    stickerEntries = mergeStickerLibrary(stickerEntries, fetched);
    stickerSyncedAt = Date.now();
    saveStickerStoreSafe();
    log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
    return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
  } catch (error) {
    log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
    return null;
  }
}

// 返回给 AI 的表情列表（带本地认知）。
export async function listStickersFor(query = '', count = 48, force = false) {
  const synced = await syncStickerLibrary(force);
  const entries = synced?.entries ?? stickerEntries;
  return formatStickerList(entries, query, count);
}

// 取单个表情的图片字节（多模态用）。
export async function getStickerImageData(stickerId) {
  const synced = await syncStickerLibrary(false);
  const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
  if (!entry) {
    // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
    const forced = await syncStickerLibrary(true);
    const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
    if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    return entry2;
  }
  return entry;
}

// 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
export async function sendSticker2(key, stickerRef, options = {}) {
  // 发送前用缓存同步（TTL 内不刷新，提速）；找不到时才强制刷新重试。
  let synced = await syncStickerLibrary(false);
  let entry = synced ? findSticker(synced?.entries ?? stickerEntries, stickerRef) : null;
  if (!entry) {
    synced = await syncStickerLibrary(true);
    entry = synced ? findSticker(synced?.entries ?? stickerEntries, stickerRef) : null;
  }
  if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
  const url = entry.url;
  if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
  const [kind, id] = key.split(':');
  const segments = [];
  const replyToMessageId = options.replyToMessageId;
  const atUserId = options.atUserId;
  // 常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
  // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const rid = String(replyToMessageId).trim();
    if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    segments.push({ type: 'reply', data: { id: rid } });
  }
  if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
    const at = String(atUserId).trim();
    if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
    segments.push({ type: 'at', data: { qq: at } });
    // QQ 规范：@昵称 后跟表情/图片要用空格隔开，避免渲染粘连（与文本发送的 at 后补空格一致）
    segments.push({ type: 'text', data: { text: ' ' } });
  }
  // 发送前校验：收藏表情 URL 必须是公网 http(s)，防止本地库被污染后诱导 OneBot 抓取内网/本机地址；
  // 本地上传表情（管理端“上传表情包图库”写入的 local:// 条目）直接用本地文件路径发送。
  // 关键：image 段一律带 sub_type=1 —— NapCat 的 createValidSendPicElement 会把 sub_type 原样写入
  // picElement.picSubType；QQ 图片 subType=1 表示“表情”上传通道，收端按表情泡泡渲染而非普通大图
  // （此前漏传 → 默认 0=普通图片，用户看到的是“大图”）。
  if (url.startsWith('local://')) {
    segments.push({ type: 'image', data: { file: url.slice('local://'.length), sub_type: 1 } });
  } else {
    try {
      await validateFetchUrl(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    // 远程收藏表情：先下载字节落到本机临时目录，再把【本地文件路径】交给 NapCat。
    // 直接传 http URL 时 NapCat 会按“普通网络图片”下载发送，清晰度差且收方看到的是图片不是表情；
    // 传本地原图文件路径后 NapCat 走本机图片上传，QQ 端按收藏表情 md5 命中渲染（真人发表情效果）。
    let imgBuf = null;
    let imgMime = '';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0) { imgBuf = buf; imgMime = String(res.headers.get('content-type') || '').split('/')[1] || 'img'; }
      }
    } catch (eImg) {
      log(`[sticker] 收藏表情原图下载失败 ${entry.id}（将改用 URL 直发兜底）: ${eImg?.message ?? eImg}`);
    }
    if (imgBuf && imgBuf.length > 0) {
      const localFile = writeStickerTmpFile(imgBuf, imgMime);
      segments.push({ type: 'image', data: { file: localFile, sub_type: 1 } });
    } else {
      segments.push({ type: 'image', data: { file: url, sub_type: 1 } });
    }
  }
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
  const httpUrl = String(stickerCfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  // 与文本发送共用发送链（core/send-chain），保证“先文字后表情”的真人顺序不被并发工具调用打乱。
  let sendResolve;
  let sendReject;
  let settled = false;
  const sendResult = new Promise((resolve, reject) => {
    sendResolve = (v) => { settled = true; resolve(v); };
    sendReject = (e) => { settled = true; reject(e); };
  });
  const sendRun = enqueueSend(async () => {
    try {
      // 真人发表情前通常会有短暂停顿（已缩短，避免发图太慢）。
      await sleep(randInt(300, 700));
      const res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(stickerCfg.napcat?.accessToken ? { authorization: `Bearer ${stickerCfg.napcat.accessToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
        const hint = res.status === 426 ? '（HTTP 426：napcat.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址）' : '';
        throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
      }
      sendResolve(body.data);
    } catch (error) {
      sendReject(error);
    }
  }, key);
  // 会话重置/隔离（cancelKeyedSends）时 send-chain 会跳过已入链但未开始的任务——回调根本不会执行，
  // sendResult 就永不 settle，调用方（qq_send_sticker）会永久挂起；链上任务结算后仍未 settle 即补失败。
  void sendRun.then(
    () => { if (!settled) sendReject(new Error('发送任务已被会话重置取消（未发出）')); },
    (e) => { if (!settled) sendReject(e); }
  );
  const data = await sendResult;
  // 更新本地使用统计
  const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
  stickerEntries = updated.entries;
  saveStickerStoreSafe();
  return { entry: updated.entry, messageId: data?.message_id ?? null };
}

// 发送一个 QQ 自带表情（face，含动态大表情）。与文本/收藏表情发送共用发送链，保持真人顺序。
export async function sendQqFace2(key, faceId, faceName, options = {}) {
  const [kind, id] = key.split(':');
  const segments = [];
  const replyToMessageId = options.replyToMessageId;
  const atUserId = options.atUserId;
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const rid = String(replyToMessageId).trim();
    if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    segments.push({ type: 'reply', data: { id: rid } });
  }
  if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
    const at = String(atUserId).trim();
    if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
    segments.push({ type: 'at', data: { qq: at } });
    // QQ 规范：@昵称 后跟 QQ 原生表情要用空格隔开，避免渲染粘连
    segments.push({ type: 'text', data: { text: ' ' } });
  }
  segments.push({ type: 'face', data: { id: Number(faceId) } });
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
  const httpUrl = String(stickerCfg.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  let sendResolve;
  let sendReject;
  let settled = false;
  const sendResult = new Promise((resolve, reject) => {
    sendResolve = (v) => { settled = true; resolve(v); };
    sendReject = (e) => { settled = true; reject(e); };
  });
  const sendRun = enqueueSend(async () => {
    try {
      await sleep(randInt(500, 1500));
      const res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(stickerCfg.napcat?.accessToken ? { authorization: `Bearer ${stickerCfg.napcat.accessToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
        const hint = res.status === 426 ? '（HTTP 426：napcat.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 napcat.httpUrl 是否为 OneBot HTTP API 地址）' : '';
        throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
      }
      sendResolve(body.data);
    } catch (error) {
      sendReject(error);
    }
  }, key);
  // 同 sendSticker2：被会话重置跳过的任务必须让 Promise 落地，否则 qq_send_qq_face 永久挂起。
  void sendRun.then(
    () => { if (!settled) sendReject(new Error('发送任务已被会话重置取消（未发出）')); },
    (e) => { if (!settled) sendReject(e); }
  );
  const data = await sendResult;
  return { messageId: data?.message_id ?? null, faceId: Number(faceId), name: faceName || '' };
}


// P6-2 追加：表情临时文件（add_custom_face 需要传入 NapCat 进程可读的本地文件路径）

export function writeStickerTmpFile(buffer, extHint) {
  // 本机部署（Windows/裸机）：bridge 与 NapCat 同机，临时文件写项目内目录即可，
  // add_custom_face 直接用返回的绝对路径读取。曾误用服务器 Docker 挂载路径
  // （/root/napcat/... ↔ /app/napcat/...），本机不存在 → ENOENT 收藏失败。
  const hostDir = path.join(path.dirname(STICKER_FILE), '..', 'state', 'sticker-tmp');
  fs.mkdirSync(hostDir, { recursive: true });
  // 简单清理 30 分钟前的旧文件，避免堆积。
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(hostDir)) {
      const p = path.join(hostDir, f);
      try { if (now - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(p); } catch {}
    }
  } catch {}
  const ext = String(extHint || '').replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'img';
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const hostPath = path.join(hostDir, name);
  fs.writeFileSync(hostPath, buffer);
  return hostPath;
}


// P6-5 追加：备注/收藏工具

export function applyStickerNote2(stickerId, note, tags, usage) {
  const patch = {};
  if (note !== undefined && note !== null) patch.note = String(note);
  if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
  if (usage !== undefined && usage !== null) patch.usage = String(usage);
  const updated = applyStickerNote(stickerEntries, stickerId, patch);
  if (!updated.entry) return null;
  updateStickerEntries(updated.entries);
  saveStickerStoreSafe();
  return updated.entry;
}

export async function setStickerRemark2(stickerId, remark) {
  const synced = await syncStickerLibrary(false);
  const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
  if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
  const cleanRemark = String(remark ?? '').trim().slice(0, 50);
  const response = await botRef.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
  if (!response || response.status !== 'ok' || response.retcode !== 0) {
    throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
  }
  const updated = applyStickerNote(stickerEntries, entry.id, {});
  // 直接改 desc（保留本地认知）
  const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
  }
  updateStickerEntries(updated.entries);
  saveStickerStoreSafe();
  return stickerEntries.find((e) => e.id === entry.id) || null;
}

export async function collectSticker2(key, messageRef, remark) {
  // NapCat OneBot11 并非所有版本都暴露 add_custom_face（私有协议动作）。探测一次后缓存：
  // 不支持时给出清晰提示，避免每次收藏都抛底层错误刷屏。
  if (collectFaceSupported === false) {
    throw new Error('本机 NapCat 不支持自动收藏（add_custom_face 动作不可用）。可以让对方手动收藏，或跳过这一步继续。');
  }
  const st = getSocialState(key);
  const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
  if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
  if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
  const mediaList = Array.isArray(found.media) ? found.media : [];
  if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
  const media = mediaList[0];
  let file = '';
  let tmpFile = '';
  let imageBuffer = null;
  if (media?.kind === 'image') {
    // 优先取图片字节写本地临时文件，避免 NapCat 直接下载聊天图片 URL 失败（带签名/防盗链）。
    // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
    // NapCat 的 add_custom_face 只接受本地文件路径，传 base64 会报 ENAMETOOLONG。
    const img = await fetchOneBotImage(media);
    if (img?.buffer) {
      tmpFile = writeStickerTmpFile(img.buffer, String(img.mimeType || '').split('/')[1] || 'img');
      imageBuffer = img.buffer;
    } else {
      throw new Error('无法安全获取该图片字节，已拒绝收藏');
    }
  } else if (media?.kind === 'face') {
    const face = await fetchFaceMedia(media);
    if (face?.buffer) {
      tmpFile = writeStickerTmpFile(face.buffer, String(face.mimeType || '').split('/')[1] || 'img');
      imageBuffer = face.buffer;
    }
  }
  if (!tmpFile) throw new Error('无法获取该表情的图片源');
  file = tmpFile;
  const maxRemarkChars = Math.max(1, Number(stickerCfg.social?.sticker?.collect?.maxRemarkChars) || 20);
  const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
  // NapCat 的 add_custom_face 只保证“添加成功”，响应不保证返回 emoji_id（实测 retcode=0 但 data 无该字段），
  // 因此不能依赖响应里的 emoji_id：用图片 md5 / “新增条目”从强制同步后的收藏列表里定位刚收藏的表情。
  const imageMd5 = imageBuffer ? crypto.createHash('md5').update(imageBuffer).digest('hex').toUpperCase() : '';
  const beforeIds = new Set((stickerEntries || []).map((e) => e && e.id).filter(Boolean));
  let addRes = null;
  let addError = null;
  try {
    addRes = await botRef.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      addError = new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
  } catch (error) {
    addError = error;
  }
  if (addError) {
    const rawErr = String(addError?.message || addError || '');
    if (/不支持的API|不支持.*(?:动作|接口)|Unsupported|not support|unknown action/i.test(rawErr)) {
      // NapCat OneBot11 不暴露 add_custom_face：置缓存标记，降级为「本地图库收藏」——
      // 图片字节存进本地上传图库（local://），模型仍可 qq_send_sticker 发出去。
      collectFaceSupported = false;
      log('[sticker] add_custom_face 不可用，收藏降级为本地图库');
      const localEntry = saveStickerToLocalLibrary(imageBuffer, cleanRemark);
      if (localEntry) {
        return { emojiId: localEntry.id, entry: localEntry, remark: cleanRemark, local: true, mode: 'local' };
      }
      throw new Error('本机 NapCat 不支持自动收藏（add_custom_face 动作不可用），且该图片字节无法获取存本地库。可以让对方手动收藏，或跳过这一步。');
    }
  }
  // 强制刷新本地库，让刚收藏的表情立即可用。
  const synced = await syncStickerLibrary(true);
  const entries = synced?.entries ?? stickerEntries;
  let entry = imageMd5 ? findSticker(entries, imageMd5) : null;
  if (!entry) entry = (entries || []).find((e) => e && !beforeIds.has(e.id)) || null;
  if (!entry && addError) {
    // add 真实失败且 md5/新增都定位不到：报告失败（同一张图已收藏过时 md5 会命中，不会走到这里）。
    throw addError;
  }
  if (!entry) {
    // add 成功但 md5/新增条目都定位不到：兜底取最新同步的 QQ 来源条目（理论极少发生）。
    entry = (entries || []).filter((e) => e && e.source === 'qq').sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
  }
  if (!entry) {
    log(`[sticker] add_custom_face 成功但收藏列表里定位不到新增表情（md5=${imageMd5 || '无'}）`);
    return { emojiId: String(addRes?.data?.emoji_id || ''), entry: null, remark: cleanRemark };
  }
  const emojiId = entry.id;
  if (cleanRemark) {
    // 本地 AI 认知备注（必存）：让 AI 记住这个表情的含义。
    const noted = applyStickerNote(stickerEntries, emojiId, { note: cleanRemark });
    if (noted.entry) {
      updateStickerEntries(noted.entries);
      saveStickerStoreSafe();
    }
    // QQ 侧 desc（尽力）：NapCat 的接口是 set_custom_face_desc（modify_custom_face 不存在）；
    // 自定义表情没有数字 emoji_id 时该接口可能失败，失败不致命，本地备注已保留。
    try {
      const descRes = await botRef.request('set_custom_face_desc', {
        emoji_id: emojiId,
        res_id: entry.resId || emojiId,
        md5: entry.md5 || '',
        desc: cleanRemark
      });
      if (!descRes || descRes.status !== 'ok' || descRes.retcode !== 0) {
        log(`[sticker] 收藏成功但 QQ desc 设置失败 ${emojiId}: ${descRes?.wording || descRes?.retcode || 'unknown'}`);
      }
    } catch (error) {
      log(`[sticker] 收藏成功但 QQ desc 设置异常 ${emojiId}: ${error?.message ?? error}`);
    }
  }
  // 返回带本地认知的最新条目（applyStickerNote 后 stickerEntries 已更新）。
  const finalEntry = findSticker(stickerEntries, emojiId) || entry;
  return { emojiId, entry: finalEntry, remark: cleanRemark };
}
