// src/lib/tool-tiers.js — MCP 工具 schema 的「压缩档」（2026-09-21）
//
// ── 为什么这是全项目最贵的一处 ────────────────────────────────────────────────────
// 实测（tools/tool-schema-meter.mjs）：工具 JSON schema 合计约 8.0 万字符 ≈ 2.4 万 token/步，
// 而一次请求的 system 只有约 5.4 万字符 —— **工具描述本身就是请求体里最大的一块，而且每一步都重发一遍**。
// 结论很硬：**少注册一个用不到的工具，比把提示词写短几个字重要两个数量级**。
//
// ── 「档位」怎么定的（2026-09-21 改成"实测用出来的"，不是凭感觉挑）────────────────────
// 第一版名单是按"看起来用不到"挑的，上线前拿服务器上**真实调用日志**（state/tool-calls.jsonl，
// 1,108 次调用）对了一遍，发现它会砍掉机器人**天天在用**的东西：
//     qq_send_meme 44 次 · qq_send_voice 16 次 · qq_profile_set 16 次 · qq_get_message_images 12 次
//     qq_get_recent_messages 12 次 · qq_memory_search 8 次 · qq_list_stickers / face_list / poke …
// 而真正"一次都没被调过、却占着最大体积"的是另一批：pixiv 两个（1.1 万字符）、rich 卡片、
// 角色卡四件、点歌、定时三条、QQ 空间五条、视频两条、联网找图、群文件…
// 所以名单按【协议必需 + 实测调用过】重排，**任何被调用过的工具都不会因为切档而消失**：
//
//   off      不裁剪（默认；行为与改动之前完全一致）
//   low      ≈ 保留一半 —— 只砍掉"实测零调用且体积最大"的那批（pixiv / rich / 角色卡 / 点歌 / 定时 / 空间 / 视频…）
//   medium   ≈ 三成 —— 日常群聊够用：发/收/引用/表情包/记忆/查资料/主动搭话/看历史图
//   high     ≈ 一成多 —— 最小闭环 + 实测用到的工具（**不丢任何被调用过的能力**）
//   extreme  ≈ 7% —— 极限档：只留"说话 + 引用 + 收尾 + 看未读"八件套。
//                    ⚠ 会真的砍掉发米姆/语音/查记忆这些在用的能力，只在"这个月必须省钱"时用
//   custom   走 social.slimTools.allow / deny 两张手写名单（老行为，仍然完全支持）
//
// 百分比是**实测**的（mcp-napcat-safe.js 注册时把每个工具的 JSON 尺寸加起来算），
// 不是拍脑袋写的：`tools/tool-schema-meter.mjs` 可以随时重算，管理端也会显示当前档位的实测值。
//
// ⚠️ 档位是**白名单**语义：不在名单里的工具**根本不注册**（描述才不会进请求体）。
//    这正是它省钱的原因 —— `social.tools.*` 那些开关做不到这件事（它们只在调用时返回 403，
//    schema 照样全量下发，见 mcp-napcat-safe.js 里的更正说明）。
//
// 工具名一律用**裸名**（不带 `mcp__napcat__` 前缀）；带前缀也认（注册端会归一化）。

/** 协议必需：每一轮唤醒都靠它们读/说/收尾，任何档位都得留（extreme 档也只留这几件）。 */
const ESSENTIAL = [
  'qq_send_message',        // 说话（唯一出口）
  'qq_reply',               // 引用着说话
  'qq_mark_read',           // 收尾（哨兵轮的主要收尾手段）
  'qq_set_wake_config',     // 收尾的另一个选项 + 调唤醒条件
  'qq_get_prompt',          // 首连时读协议
  'qq_social_state',        // 看自己/对方的状态
  'qq_get_unread_messages', // 正文没带未读时的兜底
  'qq_wait_for_messages',   // 潜水前的观察
  'qq_list_groups',         // 群号 → 群名
  'qq_status',              // 自检（198 字符，永远保留）
];

