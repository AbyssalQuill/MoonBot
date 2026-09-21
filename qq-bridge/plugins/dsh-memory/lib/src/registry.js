/**
 * host 级记忆根注册表:`~/.dsh/lmemory/registry.json`(纯逻辑,不 import cordis)。
 *
 * 回答「host 上有多少个 lmemory 目录、各自在哪、有多少数据」:固定根(用户 dsh /
 * 用户 agents)恒登记,项目根惰性登记(启动与 session-start 时传入 cwd);历史根
 * 保留,已消失的保持最后已知计数。设计见 docs/storage-and-collections.md §Q2。
 *
 * @module dsh-memory/registry
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { agentsHome, canonicalProjectRoot, dshHome, visibleGlobalDir } from './memory-file.js';
import { countValidJsonlRows } from './migrate.js';
/** registry 格式版本(结构变化时递增;读取端只认格式,不认识则视为空表)。 */
export const REGISTRY_FORMAT_VERSION = 1;
/** registry.json 的固定路径(在用户 lmemory 根内,随用户根一起备份)。 */
export function registryPath() {
    return join(dshHome(), 'lmemory', 'registry.json');
}
/** 空注册表。 */
function emptyRegistry() {
    return { formatVersion: REGISTRY_FORMAT_VERSION, updatedAt: 0, roots: [] };
}
/** 载荷解析:JSON 非法或结构不符时返回空注册表(注册表是派生索引,可重建)。 */
function parseRegistry(text) {
    try {
        const doc = JSON.parse(text);
        if (typeof doc !== 'object' || doc === null)
            return emptyRegistry();
        const { formatVersion, updatedAt, roots } = doc;
        if (formatVersion !== REGISTRY_FORMAT_VERSION || !Array.isArray(roots))
            return emptyRegistry();
        const parsed = [];
        for (const entry of roots) {
            if (typeof entry !== 'object' || entry === null)
                continue;
            const { root, kind, firstSeenAt, lastSeenAt, entries, files } = entry;
            if (typeof root !== 'string' || (kind !== 'user' && kind !== 'project' && kind !== 'global'))
                continue;
            if (typeof firstSeenAt !== 'number' || typeof lastSeenAt !== 'number')
                continue;
            if (typeof entries !== 'number' || typeof files !== 'number')
                continue;
            parsed.push({ root, kind, firstSeenAt, lastSeenAt, entries, files });
        }
        return { formatVersion: REGISTRY_FORMAT_VERSION, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0, roots: parsed };
    }
    catch {
        return emptyRegistry();
    }
}
/**
 * 读取注册表;文件缺失 / 损坏返回空注册表(派生索引,可重建,不抛)。
 * @returns 当前注册表。
 */
export function loadRegistry() {
    const path = registryPath();
    if (!existsSync(path))
        return emptyRegistry();
    return parseRegistry(readFileSync(path, 'utf8'));
}
/**
 * 写回注册表(原子:临时文件 + rename)。
 * @param registry - 要落盘的注册表。
 */
export function saveRegistry(registry) {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
}
/**
 * 扫描一个记忆根目录(只读;目录不存在返回 0/0 与空明细)。
 *
 * 计数口径 = 「迁移 + 严格校验通过」的条目(坏行跳过,不抛)——一条坏行不能让
 * 启动期 refreshRegistry 或整个目录页失效;与导出的计数口径(原始非空行数,
 * 描述被拷贝的产物)不同,健康数据下两者一致,见 collections.ts。
 */
export function scanRootDetail(dir) {
    if (!existsSync(dir))
        return { entries: 0, files: 0, filesDetail: [] };
    let names;
    try {
        names = readdirSync(dir).sort();
    }
    catch {
        // 登记后路径被替换成非常规文件等:按不可读目录处理,保持最后已知计数来源稳定。
        return { entries: 0, files: 0, filesDetail: [] };
    }
    let entries = 0;
    const filesDetail = [];
    for (const name of names) {
        if (!name.endsWith('.remember.jsonl'))
            continue;
        const count = countValidJsonlRows(join(dir, name));
        entries += count;
        filesDetail.push({ file: name, entries: count });
    }
    return { entries, files: filesDetail.length, filesDetail };
}
/** 扫描一个记忆根目录的条目数与文件数(只读;目录不存在返回 0/0)。 */
export function scanRoot(dir) {
    const { entries, files } = scanRootDetail(dir);
    return { entries, files };
}
/** 判定一个目录可作为记忆根:存在且(含记忆文件或为空目录)。 */
export function isMemoryRoot(dir) {
    if (!existsSync(dir))
        return false;
    const names = readdirSync(dir);
    return names.length === 0 || names.some(name => name.endsWith('.remember.jsonl') || name === 'catalog.json');
}
/** 登记一个根:已存在则更新计数与 lastSeenAt,否则新增;返回登记后的根。 */
function upsertRoot(registry, root, kind, now) {
    const existing = registry.roots.find(entry => entry.root === root);
    const { entries, files } = scanRoot(root);
    if (existing !== undefined) {
        return {
            root,
            kind: existing.kind,
            firstSeenAt: existing.firstSeenAt,
            lastSeenAt: now,
            entries,
            files,
        };
    }
    return { root, kind, firstSeenAt: now, lastSeenAt: now, entries, files };
}
/** 固定根候选(用户两层 + global 目录):dsh home 与 agents home 下的 lmemory 目录,及 global 目录。 */
function fixedRoots() {
    return [join(dshHome(), 'lmemory'), join(agentsHome(), 'lmemory'), visibleGlobalDir()];
}
/**
 * 刷新注册表:登记固定根与给定 cwd 的项目根,重算仍存在根的计数并落盘。
 *
 * 项目根惰性登记:启动与 session-start 时传入 cwd;历史根保留(已消失的保持
 * 最后已知计数,lastSeenAt 不更新)。
 * @param cwd - 当前工作目录;提供时登记其项目根(两个层)。
 * @param now - 刷新时刻(测试注入);缺省用当前时间。
 * @returns 刷新后的注册表。
 */
