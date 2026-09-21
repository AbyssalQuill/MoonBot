/**
 * 共享存储层:长期记忆的唯一写盘入口(纯逻辑,不 import cordis)。
 *
 * 写盘不变量(校验 + 生成 id + 去重/合并 + 追加/重写 JSONL + 重渲染 MD + 更新
 * catalog)只存在于本模块一处——模型面工具(remember / forget,以及后续的
 * memory-update / memory-delete)与抽取器都调它,不各自维护一套写盘逻辑
 * (docs/auto-extraction.md §5.5 的 store 分层)。
 *
 * 目录发现(读)由 {@link ./memory-file.js} 承担;本模块专注写与索引:
 *   - `append` / `update` / `remove`(按 id)/ `removeByEntry`(按 entry 文本,供 forget)/
 *     `find` / `rebuild`。
 *   - 旧数据迁移:读取时发现缺失 `id` 的旧行,惰性补一个 id 并落盘(id 一生不变)。
 *   - `catalog.json`:每层 `lmemory/` 目录一个派生索引(记忆 id → 所在文件),全量重写、
 *     可重建;真相源仍是 `.remember.jsonl`,不一致时以 jsonl 为准。
 *
 * @module dsh-memory/store
 */
import type { DomainId, LayerId, MemoryEntry, MemoryEntryInput, MemoryId, MemoryType } from './schema.js';
/** catalog 里的一条索引:记忆 id → 所在文件(附少量定位字段)。 */
export interface CatalogEntry {
    /** 记忆唯一编号。 */
    readonly id: MemoryId;
    /** 相对本层 `lmemory/` 目录的 `.remember.jsonl` 路径。 */
    readonly file: string;
    /** 记忆类型。 */
    readonly type: MemoryType;
    /** 知识领域。 */
    readonly domain: DomainId;
    /** 影响范围。 */
    readonly scope: string;
    /** 落点层。 */
    readonly layer: LayerId;
    /** 一句话条目文本。 */
    readonly entry: string;
}
/** 一层的派生索引目录(全量重写、可重建)。 */
export interface Catalog {
    /** catalog 格式版本。 */
    readonly version: number;
    /** 索引条目(按 jsonl 文件扫描顺序)。 */
    readonly entries: readonly CatalogEntry[];
}
/** `append` 的结果。 */
export interface AppendResult {
    /** 落盘的记忆(恒带 `id`)。 */
    readonly entry: MemoryEntry;
    /** 是否因重复(rules 只增不减)被拒绝,未落盘。 */
    readonly duplicate: boolean;
    /** 落盘 jsonl 路径;`duplicate` 时为 `undefined`。 */
    readonly jsonlPath?: string;
    /** 落盘 md 路径;`duplicate` 时为 `undefined`。 */
    readonly mdPath?: string;
}
/** `update` 可改写的字段(`id` / `type` / `layer` 不可改,见 docs/memory-review.md §6)。 */
export interface UpdatePatch {
    /** 新知识领域。 */
    readonly domain?: DomainId;
    /** 新影响范围。 */
    readonly scope?: string;
    /** 新条目文本。 */
    readonly entry?: string;
    /** 新关联入口文件路径。 */
    readonly entryPoint?: string;
    /** 新关联参考文件路径。 */
    readonly references?: string;
}
/** `find` 的过滤条件(任一维度均可选,可组合)。 */
export interface FindQuery {
    /** 按 id 精确查一条。 */
    readonly id?: MemoryId;
    /** 按类型过滤。 */
    readonly type?: MemoryType;
    /** 按领域过滤。 */
    readonly domain?: DomainId;
    /** 按影响范围过滤(精确匹配)。 */
    readonly scope?: string;
    /** 按落点层过滤。 */
    readonly layer?: LayerId;
}
/** `find` 命中的一条记忆:完整字段 + 所在文件。 */
export interface FoundEntry {
    /** 完整记忆条目。 */
    readonly entry: MemoryEntry;
    /** 相对所在 `lmemory/` 目录的 `.remember.jsonl` 路径。 */
    readonly file: string;
}
/** `remove`(按 id 删除)的结果。 */
export interface RemoveResult {
    /** 是否删除了某条记忆。 */
    readonly removed: boolean;
    /** 被删除的记忆(未命中时为 `undefined`)。 */
    readonly entry?: MemoryEntry;
    /** 被删除记忆所在文件(未命中时为 `undefined`)。 */
    readonly file?: string;
}
/**
 * 写入一条新记忆:校验 + 生成 id + 系统赋值 createdAt + 去重 + 追加 JSONL + 重渲染 MD + 更新 catalog。
 *
 * `rules` 只增不减(重复 `entry` 拒绝,返回 `duplicate: true` 不落盘);`lessons`
 * 单条 ≤300 字。写根由 `entry.layer` 决定(global → global 根,project → 项目根,user → 用户根)。
 * rules 去重兜底走可见链(不含 global 目录)且**跳过 layer=global 的写入**——global 的
 * 去重由 gated 路径承担,跨层逐字相同不算重复,docs/global-layer-design.md §5.3 ①②。
 * @param cwd - 当前工作目录(project 层需要;global/user 可为 undefined)。
 * @param candidate - 候选条目(无 `id` / `createdAt`)。
 * @returns 落盘结果(含 id 与路径)或重复拒绝标记。
 * @throws 当 schema 校验失败、entry 空白、lessons 超长、或渲染 MD 未通过静态检查。
 */
