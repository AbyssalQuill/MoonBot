/**
 * 记忆文件的发现与读取(纯 node 层,不 import cordis)。
 *
 * 目录优先级(低 → 高,同名 basename 后者覆盖):
 *   内置(包内 `lmemory/`) < 用户 `~/.agents/lmemory` < 用户 `~/.dsh/lmemory`
 *   < 项目 `<repo>/.agents/lmemory` < 项目 `<repo>/.dsh/lmemory`
 *
 * 旧目录一次性迁移:早期版本使用 `memory/` 作目录名,发现时自动 rename 到
 * `lmemory/`(幂等,只动「含记忆产物或为空」的目录,见 docs/storage-and-collections.md §Q0)。
 *
 * 真相源是 `.remember.jsonl`;本模块只做「发现 + 读取」,写盘(追加 / 重写 / 渲染
 * MD / 更新 catalog)统一由 {@link ./store.js} 承载,避免两套独立写路径并存。读取时
 * 对旧数据做「读即迁移 + 落盘」(补 id/schemaVersion 写回 jsonl,见 {@link ./migrate.js}),
 * 保证只读层读旧数据不失败、且补出的 id 跨次读取稳定。
 *
 * @module dsh-memory/memory-file
 */
import type { MemoryEntry } from './schema.js';
/** 内置记忆目录路径(host 级面板视图把内置层并入注册表根一起读取)。 */
export declare function builtinMemoryDir(): string;
/** 解析 dsh home(registry / usage 日志等 host 级文件也共用此解析)。 */
export declare function dshHome(): string;
/** 解析 agents home(同上,导出供跨模块复用)。 */
export declare function agentsHome(): string;
/** 旧目录迁移报告(一次性 `memory/` → `lmemory/`,幂等)。 */
export interface LegacyMigrationReport {
    /** 已 rename 的旧目录(源路径)。 */
    readonly moved: readonly string[];
    /** 存在但「不像记忆目录」、被跳过不动的目录。 */
    readonly skipped: readonly string[];
}
/**
 * 旧目录(`memory/`)→ 新目录(`lmemory/`)的一次性迁移(幂等)。
 *
 * 覆盖用户两层(恒迁)与项目两层(cwd 提供时);仅当旧目录含记忆产物或为空才 rename,
 * 避免误拿他方工具的同名目录。{@link visibleMemoryDirs} 与 {@link memoryWriteRoots}
 * 在每次发现/写根解析前执行(报告丢弃,保证读写路径永远先于发现迁移);启动期
 * index.ts 显式调用一次并打印报告。
 * @param cwd - 当前工作目录;提供时一并覆盖项目层两个目录。
 * @returns 迁移报告。
 */
export declare function migrateLegacyMemoryDirs(cwd?: string): LegacyMigrationReport;
/** 从 cwd 向上找项目根(以 `.git` 为标记),找不到则回退 cwd 本身。 */
export declare function findProjectRoot(cwd: string): string;
/**
 * 项目根的 canonical 形态:realpath 解析 symlink(路径已消失时回退词法路径)。
 * 写根 / 发现 / team 缓存键 / registry 登记统一用它锚定同一物理 workspace
 * (docs/global-layer-design.md §6.2.1);固定用户根豁免 realpath(避免 macOS
 * `/tmp → /private/tmp` 与 DSH_HOME symlink 的连带变更)。
 * @param cwd - 当前工作目录。
 * @returns canonical 项目根绝对路径。
 */
export declare function canonicalProjectRoot(cwd: string): string;
/** 一个记忆文件(真相源 jsonl 与其渲染投影 md,同 basename 配对)。 */
export interface MemoryFile {
    /** `.remember.jsonl` 路径。 */
    readonly jsonlPath: string;
    /** 同名 `.remember.md` 路径。 */
    readonly mdPath: string;
    /** 该文件内的全部条目(逐行解析 + 校验)。 */
    readonly entries: readonly MemoryEntry[];
}
/** global 记忆目录(用户 dsh 根内的子目录;仅 dsh home 一份,docs/global-layer-design.md §5.1)。 */
export declare function visibleGlobalDir(): string;
/** 用户级写根、项目级写根与 global 写根。 */
export interface MemoryWriteRoots {
    /** 用户级写根(`~/.dsh/lmemory`)。 */
    readonly user: string;
    /** 项目级写根(`<repo>/.dsh/lmemory`);cwd 不可得时为空串(project 写入必须有 cwd)。 */
    readonly project: string;
    /** global 写根(`~/.dsh/lmemory/global`,与 cwd 无关)。 */
    readonly global: string;
}
/** 解析写根(dsh 规范目录优先);项目根经 canonical 化锚定同一物理 workspace。 */
export declare function memoryWriteRoots(cwd: string | undefined): MemoryWriteRoots;
/**
 * 由 `entry.layer` 选写根目录:global → global 根(与 cwd 无关),project → 项目写根,
 * user → 用户写根。
 * @param cwd - 当前工作目录(project 层需要;global/user 可为 undefined)。
 * @param layer - 记忆落点层。
 * @returns 写根目录绝对路径。
 */
