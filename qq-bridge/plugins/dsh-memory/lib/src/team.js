/**
 * v4-flash 记忆节点 team 的纯逻辑:节点分区、fan-out 召回、聚合。
 *
 * 本模块只定义结构与时序,不 import cordis,也不 import dsh-llm——模型调用
 * 以函数参数注入(`recallFn` / `rerank`),由 `index.ts` 用 `ctx.llm.stream`
 * 绑定到 `deepseek-v4-flash`。这样预热 / 分区 / 聚合都能在单测里用 mock
 * 验证,而无需真实 API key。
 *
 * @module dsh-memory/team
 */
/** 每节点容量上限换算:1 Kb = 1024 字节。 */
const KB = 1024;
/** 计算一段文本的字节大小(Node 的 UTF-8 语义)。 */
export function byteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}
/**
 * 把多段记忆源按容量贪心打包成节点:累加到接近 `maxNodeKb` 即封口。
 * 单段超过容量的源独占一个节点(允许该节点超容量)。
 * @param sources - 待分配的记忆源。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 分区后的节点。
 */
export function partitionNodes(sources, maxNodeKb) {
    const maxBytes = maxNodeKb * KB;
    const nodes = [];
    let current = [];
    let currentBytes = 0;
    const flush = () => {
        if (current.length === 0)
            return;
        nodes.push(makeNode(nodes.length + 1, current, currentBytes));
        current = [];
        currentBytes = 0;
    };
    for (const source of sources) {
        const size = byteLength(source.text);
        // 已有内容 + 新源会超容量(且已有内容非空)→ 封口后另起一节点。
        if (current.length > 0 && currentBytes + size > maxBytes)
            flush();
        current.push(source);
        currentBytes += size;
        // 单源独占节点:加入后若当前节点仅含该源且超过容量,立即封口。
        if (current.length === 1 && size > maxBytes)
            flush();
    }
    flush();
    return nodes;
}
function makeNode(id, sources, sizeBytes) {
    return {
        id: `node-${id}`,
        sizeBytes,
        text: sources.map(source => source.text).join('\n\n'),
    };
}
/** 解析一行召回结果为结构化投影;无 `[id|type|domain|scope]` 前缀时整行作为 entry(降级)。 */
export function parseRecallLine(line) {
    const trimmed = line.trim();
    const match = /^\[([^\]|]+)(?:\|([^\]|]+))?(?:\|([^\]|]+))?(?:\|([^\]]*))?\]\s*(.*)$/.exec(trimmed);
    if (match === null)
        return { entry: trimmed };
    const [id, type, domain, scope] = [match[1], match[2], match[3], match[4]];
    const entry = match[5] ?? '';
    if (id === undefined || id.length === 0)
        return { entry: trimmed };
    return {
        id,
        ...(type === undefined || type.length === 0 ? {} : { type }),
        ...(domain === undefined || domain.length === 0 ? {} : { domain }),
        ...(scope === undefined || scope.length === 0 ? {} : { scope }),
        entry,
    };
}
/** 去重键:有 id 的行按 id(唯一编号),否则按整行文本(降级)。 */
function lineKey(line) {
    return parseRecallLine(line).id ?? line.trim();
}
/** 按 id(或整行文本降级)精确去重(保持首次出现顺序)。 */
export function dedupe(candidates) {
    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
        const key = lineKey(candidate);
        if (key.length === 0 || seen.has(key))
            continue;
        seen.add(key);
        result.push(candidate.trim());
    }
    return result;
}
/**
 * 预热:把记忆源分配成节点 team(纯函数,不碰磁盘、不碰模型)。
 * @param sources - 全部记忆源(来自记忆文件)。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 就绪 team。
 */
export function warmUp(sources, maxNodeKb) {
    return { nodes: partitionNodes(sources, maxNodeKb), maxNodeBytes: maxNodeKb * KB };
}
/**
 * 召回:并发 fan-out 到每个节点 → 汇总 → 去重 → 重排序 → 截断到 topK。
 *
 * per-node 容错(robustness.md §2):单节点失败跳过并告警,其余节点结果照常聚合;
 * 全部节点失败才抛「all nodes failed」(LLM 完全不可用)。空 team(0 节点)直接返回空。
 * @param team - 已预热 team。
 * @param query - 召回查询。
 * @param recallFn - 单节点召回调用器(模型调用注入)。
 * @param rerank - 重排序调用器(模型调用注入;候选 ≤1 时跳过)。
 * @param topK - 返回的最大条目数。
 * @param onNodeFailure - 节点失败告警回调(注入)。
 * @returns 按相关度排序、按 id 去重后的条目整行(≤ topK;行格式见 render.entryLine)。
 */
export async function recall(team, query, recallFn, rerank, topK, onNodeFailure) {
    if (team.nodes.length === 0)
        return [];
    const settled = await Promise.allSettled(team.nodes.map(node => recallFn(node, query)));
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    for (const r of settled) {
        if (r.status === 'rejected') {
            const node = team.nodes[settled.indexOf(r)];
            onNodeFailure(node.id, r.reason);
        }
    }
    if (fulfilled.length === 0)
        throw new Error('memory recall: all nodes failed');
    const candidates = dedupe(fulfilled.flatMap(r => r.value));
    if (candidates.length === 0)
        return [];
    const ordered = candidates.length <= 1 ? candidates : await rerank(query, candidates);
    return ordered.slice(0, Math.max(0, topK));
}