export declare function append(cwd: string | undefined, candidate: MemoryEntryInput): AppendResult;
/**
 * 按 id 更新一条记忆的可改字段(`domain` / `scope` / `entry` / `entryPoint` /
 * `references`;`id` / `type` / `layer` 不可改)→ 重写该行 jsonl → 重渲染 MD → 更新 catalog。
 * @param cwd - 当前工作目录。
 * @param id - 目标记忆 id。
 * @param patch - 要改写的字段。
 * @returns 更新后的记忆与其所在文件。
 * @throws 当 id 不存在,或改写后的字段未通过校验。
 */
export declare function update(cwd: string | undefined, id: MemoryId, patch: UpdatePatch): FoundEntry;
/**
 * 按 id 删除一条记忆 → 删除该行 jsonl → 重渲染 MD → 更新 catalog。
 * @param cwd - 当前工作目录。
 * @param id - 目标记忆 id。
 * @returns 删除结果(未命中时 `removed: false`)。
 */
export declare function remove(cwd: string | undefined, id: MemoryId): RemoveResult;
/**
 * 按 `entry` 文本精确匹配删除(可限定类型),并重渲染受影响文件的 MD 与 catalog。
 * 这是 `forget` 工具「不知道 id 时的宽泛删除入口」(docs/memory-review.md §6)。
 * @param cwd - 当前工作目录。
 * @param entryText - 精确匹配的条目文本。
 * @param type - 可选类型过滤;缺省匹配全部类型。
 * @returns 实际删除的条目数。
 */
export declare function removeByEntry(cwd: string, entryText: string, type?: MemoryType): number;
/**
 * 按 id 或类型/领域/范围/落点层过滤查找记忆,返回完整条目与所在文件。
 *
 * 定位用「扫描可见文件 + 迁移」的总是正确路径;catalog 是本模块维护的派生索引
 * (写入时同步重写,供统计 / 导出 / 目录页等外部读取),`find` 不依赖它也能返回一致结果。
 * @param cwd - 当前工作目录;缺省只查内置 + 用户级。
 * @param query - 过滤条件(空条件返回全部)。
 * @returns 命中的记忆(按目录与文件排序)。
 */
export declare function find(cwd: string | undefined, query: FindQuery): FoundEntry[];
/**
 * 在显式给出的记忆目录列表上过滤查找记忆(不 import cordis;供会话视图与
 * host 级注册表视图共用)。与 {@link find} 的差别:不做 basename 合并,且
 * `file` 为**绝对路径**——不同根是同名文件的独立数据,短名无法区分来源。
 * @param dirs - 记忆目录绝对路径列表(去重后遍历;不存在的目录跳过)。
 * @param query - 过滤条件(空条件返回全部)。
 * @returns 命中的记忆(按目录与文件排序,file 为绝对路径)。
 */
export declare function findIn(dirs: readonly string[], query: FindQuery): FoundEntry[];
/**
 * 重建全部可见层的 `catalog.json`:扫描所有可见 `.remember.jsonl`(顺带做旧数据
 * 迁移),以 jsonl 为准全量重写 catalog(不一致时 jsonl 权威)。手动编辑 jsonl 后的一键对齐。
 *
 * 内置层只读:它是随包发布、可能在只读安装目录里的种子数据,不在重建范围;
 * 用户层与项目层照常重建。默认范围 = 可见链(不含 global 子目录,默认不触碰 global);
 * 显式 `dirs` 提供时只重建给定目录(显式指定即重建,不做内置层跳过)——
 * `/lmemory catalog rebuild --root ~/.dsh/lmemory/global` 只重建 global 目录
 * (docs/global-layer-design.md §5.3)。
 * @param cwd - 当前工作目录;缺省只重建用户级。
 * @param dirs - 显式重建目标目录(可含 global 目录);缺省走可见链。
 */
export declare function rebuild(cwd?: string, dirs?: readonly string[]): void;
/** `appendImported` 的结果(global 导入专用,docs/global-layer-design.md §9.3)。 */
export interface AppendImportedResult {
    /** 实际写入的条目数。 */
    readonly imported: number;
    /** 因 id 冲突(同 id 异 entry)或同 id 同 entry 跳过、未写入的条目数。 */
    readonly duplicates: number;
}
/**
 * 导入 global 条目:保留原 id / createdAt / schemaVersion(不走 {@link append}
 * 的 id/createdAt 生成),写入导入当天文件,同 id 冲突计 duplicates 跳过
 * (决策 D4/D5,docs/global-layer-design.md §9.3 步骤 6)。
 * @param globalRoot - global 目录绝对路径。
 * @param entries - 已过防线校验(逐条 migrateRecord + gate + layer=global)的条目。
 * @returns 导入结果。
 */
export declare function appendImported(globalRoot: string, entries: readonly MemoryEntry[]): AppendImportedResult;
