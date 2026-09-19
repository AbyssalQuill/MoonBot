// 配置规范化纯函数
// loadConfig/loadState/saveState 及 state 单例属中风险，待 ctx 化阶段一并收编。

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
export function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// 访问控制判断（cfg 由调用方注入）：白名单命中放行；命中黑名单拒绝；名单为空时看"放行开关"。
// OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
// 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
//
// 【2026-09-19 加"分侧放行"】主人要求"允许名单里加一个私聊全部放行"：机器人在群里要严（只认名单），
// 私聊却想让谁都进得来。原有的 `allowAllWhenEmpty` 是**全局**开关，做不到"只放开私聊"。
// 现在三个开关的关系是：
//   · 名单**非空** → 一律以名单为准（开关不会开后门，避免"以为只放行名单、其实全放行"）；
//   · 名单**为空** → 本类开关（allowAllPrivate / allowAllGroups）**或**全局开关，
//     任一为 true 就放行该类；都不为 true（默认）就是"空名单 = 谁都不放行"。
export function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  const perKind = kind === 'private' ? cfg.allowAllPrivate : cfg.allowAllGroups;
  return perKind === true || cfg.allowAllWhenEmpty === true;
}
