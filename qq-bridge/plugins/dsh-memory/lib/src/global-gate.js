/**
 * global 记忆的准入门禁(gate)、候选解析与三泛型 team 的源拼装 / fan-out 编排
 * (纯逻辑,不 import cordis;docs/global-layer-design.md §4、§7、§8)。
 *
 * 三个泛型的隔离面在**源拼装层**:extract<global-type1> 只见文档切块,
 * review<global-type1> 复用 review.ts 注入 global 目录条目,
 * review<global-type2>(提升评审)只见 user/project 条目(host 级 registry 口径)。
 * 模型调用以函数参数注入,由 index.ts 绑定 ctx.llm;隔离是代码拼装保证的,
 * 不是提示词自律(§8 G2)。
 *
 * @module dsh-memory/global-gate
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { agentsHome, dshHome, loadDir } from './memory-file.js';
import { loadRegistry } from './registry.js';
import { DOMAINS, MAX_LESSON_CHARS } from './schema.js';
import { partitionNodes, warmUp } from './team.js';
import { entryLine } from './render.js';
/**
 * global 候选条目的最小准入长度(字符数)。低于此值的条目「太小/太碎」,
 * 缺跨项目指导意义(§7.1「大小适度」)。
 * 哨兵值而非调优旋钮(口径由设计钉死),故为常量而非配置项,
 * 类比 {@link ../extract.js} 的 MIN_TRANSCRIPT_CHARS 先例。
 */
export const MIN_GLOBAL_ENTRY_CHARS = 20;
/**
 * 单次提升 / 抽取的 pass 候选写入上限(g):pass 候选按稳定序
 * (节点顺序 → 行出现顺序)取前 g,不引入模型自评质量排序(§7.1)。
 * 哨兵值而非调优旋钮(口径由设计钉死),故为常量而非配置项。
 */
export const GLOBAL_PROMOTE_MAX = 10;
/**
 * 抽取文档的字节上限(1 MiB):服务端 / CLI 读入后的 Buffer.byteLength 硬校验
 * (§4.1,1 MiB 文档不能作为单 source 直接喂 v4-flash)。
 */
export const GLOBAL_DOC_MAX_BYTES = 1024 * 1024;
/**
 * 确定性 gate 硬查(§7.1「大小适度」+「类型合法」;跨项目通用性 / 低易变性 /
 * 无机密是提示词判据,无法确定性检查)。抽取 / 提升 / 导入三条路径的**确认阶段
 * 必须重跑**(客户端 verdict 仅供回显,确认不绕过 gate)。
 * @param input - 候选最小字段面。
 * @returns 结论。
 */
export function checkGlobalGate(input) {
    if (input.type !== 'rules' && input.type !== 'lessons') {
        return { pass: false, reason: `type "${input.type}" is not rules/lessons` };
    }
    if (!DOMAINS.includes(input.domain)) {
        return { pass: false, reason: `domain "${input.domain}" is not a known domain` };
    }
    if (input.scope.trim().length === 0) {
        return { pass: false, reason: 'scope is empty' };
    }
    if (input.entry.length < MIN_GLOBAL_ENTRY_CHARS) {
        return { pass: false, reason: `entry has ${input.entry.length} chars, below the ${MIN_GLOBAL_ENTRY_CHARS} minimum` };
    }
    if (input.entry.length > MAX_LESSON_CHARS) {
        return { pass: false, reason: `entry has ${input.entry.length} chars, above the ${MAX_LESSON_CHARS} maximum` };
    }
    return { pass: true };
}
/** 把 `-` / 空白归一化为缺省(与 extract.ts 的 parseExtraction 同口径)。 */
function normalizePath(value) {
    return value === undefined || value.length === 0 || value === '-' ? undefined : value;
}
/**
 * 解析一个 global 节点输出的 7 段候选行(容错:非法行丢弃,不抛)。
 *
 * 协议(§4.2):一行一条,格式 `type|domain|scope|entry|entryPoint|references|verdict|理由`,
 * verdict ∈ pass/reject,理由字段不含 `|`。type 非法、domain 非法、scope/entry 空白、
 * verdict 非法的行丢弃;不做长度上限(由 {@link checkGlobalGate} 硬查)。返回全部
 * 合法行(含 reject,供回显);reject 绝不落盘由聚合 / 写盘侧保证。
 * @param text - 模型输出的原始文本。
 * @returns 解析出的候选(含 verdict)。
 */
