/**
 * `/lmemory` 命令的参数解析(纯函数)。
 *
 * 子命令:status / stats / usage [--days N] / ui / team start|stop|restart /
 * query <text> / config get|set / review [layer|domain] / catalog rebuild [--root] /
 * global extract|promote|review / collections list|add|forget|export / pricing / help。
 * 解析只做词法切分,不校验配置键语义(交给 index.ts 的 handler)。
 * @module dsh-memory/command
 */
import type { DomainId, LayerId } from './schema.js';
/** `/lmemory review` 的可选限定(按落点层或知识领域缩小质检范围)。 */
export type ReviewFilter = {
    readonly kind: 'layer';
    readonly value: LayerId;
} | {
    readonly kind: 'domain';
    readonly value: DomainId;
};
/** `/lmemory` 命令的解析结果。 */
export type LmemoryCommand = {
    readonly kind: 'help';
    readonly topic?: string;
} | {
    readonly kind: 'status';
} | {
    readonly kind: 'stats';
} | {
    readonly kind: 'usage';
    readonly days?: number;
} | {
    readonly kind: 'ui';
} | {
    readonly kind: 'team';
    readonly action: 'start' | 'stop' | 'restart';
} | {
    readonly kind: 'query';
    readonly text: string;
} | {
    readonly kind: 'config-get';
    readonly key?: string;
} | {
    readonly kind: 'config-set';
    readonly key: string;
    readonly value: string;
} | {
    readonly kind: 'review';
    readonly filter?: ReviewFilter;
} | {
    readonly kind: 'catalog';
    readonly root?: string;
} | {
    readonly kind: 'global';
    readonly action: 'extract' | 'promote' | 'review';
    readonly file?: string;
    readonly dryRun?: boolean;
    readonly confirm?: boolean;
} | {
    readonly kind: 'pricing';
} | {
    readonly kind: 'collections';
    readonly action: 'list' | 'add' | 'forget' | 'export';
    readonly root?: string;
    readonly outDir?: string;
    readonly roots?: readonly string[];
};
/** 命令用法回显文案。 */
export declare const USAGE = "Usage: /lmemory status | stats | usage [--days N] | ui | team start|stop|restart | query <text> | config get|set <key> [value] | review [layer|domain] | catalog rebuild [--root <path>] | global extract <file> [--dry-run|--confirm] | global promote [--confirm] | global review | collections list|add <root>|forget <root>|export [--out <dir>] [--root <path>...] | pricing | help [command]";
/** 一条子命令的帮助详情(供 `/lmemory help [command]`)。 */
export interface CommandHelp {
    /** 一行用法(不含 `/lmemory` 前缀)。 */
    readonly usage: string;
    /** 一句话说明。 */
    readonly summary: string;
    /** 详细说明行(参数、行为、示例)。 */
    readonly details: readonly string[];
}
/** 全部子命令的帮助(键 = 子命令名;命令契约的单一真相源)。 */
export declare const COMMAND_HELPS: ReadonlyMap<string, CommandHelp>;
/**
 * 渲染 `/lmemory help`(无 topic = 全部命令一览)或 `/lmemory help <topic>`(单命令详情)。
 * @param topic - 子命令名;缺省渲染全部命令一览。
 * @returns 帮助文本。
 */
export declare function renderHelp(topic?: string): string;
/**
 * 解析 `/lmemory` 命令参数。
 * @param rawInput - 命令名之后的原始文本(含前导空白)。
 * @returns 解析结果;无法识别时回退为 `help`。
 */
export declare function parseLmemoryCommand(rawInput: string): LmemoryCommand;
