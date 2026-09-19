// 隔离 DSH 凭据文件（`.credentials.yaml`）的纯逻辑：定位 refs 块、增/改/删一条 ENV、读状态。
//
// 【为什么单独一个模块 · 2026-09-19】
//   管理端要按服务商把「接口密钥」写进隔离 DSH 的凭据文件；这份改写逻辑本地（直接写盘）与
//   服务端（SSH 写盘）**必须一模一样**，而且它踩过的坑必须能被单独测到 —— 放进 server/index.js
//   里就既不能 import 也不能单测（那个文件一 import 就起 Express）。
//
// 【坑：密钥必须写在 `refs:` 下面、缩进 2 格，顶格写会把 DSH 弄坏】
//   依据是 DSH 自己的实现（`@deepseek-ai/dsh-credentials-local/lib/index.js`，与线上同一份）：
//     · 文档里没有 `version` 键 → 报 "uses the pre-release flat layout" 直接拒收；
//     · **顶层出现 version/refs/records 之外的键 → 报 `unknown top-level key`**；
//     · 官方对老扁平格式的迁移 = 把原有行原样多缩进 2 格塞进 `refs:` 下面；
//     · `refs` 的键必须是 POSIX 标识符、值必须是非空字符串。
//   第一版实现按"顶格 KEY: value"写，等于把已有条目搬出 refs → DSH 启动解析失败。这里按缩进感知改写。

/**
 * 定位 `.credentials.yaml` 里的 `refs:` 块（顶层 `refs:` 起，到下一个顶格行为止）。
 * @param {string[]} lines
 * @returns {{rIdx:number, last:number, indent:string}|null} null = 没有 refs 块（不是 DSH 认的结构）
 */
export function credentialRefsBlock(lines) {
  const rIdx = lines.findIndex((l) => /^refs\s*:\s*$/.test(l));
  if (rIdx < 0) return null;
  let last = rIdx;
  for (let i = rIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;          // 空行/注释不结束块
    if (l.match(/^\s*/)[0].length === 0) break;          // 回到顶格 = 出了 refs 块
    last = i;
  }
  let indent = '  ';                                     // 块是空的 → 按 YAML 惯例缩进 2 格
  for (let i = rIdx + 1; i <= last; i += 1) {
    const m = /^(\s+)[A-Za-z0-9_]+\s*:/.exec(lines[i]);
    if (m) { indent = m[1]; break; }                     // 跟兄弟条目保持同一种缩进
  }
  return { rIdx, last, indent };
}

/**
 * 把值写成 YAML 里安全的标量：能用裸值就用裸值，不能用就加双引号转义。
 *
 * 【为什么要这一步】`.credentials.yaml` 是**真 YAML**（DSH 用 `yaml` 库 `parseDocument` 解析）。
 * 真实的 key 是字母数字加点划（裸写没问题，行为与以前一致），但万一值是 `abc: def`、以 `#`/`&`/`*`
 * 开头、或含引号，裸写会被 YAML 解析成另一种东西（映射/注释/锚点）甚至直接报错 —— 那等于把
 * 用户的凭据写坏。裸值判据故意保守：只在"一眼就是普通字母数字串"时才省引号。
 */
/** YAML 会把这些裸值解析成布尔/空，不是字符串（DSH 的 parseRefs 要求值必须是字符串） */
const YAML_NON_STRING_WORDS = /^(true|false|null|yes|no|on|off|nan|inf|~)$/i;
/** 纯数字外形：整数/小数/科学计数法/带正负号 —— YAML 会把它解析成数字（实测 `1e5` → 100000） */
const YAML_NUMBERISH = /^[0-9eExXoObB.+-]+$/;
/** 进制字面量外形（0x1f / 0o17 / 0b101）—— 也会被解析成数字 */
const YAML_RADIX = /^[+-]?0[xXoObB][0-9a-fA-F_]+$/;
/**
 * 裸值判据（保守）：只有"一眼就是普通字母数字串"的才省引号，其它一律双引号包起来。
 * 实测（tools/test-iso-credential.mjs 第 ⑩ 节用 DSH 自带的 yaml 库逐例验证）：
 *   纯数字 / 1.5 / 1e5 / true / null / 以 # & 开头 / 含 : 空格 全都会被 YAML 解析成非字符串或报错，
 *   而 DSH 的 parseRefs 只收**字符串**值 —— 所以这些必须带引号。
 */
