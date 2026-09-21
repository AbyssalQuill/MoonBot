/**
 * 价格表与成本估算:`~/.dsh/lmemory/pricing.json`(纯逻辑,不 import cordis)。
 * 设计见 docs/pricing-and-cost.md。
 *
 * 模型 API 只返回 usage 不返回 cost;官方价格随时段变化(调价提前公告生效日期、
 * 峰谷定价)。价格表是**唯一持久化事实**(缺失时用内置种子创建,绝不覆盖用户
 * 修改);cost 一律即时计算、绝不落盘——价格表一改,历史成本自动重算。
 *
 * @module dsh-memory/pricing
 */
import type { UsageLogRow } from './usage-log.js';
/** 价格表格式版本(结构变化时递增;读取端只认格式,不认识视为损坏)。 */
export declare const PRICING_FORMAT_VERSION = 1;
/** 每百万 tokens 的价格(元,CNY)。 */
export interface TokenPrices {
    /** 缓存未命中输入(标准输入价)。 */
    readonly inputPerMTok: number;
    /** 缓存命中输入。 */
    readonly cacheHitPerMTok: number;
    /** 输出。 */
    readonly outputPerMTok: number;
}
/** 一个模型在一个生效时段的价格记录。 */
export interface PricingPeriod {
    /** 模型 id(与配置的 model / reviewModel 同值)。 */
    readonly model: string;
    /** 生效起始时刻(epoch 毫秒,UTC;北京时刻见 source 注释)。0 = 起始时间未公告,自最早使用起计。 */
    readonly effectiveFrom: number;
    /** 价格来源与生效时刻说明(人读)。 */
    readonly source: string;
    /** 基础价(峰谷期的空闲价)。 */
    readonly prices: TokenPrices;
    /** 高峰价;存在 = 该时段启用峰谷。 */
    readonly peakPrices?: TokenPrices;
    /** 高峰窗口(北京小时区间 [起,止);缺省 9-12 / 14-18)。 */
    readonly peakWindowsBeijing?: readonly (readonly [number, number])[];
}
/** 价格表文档(pricing.json 全文)。 */
export interface PricingTable {
    /** 格式版本。 */
    readonly formatVersion: number;
    /** 币种(官方页人民币口径)。 */
    readonly currency: 'CNY';
    /** 最近一次写入时间(epoch 毫秒)。 */
    readonly updatedAt: number;
    /** 全部价格时段(按模型 + effectiveFrom 升序,种子即此序)。 */
    readonly periods: readonly PricingPeriod[];
}
/** 价格表读取结果:损坏时报错(价格错误比没有价格更糟,fail loud)。 */
export type PricingLoad = {
    ok: true;
    table: PricingTable;
} | {
    ok: false;
    error: string;
};
/** pricing.json 的固定路径(用户 lmemory 根内)。 */
export declare function pricingPath(): string;
/** 北京时刻 → epoch 毫秒(所有生效时间按 UTC+8 公告换算)。 */
export declare function beijingTime(year: number, month: number, day: number, hour?: number): number;
/** 默认高峰窗口(北京 9:00–12:00、14:00–18:00)。 */
export declare const DEFAULT_PEAK_WINDOWS: readonly [readonly [9, 12], readonly [14, 18]];
/** 内置种子价格表(来源见 docs/pricing-and-cost.md「来源」;缺失时惰性创建)。 */
export declare function seedPricing(now?: number): PricingTable;
/**
 * 读取价格表;文件缺失时用内置种子创建(绝不覆盖已存在的用户修改)。
 * @param now - 种子写入时刻(测试注入)。
 * @returns 读取结果(损坏 → ok:false + 原因)。
 */
export declare function loadPricing(now?: number): PricingLoad;
/**
 * 找一条价格记录:该模型下 `effectiveFrom <= ts` 的最新一条;没有则回退该模型
 * 最早一条(覆盖「起始时间未公告」的时段);模型完全无记录返回 undefined。
 * @param table - 价格表。
 * @param model - 模型 id。
 * @param ts - usage 行时刻(epoch 毫秒)。
 * @returns 价格时段(可能为回退项)。
 */
export declare function priceEntryFor(table: PricingTable, model: string, ts: number): PricingPeriod | undefined;
/** 判断时刻是否落在北京高峰窗口(缺省 9:00–12:00、14:00–18:00;半开区间)。 */
export declare function isPeakBeijing(ts: number, windows?: readonly (readonly [number, number])[]): boolean;
/** 按时刻选三档单价(峰谷时段判北京高峰窗口)。 */
export declare function pricesAt(period: PricingPeriod, ts: number): TokenPrices;
/**
 * 估算一次调用的成本(元):input×输入价 + cacheRead×缓存命中价 + output×输出价。
 * @param table - 价格表。
 * @param model - 模型 id。
 * @param ts - 调用时刻。
 * @param inputTokens - 缓存未命中输入 token。
 * @param cacheReadTokens - 缓存命中输入 token。
 * @param outputTokens - 输出 token。
 * @returns 成本(元);模型无价格记录返回 undefined。
 */
