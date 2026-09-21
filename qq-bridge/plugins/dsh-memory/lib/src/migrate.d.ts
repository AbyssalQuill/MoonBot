/**
 * 迁移执行器:把「旧数据 → 迁移补全 → 严格校验」接成一条流水线。
 *
 * 数据格式是 JSONL,没有成熟的数据库迁移引擎适用(docs/data-contract.md §4.3),
 * 故自建轻量迁移:每个迁移导出 `up(record)` 转换函数,按版本号递增注册到
 * {@link MIGRATIONS};{@link migrateRecord} 读记录级 `schemaVersion`(缺省 0),
 * 依次应用所有 `version > 当前` 的迁移,写回 `schemaVersion` 后严格校验。
 *
 * 迁移与校验分离:旧数据(缺 `id`/`schemaVersion`)不通过严格校验,由迁移补全;
 * 新数据直接通过。文件级「读 + 迁移 + 落盘」由 {@link readJsonlMigrating} 承载,
 * 供存储层与只读发现层共用,消除「只读层读旧数据失败 / 每次读补不同临时 id」问题。
 *
 * @module dsh-memory/migrate
 */
import type { MemoryEntry } from './schema.generated.js';
import type { CreatedAtContext } from '../migrations/0002-add-created-at.js';
/**
 * 使 jsonl 读缓存失效(写盘后调用;不传路径则清空全部)。
 * @param jsonlPath - 被改写的 `.remember.jsonl`;缺省清空。
 */
export declare function invalidateJsonlCache(jsonlPath?: string): void;
/**
 * 迁移单条记录:读 `schemaVersion`(缺省 0),依次应用 version > 当前的迁移,
 * 写回 `schemaVersion`,再严格校验。
 * @param raw - 任意来源(如 JSON.parse 产物)的候选记录。
 * @param context - 迁移线索(如文件名日期);缺省只用当前时刻兜底。
 * @returns 迁移(或未迁移)后的合法条目与「是否发生了迁移」标记。
 * @throws 当迁移补全后仍不满足严格校验(数据损坏)。
 */
export declare function migrateRecord(raw: unknown, context?: CreatedAtContext): {
    entry: MemoryEntry;
    migrated: boolean;
};
/**
 * 统计一个 jsonl 文件中「迁移 + 严格校验通过」的条目数(坏行跳过,不抛、不写回)。
 *
 * 与 {@link readJsonlMigrating} 的差异:读路径遇到坏行要 fail loud(防止写路径
 * 静默丢弃数据),但**只读计数**(注册表扫描、目录页计数)不能因为一条坏行
 * 让整个面板失效——计数按「运行时实际能读到的条目」计,坏行降级跳过。
 * @param jsonlPath - jsonl 文件路径。
 * @param now - createdAt 回填上下文(测试注入)。
 * @returns 通过校验的条目数。
 */
export declare function countValidJsonlRows(jsonlPath: string, now?: number): number;
/**
 * 按确定性字段顺序序列化一条记忆为 JSONL 一行(id 在前,`schemaVersion` 次之)。
 * @param entry - 归一化后的记忆条目。
 * @returns 一行 JSON 文本(不含换行)。
 */
export declare function serializeEntry(entry: MemoryEntry): string;
/**
 * 读取一个 jsonl 文件并做旧数据迁移:逐行 JSON.parse → {@link migrateRecord},
 * 若任一旧行被补全(id / schemaVersion),把补全后的全部记录写回 jsonl(保证 id 稳定)。
 *
 * 只写 jsonl、不渲染 MD;MD 投影由存储层写盘时同步(docs/data-contract.md §4.2 的
 * 职责边界:jsonl 是真相源,MD 是投影)。
 * @param jsonlPath - `.remember.jsonl` 路径。
 * @returns 该文件内全部条目(恒带 `id` 与 `schemaVersion`)与是否发生了迁移。
 * @throws 当某行 JSON 非法或迁移后仍不满足严格校验。
 */
export declare function readJsonlMigrating(jsonlPath: string): {
    entries: MemoryEntry[];
    migrated: boolean;
};
