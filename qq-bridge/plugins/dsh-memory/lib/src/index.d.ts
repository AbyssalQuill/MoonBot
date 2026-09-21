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
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "dsh-memory";
/** 插件挂载所需服务。 */
export declare const inject: string[];
/**
 * 插件入口:注册摘要 section、工具、设置命名空间与 `/lmemory` 命令。
 * @param ctx - Cordis 上下文。
 */
export declare function apply(ctx: Context): void;
