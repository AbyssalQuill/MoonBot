// src/lib/tool-tiers.js — MCP 工具 schema 的「压缩档」（2026-09-21）
//
// ── 为什么这是全项目最贵的一处 ────────────────────────────────────────────────────
// 实测（tools/tool-schema-meter.mjs，68 个工具）：工具 JSON schema 合计 **74,422 字符 ≈ 23.3k token**，
// 而一次请求的 system 只有 13.1k 字符 ≈ 3.3k —— **账单里约 87% 是工具 schema，而且每一步都要重发一遍**。
// 结论很硬：**少注册一个工具，比把提示词写短几个字重要两个数量级**。
//
// ── 「档位」是什么 ──────────────────────────────────────────────────────────────
// 以前只有 `social.slimTools.allow/deny` 两张手写名单：能省，但**得先知道该写哪些名字**，
// 而且省下多少没人知道（得过且过 = 名单写错也看不出来）。现在改成**四档 + 自定义**：
//
//   off      不裁剪（默认；行为与改动之前完全一致）
//   low      ≈ 52%  —— 只砍掉最肥的少数"小众能力"（pixiv 发图、富卡片、语音、角色卡、点歌、定时…）
//   medium   ≈ 30%  —— 群聊日常够用：发/收/引用/表情/记忆/查资料/主动搭话
//   high     ≈ 8.6% —— 最小闭环：只会"说话 + 收尾 + 看未读"（成本极限档，功能明显受限）
//   custom   走 social.slimTools.allow / deny 两张手写名单（老行为，仍然完全支持）
//
// 百分比是**实测**的（mcp-napcat-safe.js 注册时把每个工具的 JSON 尺寸加起来算），
// 不是拍脑袋写的：`tools/tool-schema-meter.mjs` 可以随时重算，管理端也会显示当前档位的实测值。
//
// ⚠️ 档位用**白名单**语义：不在名单里的工具**根本不注册**（描述才不会进请求体）。
//    这正是它省钱的原因 —— `social.tools.*` 那些开关做不到这件事（它们只在调用时返回 403，
//    schema 照样全量下发，见 mcp-napcat-safe.js 里的更正说明）。
//
// 工具名一律用**裸名**（不带 `mcp__napcat__` 前缀）；带前缀也认（注册端会归一化）。

/** 档位 → 保留的工具（白名单）。high/medium/low 的名单是实测调出来的，别凭感觉改：
 *  改完用 `node tools/tool-schema-meter.mjs` 复算，确认百分比还算合理。 */
