/**
 * 【由脚本生成，不要手改】MCP 工具 schema 体积表（单位：字符）。
 *
 * 数据来源：DSH 会话转录的 `request/header.tools`（用 qq-bridge/tools/emit-tool-chars.mjs 抽取）。
 * 为什么要这张表：单次模型请求里 **约 87% 的 token 是工具 JSON schema**，而且**每一步都会重发一遍**。
 * 所以「少注册一个工具」是省额度最直接的一刀 —— 管理端「工具与规则」页用它算实时成本。
 * 重新生成：`node qq-bridge/tools/emit-tool-chars.mjs <session.jsonl.zstd...>` → 本文件。
 *
 * 口径：字符数不是 token 数；本文件统一按 **3.2 字符/token** 估算（英文 JSON 的经验值）。
 * 合计 84 个工具 72858 字符，其中 mcp__napcat__ 系列 77 个 67624 字符
 *（**只有这一批能被 social.slimTools.deny 精简掉** —— 名单是在 mcp-napcat-safe.js 里生效的）。
 */
export const TOOL_SCHEMA_CHARS: Record<string, number> = {
  "mcp__napcat__qq_set_wake_config": 2811,
  "mcp__napcat__qq_send_message": 2727,
  "mcp__napcat__qq_send_rich": 2084,
  "mcp__napcat__qq_wait_for_messages": 1771,
  "mcp__napcat__qq_set_system_config": 1573,
  "mcp__napcat__qq_schedule_message": 1512,
  "mcp__napcat__qq_memory_append": 1407,
  "mcp__napcat__qq_reply": 1399,
  "todo_write": 1344,
  "ask_user_question": 1334,
  "mcp__napcat__qq_send_forward": 1268,
  "mcp__napcat__qq_send_docx": 1230,
  "mcp__napcat__qq_set_activity_hours": 1168,
  "mcp__napcat__qq_send_sticker": 1167,
  "mcp__napcat__qq_collect_sticker": 1155,
  "mcp__napcat__qq_send_private_message": 1154,
  "mcp__napcat__qq_send_qq_face": 1138,
  "mcp__napcat__qq_get_forward_msg": 1117,
  "mcp__napcat__qq_send_group_message": 1102,
  "mcp__napcat__qq_music_search": 1098,
  "mcp__napcat__qq_memory_search": 1096,
  "mcp__napcat__qq_crosschat_send": 1081,
  "mcp__napcat__qq_get_file_content": 1068,
  "mcp__napcat__qq_send_poke": 1054,
  "mcp__napcat__qq_list_stickers": 1046,
  "mcp__napcat__qq_sticker_note": 1024,
  "mcp__napcat__qq_send_burst": 1012,
  "mcp__napcat-host__qq_learning_submit": 997,
  "mcp__napcat__qq_qzone_reply_comment": 976,
  "mcp__napcat__qq_history_delete": 969,
  "mcp__napcat__qq_deepsleep": 903,
  "mcp__napcat__qq_set_sticker_remark": 882,
  "mcp__napcat__qq_proactive_send": 853,
  "mcp__napcat__qq_memory_remove": 843,
  "mcp__napcat__qq_withdraw_message": 841,
  "mcp__napcat__qq_admin_set": 819,
  "mcp__napcat__qq_slang_submit": 817,
  "mcp__napcat__qq_qzone_comment": 793,
  "mcp__napcat__qq_get_message_images": 787,
  "mcp__napcat__qq_send_whale_meme": 785,
  "mcp__napcat__qq_whitelist": 782,
  "mcp__napcat__qq_mark_read": 774,
  "mcp__napcat__qq_blacklist": 767,
  "mcp__napcat__qq_profile_set": 767,
  "mcp__napcat__qq_get_sticker_image": 758,
  "mcp__napcat__qq_whale_meme_search": 752,
  "mcp__napcat-host__qq_learning_corpus": 741,
  "mcp__napcat__qq_like": 705,
  "mcp__napcat__qq_get_group_owner": 701,
  "mcp__napcat__qq_remove_friend": 677,
  "mcp__napcat__qq_qzone_view": 671,
  "mcp__napcat__qq_slang_query": 668,
  "mcp__napcat__qq_send_qzone": 662,
  "mcp__napcat__qq_global_overview": 650,
  "mcp__napcat__qq_profile_get": 649,
  "mcp__napcat__qq_get_group_members": 646,
  "mcp__napcat__qq_get_system_config": 641,
  "mcp__napcat__qq_qzone_like": 638,
  "mcp__napcat__qq_get_recent_messages": 627,
  "mcp__napcat__qq_report_feedback": 618,
  "mcp__napcat__qq_memory_clear": 614,
  "mcp__napcat__qq_memory_query": 606,
  "mcp__napcat__qq_get_activity_hours": 598,
  "mcp__napcat__qq_persona_learn_start": 594,
  "mcp__napcat__qq_get_message_detail": 568,
  "mcp__napcat__qq_crosschat_inbox": 559,
  "mcp__napcat__qq_history_clear": 559,
  "mcp__napcat__qq_get_group_history": 557,
  "mcp__napcat__qq_face_list": 542,
  "mcp__napcat__qq_get_self_image": 541,
  "mcp__napcat__qq_get_active_members": 534,
  "mcp__napcat__qq_get_my_recent_messages": 522,
  "mcp__napcat__qq_get_unread_messages": 510,
  "mcp__napcat__qq_social_state": 468,
  "mcp__napcat__qq_get_prompt": 462,
  "mcp__napcat__qq_schedule_cancel": 399,
  "mcp__napcat__qq_persona_learn_stop": 353,
  "mcp__napcat__qq_schedule_list": 296,
  "mcp__web-search-safe__web_search": 296,
  "mcp__web-search-safe__web_fetch": 295,
  "mcp__napcat-host__napcat_status": 227,
  "mcp__napcat__qq_list_groups": 226,
  "mcp__napcat__qq_persona_learn_status": 223,
  "mcp__napcat__qq_status": 210,
};

/** 只有这批工具受管理端「工具 schema 精简」控制（其余由别的 MCP server / DSH 插件提供）。 */
export const SLIM_PREFIX = 'mcp__napcat__';

/** 字符 → 估算 token（英文 JSON 经验值 3.2 字符/token）。 */
export const charsToTokens = (chars: number) => Math.round(chars / 3.2);
