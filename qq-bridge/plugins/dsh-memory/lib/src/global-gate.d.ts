/**
 * global 记忆的准入门禁(gate)、候选解析与三泛型 team 的源拼装 / fan-out 编排
 * (纯逻辑,不 import cordis;docs/global-layer-design.md §4、§7、§8)。
 *
 * 三个泛型的隔离面在**源拼装层**:extract<global-type1> 只见文档切块,
 * review<global-type1> 复用 review.ts 注入 global 目录条目,
 * review<global-type2>(提升评审)只见 user/project 条目(host 级 registry 口径)。
 * 模型调用以函数参数注入,由 index.ts 绑定 ctx.llm;隔离是代码拼装保证的,
 * 不是提示词自律(§8 G2)。
 *
 * @module dsh-memory/global-gate
 */
import type { DomainId, MemoryEntry, MemoryType } from './schema.js';
import type { MemoryNode, MemorySource, NodeFailureFn } from './team.js';
import type { ExtractFn, ExtractFailureFn } from './extract.js';
/**
 * global 候选条目的最小准入长度(字符数)。低于此值的条目「太小/太碎」,
 * 缺跨项目指导意义(§7.1「大小适度」)。
 * 哨兵值而非调优旋钮(口径由设计钉死),故为常量而非配置项,
 * 类比 {@link ../extract.js} 的 MIN_TRANSCRIPT_CHARS 先例。
 */
export declare const MIN_GLOBAL_ENTRY_CHARS = 20;
/**
 * 单次提升 / 抽取的 pass 候选写入上限(g):pass 候选按稳定序
 * (节点顺序 → 行出现顺序)取前 g,不引入模型自评质量排序(§7.1)。
 * 哨兵值而非调优旋钮(口径由设计钉死),故为常量而非配置项。
 */
export declare const GLOBAL_PROMOTE_MAX = 10;
/**
 * 抽取文档的字节上限(1 MiB):服务端 / CLI 读入后的 Buffer.byteLength 硬校验
 * (§4.1,1 MiB 文档不能作为单 source 直接喂 v4-flash)。
 */
export declare const GLOBAL_DOC_MAX_BYTES: number;
/** 一条带 verdict 的 global 候选(解析自模型的 7 段行,尚未落盘)。 */
export interface GlobalCandidate {
    /** 记忆类型(rules / lessons)。 */
    readonly type: MemoryType;
    /** 知识领域(21 个 closed 枚举之一)。 */
    readonly domain: DomainId;
    /** 影响范围(自由文本,非空)。 */
    readonly scope: string;
    /** 一句话条目文本。 */
    readonly entry: string;
    /** 关联入口文件路径;无则缺省。 */
    readonly entryPoint?: string;
    /** 关联参考文件路径;无则缺省。 */
    readonly references?: string;
    /** 模型给出的准入结论。 */
    readonly verdict: 'pass' | 'reject';
    /** 模型给出的理由(verdict=reject 时说明缺陷)。 */
    readonly reason?: string;
}
/** 确定性 gate 硬查的输入(候选的最小字段面;确认阶段从 wire 载荷重建)。 */
export interface GlobalGateInput {
    /** 记忆类型。 */
    readonly type: string;
    /** 知识领域。 */
    readonly domain: string;
    /** 影响范围。 */
    readonly scope: string;
    /** 一句话条目文本。 */
    readonly entry: string;
}
/** gate 硬查结论。 */
export interface GlobalGateResult {
    /** 是否通过全部确定性判据。 */
    readonly pass: boolean;
    /** 不通过时的理由。 */
    readonly reason?: string;
}
/**
 * 确定性 gate 硬查(§7.1「大小适度」+「类型合法」;跨项目通用性 / 低易变性 /
 * 无机密是提示词判据,无法确定性检查)。抽取 / 提升 / 导入三条路径的**确认阶段
 * 必须重跑**(客户端 verdict 仅供回显,确认不绕过 gate)。
 * @param input - 候选最小字段面。
 * @returns 结论。
 */