export function parseGlobalCandidates(text) {
    const result = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.length === 0)
            continue;
        const segments = line.split('|').map(segment => segment.trim());
        const [type, domain, scope, entry, entryPointRaw, referencesRaw, verdict, reason] = segments;
        if (type !== 'rules' && type !== 'lessons')
            continue;
        if (domain === undefined || !DOMAINS.includes(domain))
            continue;
        if (scope === undefined || scope.length === 0 || entry === undefined || entry.length === 0)
            continue;
        if (verdict !== 'pass' && verdict !== 'reject')
            continue;
        const entryPoint = normalizePath(entryPointRaw);
        const references = normalizePath(referencesRaw);
        result.push({
            type,
            domain: domain,
            scope,
            entry,
            ...(entryPoint === undefined ? {} : { entryPoint }),
            ...(references === undefined ? {} : { references }),
            verdict,
            ...(reason === undefined || reason.length === 0 ? {} : { reason }),
        });
    }
    return result;
}
/**
 * 跨节点聚合候选:verdict=pass 才入集,按 entry 精确去重(rules/lessons 都去重),
 * 稳定序(节点顺序 → 行出现顺序)取前 max 条;超出部分不回显在此,由调用方
 * 提示「再运行可取更多」(§7.1)。
 * @param nodeResults - 各节点(或各 chunk × 类型)的解析结果,按执行顺序。
 * @param max - 写入上限(缺省 {@link GLOBAL_PROMOTE_MAX})。
 * @returns pass、去重、截断后的候选。
 */
export function aggregateGlobalCandidates(nodeResults, max = GLOBAL_PROMOTE_MAX) {
    const seen = new Set();
    const result = [];
    for (const group of nodeResults) {
        for (const candidate of group) {
            if (candidate.verdict !== 'pass')
                continue;
            if (seen.has(candidate.entry))
                continue;
            seen.add(candidate.entry);
            result.push(candidate);
            if (result.length >= max)
                return result;
        }
    }
    return result;
}
/**
 * 把文档文本预切成多个记忆源(§4.2):按 maxChars 切块,边界优先
 * 段落(`\n\n`)→ 句末(。.!? 等)→ 换行 → 硬切;不丢字符,非空文本至少 1 个 source。
 * partitionNodes 是打包器不是切分器(超容量单源独占一个节点、绝不切分),
 * 大文档必须由本函数预先切块。
 * @param text - 文档全文。
 * @param maxChars - 单块字符上限(= maxNodeKb × 1000)。
 * @returns 切块后的记忆源列表(空文本返回空)。
 */
export function chunkDocument(text, maxChars) {
    if (text.length === 0)
        return [];
    const sources = [];
    let rest = text;
    let index = 0;
    while (rest.length > 0) {
        index += 1;
        if (rest.length <= maxChars) {
            sources.push({ id: `chunk-${index}`, text: rest });
            break;
        }
        const window = rest.slice(0, maxChars);
        const para = window.lastIndexOf('\n\n');
        let sentence = -1;
        for (const marker of ['。', '.', '!', '?', ';', '！', '？', '；']) {
            sentence = Math.max(sentence, window.lastIndexOf(marker));
        }
        const newline = window.lastIndexOf('\n');
        let cutAt = maxChars;
        if (para > 0)
            cutAt = para + 2;
        else if (sentence > 0)
            cutAt = sentence + 1;
        else if (newline > 0)
            cutAt = newline + 1;
        sources.push({ id: `chunk-${index}`, text: rest.slice(0, cutAt) });
        rest = rest.slice(cutAt);
    }
    return sources;
}
/**
 * extract<global-type1> 的源拼装:仅由用户提供的文档切块构成
 * (§8 隔离面;G2 测试锁「sources 只来自文档切块」)。
 * @param text - 文档全文。
 * @param maxChars - 单块字符上限。
 * @returns 记忆源列表。
 */
export function globalExtractSources(text, maxChars) {
    return chunkDocument(text, maxChars);
}
/**
 * review<global-type2>(提升评审)的源条目:两个固定用户根经 basename 合并
 * (dsh 覆盖 agents,与召回同语义)+ registry 全部仍存在的 project 根
 * (global 跳过;已消失的根无数据可读)(§7.3、§8 隔离面)。
 * @returns 全部 user/project 条目(只读;提升绝不删改源条目)。
 */
