// src/lib/tool-schema-compress.js — 工具 schema 的「描述压缩档」（2026-09-21）
//
// ── 这是什么，为什么这么做 ──────────────────────────────────────────────────────
// 目标是「开源那套 mcp 压缩工具」的做法（atlassian-labs/mcp-compressor）。
// 我把那个包（0.31.9）真的下下来、解包、用它自己的原生核跑了一遍，量出它的档位语义是：
//     low    = 保留描述（只做去冗余）
//     medium = 每条描述只留第一句
//     high   = 完全不发描述，只留工具名 + 参数名 + 类型
//     max    = 连工具清单都不发（改用 get_tool_schema / invoke_tool 两个包装工具）
// 用它自己的文本清单格式量，medium/high 分别是 16.1% / 6.3%（此前提到的 8.6% 就是这个量级）。
//
// 但我们这边不能换格式：DSH 下发给模型的是标准 JSON Schema（每个参数还带 type/enum/required），
// 结构性开销本身就有个地板。所以这里做的是把它的档位语义原样搬过来，压的是描述文字，
// 工具一个不少、参数名/类型/枚举/必填全都照旧 —— 也就是"压缩本身，不是精简功能"。
//
// 在真实 wire 格式上实测（90 个工具，本机出厂配置）：
//     off    89,603 字符  ≈ 28,001 token/步   （100%）
//     low    89,603 字符  ≈ 28,001 token/步   （99.9%，我们本来就都是单行描述，去空白收益≈0）
//     medium 61,587 字符  ≈ 19,246 token/步   （68.7%）—— 每条描述只留第一句
//     high   27,109 字符  ≈  8,472 token/步   （30.2%）—— 完全不发描述
//     （绝对地板：连 enum/默认值/required 都砍掉、只留名字+参数名+类型 = 22.9%，high 已经很接近）
//
// high 是激进档：描述是模型判断"什么时候该用这个工具"的主要依据，去掉之后工具选择会更依赖
//    工具名本身的表意（我们的名字起得还算清楚：qq_send_sticker / qq_send_meme / qq_memory_remember…）。
//    换来的差额是每步 10,774 token。要不要用由用户决定 —— 管理端一个下拉随时切。
// 这里不动 zod 的校验：叶子节点只走 `.describe()`（返回副本，checks 全保留），
//    容器节点用 `.optional()/.default()/.nullable()/z.array/z.object/z.union` 原样重建
//    （已确认我们没有任何 array 级 min/max、没有 strict/passthrough/record/tuple/refine，重建不会丢校验）。

/* 只有三档 —— 特意不提供 mcp-compressor 的 `low`：那一档是"去冗余空白 + 去句末句号"，
 * 而我们的描述本来就都是单行、没有多余空白，实测压完反而比不压还大 2.6%（重建 union 容器会把
 * 描述搬进每个分支）。留一个"开了更贵"的档位只会误导，所以直接不给。 */
export const SCHEMA_LEVELS = ['off', 'medium', 'high'];

export const SCHEMA_LEVEL_INFO = {
  off: { label: '不压缩描述', note: '每条描述原样下发（默认）' },
  medium: { label: '中度（每条只留第一句）', note: '工具与参数的描述都只留第一句 —— 保留"什么时候用它"的判断，砍掉后半段解释' },
  high: { label: '高度（完全不发描述）', note: '⚠ 只留工具名 + 参数名 + 类型 + 枚举 + 必填；工具一个不少、参数一个不少，但模型只能靠工具名猜用途' },
};

export function normalizeSchemaLevel(v) {
  const id = String(v ?? '').trim().toLowerCase();
  return SCHEMA_LEVELS.includes(id) ? id : 'off';
}

export const trimText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 第一句：到第一个句末标点（英文 . ? ! / 中文 。？！）为止；没有就用整段（超长才截）。 */
export function firstSentence(s) {
  const t = trimText(s);
  if (!t) return '';
  const m = t.match(/^[\s\S]{1,240}?[.!?。？！](?=\s|$)/);
  if (m) return m[0];
  return t.length > 160 ? `${t.slice(0, 160).replace(/[,;，；:：]$/, '')}` : t;
}