function yamlScalar(value) {
  const v = String(value);
  const plain = /^[A-Za-z0-9][A-Za-z0-9._/+=@-]*$/.test(v)
    && /[A-Za-z]/.test(v)
    && !YAML_NUMBERISH.test(v)
    && !YAML_RADIX.test(v)
    && !YAML_NON_STRING_WORDS.test(v)
    && !/:$/.test(v) && !/#/.test(v);
  if (plain) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 读取时还原上面那层引号转义（用于把长度算准；键本身不含引号时行为不变） */
function unquoteScalar(raw) {
  const v = String(raw ?? '').trim();
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return v.replace(/^'|'$/g, '');
}

/**
 * 纯函数：在 `.credentials.yaml` 的文本里增/改/删一条 `ENV: value`（保留其它内容与顺序）。
 * 本地写盘与服务端（SSH）写盘共用这一份逻辑，避免两边行为漂移。
 * @param {string} cur 现有文本
 * @param {string} key 环境变量名
 * @param {string|null} value null = 删除这一条
 * @returns {{text:string, existed:boolean, ok:boolean, error?:string}}
 */
export function mergeCredentialText(cur, key, value) {
  const env = String(key || '').trim();
  const text = String(cur ?? '');
  const lines = text.split(/\r?\n/);
  const at = (needle) => lines.findIndex((l) => new RegExp(`^\\s*${needle}\\s*:`).test(l));
  const idx = at(env);
  if (value === null) {
    if (idx < 0) return { text, existed: false, ok: true };
    lines.splice(idx, 1);
    return { text: lines.join('\n'), existed: true, ok: true };
  }
  const block = credentialRefsBlock(lines);
  if (!block) {
    return {
      text, existed: idx >= 0, ok: false,
      error: '凭据文件不是 DSH 认的结构（缺 `version: 1` 或 `refs:` 段）—— 顶层写 `KEY: value` 会让 DSH 启动报 unknown top-level key，故拒绝改写',
    };
  }
  const kvLine = (indent) => `${indent}${env}: ${yamlScalar(value)}`;
  // ① 已经在 refs 块里 → 原地改（用这一行自己的缩进）
  if (idx > block.rIdx && idx <= block.last) {
    const ind = (lines[idx].match(/^\s*/)[0]) || block.indent;
    lines[idx] = kvLine(ind);
    return { text: lines.join('\n'), existed: true, ok: true };
  }
  // ② 存在但不在 refs 块里（顶格残留）→ 删掉再按规矩插进 refs 块
  if (idx >= 0) lines.splice(idx, 1);
  const anchor = credentialRefsBlock(lines);
  lines.splice(anchor.last + 1, 0, kvLine(anchor.indent));
  return { text: lines.join('\n'), existed: idx >= 0, ok: true };
}

/**
 * 纯函数：凭据文件文本里这个环境变量配没配（只回布尔 + 长度，**绝不回值**）。本地 / 服务端共用。
 * @param {string} credText
 * @param {string} env
 * @returns {{set:boolean, len:number}}
 */
export function credentialStatusFromText(credText, env) {
  let set = false;
  let len = 0;
  if (credText) {
    const m = new RegExp(`^\\s*${env}\\s*:\\s*(.*)$`, 'm').exec(credText);
    if (m) { const v = unquoteScalar(m[1]); set = v.length > 0; len = v.length; }
  }
  return { set, len };
}

/**
 * 按 DSH 自己的四条规矩检查文本是不是它能吃的文档（**不依赖 yaml 包**，只做结构判定）。
 * 用在测试与写入前自检：不合规就绝不用它覆盖磁盘上的文件。
 * @returns {{ok:boolean, error?:string}}
 */
export function validateCredentialDocument(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const topKeys = [];
  for (const l of lines) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (l.match(/^\s*/)[0].length === 0) {
      const m = /^([A-Za-z0-9_.\-]+)\s*:/.exec(l);
      if (m) topKeys.push(m[1]);
    }
  }
  if (!topKeys.includes('version')) return { ok: false, error: '缺 `version`（DSH 会报 pre-release flat layout）' };
  const unknown = topKeys.filter((k) => !['version', 'refs', 'records'].includes(k));
  if (unknown.length) return { ok: false, error: `顶层出现未知键：${unknown.join(', ')}（DSH 会报 unknown top-level key）` };
  const block = credentialRefsBlock(lines);
  if (!block) return { ok: false, error: '缺 `refs:` 段' };
  for (let i = block.rIdx + 1; i <= block.last; i += 1) {
    const m = /^\s+([^\s:]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1])) return { ok: false, error: `refs 里的键名不合规：${m[1]}` };
    if (m[2].trim().length === 0) return { ok: false, error: `refs 里的值不能为空：${m[1]}` };
  }
  return { ok: true };
}
