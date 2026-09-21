/**
 * 记忆统计与 token 用量估算(纯逻辑,不 import cordis / dsh-llm)。
 *
 * 支撑 `/lmemory stats`(记忆条目/文件统计)与 `/lmemory usage`(上下文成本
 * 估算 + LLM 调用消耗累计)。统计只读文件,不发模型调用;token 估算用
 * `chars / 4` 的粗略近似(中英混合语境下的工程近似,不是精确计费)。
 *
 * @module dsh-memory/stats
 */
import type { DomainId, LayerId, MemoryType } from './schema.js';
/** 记忆统计(给定 cwd 可见的全部记忆)。 */
export interface MemoryStats {
    /** 总条目数。 */
    readonly total: number;
    /** 按 type 的条目数。 */
    readonly byType: Record<MemoryType, number>;
    /** 按 layer 的条目数。 */
    readonly byLayer: Record<LayerId, number>;
    /** 按 domain 的条目数(只含非零项)。 */
    readonly byDomain: ReadonlyMap<DomainId, number>;
    /** 记忆文件数(jsonl 与 md 成对,各计一份)。 */
    readonly files: number;
    /** jsonl 总字节。 */
    readonly jsonlBytes: number;
    /** md 总字节。 */
    readonly mdBytes: number;
    /** catalog 条目总数(全部可见 memory 目录的 catalog.json 求和)。 */
    readonly catalogEntries: number;
}
/**
 * 计算给定 cwd 可见的全部记忆的统计(含 global 目录,直接追加不合并;
 * docs/global-layer-design.md §5.2)。
 * @param cwd - 当前工作目录;缺省只统计内置 + 用户级 + global。
 * @returns 统计结果(无记忆时各项为 0 / 空)。
 */
export declare function computeStats(cwd?: string): MemoryStats;
/**
 * 在显式给出的记忆目录列表上计算统计(host 级注册表视图用)。
 *
 * 与 {@link computeStats} 的差别:不做跨目录 basename 合并——不同根是各自
 * 独立的数据,合并会吞掉不同项目的同名文件;单 cwd 视图仍走
 * {@link discoverFiles} 的合并语义。
 * @param dirs - 记忆目录绝对路径列表(去重后遍历;不存在的目录跳过)。
 * @returns 统计结果(无记忆时各项为 0 / 空)。
 */
export declare function computeStatsIn(dirs: readonly string[]): MemoryStats;
/**
 * 把字符数粗估为 token 数(中英混合语境的工程近似:约 4 字符/token)。
 * @param chars - 文本字符数。
 * @returns 估算 token 数(向上取整)。
 */
export declare function estimateTokens(chars: number): number;
/** LLM 调用消耗的累计器(按职责分类:recall / extract / review)。 */
export interface UsageCounter {
    /** 调用次数。 */
    readonly calls: number;
    /** 累计输入 token(不含缓存读)。 */
    readonly inputTokens: number;
    /** 累计输出 token。 */
    readonly outputTokens: number;
    /** 累计缓存读 token。 */
    readonly cacheReadTokens: number;
}
/** 零值累计器。 */
export declare const EMPTY_USAGE: UsageCounter;
/** 一次模型调用的最小 usage 投影(结构性兼容 dsh-llm 的 TokenUsage)。 */
export interface UsageSlice {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
}
/**
 * 把一次调用的 usage 累计进计数器。
 * @param counter - 现有计数器。
 * @param usage - 本次调用的 usage。
 * @returns 新计数器(调用次数 +1)。
 */
export declare function recordUsage(counter: UsageCounter, usage: UsageSlice): UsageCounter;
