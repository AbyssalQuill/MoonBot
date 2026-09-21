/**
 * host 级记忆根注册表:`~/.dsh/lmemory/registry.json`(纯逻辑,不 import cordis)。
 *
 * 回答「host 上有多少个 lmemory 目录、各自在哪、有多少数据」:固定根(用户 dsh /
 * 用户 agents)恒登记,项目根惰性登记(启动与 session-start 时传入 cwd);历史根
 * 保留,已消失的保持最后已知计数。设计见 docs/storage-and-collections.md §Q2。
 *
 * @module dsh-memory/registry
 */
/** registry 格式版本(结构变化时递增;读取端只认格式,不认识则视为空表)。 */
export declare const REGISTRY_FORMAT_VERSION = 1;
/** 记忆根类型(user / project / global)。 */
export type RegistryRootKind = 'user' | 'project' | 'global';
/** 一个已登记的记忆根。 */
export interface RegistryRoot {
    /** 根目录绝对路径。 */
    readonly root: string;
    /** 根类型:用户级或项目级。 */
    readonly kind: RegistryRootKind;
    /** 首次登记时间(epoch 毫秒)。 */
    readonly firstSeenAt: number;
    /** 最近一次刷新时间(epoch 毫秒)。 */
    readonly lastSeenAt: number;
    /** 最近一次刷新时的条目数(根消失后保持最后已知值)。 */
    readonly entries: number;
    /** 最近一次刷新时的记忆文件数。 */
    readonly files: number;
}
/** registry 文档(registry.json 全文)。 */
export interface Registry {
    /** 格式版本。 */
    readonly formatVersion: number;
    /** 最近一次写入时间(epoch 毫秒)。 */
    readonly updatedAt: number;
    /** 全部已登记根(按登记顺序)。 */
    readonly roots: readonly RegistryRoot[];
}
/** registry.json 的固定路径(在用户 lmemory 根内,随用户根一起备份)。 */
export declare function registryPath(): string;
/**
 * 读取注册表;文件缺失 / 损坏返回空注册表(派生索引,可重建,不抛)。
 * @returns 当前注册表。
 */
export declare function loadRegistry(): Registry;
/**
 * 写回注册表(原子:临时文件 + rename)。
 * @param registry - 要落盘的注册表。
 */
export declare function saveRegistry(registry: Registry): void;
/** 根扫描明细:条目数、文件数与每个 jsonl 文件的条目数(目录页文件级明细用)。 */
export interface RootScanDetail {
    /** 总条目数。 */
    readonly entries: number;
    /** 记忆文件数。 */
    readonly files: number;
    /** 每个 `.remember.jsonl` 的文件名与条目数(按名排序)。 */
    readonly filesDetail: readonly {
        readonly file: string;
        readonly entries: number;
    }[];
}
/**
 * 扫描一个记忆根目录(只读;目录不存在返回 0/0 与空明细)。
 *
 * 计数口径 = 「迁移 + 严格校验通过」的条目(坏行跳过,不抛)——一条坏行不能让
 * 启动期 refreshRegistry 或整个目录页失效;与导出的计数口径(原始非空行数,
 * 描述被拷贝的产物)不同,健康数据下两者一致,见 collections.ts。
 */
export declare function scanRootDetail(dir: string): RootScanDetail;
/** 扫描一个记忆根目录的条目数与文件数(只读;目录不存在返回 0/0)。 */
export declare function scanRoot(dir: string): {
    entries: number;
    files: number;
};
/** 判定一个目录可作为记忆根:存在且(含记忆文件或为空目录)。 */
export declare function isMemoryRoot(dir: string): boolean;
/**
 * 刷新注册表:登记固定根与给定 cwd 的项目根,重算仍存在根的计数并落盘。
 *
 * 项目根惰性登记:启动与 session-start 时传入 cwd;历史根保留(已消失的保持
 * 最后已知计数,lastSeenAt 不更新)。
 * @param cwd - 当前工作目录;提供时登记其项目根(两个层)。
 * @param now - 刷新时刻(测试注入);缺省用当前时间。
 * @returns 刷新后的注册表。
 */
export declare function refreshRegistry(cwd?: string, now?: number): Registry;
/**
 * 从注册表移除一个根(不动磁盘数据)。
 * @param root - 根路径(精确匹配)。
 * @param now - 操作时刻(测试注入)。
 * @returns 是否真的移除了一条。
 */
export declare function forgetRoot(root: string, now?: number): boolean;
/**
 * 手动登记一个根(`/lmemory collections add` 入口)。
 *
 * 不校验目录内容(调用方先经 {@link isMemoryRoot} 判定);kind 由路径判定:
 * 恰为两个固定用户根之一算 user,恰为 global 目录算 global,其余一律 project。
 * @param root - 根路径(绝对化后存储)。
 * @param now - 登记时刻(测试注入)。
 * @returns 登记后的注册表。
 */
export declare function registerExplicitRoot(root: string, now?: number): Registry;
