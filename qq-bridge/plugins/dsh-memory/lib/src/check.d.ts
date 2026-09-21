/**
 * Markdown 静态检查:渲染产物写盘前的最终守卫。
 *
 * 检查项:表头 9 列、分隔行 9 列、数据行每行列数与表头一致、无未闭合表格、
 * 单元格内 `|` 已转义。渲染产物不通过则拒绝写盘。纯函数,不 import cordis。
 *
 * @module dsh-memory/check
 */
/**
 * 校验一份渲染出的 Markdown 表格。
 * @param md - 由 {@link renderMd} 生成的表格文本。
 * @returns 错误列表;空数组 = 通过。
 */
export declare function checkMarkdown(md: string): string[];