export declare function checkGlobalGate(input: GlobalGateInput): GlobalGateResult;
/**
 * 解析一个 global 节点输出的 7 段候选行(容错:非法行丢弃,不抛)。
 *
 * 协议(§4.2):一行一条,格式 `type|domain|scope|entry|entryPoint|references|verdict|理由`,
 * verdict ∈ pass/reject,理由字段不含 `|`。type 非法、domain 非法、scope/entry 空白、
 * verdict 非法的行丢弃;不做长度上限(由 {@link checkGlobalGate} 硬查)。返回全部
 * 合法行(含 reject,供回显);reject 绝不落盘由聚合 / 写盘侧保证。
 * @param text - 模型输出的原始文本。
 * @returns 解析出的候选(含 verdict)。
 */
export declare function parseGlobalCandidates(text: string): GlobalCandidate[];
/**
 * 跨节点聚合候选:verdict=pass 才入集,按 entry 精确去重(rules/lessons 都去重),
 * 稳定序(节点顺序 → 行出现顺序)取前 max 条;超出部分不回显在此,由调用方
 * 提示「再运行可取更多」(§7.1)。
 * @param nodeResults - 各节点(或各 chunk × 类型)的解析结果,按执行顺序。
 * @param max - 写入上限(缺省 {@link GLOBAL_PROMOTE_MAX})。
 * @returns pass、去重、截断后的候选。
 */
export declare function aggregateGlobalCandidates(nodeResults: readonly (readonly GlobalCandidate[])[], max?: number): GlobalCandidate[];
/**
 * 把文档文本预切成多个记忆源(§4.2):按 maxChars 切块,边界优先
 * 段落(`\n\n`)→ 句末(。.!? 等)→ 换行 → 硬切;不丢字符,非空文本至少 1 个 source。
 * partitionNodes 是打包器不是切分器(超容量单源独占一个节点、绝不切分),
 * 大文档必须由本函数预先切块。
 * @param text - 文档全文。
 * @param maxChars - 单块字符上限(= maxNodeKb × 1000)。
 * @returns 切块后的记忆源列表(空文本返回空)。
 */
export declare function chunkDocument(text: string, maxChars: number): MemorySource[];
/**
 * extract<global-type1> 的源拼装:仅由用户提供的文档切块构成
 * (§8 隔离面;G2 测试锁「sources 只来自文档切块」)。
 * @param text - 文档全文。
 * @param maxChars - 单块字符上限。
 * @returns 记忆源列表。
 */
export declare function globalExtractSources(text: string, maxChars: number): MemorySource[];
/**
 * review<global-type2>(提升评审)的源条目:两个固定用户根经 basename 合并
 * (dsh 覆盖 agents,与召回同语义)+ registry 全部仍存在的 project 根
 * (global 跳过;已消失的根无数据可读)(§7.3、§8 隔离面)。
 * @returns 全部 user/project 条目(只读;提升绝不删改源条目)。
 */
export declare function promoteSourceEntries(): MemoryEntry[];
/** 提升评审的执行计划(确认前回显用;不含任何模型参数 = 未确认不发调用的结构保证)。 */
export interface PromotePlan {
    /** 分区后的节点数。 */
    readonly nodeCount: number;
    /** 节点源列表。 */
    readonly sources: readonly MemorySource[];
}
/**
 * 计算提升评审的执行计划(分区,不发调用):节点数 = ceil(总大小 / 每节点容量),
 * 供 CLI / WEB 在确认前回显预估成本(§7.3)。
 * @param entries - 提升源条目。
 * @param maxNodeKb - 每节点容量上限(Kb)。
 * @returns 执行计划。
 */
