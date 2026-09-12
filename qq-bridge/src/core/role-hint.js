// 角色提示 + 媒体提示（2026-09-06 单模式化迁移自 social-v1.js）：
// default（default）仍在用的 currentRoleHint / currentRoleHint2 / mediaHintFor 独立成模块，
// 便于整删一代引擎（social-v1.js 观望状态机）后仍可被 console 等引用。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ROLE_STATE_FILE } from '../lib/paths.js';
import { readRoleState } from '../lib/role-access.js';
import { convertExampleSpacesToComma } from '../lib/cjk-split.js';

let roleHintCache = { key: '', hint: '' };

/** 当前角色人设原文（roles/*.md，按文件 mtime 缓存；不含模式守卫） */
export function currentRoleHint() {
  try {
    const rs = readRoleState();
    if (!rs.role) return '';
    const roleFile = path.join(ROOT, 'roles', rs.role + '.md');
    if (!fs.existsSync(roleFile)) return '';
    const stateStat = fs.statSync(ROLE_STATE_FILE);
    const roleStat = fs.statSync(roleFile);
    const cacheKey = `${stateStat.mtimeMs}:${roleStat.mtimeMs}`;
    if (roleHintCache.key === cacheKey) return roleHintCache.hint;
    let hint = fs.readFileSync(roleFile, 'utf8');
    if (hint.length > 6000) hint = hint.slice(0, 6000);
    roleHintCache = { key: cacheKey, hint };
    return hint;
  } catch {
    return '';
  }
}

/** default角色提示：过滤一代指令行（空格分条/自动转发/[SILENT] 等）与「回复示例」空格语义 */
export function currentRoleHint2() {
  const raw = currentRoleHint();
  if (!raw) return '';
  const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
  const lines = raw.split('\n');
  const kept = [];
  let inExampleSection = false;
  for (const line of lines) {
    if (/^##\s*.*回复示例/.test(line)) {
      inExampleSection = true;
      kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
      continue;
    }
    if (inExampleSection && /^##\s/.test(line)) {
      inExampleSection = false;
    }
    if (inExampleSection) {
      kept.push(convertExampleSpacesToComma(line));
    } else if (!GEN1_ROLE_LINE_RE.test(line)) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

/** 图片/表情消息提示（单默认模式=default语义：图片已随唤醒附上，必要时可调工具回看） */
export function mediaHintFor(key, messageRef, mediaList) {
  if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
  return `\n[Media] This message contains ${mediaList.length} image(s)/sticker(s) (messageId=${messageRef}). The newest one is already attached to this wake (view it directly). To see images in older messages, call mcp__napcat__qq_get_message_images (key="${key}", messageId="${messageRef}"). If an image fails to load / you cannot see its content: do NOT tell the peer "I can't see it" or "failed to load", do NOT ask them to resend or describe it - keep replying naturally to the conversation and skip image details rather than making them up.`;
}