export function refreshRegistry(cwd, now = Date.now()) {
    const registry = loadRegistry();
    const next = [];
    // 固定根(存在才登记;不存在则丢弃登记,避免空目录噪音);global 目录 kind='global'。
    for (const root of fixedRoots()) {
        if (!existsSync(root))
            continue;
        const kind = root === visibleGlobalDir() ? 'global' : 'user';
        next.push(upsertRoot(registry, root, kind, now));
    }
    // 项目根(cwd 提供时,canonical 锚定):无条件登记——自动提取是异步的,session-start 时刻
    // 项目 lmemory 目录往往尚未创建;先按路径登记(0/0),目录出现后由后续
    // 刷新(如提取写盘后的 refreshRegistry)更新计数。
    if (cwd !== undefined) {
        const projectRoot = canonicalProjectRoot(cwd);
        for (const root of [join(projectRoot, '.dsh', 'lmemory'), join(projectRoot, '.agents', 'lmemory')]) {
            next.push(upsertRoot(registry, root, 'project', now));
        }
    }
    // 历史根:project 根 canonical 归一合并(同一物理项目经 symlink 与真实路径只保留一条,
    // root 改写为 canonical 路径、firstSeenAt 取最早;docs/global-layer-design.md §6.2.2);
    // 已消失的根保持最后已知路径(不做 realpath)。
    const seen = new Set(next.map(entry => entry.root));
    const byCanonical = new Map();
    for (const entry of next) {
        if (entry.kind !== 'project')
            continue;
        try {
            byCanonical.set(realpathSync(entry.root), entry);
        }
        catch {
            // 新登记根刚 upsert,磁盘存在;失败仅当极端竞态,按词法路径处理。
        }
    }
    for (const entry of registry.roots) {
        if (seen.has(entry.root))
            continue;
        if (!existsSync(entry.root)) {
            next.push(entry);
            continue;
        }
        if (entry.kind !== 'project') {
            next.push(upsertRoot(registry, entry.root, entry.kind, now));
            continue;
        }
        let canonical = entry.root;
        try {
            canonical = realpathSync(entry.root);
        }
        catch {
            // 回退词法路径。
        }
        const existing = byCanonical.get(canonical);
        if (existing === undefined) {
            const fresh = upsertRoot(registry, canonical, 'project', now);
            next.push(fresh);
            byCanonical.set(canonical, fresh);
            continue;
        }
        const { entries, files } = scanRoot(canonical);
        const merged = {
            ...existing,
            root: canonical,
            firstSeenAt: Math.min(existing.firstSeenAt, entry.firstSeenAt),
            lastSeenAt: now,
            entries,
            files,
        };
        const index = next.findIndex(item => item.root === existing.root);
        if (index >= 0)
            next[index] = merged;
        byCanonical.set(canonical, merged);
    }
    const result = { formatVersion: REGISTRY_FORMAT_VERSION, updatedAt: now, roots: next };
    saveRegistry(result);
    return result;
}
/**
 * 从注册表移除一个根(不动磁盘数据)。
 * @param root - 根路径(精确匹配)。
 * @param now - 操作时刻(测试注入)。
 * @returns 是否真的移除了一条。
 */
export function forgetRoot(root, now = Date.now()) {
    const registry = loadRegistry();
    const next = registry.roots.filter(entry => entry.root !== root);
    if (next.length === registry.roots.length)
        return false;
    saveRegistry({ formatVersion: REGISTRY_FORMAT_VERSION, updatedAt: now, roots: next });
    return true;
}
/**
 * 手动登记一个根(`/lmemory collections add` 入口)。
 *
 * 不校验目录内容(调用方先经 {@link isMemoryRoot} 判定);kind 由路径判定:
 * 恰为两个固定用户根之一算 user,恰为 global 目录算 global,其余一律 project。
 * @param root - 根路径(绝对化后存储)。
 * @param now - 登记时刻(测试注入)。
 * @returns 登记后的注册表。
 */
export function registerExplicitRoot(root, now = Date.now()) {
    const resolved = resolve(root);
    const kind = resolved === visibleGlobalDir()
        ? 'global'
        : resolved === join(dshHome(), 'lmemory') || resolved === join(agentsHome(), 'lmemory')
            ? 'user'
            : 'project';
    const registry = loadRegistry();
    const next = [...registry.roots.filter(entry => entry.root !== resolved), upsertRoot(registry, resolved, kind, now)];
    const result = { formatVersion: REGISTRY_FORMAT_VERSION, updatedAt: now, roots: next };
    saveRegistry(result);
    return result;
}
