/**
 * 记忆 Web 面板(路径 B 独立页)的纯逻辑:token、页面路由、RPC 通道。
 *
 * 面板 = host 侧五个页面 GET 路由(`/memory` 记忆页、`/memory/status` 状态页、
 * `/memory/collections` 目录页、`/memory/nodes` 节点状态页、`/memory/settings`
 * 设置页,均须 `?ac_token=`)+ 一个静态资源前缀(`/memory-assets/`)+ 一个
 * RPC channel(`/memory-api`,经 connection.handle 注册,authority: 'loopback',
 * 每个请求自动过 dsh 信任栅栏)。本模块不 import cordis:token 生成/比较、URL
 * 构造、HTML 壳渲染、资源路径防穿越、RPC 载荷校验与分发都是纯函数;路由与
 * channel 的注册编排在 index.ts。
 *
 * 安全模型(三层):
 *   1. token 门:`ac_token` 每次进程启动重新生成,GET 页面 / 静态资源 / RPC
 *      载荷三层都校验(常量时间比较)。防 DNS rebinding 下的导航读取与同机
 *      其他进程越权。
 *   2. 信任栅栏:RPC channel 由 dsh 的 connection.handle 注册,浏览器请求过
 *      同源检查,非浏览器客户端必须来自 loopback。
 *   3. XSS:CSP `default-src 'none'` + React textContent 渲染,记忆内容永不进
 *      innerHTML 路径。
 *
 * @module dsh-memory/ui
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { DOMAINS, LAYERS, MEMORY_TYPES } from '../schema.js';
import { CONFIG_KEYS, EXTRACT_MODES, SUMMARY_MODES } from '../memory-runtime.js';
import { GLOBAL_DOC_MAX_BYTES } from '../global-gate.js';
// ---- token ----
/** 面板 token 的随机字节数(32 字节 → 64 hex 字符)。 */
const TOKEN_BYTES = 32;
/**
 * 生成一次进程生命周期的面板访问 token(crypto 随机)。
 * @returns 64 位十六进制字符串。
 */
export function generatePanelToken() {
    return randomBytes(TOKEN_BYTES).toString('hex');
}
/**
 * 常量时间比较两个 token(先比长度,避免时序侧信道泄露前缀)。
 * @param provided - 请求方提供的 token。
 * @param expected - 服务端持有的 token。
 * @returns 完全一致时为真。
 */
export function safeTokenEqual(provided, expected) {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}
/**
 * 从请求 URL 提取 `ac_token` 查询参数。
 * @param rawUrl - `req.url`(可能带其他参数)。
 * @returns token 值;缺失或 URL 非法时返回 undefined。
 */
export function queryToken(rawUrl) {
    try {
        const value = new URL(rawUrl ?? '/', 'http://x').searchParams.get('ac_token');
        return value ?? undefined;
    }
    catch {
        return undefined;
    }
}
/** 面板页面的路由路径(无尾斜杠)。 */
export function panelPath(page) {
    if (page === 'memory')
        return '/memory';
    if (page === 'status')
        return '/memory/status';
    if (page === 'collections')
        return '/memory/collections';
    if (page === 'nodes')
        return '/memory/nodes';
    if (page === 'global')
        return '/memory/global';
    return '/memory/settings';
}
/**
 * 构造带 `ac_token` 的面板 URL(仅 loopback 地址)。
 * @param port - webServer 监听端口。
 * @param page - 页面。
 * @param token - 面板访问 token。
 * @returns 可点开的完整 URL。
 */
export function panelUrl(port, page, token) {
    return `http://127.0.0.1:${port}${panelPath(page)}?ac_token=${token}`;
}
// ---- 静态资源 ----
/** 面板静态资源的路径前缀。 */
export const ASSET_PREFIX = '/memory-assets/';
/** 允许直发的资源后缀白名单。 */
const ASSET_EXTENSIONS = new Set(['.js', '.css', '.map', '.svg', '.png', '.woff2']);
/**
 * 把 `/memory-assets/<file>` 解析为 panel 目录内的绝对文件路径。
 * 只接受单段文件名与白名单后缀,拒绝路径穿越(`..`、分隔符、绝对路径)。
 * @param panelDir - panel 构建产物目录(绝对路径)。
 * @param pathname - 请求路径。
 * @returns 目录内文件的绝对路径;非法时返回 undefined。
 */
