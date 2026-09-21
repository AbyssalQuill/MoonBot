/**
 * 长期记忆 JSONL → Markdown 投影的纯函数渲染。
 *
 * `.remember.md` 只是渲染投影(9 列 Markdown 表格:首列 id + 8 个字段),由本模块
 * 从归一化条目纯函数生成,绝不解析 Markdown。单元格内的 `|` 转义为 `\|`;system
 * prompt 注入用 {@link renderSummary} 只列条目文本,不注入整段历史。
 *
 * @module dsh-memory/render
 */
import { TABLE_HEADER, TABLE_SEPARATOR } from './schema.js';
/** 把单元格文本中的 `|` 转义为 `\|`,保证表格结构不被破坏。 */
export function escapeCell(text) {
    return text.replace(/\|/g, '\\|');
}
/**
 * 把 epoch 毫秒渲染为本地 `YYYY-MM-DD HH:mm:ss`(Markdown 投影的 createdAt 列,人读)。
 * @param epochMs - 创建时间的 epoch 毫秒。
 * @returns 本地时间字符串。
 */
export function formatCreatedAt(epochMs) {
    const d = new Date(epochMs);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/**
 * 一条记忆在节点文本里的一行:`[id|type|domain|scope] entry`。
 * recall 与 review 节点共用(召回按 id 去重并逆查补全,review 按 id 指认缺陷)。
 * @param entry - 归一化后的记忆条目。
 * @returns 单行节点文本。
 */
export function entryLine(entry) {
    return `[${entry.id}|${entry.type}|${entry.domain}|${entry.scope}] ${entry.entry}`;
}
/** 渲染一条记忆为 9 列表格行(首列 id + 8 个字段,不含首尾换行)。 */
function renderRow(entry) {
    const cells = [
        entry.id,
        entry.type,
        entry.domain,
        entry.scope,
        entry.layer,
        formatCreatedAt(entry.createdAt),
        escapeCell(entry.entry),
        escapeCell(entry.entryPoint),
        escapeCell(entry.references),
    ];
    return `| ${cells.join(' | ')} |`;
}
/**
 * 由归一化条目渲染 9 列 Markdown 表格(表头 + 分隔行 + 每行一条)。
 * @param entries - 归一化后的记忆条目。
 * @returns 完整表格文本(末尾带一个换行)。
 */
export function renderMd(entries) {
    const header = `| ${TABLE_HEADER.join(' | ')} |`;
    const rows = entries.map(renderRow);
    return `${[header, TABLE_SEPARATOR, ...rows].join('\n')}\n`;
}
/**
 * 由归一化条目渲染 system prompt 注入用的「已知记忆」摘要(只列条目文本,
 * 非整段历史)。空集返回空串,由调用方决定是否省略该 section。
 * @param entries - 归一化后的记忆条目。
 * @returns 逐条 `- [type] entry` 的多行摘要,或空串。
 */
export function renderSummary(entries) {
    if (entries.length === 0)
        return '';
    return entries.map(entry => `- [${entry.type}] ${entry.entry}`).join('\n');
}
/**
 * system prompt 注入的 global 全文条目数上限;超过时注明「更早的 global 记忆
 * 经 recall 获取」(docs/global-layer-design.md §6.1)。
 * 哨兵值而非调优旋钮(注入预算固定,调整语义用 summaryMode),故为常量而非配置项,
 * 类比 {@link ../extract.js} 的 MIN_TRANSCRIPT_CHARS 先例。
 */
export const GLOBAL_INJECT_MAX = 30;
/** 按 domain 计数降序(同计数按 domain 名升序)渲染一条统计行;无条目返回 undefined。 */
function renderDomainCounts(entries, label) {
    if (entries.length === 0)
        return undefined;
    const counts = new Map();
    for (const entry of entries)
        counts.set(entry.domain, (counts.get(entry.domain) ?? 0) + 1);
    const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([domain, count]) => `${domain} ×${count}`);
    return `（${label}记忆 ${entries.length} 条:${parts.join(',')}）`;
}
/**
 * 渲染 system prompt 注入用的记忆摘要(docs/global-layer-design.md §6.1)。
 *
 * mode='global'(默认):global 条目全文(createdAt 降序、同刻按 id 升序定序、
 * 截断 {@link GLOBAL_INJECT_MAX},超限附「更早条目经 recall 获取」注记)+
 * 用户记忆 domain 计数行 + 当前工作区 project 记忆 domain 计数行(计数降序、
 * 全部 domain 列出)。mode='all':返回 {@link renderSummary} 的旧全量行为。
 * 退化规则:global 0 条只输出统计行;project 0 条省略该行;全部为 0 输出空串。
 * @param entries - 归一化后的记忆条目(调用方已合并可见链与 global 目录)。
 * @param mode - 注入模式。
 * @param maxInject - global 全文条目数上限(测试注入;缺省 {@link GLOBAL_INJECT_MAX})。
 * @returns 多行摘要文本,或空串。
 */
export function renderMemorySummary(entries, mode, maxInject = GLOBAL_INJECT_MAX) {
    if (mode === 'all')
        return renderSummary(entries);
    const global = entries.filter(entry => entry.layer === 'global');
    const user = entries.filter(entry => entry.layer === 'user');
    const project = entries.filter(entry => entry.layer === 'project');
    const lines = [];
    const sorted = [...global].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const capped = sorted.slice(0, maxInject);
    if (capped.length > 0) {
        lines.push(...capped.map(entry => `- [${entry.type}] ${entry.entry}`));
        if (sorted.length > maxInject) {
            lines.push(`（更早的 ${sorted.length - maxInject} 条 global 记忆经 recall 获取）`);
        }
    }
    const userLine = renderDomainCounts(user, '用户');
    if (userLine !== undefined)
        lines.push(userLine);
    const projectLine = renderDomainCounts(project, '当前工作区 project ');
    if (projectLine !== undefined)
        lines.push(projectLine);
    return lines.join('\n');
}
