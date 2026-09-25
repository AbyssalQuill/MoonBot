/**
 * 「由脚本生成，不要手改」MCP 工具 schema 体积表（单位：字符）。
 *
 * 数据来源：现场问跑起来的 MCP server（`tools/list`）——
 * `node qq-bridge/tools/mcp-tool-chars.mjs --write src/tool-schema-chars.ts`。
 * 为什么要这张表：单次模型请求里 约 87% 的 token 是工具 JSON schema，而且每一步都会重发一遍。
 * 所以「少注册一个工具」是省额度最直接的一刀 —— 管理端「工具与规则」页用它算实时成本。
 * 重新生成：`node qq-bridge/tools/mcp-tool-chars.mjs --write ../src/tool-schema-chars.ts`（在 qq-bridge 目录下执行）。
 *
 * 2026-09-19 换口径：以前是从 DSH 会话转录的 `request/header.tools` 抽的
 * （旧的 qq-bridge/tools/dump-tool-schema.mjs，仍在，留作对照）。
 * 转录是过去某一刻的快照 —— 之后新加的工具（pixiv / 联网找图 / 视频 / 语音 / 角色卡共 12 个）
 * 一条都没进表，表现是精简卡里根本看不到这些工具：既勾不掉、也看不到它占多少体积。
 * 现在改成现问 server，zod schema 是注册代码现场生成的，量到的就是此刻真实体积，不会再漏新增工具。
 *
 * 口径：字符数不是 token 数；本文件统一按 3.2 字符/token 估算（英文 JSON 的经验值）。
 * 合计 98 个工具 103142 字符，其中 mcp__napcat__ 系列 91 个 97908 字符
 *（只有这一批能被 social.slimTools.deny 精简掉 —— 名单是在 mcp-napcat-safe.js 里生效的）。
 */