export function resolvePanelAsset(panelDir, pathname) {
    if (!pathname.startsWith(ASSET_PREFIX))
        return undefined;
    const rest = pathname.slice(ASSET_PREFIX.length);
    if (rest.length === 0 || rest.includes('/') || rest.includes('\\') || rest.includes('..'))
        return undefined;
    if (!ASSET_EXTENSIONS.has(extname(rest).toLowerCase()))
        return undefined;
    const file = resolve(panelDir, rest);
    return file.startsWith(resolve(panelDir) + sep) ? file : undefined;
}
/** 资源后缀 → HTTP content-type。 */
export function assetContentType(file) {
    switch (extname(file).toLowerCase()) {
        case '.js': return 'text/javascript; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.map': return 'application/json; charset=utf-8';
        case '.svg': return 'image/svg+xml';
        case '.png': return 'image/png';
        case '.woff2': return 'font/woff2';
        default: return 'application/octet-stream';
    }
}
/**
 * 读一个 panel 目录内的静态资源(经 {@link resolvePanelAsset} 防穿越)。
 * @param panelDir - panel 构建产物目录。
 * @param pathname - 请求路径。
 * @returns 文件内容;路径非法或文件不存在时返回 undefined。
 */
export function readPanelAsset(panelDir, pathname) {
    const file = resolvePanelAsset(panelDir, pathname);
    if (file === undefined)
        return undefined;
    try {
        return readFileSync(file);
    }
    catch {
        return undefined;
    }
}
/** 序列化 bootstrap JSON;转义 `<` 防止内容破坏 script 边界。 */
function bootstrapJson(bootstrap) {
    return JSON.stringify(bootstrap).replace(/</g, '\\u003c');
}
/**
 * 渲染面板 HTML 壳:自包含,零外部 CDN。CSP 收紧到
 * `default-src 'none'` + 本源的 script/style/img/font/connect;
 * React 应用由 `/memory-assets/panel.js` 挂载到 `#root`。
 * @param bootstrap - 引导数据(page / token / channel)。
 * @returns 完整 HTML 文本。
 */
