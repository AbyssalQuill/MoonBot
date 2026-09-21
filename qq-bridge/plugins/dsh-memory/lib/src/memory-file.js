/**
 * 记忆文件的发现与读取(纯 node 层,不 import cordis)。
 *
 * 目录优先级(低 → 高,同名 basename 后者覆盖):
 *   内置(包内 `lmemory/`) < 用户 `~/.agents/lmemory` < 用户 `~/.dsh/lmemory`
 *   < 项目 `<repo>/.agents/lmemory` < 项目 `<repo>/.dsh/lmemory`
 *
 * 旧目录一次性迁移:早期版本使用 `memory/` 作目录名,发现时自动 rename 到
 * `lmemory/`(幂等,只动「含记忆产物或为空」的目录,见 docs/storage-and-collections.md §Q0)。
 *
 * 真相源是 `.remember.jsonl`;本模块只做「发现 + 读取」,写盘(追加 / 重写 / 渲染
 * MD / 更新 catalog)统一由 {@link ./store.js} 承载,避免两套独立写路径并存。读取时
 * 对旧数据做「读即迁移 + 落盘」(补 id/schemaVersion 写回 jsonl,见 {@link ./migrate.js}),
 * 保证只读层读旧数据不失败、且补出的 id 跨次读取稳定。
 *
 * @module dsh-memory/memory-file
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidateJsonlCache, readJsonlMigrating, serializeEntry } from './migrate.js';
import { renderMd } from './render.js';
import { parseRecallLine } from './team.js';
/** 内置记忆目录(包内 `lmemory/`);无内容时不存在,发现时跳过。 */
const BUILTIN_MEMORY_DIR = fileURLToPath(new URL('../lmemory', import.meta.url));
/** 内置记忆目录路径(host 级面板视图把内置层并入注册表根一起读取)。 */
export function builtinMemoryDir() {
    return BUILTIN_MEMORY_DIR;
}
/** dsh home 环境变量覆盖(默认 `~/.dsh`)。 */
const DSH_HOME_ENV = 'DSH_HOME';
/** agents home 环境变量覆盖(默认 `~/.agents`)。 */
const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME';
/** 解析 dsh home(registry / usage 日志等 host 级文件也共用此解析)。 */
export function dshHome() {
    const fromEnv = process.env[DSH_HOME_ENV];
    return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'));
}
/** 解析 agents home(同上,导出供跨模块复用)。 */
export function agentsHome() {
    const fromEnv = process.env[AGENTS_HOME_ENV];
    return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.agents'));
}
/** 判断一个目录是否「像我们的记忆目录」:含 `*.remember.jsonl` / `catalog.json`,或为空目录。 */
function hasMemoryArtifacts(dir) {
    if (!existsSync(dir))
        return false;
    const names = readdirSync(dir);
    if (names.length === 0)
        return true;
    return names.some(name => name.endsWith('.remember.jsonl') || name === 'catalog.json');
}
/** 迁移一层目录:旧 `memory/` 存在且新 `lmemory/` 不存在时 rename(防御见他方同名目录)。 */
function migrateLegacyDir(parent, report) {
    const legacy = join(parent, 'memory');
    const current = join(parent, 'lmemory');
    if (!existsSync(legacy) || existsSync(current))
        return;
    if (!hasMemoryArtifacts(legacy)) {
        report.skipped.push(legacy);
        return;
    }
    renameSync(legacy, current);
    report.moved.push(legacy);
}
/**
 * 旧目录(`memory/`)→ 新目录(`lmemory/`)的一次性迁移(幂等)。
 *
 * 覆盖用户两层(恒迁)与项目两层(cwd 提供时);仅当旧目录含记忆产物或为空才 rename,
 * 避免误拿他方工具的同名目录。{@link visibleMemoryDirs} 与 {@link memoryWriteRoots}
 * 在每次发现/写根解析前执行(报告丢弃,保证读写路径永远先于发现迁移);启动期
 * index.ts 显式调用一次并打印报告。
 * @param cwd - 当前工作目录;提供时一并覆盖项目层两个目录。
 * @returns 迁移报告。
 */
