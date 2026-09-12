// 行为标记/工具名谓词

// 社交模式"静默标记"：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在"不想接话/潜水"时有合法沉默出口，而不是写"（内心戏）"被当成消息发出去。
export const SILENT_MARKER = '[SILENT]';

export function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免"工具发一条 + 自动转发一条"的重复。
// Send tools are named qq_send_message etc.; accept bare names and mcp__<service>__ prefixes (historically napcat).
export const SEND_TOOL_RE = /^(?:mcp__[a-z0-9_-]+__)?qq_(send_group_message|send_private_message|reply|send_burst|send_message|send_sticker|send_qq_face|send_whale_meme|send_poke|proactive_send|send_docx|send_forward|send_rich)$/;

export function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示（P5-5 自 bridge.js 模块级迁入）：真人聊天不会主动用空格，空格被当作"分条信号"。
export const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示（P5-5 迁入）
export const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 审批回复词（P6-4 自 bridge.js 模块级迁入）
export const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
export const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);