export function renderPanelShell(bootstrap) {
    const tokenQuery = `?ac_token=${encodeURIComponent(bootstrap.token)}`;
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'">
<title>dsh-memory panel</title>
<link rel="stylesheet" href="${ASSET_PREFIX}style.css${tokenQuery}">
</head>
<body>
<div id="root"></div>
<script id="dsh-memory-bootstrap" type="application/json">${bootstrapJson(bootstrap)}</script>
<script type="module" src="${ASSET_PREFIX}panel.js${tokenQuery}"></script>
</body>
</html>`;
}
/**
 * panel 构建产物的候选目录(编译后 lib 运行与源码运行的相对位置不同):
 * lib 运行 = <pkg>/lib/src/web-ui/ui.js → 上溯 3 级到包根;源码运行 =
 * <pkg>/src/web-ui/ui.ts → 上溯 2 级。产物恒在包根 panel/dist(与 npm files 一致)。
 */
const PANEL_DIST_CANDIDATES = [
    new URL('../../../panel/dist/', import.meta.url),
    new URL('../../panel/dist/', import.meta.url),
];
/**
 * 定位 panel 构建产物目录:首个含 `panel.js` 的候选。
 * @returns 目录绝对路径;两个候选都不存在时返回 undefined(面板不可用)。
 */
export function findPanelDist() {
    for (const candidate of PANEL_DIST_CANDIDATES) {
        const dir = fileURLToPath(candidate);
        if (existsSync(resolve(dir, 'panel.js')))
            return dir;
    }
    return undefined;
}
// ---- RPC ----
/** 面板 RPC channel 名(与 index.ts 的 connection.handle 注册一致)。 */
export const PANEL_CHANNEL = '/memory-api';
/** 面板全文模糊匹配:大小写不敏感,覆盖 entry / scope / domain。 */
export function matchesPanelQuery(entry, query) {
    const needle = query.toLowerCase();
    return entry.entry.toLowerCase().includes(needle)
        || entry.scope.toLowerCase().includes(needle)
        || entry.domain.toLowerCase().includes(needle);
}
/** 14 个配置键的设置页元数据(键集合与 {@link CONFIG_KEYS} 一致,测试锁定不漂移)。 */
export const PANEL_CONFIG_META = {
    maxNodeKb: { label: 'maxNodeKb', description: '每节点容量上限(Kb)', kind: 'number' },
    recallTopK: { label: 'recallTopK', description: '召回返回的最大条目数', kind: 'number' },
    rerankPrompt: { label: 'rerankPrompt', description: '召回聚合阶段的重排序提示词', kind: 'textarea' },
    warmupOnStart: { label: 'warmupOnStart', description: '插件启动时是否自动预热记忆 team', kind: 'boolean' },
    provider: { label: 'provider', description: '召回模型调用所用 provider route', kind: 'string' },
    model: { label: 'model', description: '召回模型 id', kind: 'string' },
    reviewModel: { label: 'reviewModel', description: '质检(review)模式所用模型 id', kind: 'string' },
    autoExtract: { label: 'autoExtract', description: '是否启用自动提取(旁路观测主会话)', kind: 'boolean' },
    extractMode: { label: 'extractMode', description: '提取触发形态(signal / counter / event-counter)', kind: 'enum', options: EXTRACT_MODES },
    extractInterval: { label: 'extractInterval', description: '相邻两次抽取的最小 turn 间隔(退火冷却期)', kind: 'number' },
    signalWords: { label: 'signalWords', description: '形态 1(signal)信号词集,逗号分隔', kind: 'string' },
    extractRulesPrompt: { label: 'extractRulesPrompt', description: 'rules 抽取器提示词模板', kind: 'textarea' },
    extractLessonsPrompt: { label: 'extractLessonsPrompt', description: 'lessons 抽取器提示词模板', kind: 'textarea' },
    summaryMode: { label: 'summaryMode', description: '注入摘要模式(global 只注入 global 全文 + 计数;all 旧全量)', kind: 'enum', options: SUMMARY_MODES },
};
/** 把配置对象投影为设置页展示项(按 {@link CONFIG_KEYS} 顺序)。 */
export function describeConfig(config) {
    return CONFIG_KEYS.map(key => ({ key, meta: PANEL_CONFIG_META[key], value: config[key] }));
}
/** 从 wire 重建的一条候选(最小面;服务端逐条重跑 gate,客户端 verdict 仅供回显)。 */
const GLOBAL_CANDIDATE_ITEM = z.object({
    type: z.union(['rules', 'lessons']),
    domain: z.union([...DOMAINS]),
    scope: z.string().min(1),
    entry: z.string().min(1),
    entryPoint: z.string(),
    references: z.string(),
    verdict: z.union(['pass', 'reject']),
    reason: z.string(),
});
const ENTRIES_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
    filters: z.object({
        type: z.union([...MEMORY_TYPES]),
        domain: z.union([...DOMAINS]),
        layer: z.union([...LAYERS]),
        query: z.string().min(1),
    }),
});
const TOKEN_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
});
const ROOT_PATH_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
    root: z.string().min(1).required(),
});
const ROOT_EXPORT_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
    root: z.string().min(1),
});
const CONFIG_SET_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
    patch: z.object({}).required(),
});
const GLOBAL_EXTRACT_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
    text: z.string().min(1).required(),
    confirm: z.boolean(),
    candidates: z.array(GLOBAL_CANDIDATE_ITEM),
});
const GLOBAL_PROMOTE_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
    confirm: z.boolean(),
});
const GLOBAL_IMPORT_PAYLOAD = z.object({
    acToken: z.string().min(1).required(),
    text: z.string().min(1).required(),
});
/** 用 schemastery 校验线协议载荷(不通过返回错误文本)。 */
function parsePayload(schema, payload) {
    try {
        // schemastery 的调用签名不接受 unknown;线协议边界本身就是「不可信输入」,显式断言。
        return { ok: true, value: schema(payload) };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
/** 载荷携带的 acToken 是否与服务端持有的一致(常量时间比较)。 */
function authorized(payload, token) {
    if (typeof payload !== 'object' || payload === null)
        return false;
    const acToken = payload.acToken;
    return typeof acToken === 'string' && safeTokenEqual(acToken, token);
}
/** 构造 RPC 失败结果(只用 bad-request / internal 两个码)。 */
function panelError(code, message) {
    return code === 'internal'
        ? { ok: false, error: { code: 'internal', message, details: {} } }
        : { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } };
}
/**
 * 面板 RPC 分发:token 门 → 载荷校验 → 注入依赖调用。
 *
 * 端点:entries(列记忆,带过滤)/ dashboard-get(状态页视图模型)/ roots-get
 * (目录页视图)/ root-add / root-forget / root-export(目录页管理)/ nodes-get
 * (节点状态页)/ config-get(读配置)/ config-set(写配置)。未知端点与非法载荷
 * 一律 bad-request;依赖抛错折叠为 internal。
 * @param endpoint - channel 相对端点。
 * @param payload - 客户端载荷(必须携带合法 acToken)。
 * @param token - 服务端持有的面板 token。
 * @param deps - 注入依赖。
 * @returns RPC 结果。
 */
export async function handlePanelRpc(endpoint, payload, token, deps) {
    try {
        switch (endpoint) {
            case 'entries': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(ENTRIES_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { entries: deps.entries(parsed.value.filters ?? {}) } };
            }
            case 'dashboard-get': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(TOKEN_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { dashboard: deps.dashboard() } };
            }
            case 'roots-get': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(TOKEN_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { roots: deps.roots() } };
            }
            case 'root-add': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(ROOT_PATH_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { roots: deps.addRoot(parsed.value.root) } };
            }
            case 'root-forget': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(ROOT_PATH_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { roots: deps.forgetRoot(parsed.value.root) } };
            }
            case 'root-export': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(ROOT_EXPORT_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { export: deps.exportRoots(parsed.value.root) } };
            }
            case 'config-get': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(TOKEN_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { config: deps.getConfig() } };
            }
            case 'nodes-get': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(TOKEN_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { processes: deps.nodes() } };
            }
            case 'config-set': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(CONFIG_SET_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { config: await deps.setConfig(parsed.value.patch) } };
            }
            case 'global-entries': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(TOKEN_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { entries: deps.globalEntries() } };
            }
            case 'global-extract': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(GLOBAL_EXTRACT_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                // 1 MiB 硬上限(token 门不能代替上限校验;docs/global-layer-design.md §4.1)。
                if (Buffer.byteLength(parsed.value.text, 'utf8') > GLOBAL_DOC_MAX_BYTES) {
                    return panelError('bad-request', `document exceeds the ${GLOBAL_DOC_MAX_BYTES / 1024 / 1024} MiB limit`);
                }
                if (parsed.value.confirm !== true) {
                    const candidates = await deps.globalExtract(parsed.value.text);
                    return { ok: true, value: { candidates } };
                }
                if (!Array.isArray(parsed.value.candidates) || parsed.value.candidates.length === 0) {
                    return panelError('bad-request', 'confirm requires the echoed candidates payload');
                }
                const written = deps.globalExtractConfirm(parsed.value.candidates);
                return { ok: true, value: written };
            }
            case 'global-promote': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(GLOBAL_PROMOTE_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                if (parsed.value.confirm !== true) {
                    return { ok: true, value: { plan: deps.globalPromotePlan() } };
                }
                return { ok: true, value: await deps.globalPromote() };
            }
            case 'global-review': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(TOKEN_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: await deps.globalReview() };
            }
            case 'global-export': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(TOKEN_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                return { ok: true, value: { export: deps.globalExport() } };
            }
            case 'global-import': {
                if (!authorized(payload, token))
                    return panelError('bad-request', 'missing or invalid acToken');
                const parsed = parsePayload(GLOBAL_IMPORT_PAYLOAD, payload);
                if (!parsed.ok)
                    return panelError('bad-request', parsed.message);
                // 导入同受 1 MiB 硬上限(§9.3 防线之前)。
                if (Buffer.byteLength(parsed.value.text, 'utf8') > GLOBAL_DOC_MAX_BYTES) {
                    return panelError('bad-request', `import document exceeds the ${GLOBAL_DOC_MAX_BYTES / 1024 / 1024} MiB limit`);
                }
                return { ok: true, value: deps.globalImport(parsed.value.text) };
            }
            default:
                return panelError('bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`);
        }
    }
    catch (error) {
        return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } };
    }
}
