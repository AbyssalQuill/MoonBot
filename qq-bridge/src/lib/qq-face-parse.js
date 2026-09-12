// 表情/图片占位符 → QQ 原生 face 的解析工具
import { resolveFaceRef } from '../qq-faces.js';

// 从占位内容里提取 QQ 原生 face id（如 [表情:害羞(148)] → 148；[QQ表情:148] → 148）
export function faceIdFromArtifactContent(content) {
  const c = String(content ?? '').replace(/^[^:：]*[:：]?\s*/, '').trim();
  const num = /(?:^|[（(])(\d{1,4})(?:[）)]|$)/.exec(c);
  if (num) {
    const id = Number(num[1]);
    // 下限 1 → 0（2026-09-11）：NapCat 运行时 sysface 表里 **id 0 = 惊讶**，是合法表情，
    // 原守卫会把「惊讶」整条挡掉（实测 [QQ表情:惊讶] 解析为 null）。
    // 上限 400 → 999：表已按 sysface 整体重映射，出现 462（无语）、360（亲亲）等 >400 的合法 id，
    // 原上限会让**纯数字**引用（[QQ表情:462]）走不到数字路径。正则本身已限 4 位数字，放宽不引入新误判。
    if (id >= 0 && id <= 999) return id;
  }
  return null;
}

// 占位内容按名字解析 face（如 [QQ表情:旺柴] / [表情:狗头] → 真 QQ 原生表情）
export function resolveArtifactFaceId(content) {
  const numeric = faceIdFromArtifactContent(content);
  if (numeric != null) return numeric;
  const name = String(content ?? '')
    .replace(/^[^:：]*[:：]?\s*/, '')        // 去前缀（QQ表情: / 表情: …）
    .replace(/\s*[（(]?\d{1,4}[）)]?\s*$/, '') // 去尾部 (id)
    .trim();
  if (!name) return null;
  try {
    const f = resolveFaceRef(name);
    // 同样放宽到 0：NapCat 的 id 0 = 惊讶（原 `>= 1` 会让「惊讶」走名字路径时也解析失败）
    if (f && f.id != null && Number(f.id) >= 0) return Number(f.id);
  } catch {}
  return null;
}
