// 媒体管道：OneBot 图片/表情抓取、压缩、多图解析
// cfg 注入（initMediaPipeCore），bot 注入（setMediaPipeBot）。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { log } from '../lib/log.js';
import { MAX_MEDIA_COUNT } from './session-state.js';
import { safeFetchBuffer, looksLikeImageBuffer } from '../safe-fetch.js';
import { isProbablySafeImageFileRef, isSafeLocalMediaPath } from '../lib/media-guard.js';
import { mimeFromBuffer, mimeFromUrl, base64FromMaybe } from '../lib/media-meta.js';
import { finalizeImageBuffer, ensureDeliverableImage, IMAGE_HARD_MAX_SIDE } from '../lib/image-compress.js';
import { visionSplitEnabled as useVisionSplit, describeImageWithVisionModel } from './vision.js';
// 【2026-09-21 表情包理解】收到 QQ 原生表情、又拿不到在线描述时，用本地 id→中文名表兜底
import { faceNameById } from '../qq-faces.js';

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 单条消息图片总字节上限（调大以支持收藏大图/大 gif；safeFetchBuffer 调用处显式传参）
export const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
export const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

let cfgRef = null;
let botRef = null;
export function initMediaPipeCore(cfg) { cfgRef = cfg; }
export function setMediaPipeBot(bot) { botRef = bot; }

export function getImageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) return null;
        // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
        const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
        return { width, height };
      }
      if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = [buf[21], buf[22], buf[23], buf[24]];
        const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
        const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
        return { width, height };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
    }
  } catch {}
  return null;
}

export async function fetchOneBotImage(media, opts = {}) {
  /* 【2026-09-22 主人要求「默认转发原图，别压缩」】raw=true 时**原样返回抓到的字节**：
   * 喂给视觉模型那条路必须压缩（缩到 1280px 内、40KB 以上就重编码，为的是 token 与被 DSH 附件层
   * 拒收的风险），但「把这张图转出去」要的是**原图** —— 压缩过的副本转出去，对方拿到的就是
   * 二次编码的糊图。安全闸门照旧（字节上限、像素上限、魔术字校验），只是不做重编码。 */
  const raw = opts.raw === true;
  const asIs = (buf, mime) => (raw ? { buffer: buf, mimeType: mime, compressed: false } : finalizeImageBuffer(buf, mime));
  // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
  if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
    try {
      /* 【2026-09-16】NapCat 侧内核下载图片有时会超时（主人桌面 napcat.log 里的
       * `Timeout: NTEvent NodeIKernelMsgService/downloadRichMedia`）——那是 NapCat 去 QQ CDN 拉文件失败。
       * 以前这里要等满 12 秒才会落到"直接用消息段 URL 自己抓"这条兜底上，一张图就把唤醒拖十几秒。
       * 现在 6 秒就放弃 get_image，马上走 URL 直连（桥自己抓通常更快，也不受 QQ 客户端下载队列影响）。 */
      const info = await botRef.getImage({ file: String(media.file) }, { timeoutMs: 6000 });
      const obj = info && typeof info === 'object' ? info : {};
      const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
      if (base64) {
        // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
        if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
          const buf = Buffer.from(base64, 'base64');
          if (buf.length > 0 && looksLikeImageBuffer(buf)) {
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return await asIs(buf, mimeFromBuffer(buf));
            }
          }
        } else {
          log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
        }
      }
      if (obj.url) {
        const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return await asIs(fetched.buffer, mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url));
        }
      }
      if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file, cfgRef.napcat?.homeDir)) {
        const stat = fs.statSync(obj.file);
        if (stat.size > MAX_MEDIA_BYTES) {
          log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
        } else {
          const buf = fs.readFileSync(obj.file);
          const dims = getImageDimensions(buf);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else if (!looksLikeImageBuffer(buf)) {
            // 字节魔术字校验：与上面的 base64 分支对齐。缺这一步时，NapCat 缓存里若出现
            // 非 PNG/JPEG/GIF/WebP 的文件（BMP/AVIF/TIFF…），会带着猜出来的 mime 直送 DSH，
            // 触发 INVALID_IMAGE 把**整条 prompt**（含文字）拒收。
            log(`本地缓存文件不是可识别的图片格式，已跳过（${Math.round(buf.length / 1024)}KB）`);
          } else {
            // 本机缓存文件同样必须过压缩/降采样（**投递给模型**那条路）：此前这条分支直接返回原图，
            // 长截图等单边 > DSH per-side 上限的图会被整条 prompt 拒收。转发（raw）时按字节原样给。
            return await asIs(buf, mimeFromBuffer(buf));
          }
        }
      }
    } catch (error) {
      log(`get_image 解析失败: ${error?.message ?? error}`);
    }
  }
  // 其次直接用消息段里的 URL
  if (media.url) {
    try {
      const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
      const dims = getImageDimensions(fetched.buffer);
      if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
        log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
      } else {
        return await asIs(fetched.buffer, mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url));
      }
    } catch (error) {
      log(`图片 URL 抓取失败: ${error?.message ?? error}`);
    }
  }
  return null;
}