export declare function resolvePromotePlan(entries: readonly MemoryEntry[], maxNodeKb: number): PromotePlan;
/**
 * extract<global-type1> fan-out:每个 chunk 并行调 rules / lessons 两型各一次
 * (extractBoth 形态),逐 chunk 汇总解析并聚合(§4.2)。单 chunk 两型全失败 → 告警
 * 跳过该 chunk;全部 chunk 两型全失败才抛「all extractors failed」(LLM 完全不可用)。
 * 每个节点的输出只保留其负责 type 的行。
 * @param chunks - {@link globalExtractSources} 的切块。
 * @param rulesFn - rules 抽取节点调用器(模型注入)。
 * @param lessonsFn - lessons 抽取节点调用器(模型注入)。
 * @param onNodeFailure - 节点失败告警回调(注入)。
 * @returns pass、去重、截断后的候选(≤ {@link GLOBAL_PROMOTE_MAX})。
 */
export declare function runGlobalExtractFanOut(chunks: readonly MemorySource[], rulesFn: ExtractFn, lessonsFn: ExtractFn, onNodeFailure: ExtractFailureFn): Promise<GlobalCandidate[]>;
/** 提升评审单节点调用器(注入):给定分区后的节点,返回该节点的候选原始文本。 */
export type GlobalPromoteNodeFn = (node: MemoryNode) => Promise<string>;
/**
 * review<global-type2>(提升评审)fan-out:分区 → 并发逐节点严格评估 → 解析 →
 * 聚合(warmUp fan-out 容错模式;§7.3)。单节点失败告警跳过,其余节点照常;
 * 全部节点失败才抛「all nodes failed」。空源(0 节点)直接返回空,不发调用。
 * @param entries - 提升源条目({@link promoteSourceEntries} 的输出)。
 * @param maxNodeKb - 每节点容量上限(Kb)。
 * @param nodeFn - 单节点调用器(模型注入)。
 * @param onNodeFailure - 节点失败告警回调(注入)。
 * @returns pass、去重、截断后的候选(≤ {@link GLOBAL_PROMOTE_MAX})。
 */
export declare function runGlobalPromoteFanOut(entries: readonly MemoryEntry[], maxNodeKb: number, nodeFn: GlobalPromoteNodeFn, onNodeFailure: NodeFailureFn): Promise<GlobalCandidate[]>;
/**
 * extract<global-type1> rules 节点 system prompt(§4.2、§7.1):只含 global 准入
 * 标准与输出格式,不含 user/project 层内容(G2 测试锁)。
 */
