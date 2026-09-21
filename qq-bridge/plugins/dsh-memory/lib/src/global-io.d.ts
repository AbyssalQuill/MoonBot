/**
 * global 记忆的导出包与导入防线(纯逻辑,不 import cordis;docs/global-layer-design.md §9)。
 *
 * 与 `collections export` 的分叉:collections 是「jsonl+md 直拷 + manifest」(面向
 * 备份/迁移);global 导出是单文件 JSON 包——携带 kind 来源标记与逐条 layer 确认,
 * 是导入防线的第一道门。两者 formatVersion 独立演进,kind 字段先行区分。
 *
 * @module dsh-memory/global-io
 */
import type { MemoryEntry } from './schema.js';
/** global 导出包来源标记(防线 1,先于 formatVersion 校验;collections manifest 无此 kind,顺序不可调换)。 */
export declare const GLOBAL_EXPORT_KIND = "dsh-memory-global-export";
/** global 导出包格式版本(结构变化时递增;不支持的高版本拒绝并提示升级)。 */
export declare const GLOBAL_EXPORT_FORMAT_VERSION = 1;
/** global 导出包文档(单文件 JSON)。 */
export interface GlobalExportDoc {
    /** 来源标记(恒为 {@link GLOBAL_EXPORT_KIND})。 */
    readonly kind: string;
    /** 格式版本(恒为 {@link GLOBAL_EXPORT_FORMAT_VERSION})。 */
    readonly formatVersion: number;
    /** 导出时刻(epoch 毫秒)。 */
    readonly exportedAt: number;
    /** 来源实现。 */
    readonly source: string;
    /** 完整 MemoryEntry 字段(10 字段,含 schemaVersion/id/createdAt/layer=global)。 */
    readonly entries: readonly MemoryEntry[];
}
/** 导出包解析结果(非法包携带可展示的原因)。 */
export type GlobalExportParse = {
    readonly ok: true;
    readonly doc: GlobalExportDoc;
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * 构建 global 导出包(全部 global 目录条目,完整字段)。
 * @param now - 导出时刻(测试注入);缺省当前时间。
 * @returns 导出包文档。
 */
export declare function buildGlobalExport(now?: number): GlobalExportDoc;
/**
 * 解析 global 导出包(防线 1 kind → 防线 2 formatVersion;§9.3 顺序不可调换)。
 * 条目内容不在此逐条校验(由 {@link importGlobalEntries} 的 migrateRecord 防线承担),
 * 但 `entries` 必须是数组。
 * @param text - 导入文件全文。
 * @returns 解析结果或拒绝原因。
 */
export declare function parseGlobalExport(text: string): GlobalExportParse;
/** 一条被拒绝导入的条目(原文摘录 + 原因,供回显)。 */
export interface GlobalImportSkipped {
    /** 条目文本(可解析时)或原文 JSON 摘录。 */
    readonly entry: string;
    /** 拒绝原因。 */
    readonly reason: string;
}
/** 导入结果汇总(§9.3 步骤 7)。 */
export interface GlobalImportResult {
    /** 实际写入的条目数。 */
    readonly imported: number;
    /** 重复(批内或与存量按 entry 相同,或同 id 冲突)而未写入的条目数。 */
    readonly duplicates: number;
    /** 逐条拒绝明细(schema 迁移失败 / gate 拒绝 / layer 非 global)。 */
    readonly skipped: readonly GlobalImportSkipped[];
    /** 意外异常(正常为空;防线的确定性拒绝走 skipped)。 */
    readonly errors: readonly string[];
}
/**
 * 导入 global 导出包条目(§9.3 防线顺序):
 * 3 逐条 migrateRecord(失败计 skipped 列原因)→ 3.5 确定性 gate 硬查 → 4 强制
 * layer=global(非 global 计 skipped)→ 5 批内 + 存量两轮 entry 去重(计 duplicates)
 * → 6 appendImported(保留原 id/createdAt/schemaVersion)。
 * @param doc - 已通过 envelope 防线(kind/formatVersion)的导出包。
 * @returns 导入结果。
 */
export declare function importGlobalEntries(doc: GlobalExportDoc): GlobalImportResult;
