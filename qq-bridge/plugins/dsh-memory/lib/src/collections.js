/**
 * 记忆包导出:把注册表里的全部或选定记忆根合并导出到一个目录(纯逻辑,
 * 不 import cordis)。设计见 docs/storage-and-collections.md §Q3。
 *
 * 导出 = 真相源直拷(jsonl + md)+ manifest;记忆 id 是 crypto 随机全局唯一,
 * 跨根不碰撞,多包合并展开不冲突。本轮只做导出;import(合并回 host)是后续扩展。
 *
 * @module dsh-memory/collections
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { refreshRegistry } from './registry.js';
/** 导出 manifest 格式版本(结构变化时递增)。 */
export const EXPORT_FORMAT_VERSION = 1;
/** 默认导出落点(`~/dsh-memory-exports/`)。 */
export function defaultExportDir() {
    return join(homedir(), 'dsh-memory-exports');
}
/** 导出目录名后缀(本地时间戳;由调用方传入,可测)。 */
export function exportDirName(now) {
    const p = (n) => String(n).padStart(2, '0');
    return `dsh-memory-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
/** 列出根目录内要导出的记忆文件(相对路径,按名排序)。 */
function memoryFiles(root) {
    if (!existsSync(root))
        return [];
    return readdirSync(root)
        .filter(name => name.endsWith('.remember.jsonl') || name.endsWith('.remember.md'))
        .sort();
}
/**
 * 导出记忆包:把选定根(jsonl 真相源 + md 投影)拷到
 * `<outDir>/dsh-memory-<时间戳>/roots/<nn>/`,并写 manifest.json。
 *
 * 根缺省取注册表全部根(先刷新);`roots` 参数指定时只导出这些路径(存在才导)。
 * 与根同名的冲突不会发生——manifest 用序号目录隔离来源。
 * @param cwd - 当前工作目录(刷新注册表时登记项目根)。
 * @param options - `outDir`(落点,缺省 {@link defaultExportDir})、`roots`(选定根)。
 * @param now - 导出时刻(测试注入)。
 * @returns 导出结果。
 */
export function exportCollections(cwd, options = {}, now = new Date()) {
    const outDir = resolve(options.outDir ?? defaultExportDir());
    const targetRoots = options.roots !== undefined && options.roots.length > 0
        ? options.roots.map(root => resolve(root))
        : refreshRegistry(cwd, now.getTime()).roots.map(entry => entry.root);
    const manifestRoots = [];
    let totalEntries = 0;
    for (const root of targetRoots) {
        const files = memoryFiles(root);
        if (files.length === 0)
            continue;
        const index = manifestRoots.length;
        const target = join(outDir, exportDirName(now), 'roots', String(index).padStart(2, '0'));
        mkdirSync(target, { recursive: true });
        let entries = 0;
        for (const file of files) {
            copyFileSync(join(root, file), join(target, file));
            if (file.endsWith('.remember.jsonl'))
                entries += countJsonlRows(join(root, file));
        }
        manifestRoots.push({ root, entries, files });
        totalEntries += entries;
    }
    const dir = join(outDir, exportDirName(now));
    mkdirSync(dir, { recursive: true });
    const manifest = {
        formatVersion: EXPORT_FORMAT_VERSION,
        source: 'dsh-memory',
        exportedAt: now.getTime(),
        totalEntries,
        roots: manifestRoots,
    };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { dir, totalEntries, rootsExported: manifestRoots.length };
}
/**
 * 数一个 jsonl 文件的非空行数(只作导出清单计数,不做迁移/校验)。
 *
 * 导出是**原样拷贝**,manifest 的 entries 描述「被拷贝的行数」,故按原始行计;
 * 注册表/目录页的计数按「运行时能读到的条目」计(迁移+校验通过,坏行跳过,
 * 见 registry.scanRootDetail)——健康数据下两者一致,坏行只在导出侧多计。
 */
function countJsonlRows(jsonlPath) {
    return readFileSync(jsonlPath, 'utf8').split('\n').filter(line => line.trim().length > 0).length;
}