/** 实测被调用过（服务器 1,108 次调用日志里 ≥1 次）：切档**绝不能**把它们砍掉。 */
const OBSERVED_USED = [
  'qq_meme_search',         // 76 次
  'qq_send_meme',           // 44 次
  'qq_profile_set',         // 16 次
  'qq_send_voice',          // 16 次
  'qq_get_message_images',  // 12 次
  'qq_get_recent_messages', // 12 次
  'qq_memory_search',       // 8 次
  'qq_global_overview',     // 4 次
  'qq_collect_sticker',     // 4 次
  'qq_list_stickers',       // 2 次
  'qq_send_sticker',        // 2 次
  'qq_get_system_config',   // 2 次
  'qq_set_system_config',   // 2 次
  'qq_get_message_detail',  // 2 次
  'qq_face_list',           // 2 次
  'qq_send_poke',           // 2 次
  'qq_memory_query',        // 2 次
];

/** 便宜且协议/人格偶尔会用到的（都在 1,200 字符以下）：medium 档把它们留着。 */
const CHEAP_EXTRA = [
  'qq_send_burst', 'qq_proactive_send', 'qq_withdraw_message', 'qq_send_qq_face',
  'qq_transcribe_voice', 'qq_memory_remember', 'qq_slang_query',
  'qq_get_group_members', 'qq_get_group_owner', 'qq_get_activity_hours', 'qq_set_activity_hours',
];

export const TOOL_TIERS = {
  off: { label: '不裁剪', note: '全部工具都注册（默认；与改动之前行为一致）', keep: null },
  low: {
    label: '低',
    note: '只砍掉"实测零调用且体积最大"的那批：pixiv 两个（1.1 万字符）、富卡片、角色卡四件、点歌、定时三条、QQ 空间五条、视频两条、联网找图、群文件、跨会话、学习指令等',
    // low 用「不要」名单（其余一律保留）→ 将来新增工具默认可见，不会"忘了加白名单"
    drop: [
      'qq_send_pixiv', 'qq_pixiv_search',                                // 实测 0 次调用，却占 1.1 万字符
      'qq_send_rich', 'qq_music_search',                                  // 富卡片/点歌：实测 0 次
      'qq_character_list', 'qq_character_read', 'qq_character_pack', 'qq_character_search',
      'qq_schedule_message', 'qq_schedule_list', 'qq_schedule_cancel',
      'qq_qzone_view', 'qq_qzone_comment', 'qq_qzone_like', 'qq_qzone_reply_comment', 'qq_send_qzone',
      'qq_video_search', 'qq_video_parse', 'qq_image_search', 'qq_get_file_content',
      'qq_crosschat_inbox', 'qq_crosschat_send', 'qq_get_group_history', 'qq_get_active_members',
      'qq_get_self_image', 'qq_get_sticker_image', 'qq_sticker_note', 'qq_set_sticker_remark',
      'qq_profile_get', 'qq_history_delete', 'qq_history_clear', 'qq_memory_append',
      'qq_memory_remove', 'qq_memory_clear', 'qq_deepsleep', 'qq_remove_friend', 'qq_report_feedback',
      'qq_persona_learn_start', 'qq_persona_learn_stop', 'qq_persona_learn_status',
    ],
  },
  medium: {
    label: '中',
    note: '协议必需 + 实测用到的 + 一圈便宜的小工具（群成员/活跃时段/撤回/连发/语音转写/黑话查询…）；不要 pixiv、富卡片、角色卡、点歌、定时、空间、文档、转发、管理类',
    keep: [...ESSENTIAL, ...OBSERVED_USED, ...CHEAP_EXTRA],
  },
  high: {
    label: '高（实测用到的全留）',
    note: '协议必需 + 实测被调用过的工具：**不丢任何被调用过的能力**（发米姆、语音、查记忆、看历史图都在），砍掉的都是实测零调用的大块头。这是"不丢功能"前提下的地板',
    keep: [...ESSENTIAL, ...OBSERVED_USED],
  },
  extreme: {
    label: '极限（会丢功能）',
    note: '⚠️ 只留「说话 + 引用 + 收尾 + 看未读」八件套，成本最低；但会砍掉发米姆/语音/查记忆/看历史图这些**在用的**能力，只在"这个月必须省钱"时用',
    keep: [
      'qq_send_message', 'qq_reply', 'qq_mark_read',
      'qq_get_prompt', 'qq_social_state', 'qq_get_unread_messages', 'qq_list_groups',
      'qq_status',
    ],
  },
  custom: { label: '自定义名单', note: '用下面的「白名单 / 黑名单」两张表（老行为）', keep: null },
};