export declare function writeRootFor(cwd: string | undefined, layer: MemoryEntry['layer']): string;
/**
 * 给定 cwd 可见的全部记忆目录(低 → 高优先级,与发现合并顺序一致)。
 * 不含 global 子目录——`loadDir` 非递归,global 目录自动被本链排除;
 * global 条目经 {@link discoverGlobalEntries} / 各消费方显式追加(docs/global-layer-design.md §5.2)。
 * @param cwd - 当前工作目录;缺省只返回内置 + 用户级目录。
 * @returns 可见记忆目录绝对路径列表。
 */
export declare function visibleMemoryDirs(cwd?: string): string[];
/**
 * 读取 global 目录的全部条目(docs/global-layer-design.md §5.2)。
 * 目录即身份 + 防御性 layer 过滤(global 目录内只认 layer==='global' 的行)。
 * @returns global 记忆条目(按文件排序后展平)。
 */
export declare function discoverGlobalEntries(): MemoryEntry[];
/** 存量 global 条目迁移报告(docs/global-layer-design.md §5.4)。 */
export interface GlobalMigrationReport {
    /** 移入 global 目录的条目数。 */
    readonly moved: number;
}
/**
 * 一次性迁移(幂等):把两个用户根顶层 jsonl 中 `layer==='global'` 的行移入
 * global 目录当天文件(按原 type),源文件重写为不含这些行的集合,随后重写
 * 两侧 catalog。完成后「layer=global 的条目」与「global 目录的条目」恢复同一集合
 * (docs/global-layer-design.md §5.4)。内部只用直接路径,不调 visibleMemoryDirs(防递归)。
 * @returns 迁移报告。
 */
export declare function migrateLegacyGlobalEntries(): GlobalMigrationReport;
/**
 * 从给定目录读取所有 `.remember.jsonl` 记忆文件(按路径排序)。
 * 每个文件独立成项,不做跨目录 basename 合并——host 级注册表视图
 * (不同根是各自独立的数据)需要这种无合并读取;单 cwd 视图仍走
 * {@link discoverFiles} 的合并语义。
 * @param dir - 记忆目录绝对路径。
 * @returns 该目录下的记忆文件列表(目录不存在为空)。
 */
export declare function loadDir(dir: string): MemoryFile[];
/**
 * 发现给定 cwd 可见的全部记忆文件(内置 + 用户 + 项目),按 basename 合并,
 * 同名后者覆盖(项目 > 用户 > 内置;同级 `.dsh` > `.agents`)。
 * @param cwd - 当前工作目录;缺省只返回内置 + 用户级。
 * @returns 归一化后的记忆文件列表。
 */
export declare function discoverFiles(cwd?: string): MemoryFile[];
/** 发现给定 cwd 可见的全部记忆条目(按文件排序后展平)。 */
export declare function discoverEntries(cwd?: string): MemoryEntry[];
/** 召回结果的一条完整投影:条目全部字段 + 所在文件。 */
export interface RecalledEntry {
    /** 记忆 id;逆查失败时降级为 `-`。 */
    readonly id: string;
    /** 所在 `.remember.jsonl` 文件名;逆查失败时降级为 `-`。 */
    readonly file: string;
    readonly type: string;
    readonly domain: string;
    readonly scope: string;
    readonly layer: string;
    readonly entry: string;
    readonly entryPoint: string;
    readonly references: string;
}
/**
 * 把召回返回的整行(格式见 render.entryLine)按 id 逆查真相源,补全全部字段。
 *
 * 召回在节点文本(索引)上做,`layer` / `entryPoint` / `references` 只在真相源
 * (jsonl)里;逆查 = 索引 → 真相源的回填。id 唯一,命中即完整字段;模型未照抄
 * 整行(id 缺失/伪造)时降级为行内字段 + `-` 占位,不丢结果。
 * @param cwd - 当前工作目录(与召回时一致)。
 * @param lines - 召回/重排序输出的整行列表。
 * @returns 完整条目投影(与 lines 同序)。
 */
export declare function resolveRecalled(cwd: string | undefined, lines: readonly string[]): RecalledEntry[];
