/**
 * 自动提取记忆(auto-extraction)的纯逻辑:抽取节点、输出解析、去重、退火门槛。
 *
 * 与召回 / 质检不同,抽取器面向**会话上下文**(尚未落盘的对话流),输出**新记忆
 * 候选条目**(docs/auto-extraction.md §5)。本模块只定义结构与时序,不 import
 * cordis,也不 import dsh-llm——模型调用以函数参数注入(`ExtractFn`),由 `index.ts`
 * 用 `ctx.llm.stream` 绑定到 `deepseek-v4-flash`;事件监听、写盘编排也在 `index.ts`。
 *
 * 按 memory-type 分两个抽取节点(rules / lessons),并行 fan-out、互不干扰:
 *   - rules 抽取器判「用户偏好 / 习惯 / 格式 / 技术栈 / 共识 / 约束」→ 只新增(重复
 *     entry 由 store.append 的 duplicate 拒绝兜底);
 *   - lessons 抽取器判「踩坑 / 环境限制 / API 变更 / 根因」→ 单条 ≤300 字。
 *
 * @module dsh-memory/extract
 */
import type { DomainId, LayerId, MemoryType } from './schema.js';
/** 一个抽取节点的模型调用器(注入):给定会话文本,返回该 type 的结构化输出原始文本。 */
export type ExtractFn = (transcript: string) => Promise<string>;
/** 抽取节点失败告警回调(注入;由 index.ts 绑定 ctx.logger.warn)。 */
export type ExtractFailureFn = (type: MemoryType, error: unknown) => void;
/** 抽取出的候选条目(尚未落盘,无 `id` / `layer`)。 */
export interface ExtractedCandidate {
    /** 记忆类型(该节点负责的类型)。 */
    readonly type: MemoryType;
    /** 知识领域(21 个 closed 枚举之一)。 */
    readonly domain: DomainId;
    /** 影响范围(自由文本,作用于哪个子系统 / 模块)。 */
    readonly scope: string;
    /** 一句话条目文本。 */
    readonly entry: string;
    /** 关联入口文件路径(对话中出现的真实路径);无则缺省。 */
    readonly entryPoint?: string;
    /** 关联参考文件路径;无则缺省。 */
    readonly references?: string;
}
/** 一次抽取的结果:两类记忆的候选条目。 */
export interface ExtractionResult {
    /** rules 候选条目。 */
    readonly rules: readonly ExtractedCandidate[];
    /** lessons 候选条目。 */
    readonly lessons: readonly ExtractedCandidate[];
}
/** 一条消息的最小投影(role + 文本),供抽取器拼接会话窗口。 */
export interface TranscriptMessage {
    /** 会话角色。 */
    readonly role: 'system' | 'user' | 'assistant';
    /** 该消息的纯文本(不含 tool / reasoning 内容)。 */
    readonly text: string;
}
/** 退火放行决策:是否放行抽取 + 新的距上次抽取 turn 数。 */
export interface AnnealDecision {
    /** 是否放行本次抽取。 */
    readonly released: boolean;
    /** 新的距上次抽取 turn 数(供调用方写回冷却计数器)。 */
    readonly turnsSince: number;
}
/**
 * 解析一个抽取节点的原始输出为候选条目(容错,非法行丢弃,不抛)。
 *
 * 协议(docs/auto-extraction.md §5):一行一条,格式
 * `domain|scope|entry|entryPoint|references`,后两个字段可选、无对应路径时填 `-`
 * (归一化为缺省)。domain 从已知领域枚举选最贴切的一个,scope 填影响的具体
 * 子系统 / 模块(自由文本),entry 填一句话条目(**不含 `|`**);空输出 = 无记忆。
 * domain 非法、scope / entry 空白、lessons 单条超 300 字的行被丢弃;同批次内按
 * entry 精确去重(保持首次出现顺序)。
 * @param text - 模型输出的原始文本。
 * @param type - 该节点负责的记忆类型(用于校验 lessons 长度上限)。
 * @returns 归一化、去重后的候选条目。
 */
