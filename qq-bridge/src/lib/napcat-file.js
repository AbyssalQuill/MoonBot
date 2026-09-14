// NapCat 图片参数归一化（2026-09-15 新增）
//
// 背景（主人实测的严重故障）：桥把**宿主机的绝对路径**（如
// `/root/qq-bridge/state/sticker-tmp/1789397607787-o217kf.jpeg`）直接塞进 image 段的 `file`
// 交给 NapCat，而服务器上 NapCat 跑在 Docker 里 —— 容器内根本看不到宿主路径，
// NapCat 报 `文件处理失败: 识别URL失败, uri= /root/...`，于是「表情包一张都发不出去」。
// 本机（Windows 裸机）部署时同机能读，所以本地一直正常，一到服务器就全灭。
//
// 这里把「宿主文件路径」统一换成 NapCat 一定能读到的形态，三种模式：
//   · `path`   —— 原样传路径（本机裸机部署的既有行为，默认值，保持不动）；
//   · `base64` —— 读字节转 `base64://…`（跨容器/跨机都能发，代价是体积 +33%）；
//   · `auto`   —— 先看 `napcat.dockerPathMap` 能不能把宿主路径映射成**容器内路径**
//                 （服务器 NapCat 容器挂了 `-v /root/napcat/config:/app/napcat/config`，
//                  写进映射目录的文件容器里能直接读到，gif 动图也能播）；
//                 映射不上再退回 base64；都不可行才原样传路径。
// 服务器部署请在 config.json 里：
//   "napcat": {
//     "imageFileMode": "auto",
//     "tmpDir": "/root/napcat/config/moonbot-tmp",
//     "dockerPathMap": [{ "host": "/root/napcat/config", "container": "/app/napcat/config" }]
//   }
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

/** base64 直传的体积上限（超过就退回路径，避免把 NapCat 的 HTTP 体撑爆） */
export const DEFAULT_BASE64_MAX_BYTES = 10 * 1024 * 1024;

const MODES = new Set(['path', 'base64', 'auto']);

export function resolveImageFileMode(cfg) {
  const raw = String(cfg?.napcat?.imageFileMode ?? 'path').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'path';
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/** 宿主路径 → 容器路径（按 cfg.napcat.dockerPathMap 最长前缀匹配）；映射不上返回 null */
export function rewriteToContainerPath(filePath, cfg) {
  const maps = Array.isArray(cfg?.napcat?.dockerPathMap) ? cfg.napcat.dockerPathMap : [];
  const target = norm(filePath);
  if (!target) return null;
  let best = null;
  for (const m of maps) {
    const h = norm(m?.host);
    const c = norm(m?.container);
    if (!h || !c) continue;
    if (target === h || target.startsWith(h + '/')) {
      if (!best || h.length > norm(best.host).length) best = { host: h, container: c };
    }
  }
  if (!best) return null;
  return best.container + target.slice(best.host.length);
}

/**
 * 把「桥这边的文件路径」换成可以交给 NapCat 的 file 参数。
 * 已经是 base64:// / file:// / http(s):// 的原样返回。
 */
export function napcatImageFileArg(filePath, cfg, opts = {}) {
  const p = String(filePath ?? '');
  if (!p) return p;
  if (/^(base64|file|https?):\/\//i.test(p)) return p;
  const mode = resolveImageFileMode(cfg);
  const logger = typeof opts.log === 'function' ? opts.log : log;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_BASE64_MAX_BYTES;

  if (mode === 'path') return p;

  const mapped = rewriteToContainerPath(p, cfg);
  if (mode === 'auto' && mapped) return mapped;

  let stat = null;
  try { stat = fs.statSync(p); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    // 读不到文件：交给下游报「图片文件不存在」，比在这里编一个路径更好定位。
    return mapped || p;
  }
  if (stat.size > maxBytes) {
    logger(`[napcat-file] ${path.basename(p)} 体积 ${(stat.size / 1048576).toFixed(1)}MB 超过 base64 上限，改传路径（需 NapCat 能读到该路径）`);
    return mapped || p;
  }
  try {
    return `base64://${fs.readFileSync(p).toString('base64')}`;
  } catch (e) {
    logger(`[napcat-file] 读取 ${p} 失败（改传路径）: ${e?.message ?? e}`);
    return mapped || p;
  }
}

/** 表情/图片临时落盘目录：配置了就用配置的（服务器指向容器挂载目录），否则项目内 state/sticker-tmp */
export function resolveStickerTmpDir(cfg, fallbackDir) {
  const configured = String(cfg?.napcat?.tmpDir ?? '').trim();
  const dir = configured || fallbackDir;
  if (!dir) throw new Error('resolveStickerTmpDir 需要配置目录或 fallbackDir');
  return dir;
}