export async function fetchFaceMedia(media, opts = {}) {
  const raw = opts.raw === true;
  const faceId = Number(media.faceId);
  /* 【2026-09-21 表情包理解】本地表兜底：拿不到 NapCat 的在线描述时，
   * 也要把 `[表情#123]`（一个数字，模型只能猜）降级成 `[表情:偷笑]`（一句情绪）。 */
  const localName = faceNameById(faceId);
  const fallbackText = localName ? `[表情:${localName}]` : `[表情#${media.faceId}]`;
  if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
  try {
    const face = await botRef.fetchFaceEntity(faceId, { timeoutMs: 12000 });
    if (face && typeof face === 'object') {
      const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || localName || '';
      if (face.url) {
        try {
          const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            const faceMime = mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url);
            // 转发（raw）要原图：表情也一样，别把对方的动图压成一张静图
            const fim = raw ? { buffer: fetched.buffer, mimeType: faceMime } : await finalizeImageBuffer(fetched.buffer, faceMime);
          return { buffer: fim.buffer, mimeType: fim.mimeType, text: desc ? `[表情:${desc}]` : '' };
          }
        } catch (error) {
          log(`表情图片抓取失败: ${error?.message ?? error}`);
        }
      }
      return { text: desc ? `[表情:${desc}]` : fallbackText };
    }
  } catch (error) {
    log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
  }
  return { text: fallbackText };
}

/**
 * 投递闸门：DSH 附件层对单边像素有硬限制（超限 = 整条 prompt 被 `attachment-error` 拒收，
 * 桥侧表现为「⚠️ 消息未被接受」）。这里保证只要交出去的图一定合规；不合规就退化成文字占位，
 * 宁少一张图，也不要因为一张图把整轮唤醒/回复吞掉。
 */
async function gateImage(buffer, mimeType, label) {
  const checked = await ensureDeliverableImage(buffer, mimeType);
  if (checked.ok) return { ok: true, buffer: checked.buffer, mimeType: checked.mimeType };
  log(`[media] ${label} 尺寸不合规，已跳过不投递 DSH：${checked.reason}（硬上限单边 ${IMAGE_HARD_MAX_SIDE}px）`);
  return { ok: false, reason: checked.reason };
}

/* 【2026-09-16】占位文案要**明确告诉模型"这张图没到你手上"**：
 * 以前只写 `[图片（获取失败）]`，模型容易顺着上下文"脑补"图里有什么（主人报的"看图乱猜"）。
 * 现在占位文案直接把规则写进去：看不到就如实说、不要猜内容、也不要描述样子。 */
