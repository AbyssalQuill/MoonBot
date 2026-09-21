import type Schema from '@deepseek-ai/schemastery';
/** schema 版本号(记录级,单调递增)。 */
export declare const SCHEMA_VERSION = 2;
export declare const MEMORY_TYPES: readonly ["rules", "lessons"];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export declare const DOMAINS: readonly ["OutputContract", "ToolGovernance", "RedLines", "Invariants", "NamingBijection", "ContractConstants", "CommandsRuntime", "DirScoped", "PathScopedRules", "WorkflowSOP", "QualityGates", "RebuildSpec", "ChangeSurface", "ADR", "DurablePrefs", "Glossary", "ExternalRefs", "PromotedPitfalls", "CodeFacts", "PastFixes", "Style"];
export type DomainId = (typeof DOMAINS)[number];
export declare const LAYERS: readonly ["global", "user", "project"];
export type LayerId = (typeof LAYERS)[number];
/** 记忆唯一编号(品牌类型)。 */
export type MemoryId = `m-${string}`;
/** {@link MemoryId} 的运行时格式正则(来自 schema.yaml 的 id.pattern)。 */
export declare const MEMORY_ID_RE: RegExp;
/** 一条长期记忆条目(JSONL 一行)的运行时形状。 */
export interface MemoryEntry {
    readonly id: MemoryId;
    readonly schemaVersion: number;
    readonly createdAt: number;
    readonly type: MemoryType;
    readonly domain: DomainId;
    readonly scope: string;
    readonly layer: LayerId;
    readonly entry: string;
    readonly entryPoint: string;
    readonly references: string;
}
/** JSONL 记录 schema:逐行校验的数据契约(来自 schema.yaml)。 */
export declare const MEMORY_ENTRY_SCHEMA: Schema<MemoryEntry>;
