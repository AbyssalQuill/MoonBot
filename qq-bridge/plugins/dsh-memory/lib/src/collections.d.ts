/**
 * 记忆包导出:把注册表里的全部或选定记忆根合并导出到一个目录(纯逻辑,
 * 不 import cordis)。设计见 docs/storage-and-collections.md §Q3。
 *
 * 导出 = 真相源直拷(jsonl + md)+ manifest;记忆 id 是 crypto 随机全局唯一,
 * 跨根不碰撞,多包合并展开不冲突。本轮只做导出;import(合并回 host)是后续扩展。
 *
 * @module dsh-memory/collections
 */
/** 导出 manifest 格式版本(结构变化时递增)。 */
export declare const EXPORT_FORMAT_VERSION = 1;
/** manifest 里一个根的清单。 */
export interface ExportRootEntry {
    /** 来源根路径。 */
    readonly root: string;
    /** 该根导出的条目数。 */
    readonly entries: number;
    /** 该根导出的文件清单(相对该根目录)。 */
    readonly files: readonly string[];
}
/** 导出 manifest.json 的全文。 */
export interface ExportManifest {
    /** 格式版本。 */
    readonly formatVersion: number;
    /** 导出来源(固定标记)。 */
    readonly source: 'dsh-memory';
    /** 导出时刻(epoch 毫秒;由调用方传入,可测)。 */
    readonly exportedAt: number;
    /** 导出总条目数。 */
    readonly totalEntries: number;
    /** 各来源根清单。 */
    readonly roots: readonly ExportRootEntry[];
}
/** 一次导出的结果。 */
export interface ExportResult {
    /** 导出产物目录(绝对路径)。 */
    readonly dir: string;
    /** 导出总条目数。 */
    readonly totalEntries: number;
    /** 实际导出的根数。 */
    readonly rootsExported: number;
}
/** 默认导出落点(`~/dsh-memory-exports/`)。 */
export declare function defaultExportDir(): string;
/** 导出目录名后缀(本地时间戳;由调用方传入,可测)。 */
export declare function exportDirName(now: Date): string;
/**
 * 导出记忆包:把选定根(jsonl 真相源 + md 投影)拷到
 * `<outDir>/dsh-memory-<时间戳>/roots/<nn>/`,并写 manifest.json。
 *
 * 根缺省取注册表全部根(先刷新);`roots` 参数指定时只导出这些路径(存在才导)。
 * 与根同名的冲突不会发生——manifest 用序号目录隔离来源。
 * @param cwd - 当前工作目录(刷新注册表时登记项目根)。
 * @param options - `outDir`(落点,缺省 {@link defaultExportDir})、`roots`(选定根)。
 * @param now - 导出时刻(测试注入)。
 * @returns 导出结果。
 */
export declare function exportCollections(cwd: string | undefined, options?: {
    outDir?: string;
    roots?: readonly string[];
}, now?: Date): ExportResult;
