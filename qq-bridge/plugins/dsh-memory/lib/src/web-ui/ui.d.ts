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
import type { DomainId, LayerId, MemoryEntry, MemoryType } from '../schema.js';
import type { ConfigKey, MemoryConfig } from '../memory-runtime.js';
import type { GlobalCandidate } from '../global-gate.js';
import type { ProcessRow } from '../runtime-status.js';
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api';
/**
 * 生成一次进程生命周期的面板访问 token(crypto 随机)。
 * @returns 64 位十六进制字符串。
 */
export declare function generatePanelToken(): string;
/**
 * 常量时间比较两个 token(先比长度,避免时序侧信道泄露前缀)。
 * @param provided - 请求方提供的 token。
 * @param expected - 服务端持有的 token。
 * @returns 完全一致时为真。
 */
export declare function safeTokenEqual(provided: string, expected: string): boolean;
/**
 * 从请求 URL 提取 `ac_token` 查询参数。
 * @param rawUrl - `req.url`(可能带其他参数)。
 * @returns token 值;缺失或 URL 非法时返回 undefined。
 */
export declare function queryToken(rawUrl: string | undefined): string | undefined;
/** 面板页面。 */
export type PanelPage = 'memory' | 'status' | 'collections' | 'nodes' | 'settings' | 'global';
/** 面板页面的路由路径(无尾斜杠)。 */
export declare function panelPath(page: PanelPage): string;
/**
 * 构造带 `ac_token` 的面板 URL(仅 loopback 地址)。
 * @param port - webServer 监听端口。
 * @param page - 页面。
 * @param token - 面板访问 token。
 * @returns 可点开的完整 URL。
 */
export declare function panelUrl(port: number, page: PanelPage, token: string): string;
/** 面板静态资源的路径前缀。 */
export declare const ASSET_PREFIX = "/memory-assets/";
/**
 * 把 `/memory-assets/<file>` 解析为 panel 目录内的绝对文件路径。
 * 只接受单段文件名与白名单后缀,拒绝路径穿越(`..`、分隔符、绝对路径)。
 * @param panelDir - panel 构建产物目录(绝对路径)。
 * @param pathname - 请求路径。
 * @returns 目录内文件的绝对路径;非法时返回 undefined。
 */
export declare function resolvePanelAsset(panelDir: string, pathname: string): string | undefined;
/** 资源后缀 → HTTP content-type。 */
export declare function assetContentType(file: string): string;
/**
 * 读一个 panel 目录内的静态资源(经 {@link resolvePanelAsset} 防穿越)。
 * @param panelDir - panel 构建产物目录。
 * @param pathname - 请求路径。
 * @returns 文件内容;路径非法或文件不存在时返回 undefined。
 */
export declare function readPanelAsset(panelDir: string, pathname: string): Buffer | undefined;
/** 面板引导数据(注入 HTML 的 JSON bootstrap)。 */
export interface PanelBootstrap {
    /** 当前页面。 */
    readonly page: PanelPage;
    /** 面板访问 token(React 应用用它调 RPC)。 */
    readonly token: string;
    /** RPC channel 前缀(与 connection.handle 注册一致)。 */
    readonly channel: string;
}
/**
 * 渲染面板 HTML 壳:自包含,零外部 CDN。CSP 收紧到
 * `default-src 'none'` + 本源的 script/style/img/font/connect;
 * React 应用由 `/memory-assets/panel.js` 挂载到 `#root`。
 * @param bootstrap - 引导数据(page / token / channel)。
 * @returns 完整 HTML 文本。
 */
export declare function renderPanelShell(bootstrap: PanelBootstrap): string;
/**
 * 定位 panel 构建产物目录:首个含 `panel.js` 的候选。
 * @returns 目录绝对路径;两个候选都不存在时返回 undefined(面板不可用)。
 */
