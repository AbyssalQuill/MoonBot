// 路径常量（原 bridge.js 模块级 56–69 / 536）
// 纯路径推导，供全桥各模块复用；消费方用这些名字 import。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..'); // src/lib → qq-bridge 根
export const STATE_DIR = path.join(ROOT, 'state');
export const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
export const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
export const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
export const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
export const SOCIAL_STATE_FILE = path.join(STATE_DIR, 'social-state.json');
export const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
export const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
export const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
export const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
export const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
export const CROSSCHAT_FILE = path.join(STATE_DIR, 'crosschat.json'); // 跨会话互知/留言信箱（2026-09-03）
export const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock'); // 单实例锁（值与原 bridge.js 一致）
