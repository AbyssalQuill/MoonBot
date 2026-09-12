// 桥接唯一运行模式（default = default）共享状态（2026-09-06 二期单模式化）。
// 历史多模式已删除（chat / closed-agent / reserved 一代）：没有模式切换，
// 代码一律按default语义运行；白名单/黑名单访问控制保留（modeAllowed）。
// 兼容导出名保留，避免扩散 import 面；currentMode 恒为 'default'。
import { allowed } from '../lib/config.js';

export const VALID_MODES = ['default']; // 兼容旧引用：单模式

export const currentMode = 'default'; // 恒为唯一模式（default）
export const closedAgentPreset = 'router-standard'; // 兼容旧引用（不再使用）

export let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）

let cfgRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initModeCore(cfg) {
  cfgRef = cfg;
}

/** 单模式：忽略任何切换请求（DSH 设置/控制台写入不再生效） */
export function setCurrentMode() {}

export function setClosedAgentPreset() {}

export function setSelfNickname(nickname) {
  selfNickname = nickname;
}

/** 会话访问控制：保留白名单/黑名单（allow/deny/allowAllWhenEmpty），模式维度恒放行 */
export function modeAllowed(key, kind, id, cfg, _mode) {
  return allowed(kind, id, cfg);
}

/** 会话使用的 agent preset：唯一模式（default）优先 social.agentPreset */
export function modePreset(key, _mode, cfg) {
  return cfg?.social?.agentPreset || cfg?.agentPreset || undefined;
}

/** 判断一个会话 key 是否被白名单允许（供唤醒调度与 HTTP 路由共用）。 */
export function isSessionAllowedInCurrentMode(key) {
  const m = /^(group|private):(\d+)$/.exec(key);
  if (!m) return false;
  return modeAllowed(key, m[1], Number(m[2]), cfgRef);
}
