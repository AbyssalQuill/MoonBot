/**
 * `/lmemory` 命令的参数解析(纯函数)。
 *
 * 子命令:status / stats / usage [--days N] / ui / team start|stop|restart /
 * query <text> / config get|set / review [layer|domain] / catalog rebuild [--root] /
 * global extract|promote|review / collections list|add|forget|export / pricing / help。
 * 解析只做词法切分,不校验配置键语义(交给 index.ts 的 handler)。
 * @module dsh-memory/command
 */
import { DOMAINS, LAYERS } from './schema.js';
/** 命令用法回显文案。 */
export const USAGE = 'Usage: /lmemory status | stats | usage [--days N] | ui | team start|stop|restart | query <text> | config get|set <key> [value] | review [layer|domain] | catalog rebuild [--root <path>] | global extract <file> [--dry-run|--confirm] | global promote [--confirm] | global review | collections list|add <root>|forget <root>|export [--out <dir>] [--root <path>...] | pricing | help [command]';
/** 全部子命令的帮助(键 = 子命令名;命令契约的单一真相源)。 */
export const COMMAND_HELPS = new Map([
    ['status', {
            usage: 'status',
            summary: '查看记忆节点 team 状态(节点数、预热状态)。',
            details: [
                '行为:列出每个 project root 的已预热节点数;无预热 team 时只显示 maxNodeKb。',
                '示例:/lmemory status',
            ],
        }],
    ['stats', {
            usage: 'stats',
            summary: '记忆统计:条目数、layer / domain 分布、文件字节、catalog 条目数。',
            details: [
                '行为:纯文件读,不发模型调用;统计当前 cwd 可见的全部记忆(内置 < 用户 < 项目)。',
                '示例:/lmemory stats',
            ],
        }],
    ['usage', {
            usage: 'usage [--days N]',
            summary: 'token 用量:实时视图 + 持久化日志的每日聚合。',
            details: [
                '无参:预热 team 与 system prompt 摘要的上下文成本估算 + 本进程 LLM 调用消耗(重启归零)。',
                '--days N(1..90):按 usage.jsonl 持久化日志聚合近 N 天,按 recall / extract / review 分类(重启不丢)。',
                '示例:/lmemory usage --days 14',
            ],
        }],
    ['ui', {
            usage: 'ui',
            summary: '打开记忆 Web 面板全部五个页面(记忆/状态/目录/节点/设置),返回带访问 token 的链接。',
            details: [
                '行为:仅在 web 模式(webServer + connection 服务存在)可用;token 随进程启动重新生成。',
                '示例:/lmemory ui',
            ],
        }],
    ['team', {
            usage: 'team start|stop|restart',
            summary: '记忆节点 team 的生命周期管理。',
            details: [
                'start:组装(预热)team;stop:释放全部 team;restart:释放后重新组装当前项目 team。',
                '示例:/lmemory team start',
            ],
        }],
    ['query', {
            usage: 'query <text>',
            summary: '人主动召回长期记忆(fan-out 同 recall 工具,返回完整字段)。',
            details: [
                '行为:预热 team → fan-out → 按 id 去重 → 重排序 → 逆查真相源补全字段。',
                '示例:/lmemory query 依赖管理',
            ],
        }],
    ['review', {
            usage: 'review [layer|domain]',
            summary: '用 deepseek-v4-pro 质检记忆,发现矛盾/重复/过时/背离,报告注入主会话。',
            details: [
                '可选限定:layer(global / user / project)或 domain(21 枚举之一);无参质检全部可见记忆。',
                '示例:/lmemory review project',
            ],
        }],
    ['catalog', {
            usage: 'catalog rebuild [--root <path>]',
            summary: '从全部 jsonl 重建 catalog(派生索引)。',
            details: [
                '行为:默认全量重写用户层 + 当前项目层的 catalog.json;真相源仍是 jsonl;内置层只读,不重建。',
                '--root <path>:只重建给定记忆根目录(显式指定即重建,含 global 目录;docs/global-layer-design.md §5.5)。',
                '示例:/lmemory catalog rebuild',
                '示例:/lmemory catalog rebuild --root ~/.dsh/lmemory/global',
            ],
        }],
    ['global', {
            usage: 'global extract <file> [--dry-run|--confirm] | promote [--confirm] | review',
            summary: 'global 记忆入口:文档抽取 / 提升评审 / 质检(docs/global-layer-design.md)。',
            details: [
                'extract <file>:读本地文档(≤1MiB)交 extract<global-type1> 小队抽取,回显候选 + gate 结论;--dry-run 只回显不写盘;--confirm 命中暂存零调用写盘,否则重跑管线写盘。',
                'promote:review<global-type2> 小队对全部 user/project 记忆严格评估并总结提炼为 global 候选;先回显预估节点数与成本,--confirm 才执行(未确认不发调用)。',
                'review:review<global-type1> 小队质检 global 目录条目,报告注入主会话。',
                '相对路径:文档路径相对进程工作目录;global 条目的 entryPoint/references 相对来源 workspace 根解释。',
                '示例:/lmemory global extract ~/docs/guide.md --dry-run',
                '示例:/lmemory global promote --confirm',
            ],
        }],
    ['pricing', {
            usage: 'pricing',
            summary: '打印价格表全文与文件路径(成本估算的计价依据,CNY 每百万 tokens)。',
            details: [
                '行为:列出每个模型每个生效时段的价格(含峰谷价与来源);成本不落盘,改表后自动重算。',
                '价格表: ~/.dsh/lmemory/pricing.json(缺失时用内置种子创建;损坏时报错)。',
                '示例:/lmemory pricing',
            ],
        }],
    ['collections', {
            usage: 'collections list|add <root>|forget <root>|export [--out <dir>] [--root <path>...]',
            summary: '记忆根的整体管理与记忆包导出(注册表 + 备份分享)。',
            details: [
                'list:刷新并列出 host 上全部已登记记忆根(路径 / 类型 / 条目数 / 文件数 / 最近可见时间)。',
                'add <root>:手动登记一个 lmemory 根(须含记忆文件或为空目录);forget <root>:从注册表移除(不动数据)。',
                'export:把全部(或 --root 选定)记忆根合并导出到 --out(缺省 ~/dsh-memory-exports/),manifest.json + roots/ 直拷真相源。',
                '示例:/lmemory collections list',
                '示例:/lmemory collections export --out ~/memory-backup --root /Users/me/proj/.dsh/lmemory',
            ],
        }],
    ['config', {
            usage: 'config get|set <key> [value]',
            summary: '读写配置项(maxNodeKb / recallTopK / extractMode / 提示词等)。',
            details: [
                'get 不带 key 列出全部配置;set 写单个键并即时生效。',
                '示例:/lmemory config get extractMode',
            ],
        }],
    ['help', {
            usage: 'help [command]',
            summary: '显示全部命令用法,或单个子命令的详细帮助。',
            details: ['示例:/lmemory help stats'],
        }],
]);
/**
 * 渲染 `/lmemory help`(无 topic = 全部命令一览)或 `/lmemory help <topic>`(单命令详情)。
 * @param topic - 子命令名;缺省渲染全部命令一览。
 * @returns 帮助文本。
 */
