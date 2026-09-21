/**
 * dsh-memory 插件入口:把「长期记忆(Long-Term Memory)」接到 dsh 的接缝上。
 *
 * 接缝(设计文档 §2):
 *   - `ctx.tools.register` 暴露 remember / recall / forget 三个模型工具。
 *   - `ctx.llm.stream` 用 `deepseek-v4-flash` 做记忆节点 team 召回。
 *   - `ctx.systemPrompt.section` 注入「已知记忆」摘要(order 10)。
 *   - `ctx.commands.register` 提供 `/lmemory` 管理命令。
 *   - `ctx.settings` 存 maxNodeKb / recallTopK / rerankPrompt / warmupOnStart 等配置。
 *   - web 模式下经 `webServer.register` + `connection.rpc.handle` 挂记忆 Web 面板
 *     (`/memory` 及 /status、/collections、/nodes、/settings 五页 + `/memory-api`
 *     RPC channel,见 ./web-ui/ui.js)。
 *
 * 与 session-reference 的边界:session-reference 管「整段历史会话快照」,本插件管
 * 「提炼的、跨会话累积的语义事实」(只含 rules/lessons 两类)。所有注册都是
 * ctx.effect,随 fiber 自动销毁;纯逻辑下沉到不 import cordis 的模块。
 * @module @meomeo-dev/dsh-memory
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as __dshSettings from '@deepseek-ai/dsh-settings';
/** qq-bridge 兼容补丁：dsh 0.1.2 起 dsh-settings 不再导出 settingsNamespace（改用普通字符串做命名空间）。 */
const settingsNamespace = typeof __dshSettings.settingsNamespace === 'function' ? __dshSettings.settingsNamespace : (ns) => ns;
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DOMAINS } from './schema.js';
import { formatCreatedAt, renderMemorySummary } from './render.js';
import { builtinMemoryDir, discoverEntries, discoverGlobalEntries, migrateLegacyGlobalEntries, migrateLegacyMemoryDirs, resolveRecalled, visibleGlobalDir } from './memory-file.js';
import { append, find, findIn, rebuild, remove, removeByEntry, update } from './store.js';
import { recall as recallTeam } from './team.js';
import { parseFindings, renderReviewReport, reviewEntryLine, reviewTeam, runReview, } from './review.js';
import { assertDeletable, requireMemoryId } from './tool-guard.js';
import { CONFIG_KEYS, createRuntimeState, DEFAULT_CONFIG, EXTRACT_MODES, ensureTeam, restartTeam, stopTeams, SUMMARY_MODES, teamStatus, } from './memory-runtime.js';
import { annealError, annealTurnStopping, buildTranscript, containsSignalWord, deriveLayer, extractBoth, filterNovel, isTranscriptTooShort, parseSignalWords, } from './extract.js';
import { computeStats, computeStatsIn, EMPTY_USAGE, estimateTokens, recordUsage } from './stats.js';
import { aggregateByDay, aggregateByHour, aggregateWindowTotals, appendUsageRow, readUsageRows } from './usage-log.js';
import { costFor, estimateDailyCosts, estimateHourlyCosts, estimatePromoteCost, estimateWindowCosts, loadPricing, pricingPath } from './pricing.js';
import { checkGlobalGate, GLOBAL_DOC_MAX_BYTES, GLOBAL_EXTRACT_LESSONS_SYSTEM, GLOBAL_EXTRACT_RULES_SYSTEM, GLOBAL_PROMOTE_SYSTEM, globalExtractSources, promoteSourceEntries, resolvePromotePlan, runGlobalExtractFanOut, runGlobalPromoteFanOut, } from './global-gate.js';
import { buildGlobalExport, importGlobalEntries, parseGlobalExport } from './global-io.js';
import { aggregateEntryActivity } from './memory-activity.js';
import { RUNTIME_HEARTBEAT_MS, beginNode, createNodeStates, endNode, listProcesses, publishRuntime, removeRuntimeFile, } from './runtime-status.js';
import { COMMAND_HELPS, USAGE, parseLmemoryCommand, renderHelp } from './command.js';
import { exportCollections } from './collections.js';
import { forgetRoot, isMemoryRoot, loadRegistry, refreshRegistry, registerExplicitRoot, scanRootDetail } from './registry.js';
import { PANEL_CHANNEL, assetContentType, describeConfig, findPanelDist, generatePanelToken, handlePanelRpc, matchesPanelQuery, panelUrl, queryToken, readPanelAsset, renderPanelShell, resolvePanelAsset, safeTokenEqual, } from './web-ui/ui.js';
/** Stable Cordis plugin name. */
export const name = 'dsh-memory';
/** 插件挂载所需服务。 */
export const inject = ['systemPrompt', 'tools', 'commands', 'llm'];
/** 用户可写设置命名空间。 */
const NAMESPACE = settingsNamespace('memory');
/** 该命名空间的 schema(缺省回退到 {@link DEFAULT_CONFIG})。 */
const SCHEMA = z.object({
    maxNodeKb: z.number().step(1).min(1).default(DEFAULT_CONFIG.maxNodeKb),
    recallTopK: z.number().step(1).min(1).default(DEFAULT_CONFIG.recallTopK),
    rerankPrompt: z.string().min(1).default(DEFAULT_CONFIG.rerankPrompt),
    warmupOnStart: z.boolean().default(DEFAULT_CONFIG.warmupOnStart),
    provider: z.string().min(1).default(DEFAULT_CONFIG.provider),
    model: z.string().min(1).default(DEFAULT_CONFIG.model),
    reviewModel: z.string().min(1).default(DEFAULT_CONFIG.reviewModel),
    autoExtract: z.boolean().default(DEFAULT_CONFIG.autoExtract),
    extractMode: z.union([...EXTRACT_MODES]).default(DEFAULT_CONFIG.extractMode),
    extractInterval: z.number().step(1).min(1).default(DEFAULT_CONFIG.extractInterval),
    signalWords: z.string().default(DEFAULT_CONFIG.signalWords),
    extractRulesPrompt: z.string().min(1).default(DEFAULT_CONFIG.extractRulesPrompt),
    extractLessonsPrompt: z.string().min(1).default(DEFAULT_CONFIG.extractLessonsPrompt),
    summaryMode: z.union([...SUMMARY_MODES]).default(DEFAULT_CONFIG.summaryMode),
});
/** 召回节点 system prompt(固定,非配置项)。 */
const NODE_RECALL_SYSTEM = '你是长期记忆召回节点。给定一组记忆条目(每条一行,格式 `[id|type|domain|scope] 条目文本`)与一个查询,仅返回与查询相关的条目的**整行**(含方括号前缀),一行一条,照抄原文,不返回任何解释。无相关条目时返回空。';
/** 把模型输出文本按行拆成条目(轻量去前缀)。 */
function parseLines(text) {
    return text.split('\n')
        .map(line => line.trim())
        .map(line => line.replace(/^[-*•]\s*/, ''))
        .map(line => line.replace(/^\d+[.)]\s*/, ''))
        .map(line => line.trim())
        .filter(line => line.length > 0);
}
/**
 * 发一次轻量模型调用(召回用 v4-flash、质检用 v4-pro),返回聚合文本,并把
 * usage 累计进对应职责分类的计数器(供 `/lmemory usage`)。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(取配置 + usage 累计)。
 * @param system - system prompt 文本。
 * @param prompt - 用户消息文本。
 * @param label - 职责分类(recall / extract / review)。
 * @param model - 覆盖模型 id;缺省用 `config.model`。
 */