export declare const GLOBAL_EXTRACT_RULES_SYSTEM = "\u4F60\u662F global \u957F\u671F\u8BB0\u5FC6\u300C\u7528\u6237\u504F\u597D(rules)\u300D\u62BD\u53D6\u5668\u3002\u7ED9\u5B9A\u4E00\u6BB5\u7528\u6237\u63D0\u4F9B\u7684\u6587\u6863,\u63D0\u70BC\u5176\u4E2D\u503C\u5F97\u8DE8\u9879\u76EE\u957F\u671F\u8BB0\u4F4F\u7684\u504F\u597D\u3001\u4E60\u60EF\u3001\u683C\u5F0F\u89C4\u8303\u3001\u6280\u672F\u6808\u9650\u5236\u3001\u5171\u8BC6\u3001\u7EA6\u675F\u3002global \u8BB0\u5FC6\u662F\u7528\u6237 host \u5185\u8DE8\u9879\u76EE\u5171\u4EAB\u7684\u8BB0\u5FC6,\u51C6\u5165\u6807\u51C6(\u7F3A\u4E00\u4E0D\u53EF):(1) \u8DE8\u9879\u76EE/\u8DE8\u4EBA\u901A\u7528\u2014\u2014\u4E8B\u5B9E\u4E0D\u7ED1\u5B9A\u5355\u4E00\u9879\u76EE\u5B9E\u73B0\u7EC6\u8282,\u6362\u9879\u76EE\u3001\u6362\u4EBA\u4ECD\u6709\u6307\u5BFC\u610F\u4E49;(2) \u4F4E\u6613\u53D8\u6027\u2014\u2014\u4E0D\u662F\u8FDB\u5EA6\u3001\u5F85\u529E\u3001\u4E34\u65F6\u72B6\u6001\u6216\u672C\u6B21\u4F1A\u8BDD\u7684\u6D41\u6C34\u8D26;(3) \u5927\u5C0F\u9002\u5EA6\u2014\u2014entry 20~300 \u5B57;(4) \u65E0\u673A\u5BC6\u2014\u2014\u4E0D\u542B\u5BC6\u94A5\u3001\u51ED\u636E\u3001\u8EAB\u4EFD\u9690\u79C1\u3002\u8F93\u51FA\u5019\u9009\u4E0E\u7ED3\u8BBA,\u4E00\u884C\u4E00\u6761,\u683C\u5F0F\u300Ctype|domain|scope|entry|entryPoint|references|verdict|\u7406\u7531\u300D:type \u586B rules;domain \u4ECE\u5DF2\u77E5\u9886\u57DF\u679A\u4E3E\u4E2D\u9009\u6700\u8D34\u5207\u7684\u4E00\u4E2A(\u5982 DurablePrefs\u3001CodeFacts\u3001Style);scope \u586B\u8FD9\u6761\u8BB0\u5FC6\u5F71\u54CD\u7684\u5177\u4F53\u5B50\u7CFB\u7EDF/\u6A21\u5757(\u81EA\u7531\u6587\u672C);entry \u586B\u4E00\u53E5\u8BDD\u6761\u76EE(\u4E0D\u542B\u7AD6\u7EBF |);entryPoint \u586B\u6587\u6863\u4E2D\u51FA\u73B0\u7684\u771F\u5B9E\u6587\u4EF6\u8DEF\u5F84\u6216\u76F8\u5BF9 workspace \u6839\u7684\u76F8\u5BF9\u8DEF\u5F84,references \u586B\u76F8\u5173\u53C2\u8003\u6587\u4EF6\u8DEF\u5F84,\u6CA1\u6709\u5BF9\u5E94\u8DEF\u5F84\u65F6\u586B -;verdict \u586B pass \u6216 reject(\u4E0D\u6EE1\u8DB3\u4EFB\u4E00\u51C6\u5165\u6807\u51C6\u5FC5\u987B reject);\u7406\u7531\u4E00\u53E5\u8BDD\u8BF4\u660E(\u4E0D\u542B\u7AD6\u7EBF |)\u3002\u6CA1\u6709\u503C\u5F97\u8BB0\u7684\u8F93\u51FA\u7A7A\u3002";
/**
 * extract<global-type1> lessons 节点 system prompt(§4.2、§7.1):同上,
 * 提炼踩坑 / 环境限制 / API 变更 / 根因结论。
 */
