/**
 * 迁移 v1 → v2:给缺 `createdAt` 的旧记录回填创建时间。
 *
 * v1 记录无 `createdAt`(9 字段缺一);v2 记录带系统赋值的创建时间(epoch 毫秒)。
 * 旧数据没有真实创建时刻,只能按可用线索回填:优先文件名日期(`YYYY-MM-DD` 前缀,
 * 取本地零点),缺失或非法时用迁移发生时刻兜底——都是「近似而非真实」的回填,
 * Timeline 只保证有值可排序,不承诺精确到时刻。
 *
 * @module dsh-memory/migrations/0002-add-created-at
 */
/** 把 `YYYY-MM-DD` 解析为本地零点的 epoch 毫秒;非法返回 undefined。 */
function parseFileDate(fileDate) {
    if (fileDate === undefined)
        return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fileDate);
    if (match === null)
        return undefined;
    const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    return Number.isFinite(ms) ? ms : undefined;
}
/**
 * 回填 `createdAt`:优先文件名日期(本地零点),缺失/非法时用迁移时刻。
 * 已带合法 `createdAt` 的记录原样返回(按版本号本迁移只对 v1 记录跑一次,幂等只是防御)。
 * @param record - 迁移前的记录(缺 `createdAt`)。
 * @param context - 回填线索(fileDate / now)。
 * @returns 补齐 `createdAt` 后的记录。
 */
export function addCreatedAt(record, context) {
    if (typeof record.createdAt === 'number')
        return record;
    return { ...record, createdAt: parseFileDate(context.fileDate) ?? context.now };
}