export const TOOL_TIERS = {
  off: { label: '不裁剪', note: '全部工具都注册（默认；与改动之前行为一致）', keep: null },
  low: {
    label: '低（≈52%）',
    note: '只砍掉最占体积的小众能力：pixiv 发图、富卡片、语音、角色卡、点歌、定时消息、QQ空间',
    keep: [
      // ── 说话与收尾 ──
      'qq_send_message', 'qq_send_burst', 'qq_reply', 'qq_mark_read', 'qq_set_wake_config',
      'qq_proactive_send', 'qq_wait_for_messages', 'qq_withdraw_message', 'qq_send_poke',
      // ── 状态与上下文 ──
      'qq_get_prompt', 'qq_social_state', 'qq_get_unread_messages', 'qq_get_recent_messages',
      'qq_get_my_recent_messages', 'qq_get_message_detail', 'qq_get_forward_msg', 'qq_global_overview',
      // ── 表情与媒体 ──
      'qq_send_sticker', 'qq_collect_sticker', 'qq_list_stickers', 'qq_meme_search', 'qq_send_meme',
      'qq_send_qq_face', 'qq_face_list', 'qq_send_image', 'qq_get_message_images', 'qq_transcribe_voice',
      // ── 记忆与黑话 ──
      'qq_memory_search', 'qq_memory_remember', 'qq_profile_set', 'qq_slang_query', 'qq_slang_submit',
      // ── 群/人 ──
      'qq_list_groups', 'qq_get_group_members', 'qq_get_group_owner', 'qq_get_activity_hours', 'qq_set_activity_hours',
      // ── 主人专用 ──
      'qq_get_system_config', 'qq_set_system_config', 'qq_admin_set', 'qq_whitelist', 'qq_blacklist',
      'qq_send_group_message', 'qq_send_private_message', 'qq_like', 'qq_status',
    ],
  },
  medium: {
    label: '中（≈30%）',
    note: '群聊日常够用：发/收发/引用/表情/记忆/查资料/主动搭话；不要 pixiv、语音、富卡片、角色卡、定时、空间',
    keep: [
      'qq_send_message', 'qq_send_burst', 'qq_reply', 'qq_mark_read', 'qq_set_wake_config',
      'qq_proactive_send', 'qq_wait_for_messages', 'qq_withdraw_message',
      'qq_get_prompt', 'qq_social_state', 'qq_get_unread_messages', 'qq_get_recent_messages',
      'qq_get_message_detail', 'qq_get_message_images', 'qq_global_overview',
      'qq_send_sticker', 'qq_collect_sticker', 'qq_meme_search', 'qq_send_qq_face', 'qq_face_list',
      'qq_memory_search', 'qq_memory_remember', 'qq_profile_set', 'qq_slang_query',
      'qq_transcribe_voice', 'qq_list_groups', 'qq_get_group_members', 'qq_get_group_owner', 'qq_status',
    ],
  },
  high: {
    label: '高（≈8.6%）',
    note: '最小闭环：只会「说话 + 引用 + 收尾 + 看未读」。名字里的数字是实测占比（相对不裁剪时的 74,422 字符）',
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
 * @returns {{level:string, keep:Set<string>|null, allow:Set<string>|null, deny:Set<string>|null, source:string}}
 */
export function resolveToolTier(slimTools = {}) {
  const enabled = slimTools?.enabled === true;
  const level = normalizeToolTier(slimTools?.level ?? (enabled ? 'custom' : 'off'));
  const toSet = (arr) => (Array.isArray(arr) && arr.length ? new Set(arr.map(bareToolName)) : null);
  const allow = toSet(slimTools?.allow);
  const deny = toSet(slimTools?.deny);
  if (!enabled) return { level: 'off', keep: null, allow: null, deny: null, source: 'disabled' };
  // 手写白名单优先级最高（主人明确点名要什么），其次才是档位名单，最后是黑名单
  if (level === 'custom') return { level, keep: allow, allow, deny, source: allow ? 'custom-allow' : 'custom-deny' };
  const keep = Array.isArray(TOOL_TIERS[level]?.keep) ? new Set(TOOL_TIERS[level].keep.map(bareToolName)) : null;
  return { level, keep, allow, deny, source: keep ? `tier:${level}` : 'off' };
}

/** 该工具要不要注册（唯一判据；`qq_status` 永远保留 —— 它是自检通道，198 字符不值一提）。 */
export function toolAllowedByTier(name, resolved) {
  const bare = bareToolName(name);
  if (bare === 'qq_status') return true;
  if (resolved?.allow && !resolved.allow.has(bare)) return false;
  if (!resolved?.allow && resolved?.keep && !resolved.keep.has(bare)) return false;
  if (resolved?.deny && resolved.deny.has(bare)) return false;
  return true;
}

/** 量化：把每个工具的 JSON 尺寸加起来，算出"注册了这么多，占不裁剪时的百分之几"。纯函数，便于测试。 */
export function measureSchemaShare(tools, keptNames) {
  const keep = keptNames ? new Set([...keptNames].map(bareToolName)) : null;
  let total = 0;
  let kept = 0;
  let keptCount = 0;
  for (const t of Array.isArray(tools) ? tools : []) {
    const c = Number(t?.cost) || 0;
    total += c;
    if (!keep || keep.has(bareToolName(t?.name))) { kept += c; keptCount += 1; }
  }
  return { totalChars: total, keptChars: kept, keptCount, share: total > 0 ? kept / total : 1 };
}
