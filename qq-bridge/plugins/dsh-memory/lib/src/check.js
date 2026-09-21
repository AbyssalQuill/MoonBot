/**
 * Markdown 静态检查:渲染产物写盘前的最终守卫。
 *
 * 检查项:表头 9 列、分隔行 9 列、数据行每行列数与表头一致、无未闭合表格、
 * 单元格内 `|` 已转义。渲染产物不通过则拒绝写盘。纯函数,不 import cordis。
 *
 * @module dsh-memory/check
 */
/** 表格应有的列数(首列 id + {@link MemoryEntry} 的 8 个字段)。 */
const COLUMN_COUNT = 9;
/** 管道符在给定下标是否被转义(前导反斜杠数为奇 = 已转义)。 */
function isEscapedPipe(text, index) {
    let backslashes = 0;
    for (let j = index - 1; j >= 0 && text[j] === '\\'; j--)
        backslashes += 1;
    return backslashes % 2 === 1;
}
/**
 * 把一行表格拆成单元格:去掉首尾 `|`,按未转义的 `|` 切分。
 * 渲染时单元格内的 `|` 已转义为 `\|`,故只有列分隔符是裸 `|`;残留的未转义
 * `|` 会把一行切出多于 8 列,由 {@link checkMarkdown} 报列数不一致。
 * @param line - 一行表格(含首尾 `|`)。
 * @returns 单元格数组(去首尾空白)。
 */
function splitRow(line) {
    const trimmed = line.trim();
    const withoutLeading = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
    const withoutTrailing = withoutLeading.endsWith('|') ? withoutLeading.slice(0, -1) : withoutLeading;
    const cells = [];
    let current = '';
    for (let i = 0; i < withoutTrailing.length; i++) {
        const ch = withoutTrailing[i];
        if (ch === '|' && !isEscapedPipe(withoutTrailing, i)) {
            cells.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    cells.push(current.trim());
    return cells;
}
/**
 * 校验一份渲染出的 Markdown 表格。
 * @param md - 由 {@link renderMd} 生成的表格文本。
 * @returns 错误列表;空数组 = 通过。
 */
export function checkMarkdown(md) {
    const errors = [];
    const lines = md.replace(/\n$/, '').split('\n');
    if (lines.length < 2) {
        return ['table needs at least a header and a separator row'];
    }
    const headerCells = splitRow(lines[0]);
    if (headerCells.length !== COLUMN_COUNT) {
        errors.push(`header row has ${headerCells.length} columns, expected ${COLUMN_COUNT}`);
    }
    const separatorCells = splitRow(lines[1]);
    if (separatorCells.length !== COLUMN_COUNT) {
        errors.push(`separator row has ${separatorCells.length} columns, expected ${COLUMN_COUNT}`);
    }
    else if (separatorCells.some(cell => !/^:?-+:?$/.test(cell))) {
        errors.push('separator row cells must each match `---` (optionally with alignment colons)');
    }
    for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0) {
            errors.push(`data row ${i + 1} is empty`);
            continue;
        }
        const cells = splitRow(line);
        if (cells.length !== COLUMN_COUNT) {
            errors.push(`data row ${i + 1} has ${cells.length} columns, expected ${COLUMN_COUNT} (unescaped \`|\` in a cell?)`);
        }
    }
    return errors;
}
