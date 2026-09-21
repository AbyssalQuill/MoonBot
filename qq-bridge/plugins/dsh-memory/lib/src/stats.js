/**
 * 记忆统计与 token 用量估算(纯逻辑,不 import cordis / dsh-llm)。
 *
 * 支撑 `/lmemory stats`(记忆条目/文件统计)与 `/lmemory usage`(上下文成本
 * 估算 + LLM 调用消耗累计)。统计只读文件,不发模型调用;token 估算用
 * `chars / 4` 的粗略近似(中英混合语境下的工程近似,不是精确计费)。
 *
 * @module dsh-memory/stats
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { discoverFiles, loadDir, visibleGlobalDir, visibleMemoryDirs } from './memory-file.js';
/** 读取某目录的 catalog.json 条目数;文件缺失/损坏返回 0(统计只读,失败降级不抛)。 */
function readCatalogEntries(dir) {
    const path = join(dir, 'catalog.json');
    if (!existsSync(path))
        return 0;
    try {
        const doc = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(doc.entries) ? doc.entries.length : 0;
    }
    catch {
        return 0;
    }
}
/**
 * 计算给定 cwd 可见的全部记忆的统计(含 global 目录,直接追加不合并;
 * docs/global-layer-design.md §5.2)。
 * @param cwd - 当前工作目录;缺省只统计内置 + 用户级 + global。
 * @returns 统计结果(无记忆时各项为 0 / 空)。
 */
export function computeStats(cwd) {
    return aggregateStats([...discoverFiles(cwd), ...loadDir(visibleGlobalDir())], [...visibleMemoryDirs(cwd), visibleGlobalDir()]);
}
/**
 * 在显式给出的记忆目录列表上计算统计(host 级注册表视图用)。
 *
 * 与 {@link computeStats} 的差别:不做跨目录 basename 合并——不同根是各自
 * 独立的数据,合并会吞掉不同项目的同名文件;单 cwd 视图仍走
 * {@link discoverFiles} 的合并语义。
 * @param dirs - 记忆目录绝对路径列表(去重后遍历;不存在的目录跳过)。
 * @returns 统计结果(无记忆时各项为 0 / 空)。
 */
export function computeStatsIn(dirs) {
    const unique = [...new Set(dirs)];
    const files = [];
    for (const dir of unique) {
        if (!existsSync(dir))
            continue;
        files.push(...loadDir(dir));
    }
    return aggregateStats(files, unique);
}
/** 聚合一组记忆文件的统计(共享循环;catalog 条目按给定目录求和)。 */
function aggregateStats(files, catalogDirs) {
    const byType = { rules: 0, lessons: 0 };
    const byLayer = { global: 0, user: 0, project: 0 };
    const byDomain = new Map();
    let jsonlBytes = 0;
    let mdBytes = 0;
    for (const file of files) {
        jsonlBytes += statSync(file.jsonlPath).size;
        if (existsSync(file.mdPath))
            mdBytes += statSync(file.mdPath).size;
        for (const entry of file.entries) {
            byType[entry.type] += 1;
            byLayer[entry.layer] += 1;
            byDomain.set(entry.domain, (byDomain.get(entry.domain) ?? 0) + 1);
        }
    }
    return {
        total: byType.rules + byType.lessons,
        byType,
        byLayer,
        byDomain,
        files: files.length,
        jsonlBytes,
        mdBytes,
        catalogEntries: catalogDirs.reduce((sum, dir) => sum + readCatalogEntries(dir), 0),
    };
}
/**
 * 把字符数粗估为 token 数(中英混合语境的工程近似:约 4 字符/token)。
 * @param chars - 文本字符数。
 * @returns 估算 token 数(向上取整)。
 */
export function estimateTokens(chars) {
    return Math.ceil(chars / 4);
}
/** 零值累计器。 */
export const EMPTY_USAGE = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
/**
 * 把一次调用的 usage 累计进计数器。
 * @param counter - 现有计数器。
 * @param usage - 本次调用的 usage。
 * @returns 新计数器(调用次数 +1)。
 */
export function recordUsage(counter, usage) {
    return {
        calls: counter.calls + 1,
        inputTokens: counter.inputTokens + usage.inputTokens,
        outputTokens: counter.outputTokens + usage.outputTokens,
        cacheReadTokens: counter.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    };
}