export const TOOL_TIER_IDS = Object.keys(TOOL_TIERS);

/** 归一化档位 id（非法值一律当 off —— 宁可多花钱，也不要因为一个错字把工具砍没） */
export function normalizeToolTier(v) {
  const id = String(v ?? '').trim().toLowerCase();
  return TOOL_TIER_IDS.includes(id) ? id : 'off';
}

/** 去掉 mcp__server__ 前缀（与 mcp-napcat-safe.js 的 bareToolName 同口径） */
export const bareToolName = (n) => String(n).replace(/^mcp__[A-Za-z0-9_-]+__/, '');

/**
 * 由配置算出"这轮要注册哪些工具"。
 * @param {{level?:string, allow?:string[], deny?:string[]}} slimTools  config.json 的 social.slimTools
 * @returns {{level:string, keep:Set<string>|null, drop:Set<string>|null, allow:Set<string>|null, deny:Set<string>|null, source:string}}
 */
export function resolveToolTier(slimTools = {}) {
  const enabled = slimTools?.enabled === true;
  const level = normalizeToolTier(slimTools?.level ?? (enabled ? 'custom' : 'off'));
  const toSet = (arr) => (Array.isArray(arr) && arr.length ? new Set(arr.map(bareToolName)) : null);
  const allow = toSet(slimTools?.allow);
  const deny = toSet(slimTools?.deny);
  if (!enabled) return { level: 'off', keep: null, drop: null, allow: null, deny: null, source: 'disabled' };
  /* 选了具体档位（非 custom）时，**allow/deny 两张手写表一律忽略**。
   * 为什么：线上 config.json 里本来就躺着一张 16 条的 deny 名单（老配置），而档位白名单里也含着
   * `qq_memory_query` 这类被调用过的工具 —— 两张表同时生效就会出现"档位说要留、老 deny 说要砍"的
   * 自相矛盾，而且失手砍掉的正是机器人在用的工具（这类冲突在真机上极难被发现：工具静默消失，
   * 模型只会说"我调不到那个工具"）。档位 = 唯一答案，手写表只在 custom 档生效。 */
  if (level !== 'custom') {
    const def = TOOL_TIERS[level] || {};
    const keep = Array.isArray(def.keep) ? new Set(def.keep.map(bareToolName)) : null;
    const drop = Array.isArray(def.drop) ? new Set(def.drop.map(bareToolName)) : null;
    return { level, keep, drop, allow: null, deny: null, source: keep ? `tier:${level}` : drop ? `tier:${level}-drop` : 'off' };
  }
  // custom：手写白名单优先（主人明确点名要什么），其次黑名单
  return { level, keep: allow, drop: null, allow, deny, source: allow ? 'custom-allow' : 'custom-deny' };
}

/** 该工具要不要注册（唯一判据；`qq_status` 永远保留 —— 它是自检通道，198 字符不值一提）。 */
export function toolAllowedByTier(name, resolved) {
  const bare = bareToolName(name);
  if (bare === 'qq_status') return true;
  if (resolved?.allow && !resolved.allow.has(bare)) return false;
  if (!resolved?.allow && resolved?.keep && !resolved.keep.has(bare)) return false;
  if (resolved?.drop && resolved.drop.has(bare)) return false;
  if (resolved?.deny && resolved.deny.has(bare)) return false;
  return true;
}

/** 量化：把每个工具的 JSON 尺寸加起来，算出"注册了这么多，占不裁剪时的百分之几"。纯函数，便于测试。 */
export function measureSchemaShare(tools, keptNames, droppedNames) {
  const keep = keptNames ? new Set([...keptNames].map(bareToolName)) : null;
  const drop = droppedNames ? new Set([...droppedNames].map(bareToolName)) : null;
  let total = 0;
  let kept = 0;
  let keptCount = 0;
  for (const t of Array.isArray(tools) ? tools : []) {
    const c = Number(t?.cost) || 0;
    total += c;
    const bare = bareToolName(t?.name);
    const isKept = keep ? keep.has(bare) : (drop ? !drop.has(bare) : true);
    if (isKept) { kept += c; keptCount += 1; }
  }
  return { totalChars: total, keptChars: kept, keptCount, share: total > 0 ? kept / total : 1 };
}
