/**
 * 【由脚本生成，不要手改】MCP 工具 schema 体积表（单位：字符）。
 *
 * 数据来源：**现场问跑起来的 MCP server**（`tools/list`）——
 * `node qq-bridge/tools/mcp-tool-chars.mjs --write src/tool-schema-chars.ts`。
 * 为什么要这张表：单次模型请求里 **约 87% 的 token 是工具 JSON schema**，而且**每一步都会重发一遍**。
 * 所以「少注册一个工具」是省额度最直接的一刀 —— 管理端「工具与规则」页用它算实时成本。
 * 重新生成：`node qq-bridge/tools/mcp-tool-chars.mjs --write ../src/tool-schema-chars.ts`（在 qq-bridge 目录下执行）。
 *
 * 【2026-09-19 换口径】以前是从 DSH 会话转录的 `request/header.tools` 抽的
 * （旧的 qq-bridge/tools/dump-tool-schema.mjs，仍在，留作对照）。
 * 转录是**过去某一刻的快照** —— 之后新加的工具（pixiv / 联网找图 / 视频 / 语音 / 角色卡共 12 个）
 * **一条都没进表**，表现是精简卡里根本看不到这些工具：既勾不掉、也看不到它占多少体积。
 * 现在改成现问 server，zod schema 是注册代码现场生成的，量到的就是此刻真实体积，不会再漏新增工具。
 *
 * 口径：字符数不是 token 数；本文件统一按 **3.2 字符/token** 估算（英文 JSON 的经验值）。
 * 合计 96 个工具 83914 字符，其中 mcp__napcat__ 系列 89 个 78680 字符
 *（**只有这一批能被 social.slimTools.deny 精简掉** —— 名单是在 mcp-napcat-safe.js 里生效的）。
 */