export function migrateLegacyMemoryDirs(cwd) {
    const report = { moved: [], skipped: [] };
    migrateLegacyDir(dshHome(), report);
    migrateLegacyDir(agentsHome(), report);
    if (cwd !== undefined) {
        const root = canonicalProjectRoot(cwd);
        migrateLegacyDir(join(root, '.dsh'), report);
        migrateLegacyDir(join(root, '.agents'), report);
    }
    return report;
}
/** 从 cwd 向上找项目根(以 `.git` 为标记),找不到则回退 cwd 本身。 */
export function findProjectRoot(cwd) {
    let current = resolve(cwd);
    while (true) {
        if (existsSync(join(current, '.git')))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return resolve(cwd);
        current = parent;
    }
}
/**
 * 项目根的 canonical 形态:realpath 解析 symlink(路径已消失时回退词法路径)。
 * 写根 / 发现 / team 缓存键 / registry 登记统一用它锚定同一物理 workspace
 * (docs/global-layer-design.md §6.2.1);固定用户根豁免 realpath(避免 macOS
 * `/tmp → /private/tmp` 与 DSH_HOME symlink 的连带变更)。
 * @param cwd - 当前工作目录。
 * @returns canonical 项目根绝对路径。
 */
export function canonicalProjectRoot(cwd) {
    try {
        return realpathSync(findProjectRoot(cwd));
    }
    catch {
        return findProjectRoot(cwd);
    }
}
/** global 记忆目录(用户 dsh 根内的子目录;仅 dsh home 一份,docs/global-layer-design.md §5.1)。 */
export function visibleGlobalDir() {
    return join(dshHome(), 'lmemory', 'global');
}
/** 解析写根(dsh 规范目录优先);项目根经 canonical 化锚定同一物理 workspace。 */
export function memoryWriteRoots(cwd) {
    // 写根解析同样先做旧目录一次性迁移(幂等)与存量 global 条目迁移。
    migrateLegacyMemoryDirs(cwd);
    migrateLegacyGlobalEntries();
    return {
        user: join(dshHome(), 'lmemory'),
        project: cwd === undefined ? '' : join(canonicalProjectRoot(cwd), '.dsh', 'lmemory'),
        global: visibleGlobalDir(),
    };
}
/**
 * 由 `entry.layer` 选写根目录:global → global 根(与 cwd 无关),project → 项目写根,
 * user → 用户写根。
 * @param cwd - 当前工作目录(project 层需要;global/user 可为 undefined)。
 * @param layer - 记忆落点层。
 * @returns 写根目录绝对路径。
 */
export function writeRootFor(cwd, layer) {
    const roots = memoryWriteRoots(cwd);
    if (layer === 'global')
        return roots.global;
    return layer === 'project' ? roots.project : roots.user;
}
/**
 * 给定 cwd 可见的全部记忆目录(低 → 高优先级,与发现合并顺序一致)。
 * 不含 global 子目录——`loadDir` 非递归,global 目录自动被本链排除;
 * global 条目经 {@link discoverGlobalEntries} / 各消费方显式追加(docs/global-layer-design.md §5.2)。
 * @param cwd - 当前工作目录;缺省只返回内置 + 用户级目录。
 * @returns 可见记忆目录绝对路径列表。
 */
export function visibleMemoryDirs(cwd) {
    // 发现前先做旧目录一次性迁移(幂等;报告丢弃,启动期由 index.ts 显式调用并打日志)。
    migrateLegacyMemoryDirs(cwd);
    migrateLegacyGlobalEntries();
    const root = cwd === undefined ? '' : canonicalProjectRoot(cwd);
    return [
        BUILTIN_MEMORY_DIR,
        join(agentsHome(), 'lmemory'),
        join(dshHome(), 'lmemory'),
        ...(root === '' ? [] : [join(root, '.agents', 'lmemory'), join(root, '.dsh', 'lmemory')]),
    ];
}
/** 读取一个 jsonl 文件并逐行解析(读即迁移,顺带补 id/schemaVersion 并落盘);文件不存在返回空。 */
function readJsonl(jsonlPath) {
    return readJsonlMigrating(jsonlPath).entries;
}
/**
 * 读取 global 目录的全部条目(docs/global-layer-design.md §5.2)。
 * 目录即身份 + 防御性 layer 过滤(global 目录内只认 layer==='global' 的行)。
 * @returns global 记忆条目(按文件排序后展平)。
 */