export const TOOL_SCHEMA_CHARS: Record<string, number> = {
  "mcp__napcat__qq_send_pixiv": 6630,
  "mcp__napcat__qq_send_rich": 4878,
  "mcp__napcat__qq_pixiv_search": 4743,
  "mcp__napcat__qq_send_image": 2950,
  "mcp__napcat__qq_send_qzone": 2861,
  "mcp__napcat__qq_send_message": 2756,
  "mcp__napcat__qq_send_voice": 2429,
  "mcp__napcat__qq_set_wake_config": 2388,
  "mcp__napcat__qq_memory_remember": 1979,
  "mcp__napcat__qq_set_system_config": 1917,
  "mcp__napcat__qq_send_meme": 1803,
  "mcp__napcat__qq_music_search": 1529,
  "mcp__napcat__qq_schedule_message": 1506,
  "mcp__napcat__qq_character_switch": 1487,
  "mcp__napcat__qq_character_read": 1400,
  "mcp__napcat__qq_reply": 1399,
  "mcp__napcat__qq_memory_append": 1354,
  "todo_write": 1344,
  "ask_user_question": 1334,
  "mcp__napcat__qq_wait_for_messages": 1309,
  "mcp__napcat__qq_character_list": 1285,
  "mcp__napcat__qq_memory_search": 1169,
  "mcp__napcat__qq_send_forward": 1124,
  "mcp__napcat__qq_character_pack": 1114,
  "mcp__napcat__qq_video_parse": 1095,
  "mcp__napcat__qq_image_search": 1063,
  "mcp__napcat__qq_get_file_content": 1062,
  "mcp__napcat__qq_send_sticker": 1062,
  "mcp__napcat__qq_collect_sticker": 1062,
  "mcp__napcat__qq_set_activity_hours": 1058,
  "mcp__napcat__qq_send_docx": 1019,
  "mcp__napcat-host__qq_learning_submit": 997,
  "mcp__napcat__qq_meme_search": 995,
  "mcp__napcat__qq_send_qq_face": 978,
  "mcp__napcat__qq_send_private_message": 972,
  "mcp__napcat__qq_list_stickers": 967,
  "mcp__napcat__qq_sticker_note": 967,
  "mcp__napcat__qq_qzone_reply_comment": 953,
  "mcp__napcat__qq_crosschat_send": 951,
  "mcp__napcat__qq_history_delete": 945,
  "mcp__napcat__qq_get_forward_msg": 919,
  "mcp__napcat__qq_send_group_message": 918,
  "mcp__napcat__qq_admin_set": 889,
  "mcp__napcat__qq_deepsleep": 881,
  "mcp__napcat__qq_get_message_images": 881,
  "mcp__napcat__qq_whitelist": 868,
  "mcp__napcat__qq_send_poke": 866,
  "mcp__napcat__qq_character_search": 846,
  "mcp__napcat__qq_proactive_send": 843,
  "mcp__napcat__qq_set_sticker_remark": 826,
  "mcp__napcat__qq_memory_remove": 812,
  "mcp__napcat__qq_video_search": 811,
  "mcp__napcat__qq_qzone_comment": 761,
  "mcp__napcat-host__qq_learning_corpus": 741,
  "mcp__napcat__qq_slang_submit": 740,
  "mcp__napcat__qq_transcribe_voice": 735,
  "mcp__napcat__qq_blacklist": 734,
  "mcp__napcat__qq_withdraw_message": 729,
  "mcp__napcat__qq_get_sticker_image": 683,
  "mcp__napcat__qq_profile_set": 664,
  "mcp__napcat__qq_mark_read": 655,
  "mcp__napcat__qq_like": 650,
  "mcp__napcat__qq_qzone_like": 619,
  "mcp__napcat__qq_qzone_view": 614,
  "mcp__napcat__qq_remove_friend": 606,
  "mcp__napcat__qq_report_feedback": 601,
  "mcp__napcat__qq_slang_query": 599,
  "mcp__napcat__qq_profile_get": 597,
  "mcp__napcat__qq_persona_learn_start": 584,
  "mcp__napcat__qq_get_recent_messages": 580,
  "mcp__napcat__qq_memory_query": 576,
  "mcp__napcat__qq_memory_clear": 575,
  "mcp__napcat__qq_get_system_config": 552,
  "mcp__napcat__qq_get_group_members": 542,
  "mcp__napcat__qq_get_group_owner": 542,
  "mcp__napcat__qq_history_clear": 535,
  "mcp__napcat__qq_get_message_detail": 533,
  "mcp__napcat__qq_get_self_image": 523,
  "mcp__napcat__qq_get_activity_hours": 522,
  "mcp__napcat__qq_global_overview": 515,
  "mcp__napcat__qq_get_active_members": 508,
  "mcp__napcat__qq_get_my_recent_messages": 495,
  "mcp__napcat__qq_crosschat_inbox": 485,
  "mcp__napcat__qq_face_list": 478,
  "mcp__napcat__qq_get_group_history": 465,
  "mcp__napcat__qq_get_unread_messages": 463,
  "mcp__napcat__qq_social_state": 432,
  "mcp__napcat__get_time": 421,
  "mcp__napcat__qq_get_prompt": 419,
  "mcp__napcat__qq_schedule_cancel": 380,
  "mcp__napcat__qq_persona_learn_stop": 353,
  "mcp__web-search-safe__web_search": 296,
  "mcp__web-search-safe__web_fetch": 295,
  "mcp__napcat__qq_schedule_list": 271,
  "mcp__napcat-host__napcat_status": 227,
  "mcp__napcat__qq_persona_learn_status": 223,
  "mcp__napcat__qq_list_groups": 220,
  "mcp__napcat__qq_status": 210,
};

/** 只有这批工具受管理端「工具 schema 精简」控制（其余由别的 MCP server / DSH 插件提供）。 */
export const SLIM_PREFIX = 'mcp__napcat__';

/** 字符 → 估算 token（英文 JSON 经验值 3.2 字符/token）。 */
export const charsToTokens = (chars: number) => Math.round(chars / 3.2);