export declare function parseExtraction(text: string, type: MemoryType): ExtractedCandidate[];
/**
 * 并行 fan-out 到两个抽取节点(rules / lessons),各自解析、去重,互不干扰。
 *
 * per-node 容错(robustness.md §2):单类型节点失败 → 该类型返回空候选、另一类型
 * 照常;两类型全失败才抛「all extractors failed」(LLM 完全不可用)。
 * @param transcript - 会话窗口文本(主会话此刻模型上下文,§4)。
 * @param rulesFn - rules 抽取节点调用器(模型注入)。
 * @param lessonsFn - lessons 抽取节点调用器(模型注入)。
 * @param onNodeFailure - 抽取节点失败告警回调(注入)。
 * @returns 两类候选条目。
 */
export declare function extractBoth(transcript: string, rulesFn: ExtractFn, lessonsFn: ExtractFn, onNodeFailure: ExtractFailureFn): Promise<ExtractionResult>;
/**
 * 过滤掉与已有记忆重复的候选(按 entry 精确匹配)。
 *
 * rules 只增不减、lessons 防重复追加,两者都以「已存在同 entry 即跳过」为准;
 * rules 的强去重仍由 store.append 的 duplicate 兜底(docs/auto-extraction.md §5.5)。
 * @param candidates - 待写入候选。
 * @param existing - 已有同 type 记忆的 entry 文本集合。
 * @returns 不含重复 entry 的候选。
 */
export declare function filterNovel(candidates: readonly ExtractedCandidate[], existing: ReadonlySet<string>): ExtractedCandidate[];
/**
 * 由 cwd 推导记忆落点层:经 `.git` 向上探测到项目根(realpath 解析 symlink)→ `project`,否则 `user`。
 * 与召回预热 project-root 探测同源(docs/auto-extraction.md §5.6)。
 * @param cwd - 当前工作目录。
 * @returns 落点层。
 */
export declare function deriveLayer(cwd: string): LayerId;
/**
 * 把消息列表拼成抽取器输入的会话文本(每行 `role: text`)。
 * @param messages - 主会话此刻上下文的最小投影(role + 文本)。
 * @returns 抽取器输入文本。
 */
export declare function buildTranscript(messages: readonly TranscriptMessage[]): string;
/**
 * 空 transcript 守卫的最小总字符数(含 role 前缀)。低于此值的 transcript
 * 视为「trivially empty」,不发 LLM 调用(docs/auto-extraction.md §11 A)。
 * 实测空转抽取平均输入 ~24 tokens(≈ 40 字符以下),40 是哨兵值而非调优旋钮
 * (调频用 `extractInterval`),故为常量而非配置项。
 */
export declare const MIN_TRANSCRIPT_CHARS = 40;
/**
 * 判断 transcript 是否低于最小内容门槛(空/近空,无抽取价值)。
 * @param transcript - {@link buildTranscript} 的输出。
 * @returns 低于 {@link MIN_TRANSCRIPT_CHARS} 时为真。
 */
export declare function isTranscriptTooShort(transcript: string): boolean;
/**
 * 退火门槛:turn 停止时先计时,满冷却期(`interval`)放行并归零。
 * 冷却期是**抑制器**——事件是唯一触发源,计数器决定放行与否(docs/auto-extraction.md §3 形态 3)。
 * @param turnsSince - 距上次抽取的 turn 数。
 * @param interval - 冷却期(相邻两次抽取的最小 turn 间隔)。
 * @returns 放行决策与新计数器值。
 */
export declare function annealTurnStopping(turnsSince: number, interval: number): AnnealDecision;
/**
 * 退火门槛:出错时冷却期内抑制,满冷却期放行并归零(防连续出错高频触发)。
 * @param turnsSince - 距上次抽取的 turn 数。
 * @param interval - 冷却期。
 * @returns 放行决策与新计数器值。
 */
export declare function annealError(turnsSince: number, interval: number): AnnealDecision;
/**
 * 解析信号词配置(docs/auto-extraction.md §3 形态 1)为数组:逗号(半角/全角)/
 * 顿号分隔,去空白、去空项。
 * @param raw - 配置原文(如「记住,下次,偏好,always,never」)。
 * @returns 信号词数组。
 */
export declare function parseSignalWords(raw: string): string[];
/**
 * 判断文本是否命中任一信号词(大小写不敏感,子串匹配)。
 * @param text - 待测文本(如一条 user/message 或 assistant/message 的正文)。
 * @param words - 信号词数组(来自 {@link parseSignalWords})。
 * @returns 命中任一信号词时为真。
 */
export declare function containsSignalWord(text: string, words: readonly string[]): boolean;