export function discoverGlobalEntries() {
    return loadDir(visibleGlobalDir()).flatMap(file => file.entries).filter(entry => entry.layer === 'global');
}
/** catalog 格式版本(与 store.ts 的 CATALOG_VERSION 一致,docs/memory-review.md §3)。 */
const CATALOG_VERSION = 1;
/** 由一层的记忆文件构建 catalog 投影(与 store.buildCatalog 同构;迁移场景的模块内私有版)。 */
function buildCatalogProjection(files) {
    return {
        version: CATALOG_VERSION,
        entries: files.flatMap(file => file.entries.map(entry => ({
            id: entry.id,
            file: basename(file.jsonlPath),
            type: entry.type,
            domain: entry.domain,
            scope: entry.scope,
            layer: entry.layer,
            entry: entry.entry,
        }))),
    };
}
/** 全量重写一层的 `catalog.json`(输出与 store.writeCatalog 产物相等,单测锁定)。 */
function writeCatalogProjection(dir, files) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'catalog.json'), `${JSON.stringify(buildCatalogProjection(files), null, 2)}\n`, 'utf8');
}
/** 写一批条目到 jsonl / md 对(迁移重写用;不经 store 的 MD 静态检查——输入来自已有合法条目)。 */
function writeEntries(jsonlPath, mdPath, entries) {
    const jsonl = entries.length > 0 ? `${entries.map(serializeEntry).join('\n')}\n` : '';
    writeFileSync(jsonlPath, jsonl, 'utf8');
    writeFileSync(mdPath, renderMd(entries), 'utf8');
    invalidateJsonlCache(jsonlPath);
}
/**
 * 一次性迁移(幂等):把两个用户根顶层 jsonl 中 `layer==='global'` 的行移入
 * global 目录当天文件(按原 type),源文件重写为不含这些行的集合,随后重写
 * 两侧 catalog。完成后「layer=global 的条目」与「global 目录的条目」恢复同一集合
 * (docs/global-layer-design.md §5.4)。内部只用直接路径,不调 visibleMemoryDirs(防递归)。
 * @returns 迁移报告。
 */
/** 存量 global 迁移每个进程只跑一次(幂等且写根/发现咽喉每次都会调,重复 loadDir 会把心跳打满 CPU)。 */
let legacyGlobalMigrated = false;
export function migrateLegacyGlobalEntries() {
    if (legacyGlobalMigrated)
        return { moved: 0 };
    const globalDir = visibleGlobalDir();
    const movedEntries = [];
    for (const root of [join(dshHome(), 'lmemory'), join(agentsHome(), 'lmemory')]) {
        if (!existsSync(root))
            continue;
        const files = loadDir(root);
        const nextFiles = [];
        let dirChanged = false;
        for (const file of files) {
            const remaining = file.entries.filter(entry => entry.layer !== 'global');
            if (remaining.length === file.entries.length) {
                nextFiles.push(file);
                continue;
            }
            dirChanged = true;
            for (const entry of file.entries) {
                if (entry.layer === 'global')
                    movedEntries.push(entry);
            }
            writeEntries(file.jsonlPath, file.mdPath, remaining);
            nextFiles.push({ ...file, entries: remaining });
        }
        if (dirChanged)
            writeCatalogProjection(root, nextFiles);
    }
    if (movedEntries.length === 0) {
        legacyGlobalMigrated = true;
        return { moved: 0 };
    }
    // 移入 global 目录当天文件(按 type 分组追加),随后重写 global catalog。
    mkdirSync(globalDir, { recursive: true });
    const byType = new Map();
    for (const entry of movedEntries) {
        const list = byType.get(entry.type) ?? [];
        list.push(entry);
        byType.set(entry.type, list);
    }
    for (const [type, entries] of byType) {
        const base = `${new Date().toISOString().slice(0, 10)}.${type}.remember`;
        const jsonlPath = join(globalDir, `${base}.jsonl`);
        const mdPath = join(globalDir, `${base}.md`);
        writeEntries(jsonlPath, mdPath, [...readJsonl(jsonlPath), ...entries]);
    }
    writeCatalogProjection(globalDir, loadDir(globalDir));
    legacyGlobalMigrated = true;
    return { moved: movedEntries.length };
}
/**
 * 从给定目录读取所有 `.remember.jsonl` 记忆文件(按路径排序)。
 * 每个文件独立成项,不做跨目录 basename 合并——host 级注册表视图
 * (不同根是各自独立的数据)需要这种无合并读取;单 cwd 视图仍走
 * {@link discoverFiles} 的合并语义。
 * @param dir - 记忆目录绝对路径。
 * @returns 该目录下的记忆文件列表(目录不存在为空)。
 */