export declare function costFor(table: PricingTable, model: string, ts: number, inputTokens: number, cacheReadTokens: number, outputTokens: number): number | undefined;
/** 某职责的窗口成本聚合(面板「估算成本」列;yuan 为 undefined = 该职责存在缺价行,不静默为 0)。 */
export interface LabelCost {
    /** 职责分类。 */
    readonly label: UsageLogRow['label'];
    /** 窗口内调用次数。 */
    readonly calls: number;
    /** 窗口内估算成本(元,两位小数展示);缺价时为 undefined。 */
    readonly yuan?: number;
    /** 该职责缺价(无价格记录)的调用行数。 */
    readonly missingPricingRows: number;
}
/** 窗口成本聚合(近 N 天,与 totals/daily 同窗)。 */
export interface WindowCosts {
    /** 按职责的成本。 */
    readonly perLabel: readonly LabelCost[];
    /** 可计算部分的合计(元);缺价职责不计入,见 incomplete。 */
    readonly totalYuan: number;
    /** 是否因缺价而不完整。 */
    readonly incomplete: boolean;
}
/** 由 label 决定旧行(无 model)回退到哪个模型 id。 */
export type ModelFallback = (label: UsageLogRow['label']) => string;
/**
 * 聚合近 `days` 天 usage 行的估算成本(不落盘,纯计算)。
 *
 * 旧行(无 model)按 {@link ModelFallback} 映射到当前配置模型;模型无价格记录的
 * 行计缺价,该职责 yuan 置 undefined 而不静默为 0。
 * @param table - 价格表。
 * @param rows - usage 日志行。
 * @param days - 窗口天数。
 * @param fallback - label → 模型 id 映射。
 * @param now - 参照时刻(测试注入)。
 * @returns 窗口成本聚合。
 */
export declare function estimateWindowCosts(table: PricingTable, rows: readonly UsageLogRow[], days: number, fallback: ModelFallback, now?: number): WindowCosts;
/** 某一天的估算成本(yuan 为 undefined = 该天存在缺价行;空天 yuan = 0)。 */
export interface DayCost {
    /** 本地日期 `YYYY-MM-DD`(与 aggregateByDay 同日序)。 */
    readonly day: string;
    /** 当天估算成本(元);缺价时为 undefined。 */
    readonly yuan?: number;
    /** 当天缺价(无价格记录)的调用行数。 */
    readonly missingPricingRows: number;
}
/** 某个小时桶的估算成本(yuan 为 undefined = 该小时存在缺价行;空桶 yuan = 0)。 */
export interface HourCost {
    /** 本地日期 `YYYY-MM-DD`(与 aggregateByHour 同桶序)。 */
    readonly day: string;
    /** 本地小时 0..23。 */
    readonly hour: number;
    /** 该小时估算成本(元);缺价时为 undefined。 */
    readonly yuan?: number;
    /** 该小时缺价(无价格记录)的调用行数。 */
    readonly missingPricingRows: number;
}
/**
 * 逐日聚合近 `days` 天的估算成本(零填充,与 {@link aggregateByDay} 同日序;
 * 不落盘,纯计算)。逐行 {@link costFor},缺价行计 missing 不静默为 0。
 * @param table - 价格表。
 * @param rows - usage 日志行。
 * @param days - 窗口天数。
 * @param fallback - label → 模型 id 映射。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的日成本(升序)。
 */
export declare function estimateDailyCosts(table: PricingTable, rows: readonly UsageLogRow[], days: number, fallback: ModelFallback, now?: number): DayCost[];
/**
 * 逐小时聚合近 `days` 天的估算成本(零填充,与 {@link aggregateByHour} 同桶序;
 * 不落盘,纯计算)。逐行 {@link costFor},缺价行计 missing 不静默为 0。
 * @param table - 价格表。
 * @param rows - usage 日志行。
 * @param days - 窗口天数。
 * @param fallback - label → 模型 id 映射。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的小时成本(升序,`days×24` 桶)。
 */
export declare function estimateHourlyCosts(table: PricingTable, rows: readonly UsageLogRow[], days: number, fallback: ModelFallback, now?: number): HourCost[];
/**
 * 估算一次提升评审(global promote)的总成本(元;docs/global-layer-design.md §7.3,决策 D7)。
 *
 * 假设(写死在 JSDoc,不在运行时可变):输入 = nodeCount × maxNodeKb × 1024 字符
 * (满容量节点)、输出 = nodeCount × GLOBAL_PROMOTE_MAX 条 × 150 字符(逐节点输出
 * 上限近似),均按 chars/4 估 token;逐节点用 costFor 计价(线性可合并为一次调用),
 * 模型 = config.reviewModel(v4-pro),与 usage 行 label='review' 回退语义一致。
 * @param table - 价格表。
 * @param model - 提升评审模型 id。
 * @param nodeCount - 预计节点数(0 节点无调用,成本 0)。
 * @param maxNodeKb - 每节点容量上限(Kb)。
 * @param ts - 估算时刻(epoch 毫秒);缺省当前时间。
 * @returns 估算成本(元);模型无价格记录返回 undefined。
 */
export declare function estimatePromoteCost(table: PricingTable, model: string, nodeCount: number, maxNodeKb: number, ts?: number): number | undefined;