export declare function findPanelDist(): string | undefined;
/** 面板 RPC channel 名(与 index.ts 的 connection.handle 注册一致)。 */
export declare const PANEL_CHANNEL = "/memory-api";
/** 面板全文模糊匹配:大小写不敏感,覆盖 entry / scope / domain。 */
export declare function matchesPanelQuery(entry: MemoryEntry, query: string): boolean;
/** `entries` 请求的过滤条件(全部可选)。 */
export interface PanelFilters {
    /** 按类型过滤。 */
    readonly type?: MemoryType;
    /** 按领域过滤。 */
    readonly domain?: DomainId;
    /** 按落点层过滤。 */
    readonly layer?: LayerId;
    /** 全文模糊匹配(entry / scope / domain)。 */
    readonly query?: string;
}
/** 面板里的一条记忆行(完整条目 + 所在文件)。 */
export interface PanelEntryRow {
    /** 完整记忆条目(含 createdAt,Timeline 用)。 */
    readonly entry: MemoryEntry;
    /** `.remember.jsonl` 的绝对路径(host 级注册表视图;不同根的同名文件以此区分来源)。 */
    readonly file: string;
}
/** 设置页展示元数据(标签 / 说明 / 控件类型)。 */
export interface PanelConfigMeta {
    /** 展示标签。 */
    readonly label: string;
    /** 一句话说明。 */
    readonly description: string;
    /** 设置页控件类型。 */
    readonly kind: 'number' | 'boolean' | 'enum' | 'string' | 'textarea';
    /** enum 类型的可选项。 */
    readonly options?: readonly string[];
}
/** 14 个配置键的设置页元数据(键集合与 {@link CONFIG_KEYS} 一致,测试锁定不漂移)。 */
export declare const PANEL_CONFIG_META: Readonly<Record<ConfigKey, PanelConfigMeta>>;
/** 设置页的一个配置项(元数据 + 当前值)。 */
export interface PanelConfigItem {
    /** 配置键。 */
    readonly key: ConfigKey;
    /** 展示元数据。 */
    readonly meta: PanelConfigMeta;
    /** 当前值。 */
    readonly value: unknown;
}
/** 把配置对象投影为设置页展示项(按 {@link CONFIG_KEYS} 顺序)。 */
export declare function describeConfig(config: MemoryConfig): PanelConfigItem[];
/** 状态页的 team 状态一行。 */
export interface DashboardTeamRow {
    /** 项目根路径;空串表示「无项目」(内置 + 用户层)。 */
    readonly root: string;
    /** 已预热节点数。 */
    readonly nodes: number;
}
/** 状态页的 LLM 调用消耗一行(按职责分类)。 */
export interface DashboardUsageRow {
    /** 职责分类(recall / extract / review)。 */
    readonly label: string;
    /** 调用次数。 */
    readonly calls: number;
    /** 累计输入 token。 */
    readonly inputTokens: number;
    /** 累计输出 token。 */
    readonly outputTokens: number;
    /** 累计缓存读 token。 */
    readonly cacheReadTokens: number;
}
/** 状态页某一天某一职责的聚合(镜像 usage-log 的 LabelDayUsage)。 */
export interface DashboardLabelUsage {
    /** 当日调用次数。 */
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    /** 当日该职责 token 合计。 */
    readonly totalTokens: number;
}
/** 状态页某一天的聚合(镜像 usage-log 的 DayUsage)。 */
export interface DashboardDaily {
    /** 本地日期 `YYYY-MM-DD`。 */
    readonly day: string;
    readonly recall: DashboardLabelUsage;
    readonly extract: DashboardLabelUsage;
    readonly review: DashboardLabelUsage;
    /** 当日全部 token 合计。 */
    readonly total: number;
}
/** 状态页某个小时桶的聚合(镜像 usage-log 的 HourUsage;cost 字段由 pricing 合并)。 */
export interface DashboardHourly {
    /** 本地日期 `YYYY-MM-DD`。 */
    readonly day: string;
    /** 本地小时 0..23。 */
    readonly hour: number;
    readonly recall: DashboardLabelUsage;
    readonly extract: DashboardLabelUsage;
    readonly review: DashboardLabelUsage;
    /** 该小时全部 token 合计。 */
    readonly total: number;
    /** 该小时估算成本(元);缺价时缺省。 */
    readonly yuan?: number;
    /** 该小时缺价(无价格记录)的调用行数。 */
    readonly missingPricingRows?: number;
}
/** 状态页的完整视图模型(status / stats / usage 三区,一次 RPC 取齐)。 */
export interface DashboardDto {
    /** 顶部:记忆 team 状态。 */
    readonly status: {
        /** 每节点容量上限(Kb)。 */
        readonly maxNodeKb: number;
        /** 各 root 的已预热 team。 */
        readonly teams: readonly DashboardTeamRow[];
    };
    /** 中部:记忆统计指标。 */
    readonly stats: {
        /** 总条目数。 */
        readonly total: number;
        /** rules / lessons 条目数。 */
        readonly rules: number;
        readonly lessons: number;
        /** global / user / project 层条目数。 */
        readonly layers: {
            readonly global: number;
            readonly user: number;
            readonly project: number;
        };
        /** 按 domain 的条目数(按数量降序,只含非零项)。 */
        readonly domains: readonly {
            readonly domain: string;
            readonly count: number;
        }[];
        /** 记忆文件数。 */
        readonly files: number;
        /** jsonl 总字节。 */
        readonly jsonlBytes: number;
        /** md 总字节。 */
        readonly mdBytes: number;
        /** catalog 条目总数。 */
        readonly catalogEntries: number;
    };
    /** 正文:token 用量(静态上下文估算 + 持久化 LLM 调用消耗 + 每日聚合)。 */
    readonly usage: {
        /** 预热 team 的静态上下文成本(本进程实时装载)。 */
        readonly warmTeams: {
            readonly nodes: number;
            readonly chars: number;
            readonly tokens: number;
        };
        /** system prompt 摘要的静态上下文成本(本进程实时装载)。 */
        readonly summary: {
            readonly chars: number;
            readonly tokens: number;
        };
        /** 近 14 天 LLM 调用消耗(usage.jsonl,host 级跨进程;与 daily 同源,见 docs/status-page-usage.md)。 */
        readonly totals: readonly DashboardUsageRow[];
        /** 近 84 天按日聚合(usage.jsonl,零填充,升序;柱状图取后 14 天,热力图用全部)。 */
        readonly daily: readonly DashboardDaily[];
        /** 近 14 天 × 24 小时聚合(升序,336 桶;daily = hourly 按日求和,数学恒等)。
         *  可选字段:旧 host 进程不返回,面板须优雅降级(不展开、今天图显示空态)。 */
        readonly hourly?: readonly DashboardHourly[];
        /** 近 14 天估算成本(即时计算、不落盘,见 docs/pricing-and-cost.md;价格表损坏时带 error)。 */
        readonly costs: {
            readonly perLabel: readonly {
                readonly label: string;
                readonly calls: number;
                readonly yuan?: number;
                readonly missingPricingRows: number;
            }[];
            readonly totalYuan: number;
            readonly incomplete: boolean;
            /** 近 14 天逐日成本(与 daily 最后 14 天对齐;价格表损坏时缺省)。 */
            readonly daily?: readonly {
                readonly day: string;
                readonly yuan?: number;
                readonly missingPricingRows: number;
            }[];
            readonly error?: string;
        };
    };
    /** 记忆活动大表(docs/memory-activity.md):最近 24h、1 小时一格,counts 键 `type/domain`。 */
    readonly activity: {
        readonly windowStart: number;
        readonly windowEnd: number;
        readonly bucketMinutes: number;
        readonly buckets: readonly {
            readonly start: number;
            readonly counts: Readonly<Record<string, number>>;
        }[];
    };
}
/** 目录页一个根的文件级明细行。 */
export interface RootFileRow {
    /** `.remember.jsonl` 文件名。 */
    readonly file: string;
    /** 该文件条目数。 */
    readonly entries: number;
}
/** 目录页一个记忆根的行(registry 条目 + 存活状态 + 文件明细)。 */
export interface RootRow {
    /** 根目录绝对路径。 */
    readonly root: string;
    /** 根类型:user / project / global。 */
    readonly kind: 'user' | 'project' | 'global';
    /** 首次登记时间(epoch 毫秒)。 */
    readonly firstSeenAt: number;
    /** 最近一次刷新时间(epoch 毫秒)。 */
    readonly lastSeenAt: number;
    /** 最近已知条目数。 */
    readonly entries: number;
    /** 最近已知文件数。 */
    readonly files: number;
    /** 目录当前是否存在。 */
    readonly exists: boolean;
    /** 文件级明细(目录存在时新鲜扫描;消失时为空)。 */
    readonly filesDetail: readonly RootFileRow[];
}
/** 目录页视图模型(全部根 + 汇总)。 */
export interface RootsView {
    /** 全部已登记根。 */
    readonly roots: readonly RootRow[];
    /** 汇总:根数 / 总条目 / 总文件(按最近已知计数)。 */
    readonly summary: {
        readonly roots: number;
        readonly totalEntries: number;
        readonly totalFiles: number;
    };
}
/** global 页的一条候选(带模型 verdict,供回显;客户端仅回传,不参与判定)。 */
export type GlobalCandidateView = GlobalCandidate;
/** global-extract 两阶段结果:阶段 1 = 候选回显(不写盘),阶段 2 = 确认写盘(服务端重跑 gate)。 */
export interface GlobalExtractView {
    /** 阶段 1:候选(带 verdict)与 gate 结论由客户端逐条展示。 */
    readonly candidates: readonly GlobalCandidate[];
    /** 阶段 2(confirm):写盘汇总。 */
    readonly wrote?: number;
    /** 阶段 2(confirm):被 gate / 去重拒绝的条数。 */
    readonly skipped?: number;
}
/** global-promote 计划回显(确认前;未确认不发调用)。 */
export interface GlobalPromotePlanView {
    /** 提升源条目数(user/project,host 级)。 */
    readonly sourceEntries: number;
    /** 分区后的节点数。 */
    readonly nodeCount: number;
    /** 预计成本(元);价格表缺模型时缺省。 */
    readonly costYuan?: number;
    /** 价格表不可用原因。 */
    readonly costError?: string;
}
/** global-promote 执行结果(确认后)。 */
export interface GlobalPromoteDoneView {
    /** 写入的 global 条目数。 */
    readonly wrote: number;
    /** 被 gate / 去重拒绝的条数。 */
    readonly skipped: number;
}
/** global 导入结果(防线拒绝或导入汇总;镜像 global-io 的返回)。 */
export type GlobalImportView = {
    readonly ok: true;
    readonly imported: number;
    readonly duplicates: number;
    readonly skipped: readonly {
        entry: string;
        reason: string;
    }[];
    readonly errors: readonly string[];
} | {
    readonly ok: false;
    readonly reason: string;
};
/** 面板 RPC 通道的注入依赖(纯接口,由 index.ts 闭包提供)。 */
export interface PanelDeps {
    /** 按过滤条件列出 host 级记忆(注册表视图,带所在文件绝对路径);实现须按 createdAt 降序返回。 */
    entries(filters: PanelFilters): PanelEntryRow[];
    /** 状态页视图模型(status / stats / usage 一次取齐;stats 为 host 级注册表视图)。 */
    dashboard(): DashboardDto;
    /** 目录页视图模型(全部已登记根 + 文件明细)。 */
    roots(): RootsView;
    /** 手动登记一个根;非法路径由实现抛错(折叠为 internal)。 */
    addRoot(root: string): RootsView;
    /** 从注册表移除一个根的登记(不动磁盘);未命中由实现抛错。 */
    forgetRoot(root: string): RootsView;
    /** 导出全部(或单个)根到默认导出目录,返回产物信息。 */
    exportRoots(root: string | undefined): {
        dir: string;
        totalEntries: number;
        rootsExported: number;
    };
    /** 节点状态页视图模型(host 上全部进程;本进程置顶)。 */
    nodes(): ProcessRow[];
    /** 当前配置的设置页描述。 */
    getConfig(): PanelConfigItem[];
    /** 写入配置补丁(经 settings scope 校验与 applyConfig),返回写入后的描述。 */
    setConfig(patch: Record<string, unknown>): Promise<PanelConfigItem[]>;
    /** global 页条目(host 视图 layer=global 过滤)。 */
    globalEntries(): PanelEntryRow[];
    /** 抽取阶段 1:文档文本 → 候选回显(不发写盘;1MiB 已由 RPC 层硬校验)。 */
    globalExtract(text: string): Promise<readonly GlobalCandidate[]>;
    /** 抽取阶段 2:确认写盘(服务端对每条候选重跑 gate + schema 后 append)。 */
    globalExtractConfirm(candidates: readonly GlobalCandidate[]): {
        wrote: number;
        skipped: number;
    };
    /** 提升计划回显(未确认不发调用)。 */
    globalPromotePlan(): GlobalPromotePlanView;
    /** 提升执行(确认后;计划 → fan-out → gate → append)。 */
    globalPromote(): Promise<GlobalPromoteDoneView>;
    /** global 质检(review<global-type1>),返回缺陷数与报告全文。 */
    globalReview(): Promise<{
        findings: number;
        report: string;
    }>;
    /** global 导出包全文(JSON 文本)。 */
    globalExport(): string;
    /** global 导入(防线链 kind→formatVersion→migrate→gate→layer→两轮去重→append)。 */
    globalImport(text: string): GlobalImportView;
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
export declare function handlePanelRpc(endpoint: string, payload: unknown, token: string, deps: PanelDeps): Promise<RpcResult<unknown>>;