export function promoteSourceEntries() {
    const byBasename = new Map();
    for (const dir of [join(agentsHome(), 'lmemory'), join(dshHome(), 'lmemory')]) {
        for (const file of loadDir(dir))
            byBasename.set(basename(file.jsonlPath), file);
    }
    const files = [...byBasename.values()];
    for (const entry of loadRegistry().roots) {
        if (entry.kind !== 'project' || !existsSync(entry.root))
            continue;
        files.push(...loadDir(entry.root));
    }
    return files.flatMap(file => [...file.entries]);
}
/** 把提升评审源条目转成节点源(每条一个源,文本带 id,供模型照抄整行)。 */
function promoteSourcesFor(entries) {
    return entries.map(entry => ({ id: entry.id, text: entryLine(entry) }));
}
/**
 * 计算提升评审的执行计划(分区,不发调用):节点数 = ceil(总大小 / 每节点容量),
 * 供 CLI / WEB 在确认前回显预估成本(§7.3)。
 * @param entries - 提升源条目。
 * @param maxNodeKb - 每节点容量上限(Kb)。
 * @returns 执行计划。
 */
export function resolvePromotePlan(entries, maxNodeKb) {
    const sources = promoteSourcesFor(entries);
    return { nodeCount: partitionNodes(sources, maxNodeKb).length, sources };
}
/**
 * extract<global-type1> fan-out:每个 chunk 并行调 rules / lessons 两型各一次
 * (extractBoth 形态),逐 chunk 汇总解析并聚合(§4.2)。单 chunk 两型全失败 → 告警
 * 跳过该 chunk;全部 chunk 两型全失败才抛「all extractors failed」(LLM 完全不可用)。
 * 每个节点的输出只保留其负责 type 的行。
 * @param chunks - {@link globalExtractSources} 的切块。
 * @param rulesFn - rules 抽取节点调用器(模型注入)。
 * @param lessonsFn - lessons 抽取节点调用器(模型注入)。
 * @param onNodeFailure - 节点失败告警回调(注入)。
 * @returns pass、去重、截断后的候选(≤ {@link GLOBAL_PROMOTE_MAX})。
 */
export async function runGlobalExtractFanOut(chunks, rulesFn, lessonsFn, onNodeFailure) {
    if (chunks.length === 0)
        return [];
    const groups = [];
    let failedChunks = 0;
    for (const chunk of chunks) {
        const [rules, lessons] = await Promise.allSettled([rulesFn(chunk.text), lessonsFn(chunk.text)]);
        if (rules.status === 'rejected' && lessons.status === 'rejected') {
            failedChunks += 1;
            onNodeFailure('rules', rules.reason);
            onNodeFailure('lessons', lessons.reason);
            continue;
        }
        if (rules.status === 'rejected')
            onNodeFailure('rules', rules.reason);
        if (lessons.status === 'rejected')
            onNodeFailure('lessons', lessons.reason);
        groups.push([
            ...(rules.status === 'fulfilled' ? parseGlobalCandidates(rules.value).filter(candidate => candidate.type === 'rules') : []),
            ...(lessons.status === 'fulfilled' ? parseGlobalCandidates(lessons.value).filter(candidate => candidate.type === 'lessons') : []),
        ]);
    }
    if (failedChunks === chunks.length)
        throw new Error('memory global extract: all extractors failed');
    return aggregateGlobalCandidates(groups);
}
/**
 * review<global-type2>(提升评审)fan-out:分区 → 并发逐节点严格评估 → 解析 →
 * 聚合(warmUp fan-out 容错模式;§7.3)。单节点失败告警跳过,其余节点照常;
 * 全部节点失败才抛「all nodes failed」。空源(0 节点)直接返回空,不发调用。
 * @param entries - 提升源条目({@link promoteSourceEntries} 的输出)。
 * @param maxNodeKb - 每节点容量上限(Kb)。
 * @param nodeFn - 单节点调用器(模型注入)。
 * @param onNodeFailure - 节点失败告警回调(注入)。
 * @returns pass、去重、截断后的候选(≤ {@link GLOBAL_PROMOTE_MAX})。
 */
export async function runGlobalPromoteFanOut(entries, maxNodeKb, nodeFn, onNodeFailure) {
    const team = warmUp(promoteSourcesFor(entries), maxNodeKb);
    if (team.nodes.length === 0)
        return [];
    const settled = await Promise.allSettled(team.nodes.map(node => nodeFn(node)));
    const groups = [];
    let failures = 0;
    settled.forEach((result, index) => {
        if (result.status === 'rejected') {
            failures += 1;
            onNodeFailure(`promote-${index + 1}`, result.reason);
            return;
        }
        groups.push(parseGlobalCandidates(result.value));
    });
    if (failures === team.nodes.length)
        throw new Error('memory global promote: all nodes failed');
    return aggregateGlobalCandidates(groups);
}
/**
 * extract<global-type1> rules 节点 system prompt(§4.2、§7.1):只含 global 准入
 * 标准与输出格式,不含 user/project 层内容(G2 测试锁)。
 */
