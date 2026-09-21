/**
 * usage 持久化日志:`~/.dsh/lmemory/usage.jsonl`(纯逻辑,不 import cordis)。
 *
 * 每次 LLM 调用(recall / extract / review)的 usage chunk 聚合为一行追加;
 * 读侧按本地日聚合,支撑 `/lmemory usage --days` 与状态页每日图。设计见
 * docs/storage-and-collections.md §Q4。
 *
 * @module dsh-memory/usage-log
 */
/** 职责分类(与 index.ts 的 UsageLabel 对应)。 */
export type UsageLabel = 'recall' | 'extract' | 'review';
/** usage 日志的一行。 */
export interface UsageLogRow {
    /** 记录时刻(epoch 毫秒)。 */
    readonly ts: number;
    /** 职责分类。 */
    readonly label: UsageLabel;
    /** 输入 token(不含缓存读)。 */
    readonly inputTokens: number;
    /** 输出 token。 */
    readonly outputTokens: number;
    /** 缓存读 token。 */
    readonly cacheReadTokens: number;
    /** 调用所用模型 id(成本估算计价键;旧行缺省,读取端按 label 回退)。 */
    readonly model?: string;
}
/** 某一天某一职责的聚合。 */
export interface LabelDayUsage {
    /** 调用次数(日志行数)。 */
    readonly calls: number;
    /** 当日输入 token 合计。 */
    readonly inputTokens: number;
    /** 当日输出 token 合计。 */
    readonly outputTokens: number;
    /** 当日缓存读 token 合计。 */
    readonly cacheReadTokens: number;
    /** 当日该职责 token 合计(input + output + cacheRead)。 */
    readonly totalTokens: number;
}
/** 某一天的聚合视图(三职责 + 合计)。 */
export interface DayUsage {
    /** 本地日期 `YYYY-MM-DD`。 */
    readonly day: string;
    /** 各职责聚合。 */
    readonly recall: LabelDayUsage;
    readonly extract: LabelDayUsage;
    readonly review: LabelDayUsage;
    /** 当日全部 token 合计。 */
    readonly total: number;
}
/** 某一个小时桶的聚合视图(三职责 + 合计;与 {@link DayUsage} 同口径)。 */
export interface HourUsage {
    /** 本地日期 `YYYY-MM-DD`。 */
    readonly day: string;
    /** 本地小时 0..23(该小时的起始时刻)。 */
    readonly hour: number;
    /** 各职责聚合。 */
    readonly recall: LabelDayUsage;
    readonly extract: LabelDayUsage;
    readonly review: LabelDayUsage;
    /** 该小时全部 token 合计。 */
    readonly total: number;
}
/** usage.jsonl 的固定路径(用户 lmemory 根内)。 */
export declare function usageLogPath(): string;
/**
 * 追加一行 usage 日志(顺序写,不排序;行写失败不抛——usage 是旁路观测,
 * 不能让记忆主链路因日志失败而中断,失败交 logger 在调用方记录)。
 * @param row - 要追加的行。
 * @returns 是否真的写入了(失败时为 false)。
 */
export declare function appendUsageRow(row: UsageLogRow): boolean;
/**
 * 读取全部 usage 日志行;损坏行跳过(usage 是旁路数据,坏行不阻塞统计)。
 * @returns 日志行(按文件顺序)。
 */
export declare function readUsageRows(): UsageLogRow[];
/** 把 epoch 毫秒转成本地日期键 `YYYY-MM-DD`。 */
export declare function localDay(ts: number): string;
/** 近 `days` 天的本地日期键(从今往前,含今天,升序)。 */
export declare function recentDays(days: number, now?: number): string[];
/**
 * 按本地日聚合 usage 日志,零填充近 `days` 天(含今天,升序)。
 * @param rows - 日志行(由 {@link readUsageRows} 读取)。
 * @param days - 聚合天数(1..90;越界由调用方约束)。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的日聚合(升序)。
 */
export declare function aggregateByDay(rows: readonly UsageLogRow[], days: number, now?: number): DayUsage[];
/** 某职责在时间窗内的聚合(与 {@link aggregateByDay} 同窗、同口径)。 */
export interface WindowTotals {
    /** 职责分类。 */
    readonly label: UsageLabel;
    /** 窗口内调用次数(日志行数)。 */
    readonly calls: number;
    /** 窗口内输入 token 合计。 */
    readonly inputTokens: number;
    /** 窗口内输出 token 合计。 */
    readonly outputTokens: number;
    /** 窗口内缓存读 token 合计。 */
    readonly cacheReadTokens: number;
    /** 窗口内该职责 token 合计(input + output + cacheRead)。 */
    readonly totalTokens: number;
}
/**
 * 按本地小时聚合 usage 日志,零填充近 `days` 个自然日 × 24 桶(与
 * {@link aggregateByDay} 同窗、同口径——日聚合 = 小时聚合按日求和,数学恒等)。
 * @param rows - 日志行(由 {@link readUsageRows} 读取)。
 * @param days - 聚合天数(1..90;越界由调用方约束)。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的小时聚合(升序,`days×24` 桶)。
 */
export declare function aggregateByHour(rows: readonly UsageLogRow[], days: number, now?: number): HourUsage[];
/**
 * 按职责聚合近 `days` 天的调用消耗(近 14 天窗口的甜甜圈 / 堆叠条 / 明细表用)。
 *
 * 由 {@link aggregateByDay} 的同窗日聚合求和而来——与每日图**数学恒等**
 * (零填充日求和 = 真实行求和),保证「甜甜圈合计 = 每日柱合计」可对账。
 * @param rows - 日志行(由 {@link readUsageRows} 读取)。
 * @param days - 窗口天数(1..90;越界由调用方约束)。
 * @param now - 参照时刻(测试注入)。
 * @returns 三职责的窗口聚合(顺序 recall / extract / review)。
 */
export declare function aggregateWindowTotals(rows: readonly UsageLogRow[], days: number, now?: number): WindowTotals[];