async function callFlash(ctx, runtime, system, prompt, label, model = runtime.config.model) {
    const message = createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-memory' },
        content: [{ type: 'text', text: prompt }],
    });
    // 节点运行状态:开始即发布(节点页可见「运行中」),结束(含失败)再发布。
    const startedAt = Date.now();
    beginNode(runtime.nodes, label, startedAt);
    runtime.publish(startedAt);
    let text = '';
    let lastUsage;
    try {
        for await (const chunk of ctx.llm.stream({
            provider: runtime.config.provider,
            model,
            system,
            messages: [message],
        })) {
            if (chunk.type === 'text-delta')
                text += chunk.text;
            else if (chunk.type === 'usage') {
                runtime.usage.set(label, recordUsage(runtime.usage.get(label) ?? EMPTY_USAGE, chunk.usage));
                // 一次调用聚合为一行持久化日志(流式通常只发一个 usage chunk,取最后一次)。
                lastUsage = {
                    ts: Date.now(),
                    label,
                    inputTokens: chunk.usage.inputTokens,
                    outputTokens: chunk.usage.outputTokens,
                    cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
                    // 计价键:成本估算按行携带的模型 id 查价(旧行无此字段,读取端按 label 回退)。
                    model,
                };
            }
            else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                throw new Error(`memory recall call failed: ${chunk.reason.failure.message}`);
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        endNode(runtime.nodes, label, startedAt, Date.now(), message);
        // 失败调用也落 usage.jsonl:usage chunk 已到账,持久化日志与进程内计数器同口径,
        // 否则 `/lmemory usage --days` 与状态页每日图对失败调用永久少计。
        if (lastUsage !== undefined)
            appendUsageRow(lastUsage);
        runtime.publish();
        throw error;
    }
    if (lastUsage !== undefined)
        appendUsageRow(lastUsage);
    endNode(runtime.nodes, label, startedAt, Date.now());
    runtime.publish();
    return text;
}
/** 节点失败告警(per-node 容错的可观测性;绑定 ctx.logger.warn,不中断流程)。 */
function warnNode(ctx, label, error) {
    ctx.logger.warn(`dsh-memory: ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
}
/**
 * host 级记忆视图的目录列表:内置层 + 注册表中仍存在的全部根。
 * 面板(记忆页 / 状态页统计)与目录页从此共用一个数据源(注册表);
 * 会话级可见记忆(模型工具 / /lmemory 命令)仍走 cwd 视图。
 * @returns 记忆目录绝对路径列表(去重,不存在的根跳过)。
 */
function hostMemoryDirs() {
    const dirs = [builtinMemoryDir()];
    for (const entry of loadRegistry().roots) {
        if (existsSync(entry.root))
            dirs.push(entry.root);
    }
    // global 目录显式追加(存在才计入;Set 去重 registry 已登记的情形)——写盘后
    // 无需等下一次 refreshRegistry 即对面板 host 视图可见(docs/global-layer-design.md §5.2)。
    const globalDir = visibleGlobalDir();
    if (existsSync(globalDir))
        dirs.push(globalDir);
    return [...new Set(dirs)];
}
/**
 * 组装本进程运行时状态快照(身份 + team 装载 + 摘要体积 + 3 类节点状态),
 * 落盘到 `~/.dsh/lmemory/runtime/<pid>-<startedAt>.json`(docs/node-status.md)。
 * @param runtime - 运行时状态。
 * @param pid - 本进程 pid。
 * @param startedAt - 本进程启动时刻。
 * @param now - 快照时刻。
 * @returns 状态文件内容。
 */
function snapshotRuntime(runtime, pid, startedAt, now) {
    const teams = [];
    for (const [root, team] of runtime.state.teams) {
        let chars = 0;
        for (const node of team.nodes)
            chars += node.text.length;
        teams.push({ root, nodes: team.nodes.length, chars });
    }
    const labels = ['recall', 'extract', 'review'];
    const nodes = { recall: runtime.nodes.recall, extract: runtime.nodes.extract, review: runtime.nodes.review };
    return {
        formatVersion: 1,
        pid,
        startedAt,
        cwd: process.cwd(),
        ...(runtime.port === undefined ? {} : { port: runtime.port }),
        lastSeenAt: now,
        teams,
        summaryChars: summaryText(runtime.config, process.cwd()).length,
        nodes: {
            recall: { ...nodes.recall, calls: runtime.usage.get(labels[0])?.calls ?? 0 },
            extract: { ...nodes.extract, calls: runtime.usage.get(labels[1])?.calls ?? 0 },
            review: { ...nodes.review, calls: runtime.usage.get(labels[2])?.calls ?? 0 },
        },
    };
}
/** 执行一次召回:预热 team → fan-out → 聚合(整行)→ 按 id 逆查补全字段。 */
async function doRecall(ctx, runtime, cwd, query) {
    const team = ensureTeam(runtime.state, cwd, runtime.config);
    const nodeFn = async (node, q) => {
        const response = await callFlash(ctx, runtime, NODE_RECALL_SYSTEM, `记忆条目:\n${node.text}\n\n查询:${q}`, 'recall');
        return parseLines(response);
    };
    const rerankFn = async (q, candidates) => {
        const response = await callFlash(ctx, runtime, runtime.config.rerankPrompt, `查询:${q}\n\n候选条目:\n${candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`, 'recall');
        const ordered = parseLines(response);
        return ordered.length > 0 ? ordered : candidates;
    };
    const lines = await recallTeam(team, query, nodeFn, rerankFn, runtime.config.recallTopK, (nodeId, error) => warnNode(ctx, `recall node ${nodeId}`, error));
    return resolveRecalled(cwd, lines);
}
/** 质检节点 system prompt(固定,非配置项;只输出 JSON 数组)。 */
const NODE_REVIEW_SYSTEM = '你是长期记忆质检员。给定一组记忆条目(每条一行,格式 `[id|type|domain|scope] 条目文本`),批判性审查,找出其中的缺陷,只输出一个 JSON 数组,不要输出任何解释。四类缺陷:contradiction(两条记忆互相矛盾)、duplicate(同义记忆重复)、outdated(被新事实推翻的过时结论)、divergence(与当前项目状态背离)。每个元素形如 {"id":"目标记忆 id","problem":"contradiction|duplicate|outdated|divergence","related":["关联记忆 id"],"note":"一句话描述","suggest":"update|delete|merge","suggestedEntry":"建议新条目文本(可选)"}。contradiction/duplicate 需填 related;outdated/divergence 通常单条(related 为空数组)。id/related 必须照抄给定条目的 id,不得编造。无缺陷时输出 []。';
/** 质检跨节点 system prompt(只判矛盾/重复,只输出 JSON 数组)。 */
const CROSS_NODE_REVIEW_SYSTEM = '你是长期记忆质检员。给定全部记忆条目(每条一行,格式 `[id|type|domain|scope] 条目文本`),这些条目可能原本分在不同分组,现在合并到一起。找出跨条目的矛盾(contradiction)与重复(duplicate),只输出一个 JSON 数组,不要输出任何解释。每个元素形如 {"id":"目标记忆 id","problem":"contradiction|duplicate","related":["关联记忆 id"],"note":"一句话描述","suggest":"update|delete|merge","suggestedEntry":"可选"}。id/related 必须照抄给定条目的 id,不得编造。无缺陷时输出 []。';
/**
 * 执行一次质检:读全部可见记忆 → 带 id 分区 → v4-pro fan-out + 跨节点聚合。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(team + 配置)。
 * @param cwd - 当前工作目录。
 * @param filter - 可选限定(按 layer / domain 缩小质检范围)。
 * @returns 聚合去重后的缺陷发现。
 */
async function doReview(ctx, runtime, cwd, filter) {
    let entries = discoverEntries(cwd);
    if (filter?.kind === 'layer')
        entries = entries.filter(entry => entry.layer === filter.value);
    else if (filter?.kind === 'domain')
        entries = entries.filter(entry => entry.domain === filter.value);
    return reviewEntries(ctx, runtime, entries);
}
/**
 * 在给定条目集上执行 review 质检(user/project 域经 {@link doReview} 注入可见链,
 * global 域经 review<global-type1> 注入 global 目录条目;review.ts 零改动复用)。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态。
 * @param entries - 质检域条目。
 * @returns 缺陷发现。
 */
async function reviewEntries(ctx, runtime, entries) {
    if (entries.length === 0)
        return [];
    const team = reviewTeam(entries, runtime.config.maxNodeKb);
    const knownIds = new Set(entries.map(entry => entry.id));
    const nodeReviewFn = async (node) => {
        const response = await callFlash(ctx, runtime, NODE_REVIEW_SYSTEM, `记忆条目:\n${node.text}`, 'review', runtime.config.reviewModel);
        return parseFindings(response, knownIds);
    };
    const crossNodeReviewFn = async (allEntries) => {
        const text = allEntries.map(reviewEntryLine).join('\n');
        const response = await callFlash(ctx, runtime, CROSS_NODE_REVIEW_SYSTEM, `记忆条目:\n${text}`, 'review', runtime.config.reviewModel);
        return parseFindings(response, knownIds);
    };
    return runReview(team, entries, nodeReviewFn, crossNodeReviewFn, (nodeId, error) => warnNode(ctx, `review ${nodeId}`, error));
}
/** 从一条消息的 content blocks 提取纯文本(只取 text 块,跳过 reasoning/tool/图片)。 */
function blockText(block) {
    switch (block.type) {
        case 'text':
            return block.text;
        // reasoning / image / tool-call / tool-result 不含面向会话的正文;抽取器只看对话文本。
        default:
            return '';
    }
}
/** 从一组 content blocks 提取纯文本(拼接非空 text 块,供信号词匹配)。 */
function blocksText(blocks) {
    return blocks.map(blockText).filter(chunk => chunk.length > 0).join(' ');
}
/** 把 `deriveMessages()` 的结果投影成抽取器输入(role + 文本,过滤空文本消息)。 */
function toTranscript(messages) {
    const result = [];
    for (const message of messages) {
        const text = message.content.map(blockText).filter(chunk => chunk.length > 0).join(' ');
        if (text.length === 0)
            continue;
        result.push({ role: message.role, text });
    }
    return result;
}
/**
 * 执行一次自动提取:主会话上下文 fan-out 两个抽取节点 → 写盘(走 store)。
 *
 * 抽取器不调 remember 工具,直接调共享存储层;layer 由会话推导,scope/domain/entry
 * 由抽取器输出(docs/auto-extraction.md §5.5/§5.6)。lessons 先按 entry 与已有记忆
 * 去重再追加,rules 重复由 store.append 的 duplicate 拒绝兜底。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(配置)。
 * @param session - 触发抽取的会话(取上下文与 cwd;agent.id 与 session.id 同值)。
 */
async function runExtraction(ctx, runtime, session) {
    const cwd = session.header.cwd;
    if (cwd === undefined)
        return;
    const transcript = buildTranscript(toTranscript(session.deriveMessages()));
    // 空/近空 transcript 守卫:不发 LLM 调用(docs/auto-extraction.md §11 A)。
    if (isTranscriptTooShort(transcript))
        return;
    const rulesFn = text => callFlash(ctx, runtime, runtime.config.extractRulesPrompt, text, 'extract');
    const lessonsFn = text => callFlash(ctx, runtime, runtime.config.extractLessonsPrompt, text, 'extract');
    const result = await extractBoth(transcript, rulesFn, lessonsFn, (type, error) => warnNode(ctx, `extract ${type}`, error));
    const layer = deriveLayer(cwd);
    const existingLessons = new Set(find(cwd, { type: 'lessons' }).map(found => found.entry.entry));
    for (const candidate of result.rules) {
        append(cwd, {
            type: 'rules', domain: candidate.domain, scope: candidate.scope, layer, entry: candidate.entry,
            ...(candidate.entryPoint === undefined ? {} : { entryPoint: candidate.entryPoint }),
            ...(candidate.references === undefined ? {} : { references: candidate.references }),
        });
    }
    for (const candidate of filterNovel(result.lessons, existingLessons)) {
        append(cwd, {
            type: 'lessons', domain: candidate.domain, scope: candidate.scope, layer, entry: candidate.entry,
            ...(candidate.entryPoint === undefined ? {} : { entryPoint: candidate.entryPoint }),
            ...(candidate.references === undefined ? {} : { references: candidate.references }),
        });
    }
    // 提取写盘后刷新注册表计数:项目根可能在 session-start 时尚不存在
    // (提取是异步的),此处目录已创建,补登并更新 entries/files。
    refreshRegistry(cwd);
}
/** 读进程级退火冷却计数器(缺省 0;全部会话/agent 共享,docs/auto-extraction.md §11 B)。 */
function turnsSince(runtime) {
    return runtime.annealing;
}
/** 触发一次抽取(后台 fire-and-forget,吞掉错误避免未处理拒绝)。 */
function scheduleExtraction(ctx, runtime, session) {
    void runExtraction(ctx, runtime, session).catch((error) => {
        ctx.logger.warn(`dsh-memory auto-extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}
/** 形态守卫:仅当 `autoExtract` 开启且命中指定形态时放行。 */
function extractEnabled(config, mode) {
    return config.autoExtract && config.extractMode === mode;
}
/**
 * 注册自动提取的三种触发形态监听(docs/auto-extraction.md §3)。旁路观测:只监听
 * 主会话事件 / agent 事件触发抽取,不向主 agent 注入任何「主动记忆」提示词——
 * 抽取节点的提示词(rules/lessons)只在抽取发生时喂给 v4-flash,不进入主会话。
 */
function registerAutoExtraction(ctx, runtime) {
    // 形态 1 信号词:观测 user/message + assistant/message 正文,命中信号词触发。
    // 无退火——每次命中即抽(成本靠抽取提示词「无记忆返回空」约束,docs/auto-extraction.md §3)。
    ctx.on('session/event', (session, event) => {
        if (!extractEnabled(runtime.config, 'signal'))
            return;
        let text = '';
        if (event.type === 'user/message')
            text = blocksText(event.data.content);
        else if (event.type === 'assistant/message')
            text = blocksText(event.data.message.content);
        else
            return;
        if (!containsSignalWord(text, parseSignalWords(runtime.config.signalWords)))
            return;
        scheduleExtraction(ctx, runtime, session);
    });
    // 形态 2 计数器:观测 turn/end,纯 turn 计数到 extractInterval 触发(进程级共享计数器)。
    ctx.on('session/event', (session, event) => {
        if (!extractEnabled(runtime.config, 'counter'))
            return;
        if (event.type !== 'turn/end')
            return;
        const decision = annealTurnStopping(turnsSince(runtime), runtime.config.extractInterval);
        runtime.annealing = decision.turnsSince;
        if (decision.released)
            scheduleExtraction(ctx, runtime, session);
    });
    // 形态 3 事件 + 计数器:agent 事件(语义触发)+ 计数器退火抑制高频。
    // 高频检查点:每 turn 触发一次,退火降到每 N turn 最多一次(进程级共享计数器)。
    ctx.on('agent/turn-stopping', ({ agent }) => {
        if (!extractEnabled(runtime.config, 'event-counter'))
            return;
        const decision = annealTurnStopping(turnsSince(runtime), runtime.config.extractInterval);
        runtime.annealing = decision.turnsSince;
        if (decision.released)
            scheduleExtraction(ctx, runtime, agent.session);
    });
    // 强语义事件:出错即抽,退火同样防连续 error 高频触发(进程级共享计数器)。
    ctx.on('agent/error', ({ agent }) => {
        if (!extractEnabled(runtime.config, 'event-counter'))
            return;
        const decision = annealError(turnsSince(runtime), runtime.config.extractInterval);
        runtime.annealing = decision.turnsSince;
        if (decision.released)
            scheduleExtraction(ctx, runtime, agent.session);
    });
    // 会话开始:仅带历史的重开(resume / compact)回顾尾部并纳入同一退火冷却;
    // fresh 会话(startup / clear)此刻 deriveMessages() 为空,直接跳过
    // (docs/auto-extraction.md §11 C)。未知 source 一律跳过(少抽不误抽)。
    ctx.on('agent/session-start', ({ agent, source }) => {
        if (!extractEnabled(runtime.config, 'event-counter'))
            return;
        if (source !== 'resume' && source !== 'compact')
            return;
        const decision = annealTurnStopping(turnsSince(runtime), runtime.config.extractInterval);
        runtime.annealing = decision.turnsSince;
        if (decision.released)
            scheduleExtraction(ctx, runtime, agent.session);
    });
}
/** 应用新配置;容量变化时释放已预热 team 以便下次重分区。 */
function applyConfig(runtime, next) {
    const prev = runtime.config;
    runtime.config = next;
    if (next.maxNodeKb !== prev.maxNodeKb)
        stopTeams(runtime.state);
}
/** 渲染一条召回/查找结果为单行(含 id、分类、落点、溯源路径;`-` 字段省略)。 */
function renderRecalledLine(found) {
    const trace = [
        found.file,
        ...(found.entryPoint !== '-' ? [`entryPoint: ${found.entryPoint}`] : []),
        ...(found.references !== '-' ? [`references: ${found.references}`] : []),
    ].join(' · ');
    return `[${found.id}] (${found.type}/${found.domain}, ${found.layer}) ${found.entry} — ${trace}`;
}
/** 渲染召回条目为多行编号文本。 */
function renderEntries(entries) {
    if (entries.length === 0)
        return 'No relevant memory entries.';
    return entries.map((entry, index) => `${index + 1}. ${renderRecalledLine(entry)}`).join('\n');
}
/** 渲染 team 状态为可读文本。 */
function renderStatus(statuses, config) {
    if (statuses.length === 0)
        return `No warm memory team. maxNodeKb=${config.maxNodeKb}`;
    const lines = statuses.map(status => `  ${status.root === '' ? '(no project)' : status.root}: ${status.nodes} node(s)`);
    return `Memory team (maxNodeKb=${config.maxNodeKb}):\n${lines.join('\n')}`;
}
/** 把字节数渲染为人类可读的大小(保留一位小数,自适应 Kb/Mb)。 */
function renderBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} Kb`;
    return `${(bytes / 1024 / 1024).toFixed(1)} Mb`;
}
/** 渲染记忆统计(`/lmemory stats`)。 */
function renderStats(cwd, config) {
    const stats = computeStats(cwd);
    const domains = [...stats.byDomain.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const domainLines = domains.length === 0
        ? ['(none)']
        : domains.map(([domain, count]) => `    ${domain}: ${count}`);
    return [
        `Memory stats (maxNodeKb=${config.maxNodeKb}):`,
        `  entries: ${stats.total} (rules: ${stats.byType.rules}, lessons: ${stats.byType.lessons})`,
        `  layers: global: ${stats.byLayer.global}, user: ${stats.byLayer.user}, project: ${stats.byLayer.project}`,
        '  domains:',
        ...domainLines,
        `  files: ${stats.files} (jsonl ${renderBytes(stats.jsonlBytes)}, md ${renderBytes(stats.mdBytes)})`,
        `  catalog entries: ${stats.catalogEntries}`,
    ].join('\n');
}
/** 渲染每日聚合表(`/lmemory usage --days N`)。 */
function renderUsageDaily(rows, days) {
    const daily = aggregateByDay(rows, days);
    const formatLabel = (usage) => `${usage.calls} calls, ${usage.totalTokens.toLocaleString()} tok`;
    const lines = [`Memory usage (last ${days} days, persisted usage.jsonl):`];
    for (const day of daily) {
        lines.push(`  ${day.day} | recall: ${formatLabel(day.recall)} | extract: ${formatLabel(day.extract)} | review: ${formatLabel(day.review)} | total: ${day.total.toLocaleString()} tok`);
    }
    return lines.join('\n');
}
/** 渲染 token 用量(`/lmemory usage`):静态上下文成本估算 + 动态 LLM 调用消耗 + 本进程估算成本。 */
function renderUsage(runtime) {
    let nodeChars = 0;
    let nodeCount = 0;
    for (const team of runtime.state.teams.values()) {
        nodeCount += team.nodes.length;
        for (const node of team.nodes)
            nodeChars += node.text.length;
    }
    // 摘要体积按进程启动目录计算——与节点状态页/状态页 dashboard 的同一指标同口径
    // (多会话进程中各会话的摘要只在主会话注入,进程级视图以启动目录为准)。
    const summaryChars = summaryText(runtime.config, process.cwd()).length;
    const labels = ['recall', 'extract', 'review'];
    const callLines = labels.map((label) => {
        const counter = runtime.usage.get(label) ?? EMPTY_USAGE;
        return `    ${label}: ${counter.calls} call(s) — input ${counter.inputTokens.toLocaleString()} / output ${counter.outputTokens.toLocaleString()} / cacheRead ${counter.cacheReadTokens.toLocaleString()}`;
    });
    // 本进程估算成本:即时计算、不落盘(docs/pricing-and-cost.md)。usage 行恒带 model
    // (本进程),无回退问题;价格表损坏/缺模型时显式说明,不静默为 0。
    const pricing = loadPricing();
    let costLine = '  estimated cost (CNY): pricing table unavailable or invalid';
    if (pricing.ok) {
        let yuan = 0;
        let missing = 0;
        for (const [label, counter] of runtime.usage) {
            const model = label === 'review' ? runtime.config.reviewModel : runtime.config.model;
            // 本进程计数是「至今累计」,按当前价格估算(近似;历史精确值在状态页按行计)。
            const cost = costFor(pricing.table, model, Date.now(), counter.inputTokens, counter.outputTokens, counter.cacheReadTokens);
            if (cost === undefined)
                missing += 1;
            else
                yuan += cost;
        }
        costLine = missing === 0
            ? `  estimated cost (CNY): ¥${yuan.toFixed(2)}`
            : `  estimated cost (CNY): ¥${yuan.toFixed(2)} (${missing} label(s) missing pricing)`;
    }
    return [
        'Memory token usage:',
        `  warm team: ${nodeCount} node(s), ${renderBytes(nodeChars)} text (~${estimateTokens(nodeChars).toLocaleString()} tokens est.)`,
        `  system-prompt summary: ${renderBytes(summaryChars)} (~${estimateTokens(summaryChars).toLocaleString()} tokens est.)`,
        '  LLM calls (this process):',
        ...callLines,
        costLine,
    ].join('\n');
}
/** 渲染注册表(`/lmemory collections list`)。 */
function renderRegistry(registry) {
    if (registry.roots.length === 0) {
        return 'No registered memory roots. Roots register automatically on session start; or run /lmemory collections add <root> to register one.';
    }
    const lines = ['Memory collections (registered roots):'];
    for (const root of registry.roots) {
        const seen = root.lastSeenAt > 0 ? formatCreatedAt(root.lastSeenAt) : 'never';
        lines.push(`  [${root.kind}] ${root.root} — ${root.entries} entries, ${root.files} files (last seen ${seen})`);
    }
    return lines.join('\n');
}
/** 渲染价格表(`/lmemory pricing`):全文 + 文件路径(用户改表后自检)。 */
function renderPricing(pricing) {
    if (!pricing.ok)
        return `Pricing table unavailable: ${pricing.error}`;
    const lines = [`Pricing table (CNY per 1M tokens, ${pricingPath()}):`];
    for (const period of pricing.table.periods) {
        const from = period.effectiveFrom === 0 ? 'earliest usage' : formatCreatedAt(period.effectiveFrom);
        const prices = (p) => `input ${p.inputPerMTok} / cacheHit ${p.cacheHitPerMTok} / output ${p.outputPerMTok}`;
        lines.push(`  [${period.model}] from ${from}: ${prices(period.prices)}${period.peakPrices !== undefined ? ` | peak ${prices(period.peakPrices)}` : ''}`);
        lines.push(`      source: ${period.source}`);
    }
    lines.push('  edit this file to add/correct periods; cost recomputes from usage on every read.');
    return lines.join('\n');
}
/** 由配置对象渲染一行/全部配置。 */
function renderConfig(config, key) {
    if (key !== undefined) {
        if (!CONFIG_KEYS.includes(key)) {
            return `Unknown config key "${key}". Known: ${CONFIG_KEYS.join(', ')}`;
        }
        return `${key} = ${String(config[key])}`;
    }
    return CONFIG_KEYS.map(k => `${k} = ${String(config[k])}`).join('\n');
}
/**
 * 注册记忆 Web 面板(路径 B 独立页,见 ./ui.js 的模块文档):
 *   - GET `/memory`(记忆页)、`/memory/status`(状态页)、`/memory/collections`(目录页)、
 *     `/memory/nodes`(节点状态页)、`/memory/settings`(设置页),均须 `?ac_token=`;
 *   - GET `/memory-assets/*`(前缀,白名单后缀 + 路径防穿越 + token);
 *   - POST `/memory-api/*` RPC channel(authority: 'loopback',信任栅栏 + 载荷 token)。
 *
 * 仅当 webServer 与 connection 服务同时存在(web 模式)且 panel 构建产物在位时
 * 注册;headless 环境两个服务都不存在,面板不存在,`/lmemory ui` 报不可用。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(token 记录于此)。
 * @param scope - settings 命名空间 scope(config-get/set 端点经它读写)。
 */
function registerPanel(ctx, runtime, scope) {
    const web = ctx.get('webServer');
    if (web === undefined)
        return;
    const panelDir = findPanelDist();
    if (panelDir === undefined) {
        ctx.logger.warn('dsh-memory: panel dist not found (run `pnpm panel:build`); web panel disabled');
        runtime.panelError = 'panel build assets missing (run `pnpm panel:build` in the dsh-memory package)';
        return;
    }
    const token = generatePanelToken();
    runtime.panelToken = token;
    runtime.port = web.port;
    const servePage = (page) => (req, res) => {
        // token 门:缺失或不匹配一律 403(常量时间比较)。
        if (!safeTokenEqual(queryToken(req.url) ?? '', token)) {
            res.writeHead(403);
            res.end('forbidden');
            return;
        }
        const html = renderPanelShell({ page, token, channel: PANEL_CHANNEL });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
    };
    ctx.effect(() => web.register({ kind: 'exact', path: '/memory', handler: servePage('memory') }), 'dsh-memory: /memory page');
    ctx.effect(() => web.register({ kind: 'exact', path: '/memory/status', handler: servePage('status') }), 'dsh-memory: /memory/status page');
    ctx.effect(() => web.register({ kind: 'exact', path: '/memory/collections', handler: servePage('collections') }), 'dsh-memory: /memory/collections page');
    ctx.effect(() => web.register({ kind: 'exact', path: '/memory/settings', handler: servePage('settings') }), 'dsh-memory: /memory/settings page');
    ctx.effect(() => web.register({ kind: 'exact', path: '/memory/nodes', handler: servePage('nodes') }), 'dsh-memory: /memory/nodes page');
    ctx.effect(() => web.register({ kind: 'exact', path: '/memory/global', handler: servePage('global') }), 'dsh-memory: /memory/global page');
    ctx.effect(() => web.register({
        kind: 'prefix',
        path: '/memory-assets',
        handler: (req, res) => {
            const rawUrl = req.url ?? '/';
            let pathname;
            try {
                pathname = new URL(rawUrl, 'http://x').pathname;
            }
            catch {
                res.writeHead(400);
                res.end();
                return;
            }
            if (!safeTokenEqual(queryToken(rawUrl) ?? '', token)) {
                res.writeHead(403);
                res.end('forbidden');
                return;
            }
            const file = resolvePanelAsset(panelDir, pathname);
            const content = file === undefined ? undefined : readPanelAsset(panelDir, pathname);
            if (file === undefined || content === undefined) {
                res.writeHead(404);
                res.end();
                return;
            }
            res.writeHead(200, {
                'content-type': assetContentType(file),
                'cache-control': 'no-cache',
            });
            res.end(content);
        },
    }), 'dsh-memory: /memory-assets route');
    // connection 由 client-connection 插件 fiber 提供:loader 并发启动 plugin,
    // apply 时该 fiber 未必已 ACTIVE,故用声明式注入而非 ctx.get(与 api-proxy 同款)。
    ctx.inject(['connection'], (cctx) => {
        const deps = {
            entries(filters) {
                // host 级视图:内置层 + 注册表全部仍存在的根(与目录页同一数据源;
                // docs/storage-and-collections.md §Q2)。会话级可见记忆仍走模型工具与 /lmemory。
                const rows = findIn(hostMemoryDirs(), {
                    ...(filters.type !== undefined ? { type: filters.type } : {}),
                    ...(filters.domain !== undefined ? { domain: filters.domain } : {}),
                    ...(filters.layer !== undefined ? { layer: filters.layer } : {}),
                }).filter(({ entry }) => filters.query === undefined || matchesPanelQuery(entry, filters.query));
                rows.sort((a, b) => b.entry.createdAt - a.entry.createdAt);
                return rows.map(({ entry, file }) => ({ entry, file }));
            },
            dashboard() {
                const stats = computeStatsIn(hostMemoryDirs());
                let nodeChars = 0;
                let nodeCount = 0;
                for (const team of runtime.state.teams.values()) {
                    nodeCount += team.nodes.length;
                    for (const node of team.nodes)
                        nodeChars += node.text.length;
                }
                // 摘要体积是本进程的会话产物(按进程启动目录),不随 host 统计走注册表。
                const summaryChars = summaryText(runtime.config, process.cwd()).length;
                // 消耗口径(docs/status-page-usage.md):totals 与 daily 同源 usage.jsonl——
                // totals 是近 14 天窗口聚合(甜甜圈/堆叠条/明细表),daily 是 84 天日聚合
                // (每日图/热力图);warmTeams/summary 是本进程实时装载,标题已标注范围。
                // costs 即时估算(docs/pricing-and-cost.md):价格表唯一持久化事实,cost 不落盘。
                const usageRows = readUsageRows();
                const pricing = loadPricing();
                const modelFallback = (label) => label === 'review' ? runtime.config.reviewModel : runtime.config.model;
                const costs = pricing.ok
                    ? {
                        ...estimateWindowCosts(pricing.table, usageRows, 14, modelFallback),
                        daily: estimateDailyCosts(pricing.table, usageRows, 14, modelFallback),
                    }
                    : { perLabel: [], totalYuan: 0, incomplete: false, error: pricing.error };
                // 小时聚合(近 14 天 × 24 桶)+ 该小时估算成本合并进桶(缺价桶 yuan 缺省)。
                const hourlyCosts = pricing.ok ? estimateHourlyCosts(pricing.table, usageRows, 14, modelFallback) : undefined;
                const hourly = aggregateByHour(usageRows, 14).map((bucket, index) => {
                    const cost = hourlyCosts?.[index];
                    if (cost === undefined)
                        return bucket;
                    return {
                        ...bucket,
                        ...(cost.yuan === undefined ? {} : { yuan: cost.yuan }),
                        missingPricingRows: cost.missingPricingRows,
                    };
                });
                return {
                    status: {
                        maxNodeKb: runtime.config.maxNodeKb,
                        teams: teamStatus(runtime.state).map(({ root: teamRoot, nodes }) => ({ root: teamRoot, nodes })),
                    },
                    stats: {
                        total: stats.total,
                        rules: stats.byType.rules,
                        lessons: stats.byType.lessons,
                        layers: { global: stats.byLayer.global, user: stats.byLayer.user, project: stats.byLayer.project },
                        domains: [...stats.byDomain.entries()]
                            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
                            .map(([domain, count]) => ({ domain, count })),
                        files: stats.files,
                        jsonlBytes: stats.jsonlBytes,
                        mdBytes: stats.mdBytes,
                        catalogEntries: stats.catalogEntries,
                    },
                    usage: {
                        warmTeams: { nodes: nodeCount, chars: nodeChars, tokens: estimateTokens(nodeChars) },
                        summary: { chars: summaryChars, tokens: estimateTokens(summaryChars) },
                        totals: aggregateWindowTotals(usageRows, 14).map(({ label, calls, inputTokens, outputTokens, cacheReadTokens }) => ({ label, calls, inputTokens, outputTokens, cacheReadTokens })),
                        daily: aggregateByDay(usageRows, 84),
                        hourly,
                        costs,
                    },
                    // 记忆活动大表(docs/memory-activity.md):按条目 createdAt 实时聚合,不落盘。
                    activity: aggregateEntryActivity(hostMemoryDirs()),
                };
            },
            roots() {
                // 目录页视图:registry 条目 + 存活状态 + 文件级明细(目录存在时新鲜扫描)。
                const registry = loadRegistry();
                const roots = registry.roots.map(entry => {
                    const alive = existsSync(entry.root);
                    const detail = scanRootDetail(entry.root);
                    return {
                        ...entry,
                        exists: alive,
                        filesDetail: detail.filesDetail,
                        entries: alive ? detail.entries : entry.entries,
                        files: alive ? detail.files : entry.files,
                    };
                });
                return {
                    roots,
                    summary: {
                        roots: roots.length,
                        totalEntries: roots.reduce((sum, root) => sum + root.entries, 0),
                        totalFiles: roots.reduce((sum, root) => sum + root.files, 0),
                    },
                };
            },
            addRoot(path) {
                const root = resolve(path);
                if (!isMemoryRoot(root)) {
                    throw new Error(`"${path}" does not exist or contains no memory files (use an lmemory dir with *.remember.jsonl or an empty dir).`);
                }
                registerExplicitRoot(root);
                return deps.roots();
            },
            forgetRoot(path) {
                if (!forgetRoot(resolve(path))) {
                    throw new Error(`No registered root matches "${path}".`);
                }
                return deps.roots();
            },
            exportRoots(root) {
                // 面板导出固定落默认导出目录(避免任意路径写面);CLI 的 --out 保持自由。
                return exportCollections(undefined, root === undefined ? {} : { roots: [resolve(root)] });
            },
            nodes() {
                // 节点状态页:host 上全部 dsh-memory 进程(本进程置顶;失效/清理由读取端处理)。
                return listProcesses();
            },
            getConfig() {
                return describeConfig(runtime.config);
            },
            async setConfig(patch) {
                await scope.update(patch);
                applyConfig(runtime, scope.get());
                return describeConfig(runtime.config);
            },
            globalEntries() {
                // host 级视图 layer=global 过滤(§9.1;global 目录经 registry 固定根进入 hostMemoryDirs)。
                const rows = findIn(hostMemoryDirs(), { layer: 'global' });
                rows.sort((a, b) => b.entry.createdAt - a.entry.createdAt);
                return rows.map(({ entry, file }) => ({ entry, file }));
            },
            async globalExtract(text) {
                // 抽取阶段 1:候选回显(不发写盘;1MiB 已由 RPC 层硬校验)。
                return runGlobalExtractFanOut(globalExtractSources(text, runtime.config.maxNodeKb * 1000), async (chunk) => callFlash(ctx, runtime, GLOBAL_EXTRACT_RULES_SYSTEM, `文档片段:\n${chunk}`, 'extract', runtime.config.model), async (chunk) => callFlash(ctx, runtime, GLOBAL_EXTRACT_LESSONS_SYSTEM, `文档片段:\n${chunk}`, 'extract', runtime.config.model), (type, error) => warnNode(ctx, `global-extract ${type}`, error));
            },
            globalExtractConfirm(candidates) {
                // 确认写盘:服务端对每条候选重跑 gate + schema 后才 append(客户端 verdict 仅供回显)。
                return writeGlobalCandidates(candidates);
            },
            globalPromotePlan() {
                const entries = promoteSourceEntries();
                const plan = resolvePromotePlan(entries, runtime.config.maxNodeKb);
                const pricing = loadPricing();
                const cost = pricing.ok
                    ? estimatePromoteCost(pricing.table, runtime.config.reviewModel, plan.nodeCount, runtime.config.maxNodeKb)
                    : undefined;
                return {
                    sourceEntries: entries.length,
                    nodeCount: plan.nodeCount,
                    ...(cost === undefined ? {} : { costYuan: cost }),
                    ...(pricing.ok ? {} : { costError: pricing.error }),
                };
            },
            async globalPromote() {
                const entries = promoteSourceEntries();
                const candidates = await runGlobalPromoteFanOut(entries, runtime.config.maxNodeKb, async (node) => callFlash(ctx, runtime, GLOBAL_PROMOTE_SYSTEM, `记忆条目:\n${node.text}`, 'review', runtime.config.reviewModel), (nodeId, error) => warnNode(ctx, `global-promote ${nodeId}`, error));
                return writeGlobalCandidates(candidates);
            },
            async globalReview() {
                const findings = await reviewEntries(ctx, runtime, discoverGlobalEntries());
                return { findings: findings.length, report: renderReviewReport(findings) };
            },
            globalExport() {
                return JSON.stringify(buildGlobalExport(), null, 2);
            },
            globalImport(text) {
                const parsed = parseGlobalExport(text);
                if (!parsed.ok)
                    return { ok: false, reason: parsed.reason };
                const result = importGlobalEntries(parsed.doc);
                return { ok: true, ...result };
            },
        };
        const disposeChannel = cctx.connection.rpc.handle(PANEL_CHANNEL, (endpoint, payload, _signal) => handlePanelRpc(endpoint, payload, token, deps), { authority: 'loopback' });
        cctx.effect(() => disposeChannel, 'dsh-memory: /memory-api channel');
        // 面板 URL 是就绪信号,打印到 stdout(与 `dsh web:` 行一致,voice-tts 同款);
        // cctx.logger.info 在 web 模式下不落 stdout,用户/agent 看不到面板入口。
        console.log(`dsh-memory panel: ${panelUrl(web.port, 'memory', token)}`);
    });
}
/** 把配置命令里的原始字符串强转成对应 JS 值。 */
function coerceConfigValue(key, raw) {
    if (key === 'maxNodeKb' || key === 'recallTopK' || key === 'extractInterval') {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1)
            throw new Error(`${key} must be a positive integer`);
        return value;
    }
    if (key === 'warmupOnStart' || key === 'autoExtract') {
        if (raw === 'true' || raw === '1')
            return true;
        if (raw === 'false' || raw === '0')
            return false;
        throw new Error(`${key} must be true or false`);
    }
    if (key === 'extractMode') {
        if (EXTRACT_MODES.includes(raw))
            return raw;
        throw new Error(`extractMode must be one of ${EXTRACT_MODES.join(', ')}`);
    }
    if (key === 'summaryMode') {
        if (SUMMARY_MODES.includes(raw))
            return raw;
        throw new Error(`summaryMode must be one of ${SUMMARY_MODES.join(', ')}`);
    }
    return raw;
}
/** 注入摘要文本:与注入点同函数、同 summaryMode(docs/global-layer-design.md §6.1)。 */
function summaryText(config, cwd) {
    return renderMemorySummary([...discoverEntries(cwd), ...discoverGlobalEntries()], config.summaryMode);
}
/** 读取文档文本并做 1 MiB 硬上限与空文档校验(GLOBAL_DOC_MAX_BYTES;docs/global-layer-design.md §4.1)。 */
function readDocumentFile(path) {
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > GLOBAL_DOC_MAX_BYTES) {
        throw new Error(`global extract: document exceeds the ${GLOBAL_DOC_MAX_BYTES / 1024 / 1024} MiB limit`);
    }
    if (text.trim().length === 0)
        throw new Error('global extract: document is empty');
    return text;
}
/**
 * global 写盘(三条 gated 路径共用):确定性 gate 硬查 → 与现有 global 条目按
 * entry 精确去重(rules/lessons 都去重)→ append(global 根,内部 schema 校验)。
 * 确认阶段的服务端重跑不绕过 gate(§7.1、G1)。
 * @param candidates - 待写候选(含 verdict,写盘只看 gate 硬查)。
 * @returns 写入数与被拒数(gate 拒绝或重复)。
 */
