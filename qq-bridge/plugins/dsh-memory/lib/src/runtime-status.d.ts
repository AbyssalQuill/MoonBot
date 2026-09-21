/**
 * 进程运行时状态发布与读取:`~/.dsh/lmemory/runtime/<pid>-<startedAtMs>.json`
 * (纯逻辑,不 import cordis)。设计见 docs/node-status.md。
 *
 * 文件即跨进程协议:每进程只写自己的文件(原子写),读取端列目录聚合;心跳失效
 * 判「已退出」,超龄文件清理。节点运行状态机(空闲/运行中/最近一次)也在此,
 * 供 callFlash 钩子驱动。
 *
 * @module dsh-memory/runtime-status
 */
/** 状态文件格式版本(结构变化时递增;读取端只认格式,不认识则跳过)。 */
export declare const RUNTIME_FORMAT_VERSION = 1;
/** 心跳间隔(毫秒):活进程至少每 15s 写一次,顺带刷新 team 装载快照。 */
export declare const RUNTIME_HEARTBEAT_MS = 15000;
/** 失效阈值(毫秒):lastSeenAt 距今超过 60s 判「已退出」。 */
export declare const RUNTIME_STALE_MS = 60000;
/** 清理阈值(毫秒):超过 24h 无心跳的文件在读取端删除(只可能是死进程残留)。 */
export declare const RUNTIME_PURGE_MS: number;
/** 节点职责分类(与 stats.ts 的 UsageLabel 对应)。 */
export type NodeStatusKey = 'recall' | 'extract' | 'review';
/** 单个节点的运行时状态(状态机只管 running 与最近一次;calls 在快照时由 usage 计数填充)。 */
export interface NodeRuntimeState {
    /** 在飞调用数(并发 fan-out 时可 >1)。 */
    running: number;
    /** 最早一个在飞调用的起始时刻(epoch 毫秒);仅 running > 0 时存在。 */
    runningSince?: number;
    /** 已完成的累计调用次数(状态文件值 = usage 计数;{@link listProcesses} 返回时已加在飞数)。 */
    calls: number;
    /** 最近一次完成的调用起始时刻;0 = 从未调用。 */
    lastAt: number;
    /** 最近一次调用的耗时(毫秒)。 */
    lastDurationMs: number;
    /** 最近一次调用是否成功。 */
    lastOk: boolean;
    /** 最近一次失败的错误文本。 */
    lastError?: string;
}
/** 单个 project root 的预热 team 装载快照。 */
export interface TeamRuntimeRow {
    /** project root;空串 = 无项目 cwd。 */
    root: string;
    /** 节点数。 */
    nodes: number;
    /** 节点文本总字符数。 */
    chars: number;
}
/** 进程运行时状态(状态文件全文;读取端在文件内容上派生 stale / isCurrent)。 */
export interface RuntimeStatus {
    /** 格式版本。 */
    formatVersion: number;
    /** 进程 pid。 */
    pid: number;
    /** 进程启动时刻(epoch 毫秒)。 */
    startedAt: number;
    /** 进程工作目录。 */
    cwd: string;
    /** dsh web 监听端口(web 模式);headless 进程缺省。 */
    port?: number;
    /** 最近一次心跳(epoch 毫秒)。 */
    lastSeenAt: number;
    /** 已预热 team(按 root)。 */
    teams: readonly TeamRuntimeRow[];
    /** system prompt 摘要文本字符数。 */
    summaryChars: number;
    /** 3 类节点的运行状态。 */
    nodes: Record<NodeStatusKey, NodeRuntimeState>;
}
/** 面板进程行:状态文件内容 + 读取端派生字段。 */
export interface ProcessRow extends RuntimeStatus {
    /** 心跳是否已失效(进程已退出或崩溃)。 */
    stale: boolean;
    /** 是否为当前进程。 */
    isCurrent: boolean;
}
/** 运行时状态目录(用户 lmemory 根内,随用户根一起备份)。 */
export declare function runtimeDir(): string;
/** 某进程的状态文件路径。 */
export declare function runtimeFilePath(pid: number, startedAt: number): string;
/** 空的节点状态表。 */
export declare function createNodeStates(): Record<NodeStatusKey, NodeRuntimeState>;
/**
 * 标记一次节点调用开始:running +1;首个在飞调用记录 runningSince。
 * @param states - 节点状态表。
 * @param key - 节点职责。
 * @param now - 起始时刻(测试注入)。
 */
export declare function beginNode(states: Record<NodeStatusKey, NodeRuntimeState>, key: NodeStatusKey, now: number): void;
/**
 * 标记一次节点调用结束:running -1(不为负),记录最近一次的时间 / 耗时 / 成败。
 * @param states - 节点状态表。
 * @param key - 节点职责。
 * @param startAt - 该次调用的起始时刻。
 * @param now - 结束时刻(测试注入)。
 * @param error - 失败错误文本;成功缺省。
 */
export declare function endNode(states: Record<NodeStatusKey, NodeRuntimeState>, key: NodeStatusKey, startAt: number, now: number, error?: string): void;
/**
 * 原子写状态文件(临时文件 + rename;目录不存在时创建)。
 * @param status - 要落盘的状态。
 */
export declare function publishRuntime(status: RuntimeStatus): void;
/** 删除本进程的状态文件(dispose 时调用;文件不存在则静默)。 */
export declare function removeRuntimeFile(pid: number, startedAt: number): void;
/**
 * 读取全部进程的运行状态:清理超龄文件、标记失效、把在飞调用计入累计 calls、
 * 排序(本进程 → 在线按启动时间倒序 → 已退出按最后心跳倒序)。
 * @param now - 读取时刻(测试注入)。
 * @param currentPid - 当前进程 pid(测试注入;缺省 process.pid)。
 * @returns 进程行列表(calls 含在飞调用数)。
 */
export declare function listProcesses(now?: number, currentPid?: number): ProcessRow[];