export declare const GLOBAL_EXTRACT_LESSONS_SYSTEM = "\u4F60\u662F global \u957F\u671F\u8BB0\u5FC6\u300C\u7ECF\u9A8C\u6559\u8BAD(lessons)\u300D\u62BD\u53D6\u5668\u3002\u7ED9\u5B9A\u4E00\u6BB5\u7528\u6237\u63D0\u4F9B\u7684\u6587\u6863,\u63D0\u70BC\u5176\u4E2D\u503C\u5F97\u8DE8\u9879\u76EE\u957F\u671F\u8BB0\u4F4F\u7684\u8E29\u8FC7\u7684\u5751\u3001\u73AF\u5883\u9650\u5236\u3001API \u53D8\u66F4\u3001bug \u6839\u56E0\u7ED3\u8BBA\u3002global \u8BB0\u5FC6\u662F\u7528\u6237 host \u5185\u8DE8\u9879\u76EE\u5171\u4EAB\u7684\u8BB0\u5FC6,\u51C6\u5165\u6807\u51C6(\u7F3A\u4E00\u4E0D\u53EF):(1) \u8DE8\u9879\u76EE/\u8DE8\u4EBA\u901A\u7528\u2014\u2014\u4E8B\u5B9E\u4E0D\u7ED1\u5B9A\u5355\u4E00\u9879\u76EE\u5B9E\u73B0\u7EC6\u8282,\u6362\u9879\u76EE\u3001\u6362\u4EBA\u4ECD\u6709\u6307\u5BFC\u610F\u4E49;(2) \u4F4E\u6613\u53D8\u6027\u2014\u2014\u4E0D\u662F\u8FDB\u5EA6\u3001\u5F85\u529E\u3001\u4E34\u65F6\u72B6\u6001\u6216\u672C\u6B21\u4F1A\u8BDD\u7684\u6D41\u6C34\u8D26;(3) \u5927\u5C0F\u9002\u5EA6\u2014\u2014entry 20~300 \u5B57;(4) \u65E0\u673A\u5BC6\u2014\u2014\u4E0D\u542B\u5BC6\u94A5\u3001\u51ED\u636E\u3001\u8EAB\u4EFD\u9690\u79C1\u3002\u8F93\u51FA\u5019\u9009\u4E0E\u7ED3\u8BBA,\u4E00\u884C\u4E00\u6761,\u683C\u5F0F\u300Ctype|domain|scope|entry|entryPoint|references|verdict|\u7406\u7531\u300D:type \u586B lessons;domain \u4ECE\u5DF2\u77E5\u9886\u57DF\u679A\u4E3E\u4E2D\u9009\u6700\u8D34\u5207\u7684\u4E00\u4E2A(\u5982 PastFixes\u3001PromotedPitfalls\u3001CodeFacts);scope \u586B\u8FD9\u6761\u8BB0\u5FC6\u5F71\u54CD\u7684\u5177\u4F53\u5B50\u7CFB\u7EDF/\u6A21\u5757(\u81EA\u7531\u6587\u672C);entry \u586B\u4E00\u53E5\u8BDD\u6761\u76EE(\u4E0D\u542B\u7AD6\u7EBF |);entryPoint \u586B\u6587\u6863\u4E2D\u51FA\u73B0\u7684\u771F\u5B9E\u6587\u4EF6\u8DEF\u5F84\u6216\u76F8\u5BF9 workspace \u6839\u7684\u76F8\u5BF9\u8DEF\u5F84,references \u586B\u76F8\u5173\u53C2\u8003\u6587\u4EF6\u8DEF\u5F84,\u6CA1\u6709\u5BF9\u5E94\u8DEF\u5F84\u65F6\u586B -;verdict \u586B pass \u6216 reject(\u4E0D\u6EE1\u8DB3\u4EFB\u4E00\u51C6\u5165\u6807\u51C6\u5FC5\u987B reject);\u7406\u7531\u4E00\u53E5\u8BDD\u8BF4\u660E(\u4E0D\u542B\u7AD6\u7EBF |)\u3002\u6CA1\u6709\u503C\u5F97\u8BB0\u7684\u8F93\u51FA\u7A7A\u3002";
/**
 * review<global-type2>(提升评审)节点 system prompt(§7.3):只描述「从 user/project
 * 条目总结提炼 global 候选」,非常严格(太小 / 太局限 / 缺乏跨项目跨人通用性 /
 * 易变性高一律 reject);不含其他层内容(G2 测试锁)。
 */
