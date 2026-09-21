/**
 * 迁移 v0 → v1:给缺 `id` 的旧记录补一个 {@link MemoryId}。
 *
 * v0 记录无 `id`、无 `schemaVersion`(7 字段);v1 记录带全局唯一 `id` 与
 * 记录级 `schemaVersion`。本迁移只负责补 `id`——`schemaVersion` 由迁移执行器
 * {@link ../src/migrate.js} 统一写回,不在每个迁移里手写。
 *
 * @module dsh-memory/migrations/0001-add-id-and-version
 */
import { generateMemoryId, isMemoryId } from '../src/schema.js';
/**
 * 给缺 `id` 的记录补一个合法 {@link MemoryId};已有合法 `id` 时原样保留。
 * @param record - 迁移前的记录(可能缺 `id`)。
 * @returns 补齐 `id` 后的记录。
 */
export function addIdAndVersion(record) {
    const next = { ...record };
    if (!isMemoryId(next.id))
        next.id = generateMemoryId();
    return next;
}