export function renderHelp(topic) {
    if (topic === undefined) {
        const lines = [USAGE, '', 'Commands:'];
        for (const [name, help] of COMMAND_HELPS)
            lines.push(`  ${name.padEnd(9)}${help.summary}`);
        lines.push('', '详细帮助:/lmemory help <command>');
        return lines.join('\n');
    }
    const help = COMMAND_HELPS.get(topic);
    if (help === undefined)
        return `Unknown command "${topic}". Run /lmemory help for the command list.`;
    return [`/lmemory ${help.usage}`, '', help.summary, ...help.details.map(detail => `  ${detail}`)].join('\n');
}
/**
 * 解析 `/lmemory` 命令参数。
 * @param rawInput - 命令名之后的原始文本(含前导空白)。
 * @returns 解析结果;无法识别时回退为 `help`。
 */
export function parseLmemoryCommand(rawInput) {
    const parts = rawInput.trim().split(/\s+/).filter(part => part.length > 0);
    const head = parts[0]?.toLowerCase() ?? '';
    if (head === '' || head === 'help') {
        const topic = parts[1]?.toLowerCase();
        return topic === undefined ? { kind: 'help' } : { kind: 'help', topic };
    }
    if (head === 'status')
        return { kind: 'status' };
    if (head === 'stats')
        return { kind: 'stats' };
    if (head === 'usage') {
        if (parts[1]?.toLowerCase() === '--days' && parts[2] !== undefined && /^\d+$/.test(parts[2])) {
            return { kind: 'usage', days: Number(parts[2]) };
        }
        return { kind: 'usage' };
    }
    if (head === 'ui')
        return { kind: 'ui' };
    if (head === 'team') {
        const action = parts[1]?.toLowerCase();
        if (action === 'start' || action === 'stop' || action === 'restart')
            return { kind: 'team', action };
        return { kind: 'help' };
    }
    if (head === 'query') {
        return { kind: 'query', text: parts.slice(1).join(' ') };
    }
    if (head === 'config') {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'set' && parts[2] !== undefined && parts[3] !== undefined) {
            return { kind: 'config-set', key: parts[2], value: parts.slice(3).join(' ') };
        }
        if (sub === 'get')
            return { kind: 'config-get', key: parts[2] };
        if (sub === undefined)
            return { kind: 'config-get' };
        return { kind: 'help' };
    }
    if (head === 'review') {
        const token = parts[1];
        if (token === undefined)
            return { kind: 'review' };
        const layer = token.toLowerCase();
        if (LAYERS.includes(layer)) {
            return { kind: 'review', filter: { kind: 'layer', value: layer } };
        }
        if (DOMAINS.includes(token)) {
            return { kind: 'review', filter: { kind: 'domain', value: token } };
        }
        return { kind: 'help' };
    }
    if (head === 'catalog' && parts[1]?.toLowerCase() === 'rebuild') {
        if (parts[2]?.toLowerCase() === '--root' && parts[3] !== undefined) {
            return { kind: 'catalog', root: parts.slice(3).join(' ') };
        }
        return { kind: 'catalog' };
    }
    if (head === 'global') {
        const action = parts[1]?.toLowerCase();
        const flags = parts.slice(2).filter(part => part.startsWith('--'));
        if (action === 'extract') {
            const file = parts.slice(2).filter(part => !part.startsWith('--')).join(' ');
            if (file.length === 0)
                return { kind: 'help' };
            return {
                kind: 'global',
                action: 'extract',
                file,
                ...(flags.includes('--dry-run') ? { dryRun: true } : {}),
                ...(flags.includes('--confirm') ? { confirm: true } : {}),
            };
        }
        if (action === 'promote') {
            return { kind: 'global', action: 'promote', ...(flags.includes('--confirm') ? { confirm: true } : {}) };
        }
        if (action === 'review')
            return { kind: 'global', action: 'review' };
        return { kind: 'help' };
    }
    if (head === 'pricing' && parts.length === 1) {
        return { kind: 'pricing' };
    }
    if (head === 'collections') {
        const action = parts[1]?.toLowerCase();
        if (action === undefined || action === 'list')
            return { kind: 'collections', action: 'list' };
        if (action === 'add' && parts[2] !== undefined)
            return { kind: 'collections', action: 'add', root: parts.slice(2).join(' ') };
        if (action === 'forget' && parts[2] !== undefined)
            return { kind: 'collections', action: 'forget', root: parts.slice(2).join(' ') };
        if (action === 'export') {
            let outDir;
            const roots = [];
            for (let i = 2; i < parts.length; i++) {
                const token = parts[i];
                if (token === '--out' && parts[i + 1] !== undefined) {
                    outDir = parts[i + 1];
                    i += 1;
                }
                else if (token === '--root' && parts[i + 1] !== undefined) {
                    roots.push(parts[i + 1]);
                    i += 1;
                }
            }
            return { kind: 'collections', action: 'export', ...(outDir !== undefined ? { outDir } : {}), ...(roots.length > 0 ? { roots } : {}) };
        }
        return { kind: 'help' };
    }
    return { kind: 'help' };
}
