/**
 * 记忆质检(review)的纯逻辑:节点分区、fan-out 审查、跨节点判矛盾/重复、聚合。
 *
 * 与 recall 不同,review 的输出是**结构化缺陷发现**(不是条目文本),因此节点
 * 文本必须带 id 才能指认缺陷目标(docs/memory-review.md §4)。本模块只定义结构
 * 与时序,不 import cordis,也不 import dsh-llm——模型调用以函数参数注入
 * (`nodeReviewFn` / `crossNodeReviewFn`),由 `index.ts` 用 `ctx.llm.stream` 绑定到
 * `deepseek-v4-pro`。这样分区 / fan-out / 聚合都能在单测里用 mock 验证。
 *
 * @module dsh-memory/review
 */
import { warmUp } from './team.js';
import { isMemoryId } from './schema.js';
/** 四类缺陷(docs/memory-review.md §4)。 */
export const REVIEW_PROBLEMS = ['contradiction', 'duplicate', 'outdated', 'divergence'];
/** 建议动作(docs/memory-review.md §4)。 */
export const REVIEW_SUGGESTIONS = ['update', 'delete', 'merge'];
/** 一条记忆在 review 节点文本里的一行:`[id|type|domain|scope] entry`(与 recall 共用 render.entryLine)。 */
import { entryLine } from './render.js';
export { entryLine as reviewEntryLine } from './render.js';
/**
 * 把记忆条目转成 review 节点源(每条一个源,文本带 id,供模型指认缺陷目标)。
 * @param entries - 归一化后的记忆条目。
 * @returns 记忆源列表(供 `warmUp` 分区)。
 */
export function reviewSourcesFor(entries) {
    return entries.map(entry => ({ id: entry.id, text: entryLine(entry) }));
}
/**
 * 由记忆条目构建就绪的 review team(带 id 节点文本 + 分区)。
 * @param entries - 归一化后的记忆条目。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 就绪 team。
 */
export function reviewTeam(entries, maxNodeKb) {
    return warmUp(reviewSourcesFor(entries), maxNodeKb);
}
/**
 * 从模型输出文本中提取并解析缺陷数组(容错:跳过非法元素,不抛)。
 *
 * 协议:模型返回一个 JSON 数组,每个元素形如
 * `{"id","problem","related","note","suggest","suggestedEntry?"}`。本函数抽取第一个
 * 平衡的 `[...]` 子串再 `JSON.parse`,非法 id / problem / suggest 的元素被丢弃,
 * 保证返回值里的 id 都是真实存在、格式合法的记忆 id。
 * @param text - 模型输出的原始文本。
 * @param knownIds - 已知合法记忆 id 集合(用于过滤编造的 id)。
 * @returns 解析出的缺陷发现。
 */
export function parseFindings(text, knownIds) {
    const arrayText = extractJsonArray(text);
    if (arrayText === undefined)
        return [];
    let raw;
    try {
        raw = JSON.parse(arrayText);
    }
    catch {
        return [];
    }
    if (!Array.isArray(raw))
        return [];
    const findings = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const obj = item;
        const { id, problem, suggest } = obj;
        if (!isMemoryId(id) || !knownIds.has(id))
            continue;
        if (!isReviewProblem(problem))
            continue;
        if (!isReviewSuggestion(suggest))
            continue;
        const related = Array.isArray(obj.related)
            ? obj.related.filter((value) => isMemoryId(value) && knownIds.has(value))
            : [];
        const note = typeof obj.note === 'string' ? obj.note : '';
        const suggestedEntry = typeof obj.suggestedEntry === 'string' ? obj.suggestedEntry : undefined;
        findings.push({
            id,
            problem,
            related,
            note,
            suggest,
            ...(suggestedEntry !== undefined ? { suggestedEntry } : {}),
        });
    }
    return findings;
}
/** 判定一个未知值是否为合法缺陷类别。 */
function isReviewProblem(value) {
    return typeof value === 'string' && REVIEW_PROBLEMS.includes(value);
}
/** 判定一个未知值是否为合法建议动作。 */
function isReviewSuggestion(value) {
    return typeof value === 'string' && REVIEW_SUGGESTIONS.includes(value);
}
/** 从文本中抽取第一个平衡的 JSON 数组子串(处理模型输出前后的冗余文字)。 */
function extractJsonArray(text) {
    const start = text.indexOf('[');
    if (start < 0)
        return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '[')
            depth += 1;
        else if (ch === ']') {
            depth -= 1;
            if (depth === 0)
                return text.slice(start, i + 1);
        }
    }
    return undefined;
}
/** 缺陷去重键:按「类别 + 涉及的全部 id」排序后归一,同类同集合并为一条。 */
function findingKey(finding) {
    const involved = new Set([finding.id, ...finding.related]);
    return `${finding.problem}:${[...involved].sort().join(',')}`;
}
/**
 * 缺陷去重:类别与涉及 id 集合相同的发现只保留第一条(保持出现顺序)。
 * @param findings - 待去重缺陷。
 * @returns 去重后的缺陷。
 */