export const TOOL_SCHEMA_CHARS: Record<string, number> = {
  "mcp__napcat__qq_send_rich": 4879,
  "mcp__napcat__qq_send_voice": 2430,
  "mcp__napcat__qq_set_wake_config": 2389,
  "mcp__napcat__qq_send_message": 2290,
  "mcp__napcat__qq_music_search": 1530,
  "mcp__napcat__qq_schedule_message": 1507,
  "mcp__napcat__qq_character_read": 1401,
  "mcp__napcat__qq_memory_append": 1355,
  "todo_write": 1344,
  "ask_user_question": 1334,
  "mcp__napcat__qq_wait_for_messages": 1310,
  "mcp__napcat__qq_send_pixiv": 1310,
  "mcp__napcat__qq_character_list": 1286,
  "mcp__napcat__qq_set_system_config": 1265,
  "mcp__napcat__qq_send_image": 1213,
  "mcp__napcat__qq_reply": 1198,
  "mcp__napcat__qq_memory_search": 1170,
  "mcp__napcat__qq_send_forward": 1125,
  "mcp__napcat__qq_character_pack": 1115,
  "mcp__napcat__qq_video_parse": 1096,
  "mcp__napcat__qq_image_search": 1064,
  "mcp__napcat__qq_send_sticker": 1063,
  "mcp__napcat__qq_collect_sticker": 1063,
  "mcp__napcat__qq_set_activity_hours": 1059,
  "mcp__napcat__qq_send_docx": 1020,
  "mcp__napcat-host__qq_learning_submit": 997,
  "mcp__napcat__qq_pixiv_search": 980,
  "mcp__napcat__qq_send_qq_face": 979,
  "mcp__napcat__qq_send_private_message": 973,
  "mcp__napcat__qq_list_stickers": 968,
  "mcp__napcat__qq_sticker_note": 968,
  "mcp__napcat__qq_qzone_reply_comment": 954,
  "mcp__napcat__qq_crosschat_send": 952,
  "mcp__napcat__qq_history_delete": 946,
  "mcp__napcat__qq_get_forward_msg": 920,
  "mcp__napcat__qq_send_group_message": 919,
  "mcp__napcat__qq_get_file_content": 883,
  "mcp__napcat__qq_deepsleep": 882,
  "mcp__napcat__qq_send_poke": 867,
  "mcp__napcat__qq_send_burst": 863,
  "mcp__napcat__qq_character_search": 847,
  "mcp__napcat__qq_proactive_send": 844,
  "mcp__napcat__qq_set_sticker_remark": 827,
  "mcp__napcat__qq_memory_remove": 813,
  "mcp__napcat__qq_video_search": 812,
  "mcp__napcat__qq_qzone_comment": 762,
  "mcp__napcat__qq_admin_set": 759,
  "mcp__napcat__qq_send_meme": 751,
  "mcp__napcat__qq_slang_submit": 741,
  "mcp__napcat-host__qq_learning_corpus": 741,
  "mcp__napcat__qq_whitelist": 738,
  "mcp__napcat__qq_transcribe_voice": 736,
  "mcp__napcat__qq_blacklist": 735,
  "mcp__napcat__qq_meme_search": 734,
  "mcp__napcat__qq_withdraw_message": 730,
  "mcp__napcat__qq_get_message_images": 717,
  "mcp__napcat__qq_get_sticker_image": 684,
  "mcp__napcat__qq_profile_set": 665,
  "mcp__napcat__qq_mark_read": 656,
  "mcp__napcat__qq_like": 651,
  "mcp__napcat__qq_send_qzone": 637,
  "mcp__napcat__qq_qzone_like": 620,
  "mcp__napcat__qq_qzone_view": 615,
  "mcp__napcat__qq_remove_friend": 607,
  "mcp__napcat__qq_report_feedback": 602,
  "mcp__napcat__qq_slang_query": 600,
  "mcp__napcat__qq_profile_get": 598,
  "mcp__napcat__qq_persona_learn_start": 585,
  "mcp__napcat__qq_get_recent_messages": 581,
  "mcp__napcat__qq_memory_query": 577,
  "mcp__napcat__qq_memory_clear": 576,
  "mcp__napcat__qq_get_system_config": 553,
  "mcp__napcat__qq_get_group_members": 543,
  "mcp__napcat__qq_get_group_owner": 543,
  "mcp__napcat__qq_history_clear": 536,
  "mcp__napcat__qq_get_message_detail": 534,
  "mcp__napcat__qq_get_self_image": 524,
  "mcp__napcat__qq_get_activity_hours": 523,
  "mcp__napcat__qq_global_overview": 516,
  "mcp__napcat__qq_get_active_members": 509,
  "mcp__napcat__qq_get_my_recent_messages": 496,
  "mcp__napcat__qq_crosschat_inbox": 486,
  "mcp__napcat__qq_face_list": 479,
  "mcp__napcat__qq_get_group_history": 466,
  "mcp__napcat__qq_get_unread_messages": 464,
  "mcp__napcat__qq_social_state": 433,
  "mcp__napcat__qq_get_prompt": 420,
  "mcp__napcat__qq_schedule_cancel": 381,
  "mcp__napcat__qq_persona_learn_stop": 354,
  "mcp__web-search-safe__web_search": 296,
  "mcp__web-search-safe__web_fetch": 295,
  "mcp__napcat__qq_schedule_list": 272,
  "mcp__napcat-host__napcat_status": 227,
  "mcp__napcat__qq_persona_learn_status": 224,
  "mcp__napcat__qq_list_groups": 221,
  "mcp__napcat__qq_status": 211,
};

/** 只有这批工具受管理端「工具 schema 精简」控制（其余由别的 MCP server / DSH 插件提供）。 */
export const SLIM_PREFIX = 'mcp__napcat__';

/** 字符 → 估算 token（英文 JSON 经验值 3.2 字符/token）。 */
export const charsToTokens = (chars: number) => Math.round(chars / 3.2);