const MEDIA_PLACEHOLDER_HINT = '—— 这张图没能投递给你，看不到就如实说"图没加载出来"，不要猜内容';
export async function resolveOneMedia(media, opts = {}) {
  const raw = opts.raw === true;
  if (!media || typeof media !== 'object') return { ok: false, fallbackText: '' };
  if (media.kind === 'face') {
    const face = await fetchFaceMedia(media, opts);
    if (face.buffer) {
      if (raw) return { ok: true, face: true, buffer: face.buffer, mimeType: face.mimeType || 'image/png', faceText: face.text || '', raw: true };
      const g = await gateImage(face.buffer, face.mimeType || 'image/png', `表情#${media.faceId ?? ''}`);
      if (g.ok) return { ok: true, face: true, buffer: g.buffer, mimeType: g.mimeType, faceText: face.text || '' };
      return { ok: false, fallbackText: `${face.text || `[表情#${media.faceId}]`}（尺寸过大，已跳过${MEDIA_PLACEHOLDER_HINT}）` };
    }
    return { ok: false, fallbackText: face.text || `[表情#${media.faceId}]` };
  }
  const img = await fetchOneBotImage(media, opts);
  if (img?.buffer) {
    // 转发（raw）：只做安全校验，不做压缩/降采样 —— 这一步正是"默认转发原图"的实现点
    if (raw) return { ok: true, face: false, buffer: img.buffer, mimeType: img.mimeType || 'image/jpeg', raw: true };
    const g = await gateImage(img.buffer, img.mimeType || 'image/jpeg', '图片');
    if (g.ok) return { ok: true, face: false, buffer: g.buffer, mimeType: g.mimeType };
    return { ok: false, fallbackText: `[图片（尺寸过大已跳过：${g.reason}）${MEDIA_PLACEHOLDER_HINT}]` };
  }
  return { ok: false, fallbackText: `[图片（获取失败）${MEDIA_PLACEHOLDER_HINT}]` };
}

export async function resolveMediaList(mediaList) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const limited = [];
  let index = 0;
  for (const media of list) {
    index += 1;
    if (index > MAX_MEDIA_COUNT) {
      limited.push({ media: null, index, overLimit: true });
      continue;
    }
    if (!media || typeof media !== 'object') continue;
    limited.push({ media, index, overLimit: false });
  }
  // 并行解析全部图片/表情（每张内部已有 12s 短超时），避免多图串行卡住唤醒/回复
  const results = await Promise.all(limited.map(async ({ media, index, overLimit }) => {
    if (overLimit) return { type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` };
    const r = await resolveOneMedia(media);
    if (!r.ok) return { type: 'text', text: r.fallbackText || `[图片${index}（获取失败）]` };
    return r;
  }));
  const parts = [];
  let totalBytes = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    const idx = limited[i]?.index ?? i + 1;
    if (r.type === 'text') { parts.push(r); continue; }
    const size = r.buffer.length;
    if (totalBytes + size > MAX_MEDIA_BYTES) {
      parts.push({ type: 'text', text: r.face ? `[表情${idx}（图片总大小超限，已跳过）]` : `[图片${idx}（图片总大小超限，已跳过）]` });
      continue;
    }
    totalBytes += size;
    if (r.face) {
      if (r.faceText) parts.push({ type: 'text', text: r.faceText });
      parts.push({ type: 'image', mediaType: r.mimeType, data: r.buffer.toString('base64'), name: `face-${idx}.${(r.mimeType || 'png').split('/')[1]}` });
      continue;
    }
    /* 【2026-09-19】配了「识图模型请求地址」→ 走独立识图通路：图片不进上下文，只把**文字描述**交给语言模型。
     * 失败（超时/非 2xx/没文字）就退回附件，绝不让识图故障变成"图丢了"。 */
    if (useVisionSplit()) {
      const d = await describeImageWithVisionModel(r.buffer, r.mimeType);
      if (d.ok) {
        log(`[vision] 图片${idx} 由独立识图模型 ${d.model} 转成文字（${d.text.length} 字，${d.ms}ms）`);
        parts.push({ type: 'text', text: `[图片${idx}] ${d.text}` });
        continue;
      }
      log(`[vision] 图片${idx} 独立识图失败（${d.error}），退回附件方式发给主模型`);
    }
    parts.push({ type: 'text', text: `[图片${idx}]` });
    parts.push({ type: 'image', mediaType: r.mimeType, data: r.buffer.toString('base64'), name: `qq-image-${idx}.${(r.mimeType || 'jpeg').split('/')[1]}` });
  }
  return parts;
}

export async function fetchMediaData(mediaList, opts = {}) {
  const raw = opts.raw === true;
  const list = Array.isArray(mediaList) ? mediaList : [];
  const limited = [];
  let index = 0;
  for (const media of list) {
    index += 1;
    if (index > MAX_MEDIA_COUNT) {
      limited.push({ media: null, index, overLimit: true });
      continue;
    }
    if (!media || typeof media !== 'object') continue;
    limited.push({ media, index, overLimit: false });
  }
  const results = await Promise.all(limited.map(async ({ media, index, overLimit }) => {
    if (overLimit) return { index, kind: 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` };
    const r = await resolveOneMedia(media, opts);
    if (!r.ok) {
      return {
        index,
        kind: media?.kind === 'face' ? 'face' : 'image',
        ...(media?.kind !== 'face' ? { file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined } : {}),
        text: r.fallbackText || '（图片获取失败）'
      };
    }
    const out = {
      index,
      kind: r.face ? 'face' : 'image',
      mimeType: r.mimeType,
      data: r.buffer.toString('base64'),
      bytes: r.buffer.length,
      text: r.face ? (r.faceText || '') : ''
    };
    // raw=1（转发用）：如实标出这是**未经压缩的原图字节**
    if (raw) {
      out.raw = true;
      out.sha256 = createHash('sha256').update(r.buffer).digest('hex');
    }
    if (r.face) {
      if (media.faceId != null) out.faceId = String(media.faceId);
    } else {
      if (media.file) out.file = String(media.file);
      if (media.url) out.url = String(media.url);
    }
    return out;
  }));
  let totalBytes = 0;
  const out = [];
  for (const r of results) {
    if (!r) continue;
    if (r.data) {
      const size = Math.round(r.data.length * 3 / 4);
      if (totalBytes + size > MAX_MEDIA_BYTES) {
        out.push({ ...r, data: undefined, mimeType: undefined, text: `${r.text || ''}（图片总大小超限，已跳过）` });
        continue;
      }
      totalBytes += size;
    }
    out.push(r);
  }
  return out;
}