export function dedupeFindings(findings) {
    const seen = new Set();
    const result = [];
    for (const finding of findings) {
        const key = findingKey(finding);
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(finding);
    }
    return result;
}
/**
 * 执行一次质检:fan-out 各节点审查本节点内缺陷 → 跨节点再判矛盾/重复 → 聚合去重。
 *
 * per-node 容错(robustness.md §2):单节点失败跳过并告警,其余节点缺陷照常;跨节点
 * 判失败则降级为只用节点内发现;全部节点失败才抛「all nodes failed」。
 * 单节点时跳过跨节点判(本节点审查已覆盖全部条目);≥2 节点时才补跨节点,
 * 捕捉分在不同节点的同义/冲突记忆(docs/memory-review.md §4)。
 * @param team - 已预热 team(带 id 节点文本)。
 * @param entries - 全部归一化记忆条目(供跨节点判矛盾/重复)。
 * @param nodeReviewFn - 单节点审查调用器(模型注入)。
 * @param crossNodeReviewFn - 跨节点审查调用器(模型注入)。
 * @param onNodeFailure - 节点/跨节点失败告警回调(注入)。
 * @returns 聚合去重后的缺陷发现。
 */
export async function runReview(team, entries, nodeReviewFn, crossNodeReviewFn, onNodeFailure) {
    if (team.nodes.length === 0)
        return [];
    const settled = await Promise.allSettled(team.nodes.map(node => nodeReviewFn(node)));
    const intra = settled.flatMap((r) => {
        if (r.status === 'rejected') {
            const node = team.nodes[settled.indexOf(r)];
            onNodeFailure(node.id, r.reason);
            return [];
        }
        return [...r.value];
    });
    if (settled.every(r => r.status === 'rejected'))
        throw new Error('memory review: all nodes failed');
    let cross = [];
    if (team.nodes.length > 1) {
        try {
            cross = [...await crossNodeReviewFn(entries)];
        }
        catch (error) {
            // 跨节点判失败 → 降级为只用节点内发现(不丢 intra)。
            onNodeFailure('cross-node', error);
        }
    }
    return dedupeFindings([...intra, ...cross]);
}
/**
 * 把缺陷发现渲染成主 agent 可读、可行动的报告文本(每条带 id + suggest)。
 * @param findings - 缺陷发现。
 * @returns 多行报告文本。
 */
export function renderReviewReport(findings) {
    if (findings.length === 0)
        return 'Memory review found no issues.';
    const lines = findings.map((finding, index) => {
        const related = finding.related.length > 0 ? ` (related: ${finding.related.join(', ')})` : '';
        const suggested = finding.suggestedEntry !== undefined ? ` | suggestedEntry: ${finding.suggestedEntry}` : '';
        return `${index + 1}. [${finding.problem}] ${finding.id}${related} — ${finding.note} — suggest: ${finding.suggest}${suggested}`;
    });
    return [
        `Memory review found ${findings.length} issue(s). Fix each by calling memory-update (id + suggestedEntry) or memory-delete (id; rules need confirm: true).`,
        '',
        ...lines,
    ].join('\n');
}