function writeGlobalCandidates(candidates) {
    const existing = new Set(discoverGlobalEntries().map(entry => entry.entry));
    const pending = candidates.filter(candidate => checkGlobalGate(candidate).pass && !existing.has(candidate.entry));
    const skipped = candidates.length - pending.length;
    for (const candidate of pending) {
        append(undefined, { ...candidate, layer: 'global' });
    }
    if (pending.length > 0)
        rebuild(undefined, [visibleGlobalDir()]);
    return { wrote: pending.length, skipped };
}
/** 写盘结果的 CLI 文案。 */
function describeGlobalWrite(result) {
    return result.skipped > 0
        ? `wrote ${result.wrote} global entr(ies), skipped ${result.skipped} (gate reject or duplicate).`
        : `wrote ${result.wrote} global entr(ies).`;
}
/** global extract 回显:每条候选 + 确定性 gate 结论(§4.1)。 */
function renderGlobalExtractEcho(file, candidates) {
    if (candidates.length === 0)
        return `global extract from ${file}: 0 candidates (nothing to write).`;
    const lines = candidates.map((candidate) => {
        const gate = checkGlobalGate(candidate);
        const conclusion = gate.pass ? 'pass' : `reject: ${gate.reason}`;
        return `- [${candidate.type}|${candidate.domain}] ${candidate.entry} — gate ${conclusion}`;
    });
    return [`global extract from ${file}: ${candidates.length} candidate(s)`, ...lines, 'run with --confirm to write.'].join('\n');
}
/** 执行一次 `/lmemory` 命令。 */
async function handleCommand(ctx, runtime, scope, invocation) {
    const command = parseLmemoryCommand(invocation.rawInput);
    const cwd = invocation.agent.session.header.cwd;
    try {
        switch (command.kind) {
            case 'help':
                if (command.topic !== undefined && !COMMAND_HELPS.has(command.topic)) {
                    return { kind: 'error', text: renderHelp(command.topic) };
                }
                return { kind: 'success', text: renderHelp(command.topic) };
            case 'status':
                return { kind: 'success', text: renderStatus(teamStatus(runtime.state), runtime.config) };
            case 'stats':
                return { kind: 'success', text: renderStats(cwd, runtime.config) };
            case 'usage': {
                if (command.days !== undefined) {
                    if (command.days < 1 || command.days > 90) {
                        return { kind: 'error', text: 'usage --days N requires 1 <= N <= 90.' };
                    }
                    return { kind: 'success', text: renderUsageDaily(readUsageRows(), command.days) };
                }
                return { kind: 'success', text: renderUsage(runtime) };
            }
            case 'ui': {
                const token = runtime.panelToken;
                const port = ctx.get('webServer')?.port;
                if (port === undefined) {
                    return { kind: 'error', text: 'Memory panel is not available: this session has no webServer/connection (web mode only).' };
                }
                if (token === undefined) {
                    return { kind: 'error', text: `Memory panel is not available: ${runtime.panelError ?? 'panel registration failed'}.` };
                }
                // 命令卡片只在结果含换行时可展开/复制(GenericCommandCard 的 expandable 判定);
                // 卡片是纯文本渲染,故用裸 URL 而非 markdown 链接语法。
                return {
                    kind: 'success',
                    text: [
                        'Memory panel (展开后复制 URL):',
                        `  记忆面板: ${panelUrl(port, 'memory', token)}`,
                        `  状态面板: ${panelUrl(port, 'status', token)}`,
                        `  目录面板: ${panelUrl(port, 'collections', token)}`,
                        `  节点面板: ${panelUrl(port, 'nodes', token)}`,
                        `  设置面板: ${panelUrl(port, 'settings', token)}`,
                        `  Global 面板: ${panelUrl(port, 'global', token)}`,
                    ].join('\n'),
                };
            }
            case 'team': {
                if (command.action === 'start') {
                    ensureTeam(runtime.state, cwd, runtime.config);
                    return { kind: 'success', text: 'Memory team started.' };
                }
                if (command.action === 'stop') {
                    stopTeams(runtime.state);
                    return { kind: 'success', text: 'Memory team stopped.' };
                }
                restartTeam(runtime.state, cwd, runtime.config);
                return { kind: 'success', text: 'Memory team restarted.' };
            }
            case 'query': {
                const entries = await doRecall(ctx, runtime, cwd, command.text);
                return { kind: 'success', text: renderEntries(entries) };
            }
            case 'config-get':
                return { kind: 'success', text: renderConfig(runtime.config, command.key) };
            case 'config-set': {
                if (!CONFIG_KEYS.includes(command.key)) {
                    return { kind: 'error', text: `Unknown config key "${command.key}". Known: ${CONFIG_KEYS.join(', ')}` };
                }
                const value = coerceConfigValue(command.key, command.value);
                await scope.update({ [command.key]: value });
                applyConfig(runtime, scope.get());
                return { kind: 'success', text: renderConfig(runtime.config, command.key) };
            }
            case 'review': {
                const findings = await doReview(ctx, runtime, cwd, command.filter);
                const report = renderReviewReport(findings);
                invocation.agent.followup(createUserMessage({
                    source: { kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary: `记忆质检:发现 ${findings.length} 处缺陷` },
                    content: [{ type: 'text', text: report }],
                }));
                return { kind: 'success', text: `review 完成,发现 ${findings.length} 处,报告已注入会话` };
            }
            case 'catalog': {
                rebuild(cwd, command.root !== undefined ? [resolve(command.root)] : undefined);
                return { kind: 'success', text: 'catalog rebuilt from jsonl.' };
            }
            case 'global': {
                switch (command.action) {
                    case 'extract': {
                        const text = readDocumentFile(command.file);
                        const key = resolve(command.file);
                        const staged = runtime.globalStaged;
                        // --confirm 命中暂存:零调用直接写盘(决策 D9;gate 在写盘侧重跑,不绕过)。
                        if (command.confirm && !command.dryRun && staged !== undefined && staged.key === key) {
                            runtime.globalStaged = undefined;
                            return { kind: 'success', text: describeGlobalWrite(writeGlobalCandidates(staged.candidates)) };
                        }
                        const candidates = await runGlobalExtractFanOut(globalExtractSources(text, runtime.config.maxNodeKb * 1000), async (chunk) => callFlash(ctx, runtime, GLOBAL_EXTRACT_RULES_SYSTEM, `文档片段:\n${chunk}`, 'extract', runtime.config.model), async (chunk) => callFlash(ctx, runtime, GLOBAL_EXTRACT_LESSONS_SYSTEM, `文档片段:\n${chunk}`, 'extract', runtime.config.model), (type, error) => warnNode(ctx, `global-extract ${type}`, error));
                        const echo = renderGlobalExtractEcho(command.file, candidates);
                        if (command.dryRun)
                            return { kind: 'success', text: echo };
                        runtime.globalStaged = { key, candidates };
                        if (command.confirm) {
                            runtime.globalStaged = undefined;
                            return { kind: 'success', text: `${echo}\n${describeGlobalWrite(writeGlobalCandidates(candidates))}` };
                        }
                        return { kind: 'success', text: echo };
                    }
                    case 'promote': {
                        const entries = promoteSourceEntries();
                        const plan = resolvePromotePlan(entries, runtime.config.maxNodeKb);
                        const pricing = loadPricing();
                        const cost = pricing.ok
                            ? estimatePromoteCost(pricing.table, runtime.config.reviewModel, plan.nodeCount, runtime.config.maxNodeKb)
                            : undefined;
                        const head = `global promote plan: ${entries.length} source entr(ies) -> ${plan.nodeCount} node(s); estimated cost ${cost === undefined ? 'unknown (pricing unavailable)' : `¥${cost.toFixed(2)}`}`;
                        if (!command.confirm) {
                            return { kind: 'success', text: `${head}\nrun with --confirm to execute (no LLM calls were made).` };
                        }
                        const candidates = await runGlobalPromoteFanOut(entries, runtime.config.maxNodeKb, async (node) => callFlash(ctx, runtime, GLOBAL_PROMOTE_SYSTEM, `记忆条目:\n${node.text}`, 'review', runtime.config.reviewModel), (nodeId, error) => warnNode(ctx, `global-promote ${nodeId}`, error));
                        return { kind: 'success', text: `${head}\n${describeGlobalWrite(writeGlobalCandidates(candidates))}` };
                    }
                    case 'review': {
                        const findings = await reviewEntries(ctx, runtime, discoverGlobalEntries());
                        const report = renderReviewReport(findings);
                        invocation.agent.followup(createUserMessage({
                            source: { kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary: `global 记忆质检:发现 ${findings.length} 处缺陷` },
                            content: [{ type: 'text', text: report }],
                        }));
                        return { kind: 'success', text: `global review 完成,发现 ${findings.length} 处,报告已注入会话` };
                    }
                    /* v8 ignore next 2 -- closed union backstop */
                    default:
                        return { kind: 'error', text: USAGE };
                }
            }
            case 'pricing': {
                return { kind: 'success', text: renderPricing(loadPricing()) };
            }
            case 'collections': {
                switch (command.action) {
                    case 'list':
                        return { kind: 'success', text: renderRegistry(refreshRegistry(cwd)) };
                    case 'add': {
                        const root = resolve(command.root ?? '');
                        if (!isMemoryRoot(root)) {
                            return { kind: 'error', text: `"${command.root}" does not exist or contains no memory files (use an lmemory dir with *.remember.jsonl or an empty dir).` };
                        }
                        return { kind: 'success', text: renderRegistry(registerExplicitRoot(root)) };
                    }
                    case 'forget': {
                        const removed = forgetRoot(resolve(command.root ?? ''));
                        if (!removed)
                            return { kind: 'error', text: `No registered root matches "${command.root}".` };
                        return { kind: 'success', text: renderRegistry(loadRegistry()) };
                    }
                    case 'export': {
                        const result = exportCollections(cwd, {
                            ...(command.outDir !== undefined ? { outDir: command.outDir } : {}),
                            ...(command.roots !== undefined ? { roots: command.roots } : {}),
                        });
                        return { kind: 'success', text: `Exported ${result.rootsExported} root(s), ${result.totalEntries} entries -> ${result.dir}` };
                    }
                    /* v8 ignore next 2 -- closed union backstop */
                    default:
                        return { kind: 'error', text: USAGE };
                }
            }
            /* v8 ignore next 2 -- closed union backstop */
            default:
                return { kind: 'error', text: USAGE };
        }
    }
    catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
}
/** remember 工具:校验枚举 → 追加 JSONL 行 → 重渲染 MD;rules 只增不减。 */
const REMEMBER_DESCRIPTION = 'Write one long-term memory entry. Only record rules (durable preferences, constraints, consensus) or lessons (past pitfalls, API changes); never log the step-by-step transcript, reasoning process, code implementation, or credentials. Provide type, domain, scope (impacted subsystem/module, free text), layer (storage layer), and the one-sentence entry; entryPoint and references default to "-".';
/** recall 工具:fan-out 到记忆节点 team → 聚合返回相关条目。 */
const RECALL_DESCRIPTION = 'Recall relevant long-term memory entries for a query by fanning out to the warm memory-node team and aggregating the deduplicated, reranked results. Each returned entry carries its full fields (id, type, domain, scope, layer, entry) plus the containing file, entryPoint, and references for traceability.';
/** forget 工具:精确匹配删除;rules 删除需 confirm:true。 */
const FORGET_DESCRIPTION = 'Delete a long-term memory entry by exact entry text. Deleting a "rules" entry requires confirm: true because rules are append-only.';
/** memory-find 工具:按 id 精确查一条,或按类型/领域/范围/落点层过滤列多条。 */
const FIND_DESCRIPTION = 'Look up long-term memory entries. Pass an exact id to retrieve one entry, or filter by type, domain, scope, or storage layer to list many. Returns the full entry with its id and containing file.';
/** memory-update 工具:按 id 改写可改字段;id/type/layer 不可改。 */
const UPDATE_DESCRIPTION = 'Update one long-term memory entry by its exact id. Only the entry text, domain, scope, entryPoint, and references are mutable; the id, type, and layer cannot change.';
/** memory-delete 工具:按 id 精确删除;rules 删除需 confirm:true。 */
const DELETE_DESCRIPTION = 'Delete one long-term memory entry by its exact id. Deleting a "rules" entry requires confirm: true because rules are append-only.';
/**
 * 注册 remember / recall / forget 三个模型工具。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(team + 配置)。
 */
