/**
 * v4-flash 记忆节点 team 的纯逻辑:节点分区、fan-out 召回、聚合。
 *
 * 本模块只定义结构与时序,不 import cordis,也不 import dsh-llm——模型调用
 * 以函数参数注入(`recallFn` / `rerank`),由 `index.ts` 用 `ctx.llm.stream`
 * 绑定到 `deepseek-v4-flash`。这样预热 / 分区 / 聚合都能在单测里用 mock
 * 验证,而无需真实 API key。
 *
 * @module dsh-memory/team
 */
/** 一个已就绪的记忆节点:一段受管记忆文本 + 它的大小。 */
export interface MemoryNode {
    /** 稳定节点 id(如 `node-1`)。 */
    readonly id: string;
    /** 该节点记忆文本的字节数。 */
    readonly sizeBytes: number;
    /** 该节点负责的记忆文本(供模型挑选相关条目)。 */
    readonly text: string;
}
/** 已预热、可立即 fan-out 的节点 team。 */
export interface RecallTeam {
    /** 分配后的节点(数量 = ceil(总大小 / 每节点容量))。 */
    readonly nodes: readonly MemoryNode[];
    /** 每节点容量上限(字节)。 */
    readonly maxNodeBytes: number;
}
/** 一次 fan-out 中单个节点返回的候选条目文本(逐条一行,精确匹配)。 */
export type NodeRecallFn = (node: MemoryNode, query: string) => Promise<readonly string[]>;
/** 聚合阶段对去重后的候选按相关度重排序(仅返回排序后的条目文本)。 */
export type RerankFn = (query: string, candidates: readonly string[]) => Promise<readonly string[]>;
/** 节点失败告警回调(注入;纯逻辑模块不 import cordis,由 index.ts 绑定 ctx.logger.warn)。 */
export type NodeFailureFn = (nodeId: string, error: unknown) => void;
/** 一段待分配进节点的记忆源文本。 */
export interface MemorySource {
    /** 源标识(用于诊断)。 */
    readonly id: string;
    /** 文本内容。 */
    readonly text: string;
}
/** 计算一段文本的字节大小(Node 的 UTF-8 语义)。 */
export declare function byteLength(text: string): number;
/**
 * 把多段记忆源按容量贪心打包成节点:累加到接近 `maxNodeKb` 即封口。
 * 单段超过容量的源独占一个节点(允许该节点超容量)。
 * @param sources - 待分配的记忆源。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 分区后的节点。
 */
export declare function partitionNodes(sources: readonly MemorySource[], maxNodeKb: number): MemoryNode[];
/** 一条召回/重排序行的解析投影(整行格式 `[id|type|domain|scope] entry`,见 render.entryLine)。 */
export interface RecallLine {
    /** 记忆 id;行不含 `[id|` 前缀时为 undefined(模型未照抄整行)。 */
    readonly id?: string;
    /** 记忆类型(行内字段;降级解析用)。 */
    readonly type?: string;
    /** 知识领域(行内字段;降级解析用)。 */
    readonly domain?: string;
    /** 影响范围(行内字段;降级解析用)。 */
    readonly scope?: string;
    /** 条目文本(前缀之后的全部文本)。 */
    readonly entry: string;
}
/** 解析一行召回结果为结构化投影;无 `[id|type|domain|scope]` 前缀时整行作为 entry(降级)。 */
export declare function parseRecallLine(line: string): RecallLine;
/** 按 id(或整行文本降级)精确去重(保持首次出现顺序)。 */
export declare function dedupe(candidates: readonly string[]): string[];
/**
 * 预热:把记忆源分配成节点 team(纯函数,不碰磁盘、不碰模型)。
 * @param sources - 全部记忆源(来自记忆文件)。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 就绪 team。
 */
export declare function warmUp(sources: readonly MemorySource[], maxNodeKb: number): RecallTeam;
/**
 * 召回:并发 fan-out 到每个节点 → 汇总 → 去重 → 重排序 → 截断到 topK。
 *
 * per-node 容错(robustness.md §2):单节点失败跳过并告警,其余节点结果照常聚合;
 * 全部节点失败才抛「all nodes failed」(LLM 完全不可用)。空 team(0 节点)直接返回空。
 * @param team - 已预热 team。
 * @param query - 召回查询。
 * @param recallFn - 单节点召回调用器(模型调用注入)。
 * @param rerank - 重排序调用器(模型调用注入;候选 ≤1 时跳过)。
 * @param topK - 返回的最大条目数。
 * @param onNodeFailure - 节点失败告警回调(注入)。
 * @returns 按相关度排序、按 id 去重后的条目整行(≤ topK;行格式见 render.entryLine)。
 */
export declare function recall(team: RecallTeam, query: string, recallFn: NodeRecallFn, rerank: RerankFn, topK: number, onNodeFailure: NodeFailureFn): Promise<string[]>;