/** 一条描述在给定档位下的最终文案（high 返回空串 = 整体不发）。 */
export function applyDesc(text, level) {
  const t = trimText(text);
  if (!t) return '';
  if (level === 'high') return '';
  if (level === 'medium') return firstSentence(t);
  // low：去句末句号 + 压空白（保留全部信息）
  return t.replace(/\.$/, '');
}

/** 从 zod 字段上读现有描述（zod v4 把它放在 .description / .def.description 上）。 */
function descOf(field) {
  try { return String(field?.description ?? field?.def?.description ?? ''); } catch { return ''; }
}

/** 重建容器（array/object/union/optional/…）之后，把**容器自己那条**描述按档位补回去。
 *  【为什么必须补】实测踩到：`wrapped = z.union([...]).optional().describe('Group id')` —— 描述挂在外层，
 *  而重建用的是 `z.union(next)`，它不带描述 → low 档下 51 个参数（groupId / replyToMessageId / windows…）
 *  的描述凭空消失。描述是模型判断"这个参数填什么"的唯一线索，丢它比不压缩更糟。 */
function withOwnDesc(rebuilt, field, level) {
  const own = descOf(field);
  if (!own) return rebuilt;
  if (level === 'high') return rebuilt;                    // high：本来就不发描述
  try { return rebuilt.describe(applyDesc(own, level)); } catch { return rebuilt; }
}

/**
 * 按档位重建一个 zod 字段（叶子用 describe 副本 → 校验全保留；容器用公开构造器重建）。
 * 认不出的类型原样返回（宁可不压，也不能把校验搞坏）。
 * @param {any} field zod 字段
 * @param {string} level off|low|medium|high
 * @param {any} z zod 实例（注入进来，避免本模块自己 import zod 造成版本歧义）
 */
export function slimField(field, level, z) {
  if (!field || level === 'off') return field;
  const d = field?.def ?? field?._def ?? {};
  const type = String(d.type ?? d.typeName ?? '');
  try {
    switch (type) {
      case 'optional': {
        const inner = slimField(d.innerType, level, z);
        return withOwnDesc(inner.optional(), field, level);
      }
      case 'default': {
        const inner = slimField(d.innerType, level, z);
        return withOwnDesc(inner.default(d.defaultValue), field, level);
      }
      case 'nullable': {
        const inner = slimField(d.innerType, level, z);
        return withOwnDesc(inner.nullable(), field, level);
      }
      case 'array': {
        const el = slimField(d.element, level, z);
        return withOwnDesc(z.array(el), field, level);
      }
      case 'object': {
        const shape = d.shape && typeof d.shape === 'object' ? d.shape : null;
        if (!shape) return field;
        const next = {};
        for (const [k, v] of Object.entries(shape)) next[k] = slimField(v, level, z);
        return withOwnDesc(z.object(next), field, level);
      }
      case 'union': {
        const opts = Array.isArray(d.options) ? d.options : null;
        if (!opts) return field;
        const next = opts.map((o) => slimField(o, level, z));
        return withOwnDesc(z.union(next), field, level);
      }
      default: {
        // 叶子（string/number/boolean/enum/literal/any…）：describe(undefined) 会彻底移除描述
        const next = level === 'high' ? undefined : applyDesc(descOf(field), level);
        return field.describe(next);
      }
    }
  } catch {
    return field;   // 任何意外都退回原字段：压缩是优化，绝不能让它把工具搞坏
  }
}

/** 按档位重建整个参数表（ZodRawShape）。 */
export function slimShape(shape, level, z) {
  if (!shape || typeof shape !== 'object' || level === 'off') return shape;
  const out = {};
  for (const [k, v] of Object.entries(shape)) out[k] = slimField(v, level, z);
  return out;
}

/**
 * 纯函数：按档位算出"压完剩多少字符"，用于实测统计与管理端展示。
 * 输入是已经转好的 JSON Schema（DSH 真正下发的那份）。
 */
export function measureJsonSchemaLevel(jsonSchema, level) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description') {
        const next = applyDesc(v, level);
        if (next) out[k] = next;
        continue;
      }
      out[k] = walk(v);
    }
    return out;
  };
  return JSON.stringify(walk(jsonSchema)).length;
}
