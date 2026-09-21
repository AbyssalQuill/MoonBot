/**
 * 记忆质检(review)的纯逻辑:节点分区、fan-out 审查、跨节点判矛盾/重复、聚合。
 *
 * 与 recall 不同,review 的输出是**结构化缺陷发现**(不是条目文本),因此节点
 * 文本必须带 id 才能指认缺陷目标(docs/memory-review.md §4)。本模块只定义结构
 * 与时序,不 import cordis,也不 import dsh-llm——模型调用以函数参数注入
 * (`nodeReviewFn` / `crossNodeReviewFn`),由 `index.ts` 用 `ctx.llm.stream` 绑定到
 * `deepseek-v4-pro`。这样分区 / fan-out / 聚合都能在单测里用 mock 验证。
 *
 * @module dsh-memory/review
 */
import type { MemoryNode, MemorySource, RecallTeam } from './team.js';
import type { MemoryEntry, MemoryId } from './schema.js';
/** 四类缺陷(docs/memory-review.md §4)。 */
export declare const REVIEW_PROBLEMS: readonly ["contradiction", "duplicate", "outdated", "divergence"];
/** 一条缺陷的类别。 */
export type ReviewProblem = (typeof REVIEW_PROBLEMS)[number];
/** 建议动作(docs/memory-review.md §4)。 */
export declare const REVIEW_SUGGESTIONS: readonly ["update", "delete", "merge"];
/** 一条缺陷建议的动作。 */
export type ReviewSuggestion = (typeof REVIEW_SUGGESTIONS)[number];
/**
 * 一条缺陷发现(docs/memory-review.md §4 的报告结构)。
 * `id` 是目标记忆(merge 时是保留的那条),`related` 是矛盾/重复的对方。
 */
export interface ReviewFinding {
    /** 目标记忆 id。 */
    readonly id: MemoryId;
    /** 缺陷类别。 */
    readonly problem: ReviewProblem;
    /** 关联的其它记忆 id(矛盾/重复的对方;outdated/divergence 通常为空)。 */
    readonly related: readonly MemoryId[];
    /** 一句话描述问题。 */
    readonly note: string;
    /** 建议动作。 */
    readonly suggest: ReviewSuggestion;
    /** `update` 时的建议新条目文本(可选)。 */
    readonly suggestedEntry?: string;
}
/** 单节点审查调用器(模型注入):审查一个节点的记忆文本,返回本节点内缺陷。 */
export type NodeReviewFn = (node: MemoryNode) => Promise<readonly ReviewFinding[]>;
/** 跨节点判矛盾/重复调用器(模型注入):给定全部条目,返回跨节点缺陷。 */
export type CrossNodeReviewFn = (entries: readonly MemoryEntry[]) => Promise<readonly ReviewFinding[]>;
/** 节点/跨节点失败告警回调(注入;由 index.ts 绑定 ctx.logger.warn)。 */
export type ReviewFailureFn = (nodeId: string, error: unknown) => void;
export { entryLine as reviewEntryLine } from './render.js';
/**
 * 把记忆条目转成 review 节点源(每条一个源,文本带 id,供模型指认缺陷目标)。
 * @param entries - 归一化后的记忆条目。
 * @returns 记忆源列表(供 `warmUp` 分区)。
 */
export declare function reviewSourcesFor(entries: readonly MemoryEntry[]): MemorySource[];
/**
 * 由记忆条目构建就绪的 review team(带 id 节点文本 + 分区)。
 * @param entries - 归一化后的记忆条目。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 就绪 team。
 */
export declare function reviewTeam(entries: readonly MemoryEntry[], maxNodeKb: number): RecallTeam;
/**
 * 从模型输出文本中提取并解析缺陷数组(容错:跳过非法元素,不抛)。
 *
 * 协议:模型返回一个 JSON 数组,每个元素形如
 * `{"id","problem","related","note","suggest","suggestedEntry?"}`。本函数抽取第一个
 * 平衡的 `[...]` 子串再 `JSON.parse`,非法 id / problem / suggest 的元素被丢弃,
 * 保证返回值里的 id 都是真实存在、格式合法的记忆 id。
 * @param text - 模型输出的原始文本。
 * @param knownIds - 已知合法记忆 id 集合(用于过滤编造的 id)。
 * @returns 解析出的缺陷发现。
 */
export declare function parseFindings(text: string, knownIds: ReadonlySet<MemoryId>): ReviewFinding[];
/**
 * 缺陷去重:类别与涉及 id 集合相同的发现只保留第一条(保持出现顺序)。
 * @param findings - 待去重缺陷。
 * @returns 去重后的缺陷。
 */
export declare function dedupeFindings(findings: readonly ReviewFinding[]): ReviewFinding[];
/**
 * 执行一次质检:fan-out 各节点审查本节点内缺陷 → 跨节点再判矛盾/重复 → 聚合去重。
 *
 * per-node 容错(robustness.md §2):单节点失败跳过并告警,其余节点缺陷照常;跨节点
 * 判失败则降级为只用节点内发现;全部节点失败才抛「all nodes failed」。
 * 单节点时跳过跨节点判(本节点审查已覆盖全部条目);≥2 节点时才补跨节点,
 * 捕捉分在不同节点的同义/冲突记忆(docs/memory-review.md §4)。
 * @param team - 已预热 team(带 id 节点文本)。
 * @param entries - 全部归一化记忆条目(供跨节点判矛盾/重复)。
 * @param nodeReviewFn - 单节点审查调用器(模型注入)。
 * @param crossNodeReviewFn - 跨节点审查调用器(模型注入)。
 * @param onNodeFailure - 节点/跨节点失败告警回调(注入)。
 * @returns 聚合去重后的缺陷发现。
 */
export declare function runReview(team: RecallTeam, entries: readonly MemoryEntry[], nodeReviewFn: NodeReviewFn, crossNodeReviewFn: CrossNodeReviewFn, onNodeFailure: ReviewFailureFn): Promise<ReviewFinding[]>;
/**
 * 把缺陷发现渲染成主 agent 可读、可行动的报告文本(每条带 id + suggest)。
 * @param findings - 缺陷发现。
 * @returns 多行报告文本。
 */
export declare function renderReviewReport(findings: readonly ReviewFinding[]): string;