export const GLOBAL_EXTRACT_RULES_SYSTEM = '你是 global 长期记忆「用户偏好(rules)」抽取器。给定一段用户提供的文档,提炼其中值得跨项目长期记住的偏好、习惯、格式规范、技术栈限制、共识、约束。global 记忆是用户 host 内跨项目共享的记忆,准入标准(缺一不可):(1) 跨项目/跨人通用——事实不绑定单一项目实现细节,换项目、换人仍有指导意义;(2) 低易变性——不是进度、待办、临时状态或本次会话的流水账;(3) 大小适度——entry 20~300 字;(4) 无机密——不含密钥、凭据、身份隐私。输出候选与结论,一行一条,格式「type|domain|scope|entry|entryPoint|references|verdict|理由」:type 填 rules;domain 从已知领域枚举中选最贴切的一个(如 DurablePrefs、CodeFacts、Style);scope 填这条记忆影响的具体子系统/模块(自由文本);entry 填一句话条目(不含竖线 |);entryPoint 填文档中出现的真实文件路径或相对 workspace 根的相对路径,references 填相关参考文件路径,没有对应路径时填 -;verdict 填 pass 或 reject(不满足任一准入标准必须 reject);理由一句话说明(不含竖线 |)。没有值得记的输出空。';
/**
 * extract<global-type1> lessons 节点 system prompt(§4.2、§7.1):同上,
 * 提炼踩坑 / 环境限制 / API 变更 / 根因结论。
 */
export const GLOBAL_EXTRACT_LESSONS_SYSTEM = '你是 global 长期记忆「经验教训(lessons)」抽取器。给定一段用户提供的文档,提炼其中值得跨项目长期记住的踩过的坑、环境限制、API 变更、bug 根因结论。global 记忆是用户 host 内跨项目共享的记忆,准入标准(缺一不可):(1) 跨项目/跨人通用——事实不绑定单一项目实现细节,换项目、换人仍有指导意义;(2) 低易变性——不是进度、待办、临时状态或本次会话的流水账;(3) 大小适度——entry 20~300 字;(4) 无机密——不含密钥、凭据、身份隐私。输出候选与结论,一行一条,格式「type|domain|scope|entry|entryPoint|references|verdict|理由」:type 填 lessons;domain 从已知领域枚举中选最贴切的一个(如 PastFixes、PromotedPitfalls、CodeFacts);scope 填这条记忆影响的具体子系统/模块(自由文本);entry 填一句话条目(不含竖线 |);entryPoint 填文档中出现的真实文件路径或相对 workspace 根的相对路径,references 填相关参考文件路径,没有对应路径时填 -;verdict 填 pass 或 reject(不满足任一准入标准必须 reject);理由一句话说明(不含竖线 |)。没有值得记的输出空。';
/**
 * review<global-type2>(提升评审)节点 system prompt(§7.3):只描述「从 user/project
 * 条目总结提炼 global 候选」,非常严格(太小 / 太局限 / 缺乏跨项目跨人通用性 /
 * 易变性高一律 reject);不含其他层内容(G2 测试锁)。
 */
export const GLOBAL_PROMOTE_SYSTEM = '你是 global 记忆「提升评审」节点。给定一组来自用户层与项目层的长期记忆条目(每条一行,格式「[id|type|domain|scope] 条目文本」),非常严格地评估哪些内容值得总结提炼为 global 记忆——global 是用户 host 内跨项目共享的记忆,准入标准(缺一不可):(1) 跨项目/跨人通用——事实不绑定单一项目实现细节,换项目、换人仍有指导意义;(2) 低易变性——不是进度、待办、临时状态或流水账;(3) 大小适度——20~300 字;(4) 无机密——不含密钥、凭据、身份隐私;(5) 不是原条目拷贝——必须通用化、去项目细节,总结提炼。太小、太局限、缺乏跨项目跨人通用性、易变性高的条目一律 reject。输出候选与结论,一行一条,格式「type|domain|scope|entry|entryPoint|references|verdict|理由」:type 填 rules 或 lessons;domain 从已知领域枚举中选最贴切的一个;scope 填这条记忆影响的具体子系统/模块(自由文本);entry 填一句话条目(不含竖线 |);entryPoint/references 从原条目继承,没有对应路径时填 -;verdict 填 pass 或 reject;理由一句话说明(不含竖线 |)。没有值得提升的输出空。';