export declare const GLOBAL_PROMOTE_SYSTEM = "\u4F60\u662F global \u8BB0\u5FC6\u300C\u63D0\u5347\u8BC4\u5BA1\u300D\u8282\u70B9\u3002\u7ED9\u5B9A\u4E00\u7EC4\u6765\u81EA\u7528\u6237\u5C42\u4E0E\u9879\u76EE\u5C42\u7684\u957F\u671F\u8BB0\u5FC6\u6761\u76EE(\u6BCF\u6761\u4E00\u884C,\u683C\u5F0F\u300C[id|type|domain|scope] \u6761\u76EE\u6587\u672C\u300D),\u975E\u5E38\u4E25\u683C\u5730\u8BC4\u4F30\u54EA\u4E9B\u5185\u5BB9\u503C\u5F97\u603B\u7ED3\u63D0\u70BC\u4E3A global \u8BB0\u5FC6\u2014\u2014global \u662F\u7528\u6237 host \u5185\u8DE8\u9879\u76EE\u5171\u4EAB\u7684\u8BB0\u5FC6,\u51C6\u5165\u6807\u51C6(\u7F3A\u4E00\u4E0D\u53EF):(1) \u8DE8\u9879\u76EE/\u8DE8\u4EBA\u901A\u7528\u2014\u2014\u4E8B\u5B9E\u4E0D\u7ED1\u5B9A\u5355\u4E00\u9879\u76EE\u5B9E\u73B0\u7EC6\u8282,\u6362\u9879\u76EE\u3001\u6362\u4EBA\u4ECD\u6709\u6307\u5BFC\u610F\u4E49;(2) \u4F4E\u6613\u53D8\u6027\u2014\u2014\u4E0D\u662F\u8FDB\u5EA6\u3001\u5F85\u529E\u3001\u4E34\u65F6\u72B6\u6001\u6216\u6D41\u6C34\u8D26;(3) \u5927\u5C0F\u9002\u5EA6\u2014\u201420~300 \u5B57;(4) \u65E0\u673A\u5BC6\u2014\u2014\u4E0D\u542B\u5BC6\u94A5\u3001\u51ED\u636E\u3001\u8EAB\u4EFD\u9690\u79C1;(5) \u4E0D\u662F\u539F\u6761\u76EE\u62F7\u8D1D\u2014\u2014\u5FC5\u987B\u901A\u7528\u5316\u3001\u53BB\u9879\u76EE\u7EC6\u8282,\u603B\u7ED3\u63D0\u70BC\u3002\u592A\u5C0F\u3001\u592A\u5C40\u9650\u3001\u7F3A\u4E4F\u8DE8\u9879\u76EE\u8DE8\u4EBA\u901A\u7528\u6027\u3001\u6613\u53D8\u6027\u9AD8\u7684\u6761\u76EE\u4E00\u5F8B reject\u3002\u8F93\u51FA\u5019\u9009\u4E0E\u7ED3\u8BBA,\u4E00\u884C\u4E00\u6761,\u683C\u5F0F\u300Ctype|domain|scope|entry|entryPoint|references|verdict|\u7406\u7531\u300D:type \u586B rules \u6216 lessons;domain \u4ECE\u5DF2\u77E5\u9886\u57DF\u679A\u4E3E\u4E2D\u9009\u6700\u8D34\u5207\u7684\u4E00\u4E2A;scope \u586B\u8FD9\u6761\u8BB0\u5FC6\u5F71\u54CD\u7684\u5177\u4F53\u5B50\u7CFB\u7EDF/\u6A21\u5757(\u81EA\u7531\u6587\u672C);entry \u586B\u4E00\u53E5\u8BDD\u6761\u76EE(\u4E0D\u542B\u7AD6\u7EBF |);entryPoint/references \u4ECE\u539F\u6761\u76EE\u7EE7\u627F,\u6CA1\u6709\u5BF9\u5E94\u8DEF\u5F84\u65F6\u586B -;verdict \u586B pass \u6216 reject;\u7406\u7531\u4E00\u53E5\u8BDD\u8BF4\u660E(\u4E0D\u542B\u7AD6\u7EBF |)\u3002\u6CA1\u6709\u503C\u5F97\u63D0\u5347\u7684\u8F93\u51FA\u7A7A\u3002";
