/**
 * usage 持久化日志:`~/.dsh/lmemory/usage.jsonl`(纯逻辑,不 import cordis)。
 *
 * 每次 LLM 调用(recall / extract / review)的 usage chunk 聚合为一行追加;
 * 读侧按本地日聚合,支撑 `/lmemory usage --days` 与状态页每日图。设计见
 * docs/storage-and-collections.md §Q4。
 *
 * @module dsh-memory/usage-log
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from './memory-file.js';
/** usage.jsonl 的固定路径(用户 lmemory 根内)。 */
export function usageLogPath() {
    return join(dshHome(), 'lmemory', 'usage.jsonl');
}
/**
 * 追加一行 usage 日志(顺序写,不排序;行写失败不抛——usage 是旁路观测,
 * 不能让记忆主链路因日志失败而中断,失败交 logger 在调用方记录)。
 * @param row - 要追加的行。
 * @returns 是否真的写入了(失败时为 false)。
 */
export function appendUsageRow(row) {
    try {
        const path = usageLogPath();
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 读取全部 usage 日志行;损坏行跳过(usage 是旁路数据,坏行不阻塞统计)。
 * @returns 日志行(按文件顺序)。
 */
export function readUsageRows() {
    const path = usageLogPath();
    if (!existsSync(path))
        return [];
    const rows = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim().length === 0)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed !== 'object' || parsed === null)
                continue;
            const { ts, label, inputTokens, outputTokens, cacheReadTokens, model } = parsed;
            if (typeof ts !== 'number' || (label !== 'recall' && label !== 'extract' && label !== 'review'))
                continue;
            if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number')
                continue;
            rows.push({
                ts,
                label,
                inputTokens,
                outputTokens,
                cacheReadTokens: typeof cacheReadTokens === 'number' ? cacheReadTokens : 0,
                ...(typeof model === 'string' ? { model } : {}),
            });
        }
        catch {
            // 坏行跳过。
        }
    }
    return rows;
}
/** 把 epoch 毫秒转成本地日期键 `YYYY-MM-DD`。 */
export function localDay(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 零值职责聚合。 */
function emptyLabel() {
    return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
}
/** 零值日聚合。 */
function emptyDay(day) {
    return { day, recall: emptyLabel(), extract: emptyLabel(), review: emptyLabel(), total: 0 };
}
/** 把某职责的行累计进该职责聚合。 */
function addToLabel(target, row) {
    const totalTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens;
    return {
        calls: target.calls + 1,
        inputTokens: target.inputTokens + row.inputTokens,
        outputTokens: target.outputTokens + row.outputTokens,
        cacheReadTokens: target.cacheReadTokens + row.cacheReadTokens,
        totalTokens: target.totalTokens + totalTokens,
    };
}
/** 近 `days` 天的本地日期键(从今往前,含今天,升序)。 */
export function recentDays(days, now = Date.now()) {
    const result = [];
    const cursor = new Date(now);
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - i);
        const p = (n) => String(n).padStart(2, '0');
        result.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    }
    return result;
}
/**
 * 按本地日聚合 usage 日志,零填充近 `days` 天(含今天,升序)。
 * @param rows - 日志行(由 {@link readUsageRows} 读取)。
 * @param days - 聚合天数(1..90;越界由调用方约束)。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的日聚合(升序)。
 */
export function aggregateByDay(rows, days, now = Date.now()) {
    const daysList = recentDays(days, now);
    const byDay = new Map();
    for (const day of daysList)
        byDay.set(day, emptyDay(day));
    for (const row of rows) {
        const bucket = byDay.get(localDay(row.ts));
        if (bucket === undefined)
            continue;
        const next = {
            ...bucket,
            [row.label]: addToLabel(bucket[row.label], row),
            total: bucket.total + row.inputTokens + row.outputTokens + row.cacheReadTokens,
        };
        byDay.set(bucket.day, next);
    }
    return daysList.map(day => byDay.get(day));
}
/** 零值小时聚合。 */
function emptyHour(day, hour) {
    return { day, hour, recall: emptyLabel(), extract: emptyLabel(), review: emptyLabel(), total: 0 };
}
/** 本地小时数 0..23。 */
function localHour(ts) {
    return new Date(ts).getHours();
}
/**
 * 按本地小时聚合 usage 日志,零填充近 `days` 个自然日 × 24 桶(与
 * {@link aggregateByDay} 同窗、同口径——日聚合 = 小时聚合按日求和,数学恒等)。
 * @param rows - 日志行(由 {@link readUsageRows} 读取)。
 * @param days - 聚合天数(1..90;越界由调用方约束)。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的小时聚合(升序,`days×24` 桶)。
 */
export function aggregateByHour(rows, days, now = Date.now()) {
    const daysList = recentDays(days, now);
    const buckets = [];
    const byKey = new Map();
    for (const day of daysList) {
        for (let hour = 0; hour < 24; hour++) {
            buckets.push(emptyHour(day, hour));
            byKey.set(`${day}T${hour}`, buckets.length - 1);
        }
    }
    for (const row of rows) {
        const index = byKey.get(`${localDay(row.ts)}T${localHour(row.ts)}`);
        if (index === undefined)
            continue;
        const bucket = buckets[index];
        buckets[index] = {
            ...bucket,
            [row.label]: addToLabel(bucket[row.label], row),
            total: bucket.total + row.inputTokens + row.outputTokens + row.cacheReadTokens,
        };
    }
    return buckets;
}
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
export function aggregateWindowTotals(rows, days, now = Date.now()) {
    const daily = aggregateByDay(rows, days, now);
    const labels = ['recall', 'extract', 'review'];
    return labels.map((label) => {
        let calls = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let totalTokens = 0;
        for (const day of daily) {
            calls += day[label].calls;
            inputTokens += day[label].inputTokens;
            outputTokens += day[label].outputTokens;
            cacheReadTokens += day[label].cacheReadTokens;
            totalTokens += day[label].totalTokens;
        }
        return { label, calls, inputTokens, outputTokens, cacheReadTokens, totalTokens };
    });
}
