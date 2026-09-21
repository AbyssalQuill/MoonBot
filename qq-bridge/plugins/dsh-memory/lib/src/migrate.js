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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { validateEntry } from './schema.js';
import { addIdAndVersion } from '../migrations/0001-add-id-and-version.js';
import { addCreatedAt } from '../migrations/0002-add-created-at.js';
/** jsonl 读缓存:心跳 / 注入 / 面板每 15s 全量扫盘时按 mtime+size 命中,避免反复 schemastery 校验。 */
const jsonlReadCache = new Map();
/**
 * 使 jsonl 读缓存失效(写盘后调用;不传路径则清空全部)。
 * @param jsonlPath - 被改写的 `.remember.jsonl`;缺省清空。
 */
export function invalidateJsonlCache(jsonlPath) {
    if (jsonlPath === undefined)
        jsonlReadCache.clear();
    else
        jsonlReadCache.delete(jsonlPath);
}
/** 全部迁移,按版本号升序。 */
const MIGRATIONS = [
    { version: 1, up: addIdAndVersion },
    { version: 2, up: addCreatedAt },
];
/** 由 schemastery 的 ValidationError 或 JSON 解析错误提取可读文本。 */
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 迁移单条记录:读 `schemaVersion`(缺省 0),依次应用 version > 当前的迁移,
 * 写回 `schemaVersion`,再严格校验。
 * @param raw - 任意来源(如 JSON.parse 产物)的候选记录。
 * @param context - 迁移线索(如文件名日期);缺省只用当前时刻兜底。
 * @returns 迁移(或未迁移)后的合法条目与「是否发生了迁移」标记。
 * @throws 当迁移补全后仍不满足严格校验(数据损坏)。
 */
export function migrateRecord(raw, context = { now: Date.now() }) {
    const record = (typeof raw === 'object' && raw !== null ? raw : {});
    const current = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0;
    let next = { ...record };
    let migrated = false;
    for (const m of MIGRATIONS) {
        if (m.version <= current)
            continue;
        next = m.up(next, context);
        next.schemaVersion = m.version;
        migrated = true;
    }
    return { entry: validateEntry(next), migrated };
}
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
export function countValidJsonlRows(jsonlPath, now = Date.now()) {
    if (existsSync(jsonlPath)) {
        const stat = statSync(jsonlPath);
        const cached = jsonlReadCache.get(jsonlPath);
        if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
            return cached.entries.length;
    }
    const text = readFileSync(jsonlPath, 'utf8');
    const fileDate = /^(\d{4}-\d{2}-\d{2})/.exec(basename(jsonlPath))?.[1];
    const context = { fileDate, now };
    let count = 0;
    for (const line of text.split('\n')) {
        if (line.trim().length === 0)
            continue;
        try {
            migrateRecord(JSON.parse(line), context);
            count += 1;
        }
        catch {
            // 坏行跳过:计数口径与导出(原始行数)的差异见 collections.ts 注释。
        }
    }
    return count;
}
/**
 * 按确定性字段顺序序列化一条记忆为 JSONL 一行(id 在前,`schemaVersion` 次之)。
 * @param entry - 归一化后的记忆条目。
 * @returns 一行 JSON 文本(不含换行)。
 */
export function serializeEntry(entry) {
    return JSON.stringify({
        id: entry.id,
        schemaVersion: entry.schemaVersion,
        createdAt: entry.createdAt,
        type: entry.type,
        domain: entry.domain,
        scope: entry.scope,
        layer: entry.layer,
        entry: entry.entry,
        entryPoint: entry.entryPoint,
        references: entry.references,
    });
}
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
export function readJsonlMigrating(jsonlPath) {
    if (!existsSync(jsonlPath)) {
        jsonlReadCache.delete(jsonlPath);
        return { entries: [], migrated: false };
    }
    const stat = statSync(jsonlPath);
    const cached = jsonlReadCache.get(jsonlPath);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
        return { entries: cached.entries, migrated: false };
    const text = readFileSync(jsonlPath, 'utf8');
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    // 文件名日期作为 createdAt 回填的第一线索(`YYYY-MM-DD[.<partition>]....jsonl` 前缀)。
    const fileDate = /^(\d{4}-\d{2}-\d{2})/.exec(basename(jsonlPath))?.[1];
    const context = { fileDate, now: Date.now() };
    const entries = [];
    let migrated = false;
    for (let i = 0; i < lines.length; i++) {
        let raw;
        try {
            raw = JSON.parse(lines[i]);
        }
        catch (error) {
            throw new Error(`remember.jsonl:${i + 1}: invalid JSON: ${describeError(error)}`);
        }
        const result = migrateRecord(raw, context);
        entries.push(result.entry);
        if (result.migrated)
            migrated = true;
    }
    if (migrated) {
        writeFileSync(jsonlPath, entries.length > 0 ? `${entries.map(serializeEntry).join('\n')}\n` : '', 'utf8');
    }
    const next = migrated ? statSync(jsonlPath) : stat;
    jsonlReadCache.set(jsonlPath, { mtimeMs: next.mtimeMs, size: next.size, entries });
    return { entries, migrated };
}
