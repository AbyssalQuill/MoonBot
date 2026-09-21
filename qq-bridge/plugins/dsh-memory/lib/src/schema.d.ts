/**
 * 长期记忆条目的领域模型与 JSONL 逐行 schema(单一真相源)。
 *
 * 数据契约的运行时真相源是 {@link ./schema.generated.js}(由 schema/memory-entry.schema.yaml
 * 经 scripts/gen-schema.mjs 生成,勿手改);本模块 re-export 其数据契约常量
 * (`MEMORY_TYPES` / `DOMAINS` / `LAYERS` / `MEMORY_ID_RE` / `SCHEMA_VERSION` /
 * `MEMORY_ENTRY_SCHEMA`)与类型,并保留非数据契约的手写逻辑:记忆 id 生成 / 判定、
 * 工具输入类型、渲染常量、文件命名正则,以及「严格校验」入口 {@link validateEntry}。
 *
 * 一条记忆 = `.remember.jsonl` 的一行;`type` 只含 `rules` / `lessons` 两类(不含
 * state/todo),见 docs/concept.md §4;`domain` 是 21 个 closed 枚举之一,见
 * docs/concept.md §3。`validateEntry` 只接受完整合法记录(id / schemaVersion 由
 * generated 的 required 强制),id 补齐由存储层显式生成与迁移引擎负责。
 *
 * @module dsh-memory/schema
 */
import type { DomainId, LayerId, MemoryEntry, MemoryId, MemoryType } from './schema.generated.js';
export { SCHEMA_VERSION, MEMORY_TYPES, DOMAINS, LAYERS, MEMORY_ID_RE, MEMORY_ENTRY_SCHEMA, } from './schema.generated.js';
export type { DomainId, LayerId, MemoryEntry, MemoryId, MemoryType, } from './schema.generated.js';
/**
 * 判断一个值是否为合法 {@link MemoryId}(运行时格式校验)。
 * @param value - 待判定值。
 * @returns 当 `value` 是 `m-` + 10 位 base36 字符串时为真。
 */
export declare function isMemoryId(value: unknown): value is MemoryId;
/**
 * 生成一个新的记忆唯一编号:`m-` + 10 位 base36(crypto 随机)。
 *
 * 用随机而非全局递增,是因为记忆跨 global/user/project 三层分散写,递增需跨层
 * 协调全局计数器;随机 id 全局唯一、无需协调、短且可引用(见 docs/memory-review.md §2)。
 * 8 字节(64 位)随机数的 base36 表示补零后取前 10 位,保证恒为 10 个 base36 字符。
 * @returns 新的 {@link MemoryId}。
 */
export declare function generateMemoryId(): MemoryId;
/** 新建记忆的候选输入(无 `id` / `createdAt`;二者由存储层系统赋值,`entryPoint`/`references` 缺省 `-`)。 */
export interface MemoryEntryInput {
    /** 记忆类型:偏好/约束,或经验教训。 */
    readonly type: MemoryType;
    /** 知识领域(21 个 closed 枚举之一)。 */
    readonly domain: DomainId;
    /** 影响范围:作用于哪个子系统 / 模块(自由文本,非空)。 */
    readonly scope: string;
    /** 落点层:global / user / project。 */
    readonly layer: LayerId;
    /** 一句话条目文本(非空)。 */
    readonly entry: string;
    /** 关联入口文件路径,可省略(缺省 `-`)。 */
    readonly entryPoint?: string;
    /** 关联参考文件路径,可省略(缺省 `-`)。 */
    readonly references?: string;
}
/**
 * 9 列 Markdown 表格表头(首列 `id` + {@link MemoryEntry} 的 8 个字段:
 * type / domain / scope / layer / createdAt / entry / entryPoint / references)。
 * 其中 domain 与 scope 是语义定位的正交对,layer 与 createdAt 是存储元数据。
 */
export declare const TABLE_HEADER: readonly ["id", "类型", "所属知识领域 (domain)", "影响范围 (Scope)", "Layer (落点层)", "创建时间 (createdAt)", "条目", "entry point (file path)", "references (file path)"];
/** 9 列表格分隔行。 */
export declare const TABLE_SEPARATOR = "|---|---|---|---|---|---|---|---|---|";
/** lessons 单条入口的字数上限(concept.md §5「偶尔合并,单条 ≤300 字」)。 */
export declare const MAX_LESSON_CHARS = 300;
/**
 * 记忆文件名正则:日期 + 可选分区(自由分片)+ 类型 + 后缀。
 * `YYYY-MM-DD[.<partition>].<rules|lessons>.remember.{jsonl,md}`。
 */
export declare const FILE_NAME_RE: RegExp;
/**
 * 严格校验一条完整记录(JSONL 一行)。
 *
 * 只接受「完整合法记录」:`id` / `schemaVersion` / `createdAt` 由 generated schema 的
 * required 强制,缺一即拒绝;`entryPoint` / `references` 缺省为 `-`。不在此处惰性补
 * `id`——id 补齐由存储层 `append` 显式生成、迁移引擎 {@link ./migrate.js} 负责。
 * @param entry - 完整候选记录。
 * @param lineNumber - 可选行号,用于把错误定位到 JSONL 的某一行。
 * @returns 校验(并归一化)后的 {@link MemoryEntry}。
 * @throws 当类型 / 域 / 范围非法、entry 为空、id / schemaVersion 缺失或非法。
 */
export declare function validateEntry(entry: unknown, lineNumber?: number): MemoryEntry;