function registerTools(ctx, runtime) {
    ctx.tools.register(defineTool({
        name: 'remember',
        description: REMEMBER_DESCRIPTION,
        parameters: {
            type: { type: 'string', required: true, enum: ['rules', 'lessons'], description: 'Memory type: rules or lessons.' },
            domain: { type: 'string', required: true, enum: [...DOMAINS], description: 'Knowledge domain (one of 21 ids).' },
            scope: { type: 'string', required: true, description: 'Impacted scope: which subsystem or module this memory affects (free text, e.g. "全项目", "Web UI", "Provider 接入").' },
            layer: { type: 'string', required: true, enum: ['user', 'project'], description: 'Storage layer: project writes under the repo, user under ~/.dsh. (global memories are written only via /lmemory global or import.)' },
            entry: { type: 'string', required: true, description: 'One-sentence entry text.' },
            entryPoint: { type: 'string', description: 'Associated entry-point file path, or omit.' },
            references: { type: 'string', description: 'Associated reference file path, or omit.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    remembered: { type: 'boolean', required: true },
                    duplicate: { type: 'boolean', required: true },
                    type: { type: 'string', required: true },
                    entry: { type: 'string', required: true },
                    jsonlPath: { type: 'string', required: true },
                    mdPath: { type: 'string', required: true },
                },
            },
            render: (_args, value) => {
                const v = value;
                const text = v.duplicate
                    ? `Already remembered (${v.type}): ${v.entry}`
                    : `Remembered (${v.type}): ${v.entry}`;
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            const candidate = {
                type: args.type,
                domain: args.domain,
                scope: args.scope,
                layer: args.layer,
                entry: args.entry,
                ...(args.entryPoint !== undefined ? { entryPoint: args.entryPoint } : {}),
                ...(args.references !== undefined ? { references: args.references } : {}),
            };
            const cwd = exec.agent?.session.header.cwd ?? process.cwd();
            const result = append(cwd, candidate);
            return {
                remembered: true,
                duplicate: result.duplicate,
                type: result.entry.type,
                entry: result.entry.entry,
                jsonlPath: result.jsonlPath ?? '-',
                mdPath: result.mdPath ?? '-',
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'recall',
        description: RECALL_DESCRIPTION,
        parameters: {
            query: { type: 'string', required: true, description: 'The recall query.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    entries: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                file: { type: 'string', required: true },
                                type: { type: 'string', required: true },
                                domain: { type: 'string', required: true },
                                scope: { type: 'string', required: true },
                                layer: { type: 'string', required: true },
                                entry: { type: 'string', required: true },
                                entryPoint: { type: 'string', required: true },
                                references: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: renderEntries(v.entries) }];
            },
        },
        async execute(args, exec) {
            const cwd = exec.agent?.session.header.cwd;
            const entries = await doRecall(ctx, runtime, cwd, args.query);
            return { entries };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'forget',
        description: FORGET_DESCRIPTION,
        parameters: {
            entry: { type: 'string', required: true, description: 'Exact entry text to delete.' },
            type: { type: 'string', enum: ['rules', 'lessons'], description: 'Restrict deletion to this type.' },
            confirm: { type: 'boolean', description: 'Required (true) when deleting a rules entry.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    removed: { type: 'integer', required: true },
                    entry: { type: 'string', required: true },
                },
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.removed > 0 ? `Forgot ${v.removed} entry: ${v.entry}` : `No matching entry: ${v.entry}` }];
            },
        },
        async execute(args, exec) {
            const cwd = exec.agent?.session.header.cwd ?? process.cwd();
            const type = args.type;
            const matches = find(cwd, type === undefined ? {} : { type })
                .filter(found => found.entry.entry === args.entry);
            if (matches.some(found => found.entry.type === 'rules') && args.confirm !== true) {
                throw new Error('forget: this removes a "rules" entry; call again with confirm: true to proceed.');
            }
            const removed = removeByEntry(cwd, args.entry, type);
            return { removed, entry: args.entry };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory-find',
        description: FIND_DESCRIPTION,
        parameters: {
            id: { type: 'string', description: 'Exact memory id to retrieve (e.g. "m-3k9f2x8q1a").' },
            type: { type: 'string', enum: ['rules', 'lessons'], description: 'Filter by memory type.' },
            domain: { type: 'string', enum: [...DOMAINS], description: 'Filter by knowledge domain.' },
            scope: { type: 'string', description: 'Filter by exact impacted scope.' },
            layer: { type: 'string', enum: ['global', 'user', 'project'], description: 'Filter by storage layer.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    entries: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                file: { type: 'string', required: true },
                                type: { type: 'string', required: true },
                                domain: { type: 'string', required: true },
                                scope: { type: 'string', required: true },
                                layer: { type: 'string', required: true },
                                entry: { type: 'string', required: true },
                                entryPoint: { type: 'string', required: true },
                                references: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const v = value;
                if (v.entries.length === 0)
                    return [{ type: 'text', text: 'No matching memory entries.' }];
                const lines = v.entries.map((found, index) => `${index + 1}. ${renderRecalledLine(found)}`);
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        async execute(args, exec) {
            const cwd = exec.agent?.session.header.cwd;
            const id = args.id !== undefined ? requireMemoryId(args.id) : undefined;
            const entries = find(cwd, {
                ...(id !== undefined ? { id } : {}),
                ...(args.type !== undefined ? { type: args.type } : {}),
                ...(args.domain !== undefined ? { domain: args.domain } : {}),
                ...(args.scope !== undefined ? { scope: args.scope } : {}),
                ...(args.layer !== undefined ? { layer: args.layer } : {}),
            });
            return {
                entries: entries.map(found => ({
                    id: found.entry.id,
                    file: found.file,
                    type: found.entry.type,
                    domain: found.entry.domain,
                    scope: found.entry.scope,
                    layer: found.entry.layer,
                    entry: found.entry.entry,
                    entryPoint: found.entry.entryPoint,
                    references: found.entry.references,
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory-update',
        description: UPDATE_DESCRIPTION,
        parameters: {
            id: { type: 'string', required: true, description: 'Exact memory id to update.' },
            entry: { type: 'string', description: 'New one-sentence entry text.' },
            domain: { type: 'string', enum: [...DOMAINS], description: 'New knowledge domain.' },
            scope: { type: 'string', description: 'New impacted scope.' },
            entryPoint: { type: 'string', description: 'New associated entry-point file path.' },
            references: { type: 'string', description: 'New associated reference file path.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    entry: { type: 'string', required: true },
                    file: { type: 'string', required: true },
                },
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: `Updated ${v.id}: ${v.entry} (${v.file})` }];
            },
        },
        async execute(args, exec) {
            const id = requireMemoryId(args.id);
            const cwd = exec.agent?.session.header.cwd ?? process.cwd();
            const updated = update(cwd, id, {
                ...(args.entry !== undefined ? { entry: args.entry } : {}),
                ...(args.domain !== undefined ? { domain: args.domain } : {}),
                ...(args.scope !== undefined ? { scope: args.scope } : {}),
                ...(args.entryPoint !== undefined ? { entryPoint: args.entryPoint } : {}),
                ...(args.references !== undefined ? { references: args.references } : {}),
            });
            return { id: updated.entry.id, entry: updated.entry.entry, file: updated.file };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'memory-delete',
        description: DELETE_DESCRIPTION,
        parameters: {
            id: { type: 'string', required: true, description: 'Exact memory id to delete.' },
            confirm: { type: 'boolean', description: 'Required (true) when deleting a rules entry.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    removed: { type: 'boolean', required: true },
                    id: { type: 'string', required: true },
                },
            },
            render: (_args, value) => {
                const v = value;
                return [{ type: 'text', text: v.removed ? `Deleted ${v.id}` : `No memory entry with id ${v.id}` }];
            },
        },
        async execute(args, exec) {
            const id = requireMemoryId(args.id);
            const cwd = exec.agent?.session.header.cwd ?? process.cwd();
            const found = find(cwd, { id });
            if (found.length === 0)
                return { removed: false, id };
            assertDeletable(found[0].entry, args.confirm);
            const result = remove(cwd, id);
            return { removed: result.removed, id };
        },
    }));
}
/**
 * 插件入口:注册摘要 section、工具、设置命名空间与 `/lmemory` 命令。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
    const runtime = { state: createRuntimeState(), config: { ...DEFAULT_CONFIG }, annealing: 0, usage: new Map(), nodes: createNodeStates(), publish: () => { } };
    // 跨进程运行时状态(docs/node-status.md):启动即发布 → 节点状态变化即发布 →
    // 15s 心跳(顺带刷新 team 装载快照)→ fiber 销毁时清理器删除自己的文件。
    const pid = process.pid;
    const startedAt = Date.now();
    const publishNow = (now = Date.now()) => {
        try {
            publishRuntime(snapshotRuntime(runtime, pid, startedAt, now));
        }
        catch (error) {
            ctx.logger.warn(`dsh-memory: runtime status publish failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    runtime.publish = publishNow;
    publishNow();
    ctx.effect(() => {
        const heartbeat = setInterval(publishNow, RUNTIME_HEARTBEAT_MS);
        heartbeat.unref();
        return () => {
            clearInterval(heartbeat);
            removeRuntimeFile(pid, startedAt);
        };
    }, 'dsh-memory: runtime status heartbeat');
    // 旧目录一次性迁移(用户两层):先于一切发现/写盘执行;项目层由发现路径惰性迁移。
    const migration = migrateLegacyMemoryDirs();
    for (const moved of migration.moved)
        ctx.logger.info(`dsh-memory: migrated legacy memory dir ${moved} -> lmemory/`);
    for (const skipped of migration.skipped)
        ctx.logger.warn(`dsh-memory: ${skipped} does not look like a memory dir; leaving it untouched`);
    // 存量 global 条目迁移(两用户根顶层 → global 目录,幂等;发现/写根咽喉也各跑一次,此处仅报告)。
    const globalMigration = migrateLegacyGlobalEntries();
    if (globalMigration.moved > 0)
        ctx.logger.info(`dsh-memory: migrated ${globalMigration.moved} legacy global entries -> ${visibleGlobalDir()}`);
    // 注册表:启动登记用户根;每次会话开始登记项目根(惰性发现,docs/storage-and-collections.md §Q2)。
    refreshRegistry();
    ctx.on('agent/session-start', ({ agent }) => {
        refreshRegistry(agent.session.header.cwd);
    });
    // 价格表:启动即种子(与 registry 同节奏,不依赖首次面板/命令访问);损坏不阻断启动,
    // 成本展示会显式报「价格表不可用」,用户修表即恢复(docs/pricing-and-cost.md)。
    const pricingSeed = loadPricing();
    if (!pricingSeed.ok)
        ctx.logger.warn(`dsh-memory: pricing table unavailable: ${pricingSeed.error}`);
    // order 10:persona(0)之后、工具指导(100–199)之前,注入已知记忆摘要。
    ctx.systemPrompt.section({
        name: 'memory:summary',
        order: 10,
        text: (assemble) => summaryText(runtime.config, assemble.agent?.session.header.cwd),
    });
    registerTools(ctx, runtime);
    // 自动提取(默认开):三种触发形态(信号词 / 计数器 / 事件+计数器)旁路观测主会话。
    registerAutoExtraction(ctx, runtime);
    // settings 是可选服务;存在时接管配置读写并挂载 /lmemory。
    ctx.inject(['settings'], (sctx) => {
        const scope = sctx.settings.register(NAMESPACE, SCHEMA, { base: DEFAULT_CONFIG });
        runtime.config = scope.get();
        if (runtime.config.warmupOnStart)
            ensureTeam(runtime.state, undefined, runtime.config);
        scope.watch(next => applyConfig(runtime, next));
        ctx.commands.register({
            name: 'lmemory',
            description: 'manage long-term memory (status / stats / usage / ui / team / query / config / review / catalog / global / collections / pricing)',
            input: { hint: 'status | stats | usage [--days N] | ui | team start|stop|restart | query <text> | config get|set <key> [value] | review [layer|domain] | catalog rebuild [--root <path>] | global extract <file> [--dry-run|--confirm] | global promote [--confirm] | global review | collections list|add|forget|export | pricing | help [command]' },
            handler: invocation => handleCommand(ctx, runtime, scope, invocation),
        });
        // Web 面板(路径 B):web 模式下挂页面路由 + RPC channel;headless 时静默不存在。
        registerPanel(ctx, runtime, scope);
    });
}
