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

// 访问控制判断（cfg 由调用方注入）：白名单命中放行；命中黑名单拒绝；名单空时看 allowAllWhenEmpty。
// OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
// 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
export function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}
