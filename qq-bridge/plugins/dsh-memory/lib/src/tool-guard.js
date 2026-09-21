/**
 * 记忆操作工具的入参守卫(纯逻辑,不 import cordis)。
 *
 * 三个按 id 操作的工具(`memory-find` / `memory-update` / `memory-delete`)是
 * `index.ts` 里的薄 handler,直接调 store;本模块抽出其中可单测的入参校验——
 * id 格式校验与 `rules` 删除确认约束(docs/memory-review.md §6),供 handler 调用、
 * 供单测验证,避免把校验逻辑埋进不可测的 cordis 注册里。
 *
 * @module dsh-memory/tool-guard
 */
import { isMemoryId } from './schema.js';
/**
 * 校验一个值是否为合法 {@link MemoryId},非法则抛清晰错误。
 * @param value - 待校验值。
 * @returns 通过校验的 {@link MemoryId}。
 * @throws 当 `value` 不是 `m-` + 10 位 base36 字符串。
 */
export function requireMemoryId(value) {
    if (!isMemoryId(value)) {
        throw new Error(`invalid memory id ${JSON.stringify(value)}; expected "m-" followed by 10 base36 characters`);
    }
    return value;
}
/**
 * 校验删除一条记忆的确认约束:`rules` 只增不减,删除须显式 `confirm: true`。
 * @param entry - 待删除的记忆。
 * @param confirm - 工具传入的 `confirm` 参数(任意值,非 `true` 视为未确认)。
 * @throws 当目标是 `rules` 且未确认。
 */
export function assertDeletable(entry, confirm) {
    if (entry.type === 'rules' && confirm !== true) {
        throw new Error('memory-delete: removing a "rules" entry requires confirm: true');
    }
}
