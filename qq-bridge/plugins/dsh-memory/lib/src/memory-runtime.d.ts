/**
 * 记忆运行时状态机:team 预热 / 释放 / 重启 / 状态查询(纯逻辑,不 import cordis)。
 *
 * 把「发现记忆文件」与「节点 team 分区」粘起来,暴露给 `index.ts` 的召回工具、
 * `/lmemory` 命令与 system prompt 摘要。team 按 project root 缓存:预热后同一
 * root 的召回不再重读磁盘、不重组装,直到 stop / restart。
 *
 * @module dsh-memory/memory-runtime
 */
import type { MemorySource, RecallTeam } from './team.js';
import type { SummaryMode } from './render.js';
/** 自动提取触发形态枚举(docs/auto-extraction.md §3)。 */
export declare const EXTRACT_MODES: readonly ["signal", "counter", "event-counter"];
/** 自动提取触发形态。 */
export type ExtractMode = (typeof EXTRACT_MODES)[number];
/** 注入摘要模式枚举(docs/global-layer-design.md §6.1)。 */
export declare const SUMMARY_MODES: readonly ["global", "all"];
/** 用户可写配置切片(与 `ctx.settings` 的命名空间 schema 对应)。 */
export interface MemoryConfig {
    /** 每节点容量上限(单位 Kb)。 */
    maxNodeKb: number;
    /** recall 返回的最大条目数。 */
    recallTopK: number;
    /** 聚合阶段重排序提示词模板。 */
    rerankPrompt: string;
    /** 插件启动时是否自动预热 team。 */
    warmupOnStart: boolean;
    /** 召回模型调用所用 provider route。 */
    provider: string;
    /** 召回模型 id(设计钉死 v4-flash)。 */
    model: string;
    /** 质检(review)模式所用模型 id(设计钉死 v4-pro)。 */
    reviewModel: string;
    /** 是否启用自动提取(默认开,旁路观测主会话自动管理记忆)。 */
    autoExtract: boolean;
    /** 触发形态(`signal` / `counter` / `event-counter`)。 */
    extractMode: ExtractMode;
    /** 相邻两次抽取的最小 turn 间隔(形态 3 作退火冷却期)。 */
    extractInterval: number;
    /** 形态 1(signal)信号词集,逗号分隔。 */
    signalWords: string;
    /** rules 抽取器提示词模板。 */
    extractRulesPrompt: string;
    /** lessons 抽取器提示词模板。 */
    extractLessonsPrompt: string;
    /** system prompt 注入摘要模式('global' 只注入 global 全文 + user/project 计数;'all' 旧全量行为)。 */
    summaryMode: SummaryMode;
}
/** 召回默认配置(设计文档 §9 的起点,含自动提取配置 auto-extraction.md §7)。 */
export declare const DEFAULT_CONFIG: MemoryConfig;
/** 可经 `/lmemory config get|set` 读写的配置键。 */
export declare const CONFIG_KEYS: readonly ["maxNodeKb", "recallTopK", "rerankPrompt", "warmupOnStart", "provider", "model", "reviewModel", "autoExtract", "extractMode", "extractInterval", "signalWords", "extractRulesPrompt", "extractLessonsPrompt", "summaryMode"];
/** 一个配置键。 */
export type ConfigKey = (typeof CONFIG_KEYS)[number];
/** 运行时 team 状态:按 project root 缓存的已预热 team。 */
export interface RuntimeState {
    /** project root → 已预热 team。空串 root 表示「无项目 cwd」。 */
    readonly teams: Map<string, RecallTeam>;
}
/** 创建空的运行时状态。 */
export declare function createRuntimeState(): RuntimeState;
/**
 * 把给定 cwd 可见的记忆文件转为节点分配所需的记忆源(每个文件一个源,
 * 内容为逐行条目文本 `[id|type|domain|scope] entry`,供模型挑选相关条目并照抄整行)。
 * global 目录整体追加(concat 不合并——独立层,不与用户/项目同名文件互斥;
 * docs/global-layer-design.md §5.2)。
 * @param cwd - 当前工作目录;缺省只含内置 + 用户级。
 * @returns 记忆源列表。
 */
export declare function sourcesFor(cwd: string | undefined): MemorySource[];
/**
 * 取(或惰性预热)某 cwd 的 team:已预热则直接返回,否则读盘分区并缓存。
 * @param state - 运行时状态。
 * @param cwd - 当前工作目录。
 * @param config - 配置(取 maxNodeKb)。
 * @returns 就绪 team。
 */
export declare function ensureTeam(state: RuntimeState, cwd: string | undefined, config: MemoryConfig): RecallTeam;
/** 释放全部已预热 team。 */
export declare function stopTeams(state: RuntimeState): void;
/** 重新组装某 cwd 的 team(先释放再预热)。 */
export declare function restartTeam(state: RuntimeState, cwd: string | undefined, config: MemoryConfig): RecallTeam;
/** 单条 team 状态(供 `/lmemory status` 展示)。 */
export interface TeamStatus {
    /** project root;空串 = 无项目。 */
    readonly root: string;
    /** 节点数。 */
    readonly nodes: number;
    /** 该 root 是否已预热。 */
    readonly warmed: boolean;
}
/** 汇总当前 team 状态。 */
export declare function teamStatus(state: RuntimeState): TeamStatus[];
