/**
 * global 记忆的导出包与导入防线(纯逻辑,不 import cordis;docs/global-layer-design.md §9)。
 *
 * 与 `collections export` 的分叉:collections 是「jsonl+md 直拷 + manifest」(面向
 * 备份/迁移);global 导出是单文件 JSON 包——携带 kind 来源标记与逐条 layer 确认,
 * 是导入防线的第一道门。两者 formatVersion 独立演进,kind 字段先行区分。
 *
 * @module dsh-memory/global-io
 */
import { discoverGlobalEntries, visibleGlobalDir } from './memory-file.js';
import { migrateRecord } from './migrate.js';
import { checkGlobalGate } from './global-gate.js';
import { appendImported } from './store.js';
/** global 导出包来源标记(防线 1,先于 formatVersion 校验;collections manifest 无此 kind,顺序不可调换)。 */
export const GLOBAL_EXPORT_KIND = 'dsh-memory-global-export';
/** global 导出包格式版本(结构变化时递增;不支持的高版本拒绝并提示升级)。 */
export const GLOBAL_EXPORT_FORMAT_VERSION = 1;
/**
 * 构建 global 导出包(全部 global 目录条目,完整字段)。
 * @param now - 导出时刻(测试注入);缺省当前时间。
 * @returns 导出包文档。
 */
export function buildGlobalExport(now = Date.now()) {
    return {
        kind: GLOBAL_EXPORT_KIND,
        formatVersion: GLOBAL_EXPORT_FORMAT_VERSION,
        exportedAt: now,
        source: 'dsh-memory',
        entries: discoverGlobalEntries(),
    };
}
/**
 * 解析 global 导出包(防线 1 kind → 防线 2 formatVersion;§9.3 顺序不可调换)。
 * 条目内容不在此逐条校验(由 {@link importGlobalEntries} 的 migrateRecord 防线承担),
 * 但 `entries` 必须是数组。
 * @param text - 导入文件全文。
 * @returns 解析结果或拒绝原因。
 */
export function parseGlobalExport(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (typeof raw !== 'object' || raw === null)
        return { ok: false, reason: 'export is not a JSON object' };
    const doc = raw;
    if (doc.kind !== GLOBAL_EXPORT_KIND) {
        return { ok: false, reason: '不是真实的 global 导出(不是 dsh-memory global 导出包)' };
    }
    if (typeof doc.formatVersion !== 'number') {
        return { ok: false, reason: 'export has no formatVersion' };
    }
    if (doc.formatVersion > GLOBAL_EXPORT_FORMAT_VERSION) {
        return { ok: false, reason: `unsupported global export formatVersion ${doc.formatVersion} (this build supports up to ${GLOBAL_EXPORT_FORMAT_VERSION}); upgrade dsh-memory first` };
    }
    if (doc.formatVersion < GLOBAL_EXPORT_FORMAT_VERSION) {
        return { ok: false, reason: `unknown legacy global export formatVersion ${doc.formatVersion}` };
    }
    if (!Array.isArray(doc.entries)) {
        return { ok: false, reason: 'export has no entries array' };
    }
    return {
        ok: true,
        doc: {
            kind: GLOBAL_EXPORT_KIND,
            formatVersion: doc.formatVersion,
            exportedAt: typeof doc.exportedAt === 'number' ? doc.exportedAt : 0,
            source: typeof doc.source === 'string' ? doc.source : '',
            entries: doc.entries,
        },
    };
}
/** 不可解析条目的可读摘录。 */
function describeRawEntry(raw) {
    if (typeof raw === 'object' && raw !== null && typeof raw.entry === 'string') {
        return raw.entry;
    }
    try {
        return JSON.stringify(raw).slice(0, 200);
    }
    catch {
        return String(raw).slice(0, 200);
    }
}
/**
 * 导入 global 导出包条目(§9.3 防线顺序):
 * 3 逐条 migrateRecord(失败计 skipped 列原因)→ 3.5 确定性 gate 硬查 → 4 强制
 * layer=global(非 global 计 skipped)→ 5 批内 + 存量两轮 entry 去重(计 duplicates)
 * → 6 appendImported(保留原 id/createdAt/schemaVersion)。
 * @param doc - 已通过 envelope 防线(kind/formatVersion)的导出包。
 * @returns 导入结果。
 */
export function importGlobalEntries(doc) {
    const existing = new Set(discoverGlobalEntries().map(entry => entry.entry));
    const batchSeen = new Set();
    const accepted = [];
    const skipped = [];
    const errors = [];
    let duplicates = 0;
    for (const raw of doc.entries) {
        let migrated;
        try {
            migrated = migrateRecord(raw).entry;
        }
        catch (error) {
            skipped.push({ entry: describeRawEntry(raw), reason: error instanceof Error ? error.message : String(error) });
            continue;
        }
        const gate = checkGlobalGate(migrated);
        if (!gate.pass) {
            skipped.push({ entry: migrated.entry, reason: `gate: ${gate.reason}` });
            continue;
        }
        if (migrated.layer !== 'global') {
            skipped.push({ entry: migrated.entry, reason: `layer "${migrated.layer}" is not global` });
            continue;
        }
        if (batchSeen.has(migrated.entry) || existing.has(migrated.entry)) {
            duplicates += 1;
            continue;
        }
        batchSeen.add(migrated.entry);
        accepted.push(migrated);
    }
    const appended = appendImported(visibleGlobalDir(), accepted);
    return {
        imported: appended.imported,
        duplicates: duplicates + appended.duplicates,
        skipped,
        errors,
    };
}