export function loadDir(dir) {
    if (!existsSync(dir))
        return [];
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.remember.jsonl'))
            continue;
        const jsonlPath = join(dir, entry.name);
        const mdPath = jsonlPath.replace(/\.jsonl$/, '.md');
        files.push({ jsonlPath, mdPath, entries: readJsonl(jsonlPath) });
    }
    return files.sort((a, b) => (a.jsonlPath < b.jsonlPath ? -1 : a.jsonlPath > b.jsonlPath ? 1 : 0));
}
/**
 * 发现给定 cwd 可见的全部记忆文件(内置 + 用户 + 项目),按 basename 合并,
 * 同名后者覆盖(项目 > 用户 > 内置;同级 `.dsh` > `.agents`)。
 * @param cwd - 当前工作目录;缺省只返回内置 + 用户级。
 * @returns 归一化后的记忆文件列表。
 */
export function discoverFiles(cwd) {
    const byBasename = new Map();
    for (const dir of visibleMemoryDirs(cwd)) {
        for (const file of loadDir(dir)) {
            const basename = file.jsonlPath.split(/[\\/]/).pop();
            byBasename.set(basename, file);
        }
    }
    return [...byBasename.values()].sort((a, b) => (a.jsonlPath < b.jsonlPath ? -1 : a.jsonlPath > b.jsonlPath ? 1 : 0));
}
/** 发现给定 cwd 可见的全部记忆条目(按文件排序后展平)。 */
export function discoverEntries(cwd) {
    return discoverFiles(cwd).flatMap(file => [...file.entries]);
}
/** 逆查失败的降级行(行内可解析的字段保留,真相源字段以 `-` 占位)。 */
function degradedEntry(line) {
    return {
        id: line.id ?? '-',
        file: '-',
        type: line.type ?? '-',
        domain: line.domain ?? '-',
        scope: line.scope ?? '-',
        layer: '-',
        entry: line.entry,
        entryPoint: '-',
        references: '-',
    };
}
/**
 * 把召回返回的整行(格式见 render.entryLine)按 id 逆查真相源,补全全部字段。
 *
 * 召回在节点文本(索引)上做,`layer` / `entryPoint` / `references` 只在真相源
 * (jsonl)里;逆查 = 索引 → 真相源的回填。id 唯一,命中即完整字段;模型未照抄
 * 整行(id 缺失/伪造)时降级为行内字段 + `-` 占位,不丢结果。
 * @param cwd - 当前工作目录(与召回时一致)。
 * @param lines - 召回/重排序输出的整行列表。
 * @returns 完整条目投影(与 lines 同序)。
 */
export function resolveRecalled(cwd, lines) {
    const byId = new Map();
    // 逆查域 = 可见链 + global 目录(召回可见面与逆查必须同步,否则 global 召回行全降级;
    // docs/global-layer-design.md §5.2 表)。
    for (const file of [...discoverFiles(cwd), ...loadDir(visibleGlobalDir())]) {
        for (const entry of file.entries) {
            byId.set(entry.id, { entry, file: file.jsonlPath.split(/[\\/]/).pop() });
        }
    }
    return lines.map((line) => {
        const parsed = parseRecallLine(line);
        const hit = parsed.id === undefined ? undefined : byId.get(parsed.id);
        if (hit === undefined)
            return degradedEntry(parsed);
        return {
            id: hit.entry.id,
            file: hit.file,
            type: hit.entry.type,
            domain: hit.entry.domain,
            scope: hit.entry.scope,
            layer: hit.entry.layer,
            entry: hit.entry.entry,
            entryPoint: hit.entry.entryPoint,
            references: hit.entry.references,
        };
    });
}
