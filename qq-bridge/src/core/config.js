// 配置加载 + 会话状态持久化
// state 为模块内单例：loadState 会整体重赋值，saveState 落盘；bridge.js 通过 import 活绑定共享同一实例。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE_DIR, STATE_FILE } from '../lib/paths.js';
import { readJsonSafe } from '../lib/json-fs.js';
import { log } from '../lib/log.js';
import { normalizeOwnerQQ, normalizeIdList } from '../lib/config.js';

export function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  // 命名迁移兼容：老配置文件里是 socialV2 键 → 归一为 social
  if (typeof file.socialV2 === 'object' && file.socialV2 !== null && file.social === undefined) file.social = file.socialV2;
  const cfg = {
    dsh: {
      // 默认指向“内置隔离 DSH”实例（QQ-Bridge\.runtime\dsh-isolated-home，端口 10721），
      // 不写死本机路径；config.json 或环境变量 QQB_DSH_BASE_URL 可覆盖。
      baseUrl: process.env.QQB_DSH_BASE_URL || 'http://127.0.0.1:10721',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      reasoningEffort: 'max',
      ...(file.dsh ?? {})
    },
    /* 【2026-09-19 主人要求】「一个会话永久使用，但别让上下文堆积」——
     * 桥侧不自己动 DSH 的历史（DSH 的会话是内存事件溯源，外部改文件只会撞 seq gap），
     * 而是把**压缩策略**写进 DSH home 的 cordis.patch.yml（home 级 patch 层），交给 DSH 自己的
     * compaction-basic + tool-result-pruner 执行：
     *   · 先剪掉超大工具结果（剪枝不发模型请求、聊天记录一字不动）；
     *   · 剪枝后仍超阈值 / 提供方报上下文溢出，才把最老一段摘要成 <compacted-summary>。
     * 阈值用**比例**（相对已路由模型的 contextWindow），换模型自动等比缩放 —— 也是 DSH 的硬要求：
     * retainRatio 必须小于 thresholdRatio，否则插件直接拒绝加载。字段含义与取值见 lib/dsh-compaction.js。 */
    dshCompaction: {
      enabled: true,             // 关掉 = 不写这段（回到 DSH 默认：窗口 80% 才压缩 ≈ 等于不压缩）
      /* 【2026-09-20 主人实测账单后从 0.12/0.03 收到 0.08/0.02】
       * 第一次修（0.06 → 0.12）解决的是"每一步都压缩"（阈值被固定开销顶穿，114 步触发 46 次摘要、
       * 每步之间多花 15~20 秒）。但 0.12 让上下文长期停在 ~11.7 万 token，主人实测"一句话 1 分钱，不划算"。
       * 把 token-usage.jsonl 逐条算下来，花费几乎完全正比于**上下文大小**（缓存命中价 ≈ 全价的 0.1，
       * 而每次请求未缓存的只有 1.4k~3.4k token，工具结果的修剪已经在起作用）：
       *     上下文 0~40k   → 约 0.41 分/条
       *     上下文 40~70k  → 约 0.56 分/条
       *     上下文 70~90k  → 约 0.79 分/条
       *     上下文 90~110k → 约 0.82 分/条
       *     上下文 110~140k→ 约 1.04 分/条   ← 主人看到的"一句话 1 分钱"
       * 所以阈值收到 0.08（1M 窗口 ≈ 8.4 万 token）：上下文稳定在 8 万上下 ≈ 0.7 分/条；
       * 保留 2% ≈ 2.1 万，压缩后 ≈ 2.1 万 + 固定开销 2.75 万 = 4.9 万，**离阈值还有 3.5 万余量**，
       * 不会退回"压完立刻又压"。下限 MIN_THRESHOLD_RATIO 同步钉在 0.08。 */
      thresholdRatio: 0.08,      // 上下文用到窗口的多少比例就开始治理（0.08 × 1M ≈ 8.4 万 token）
      retainRatio: 0.02,         // 最近多少比例的上下文**逐字保留**（必须小于 thresholdRatio）
      /* 【2026-09-19 主人反馈"模型像是不记得工具怎么调、也忘了规矩"之后从 1500 抬到 8192】
       * 1500 太狠：`qq_get_prompt` 返回的整段协议、会话状态、角色卡、贴纸清单这些**工具结果**动辄
       * 好几 KB，一律被剪成「开头 900 字 + 剪枝标记 + 结尾 300 字」——模型等于只看到个零头，越用越像
       * "不知道工具叫什么、不知道规矩"。8192 与 DSH 插件的默认值一致：整段唤醒协议 / 状态快照都能完整留下，
       * 真正超大的（图片 base64、超长历史）照旧被剪，不会把上下文撑爆。 */
      toolResultMaxChars: 8192,  // 单个工具结果超过多少字符就被剪成「开头 + 剪枝标记 + 结尾」
      summarizationProvider: '', // 摘要用哪个服务商（留空 = 跟主模型，能复用热前缀最便宜）
      summarizationModel: '',    // 摘要用哪个模型（留空 = 跟主模型）
      ...(file.dshCompaction ?? {})
    },
    napcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.napcat ?? file.napcat ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'default', // 唯一模式（default=default）默认预设
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    adminQQ: normalizeIdList(file.adminQQ ?? []),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    // 【2026-09-19】分侧放行开关：某个类的名单为空时，单独放开这一类（群严、私聊松的常见配置）。
    // 恒为布尔（缺省 false）—— 界面按"配置里存在的键"渲染，不给默认值的话这两个勾选框不会出现。
    allowAllPrivate: file.allowAllPrivate === true,
    allowAllGroups: file.allowAllGroups === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'default',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'default',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 30000,           // 默认沉睡前观察窗口：只等 30 秒，不傻等 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        /* 【2026-09-15 主人反馈"活跃模式配置看着就是我的潜水配置，那它和潜水有何区别"】
         * 确实有这个问题：转活跃以前只强制 anyMessage/infinite，**概率仍沿用潜水时代的 0.05** ——
         * 于是"活跃"= 每 ~20 条消息才随机醒一次，观感和潜水差不多。
         * 现在给活跃模式一个自己的概率：切到 active 时若没显式指定 probability 就用它。 */
        activeProbability: 0.3,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: 'When thinking about diving, judge smartly instead of waiting blindly: if the other person said goodnight / the topic is over / you already answered everything needed, wrap up right away (qq_set_wake_config / qq_mark_read). Only wait briefly when you want to confirm whether the other person is done (qq_wait_for_messages, within 30s). Recommended dive length 5-120 minutes, normal-message probability 0.05. Keep @ / name / keyword / question wake triggers on. To wait for a specific person, add triggers.speakerIds.',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        // —— 打字节拍：只保留"按字数"一种（2026-09-15 主人定稿）——
        // 批内首条秒回；第 2 条起 = 本条字数 × linearPerCharMs，±linearJitterRatio 抖动，
        // 夹在 [linearMinMs, linearCapMs]。linearEnabled=false = 完全不延迟。
        linearEnabled: true,
        linearPerCharMs: 150,
        linearMinMs: 250,
        linearCapMs: 4000,
        linearJitterRatio: 0.25,
        linearResetMs: 60000,
        longGapProbability: 0.25,
        longGapMinMs: 8000,
        longGapMaxMs: 18000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 15000,
        recommendedHint: 'Normal chat: 1-4 bubbles per reply, 1.2-4 s between bubbles like typing; occasionally (25%) pause 8-20 s like thinking; never spam.',
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      // 【2026-09-15 主人要求】私聊「不抢话」：看对方打字状态、等 ta 打完再回；
      // 对方不停发消息时打字状态保持连续；用概率骰子决定要不要插话（智能接话）；
      // 等待期间的消息全部排队 → 合并成一次注入（省注入轮数）。详见 core/typing-hold.js
      typing: {
        enabled: true,
        holdMaxMs: 12000,            // 最多等这么久（到点就插话，避免遇到"打字没完"的人一直不回复）
        refreshOnMessageMs: 5000,    // 收到一条消息后，把"对方在打字"再续这么多毫秒（QQ 输入事件不可靠）
        breakProbability: 0.15       // 每次唤醒的插话概率（0=只等他停，1=从不等待）
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        // 【2026-09-15】发表情概率从"提示词软引导"改成**桥侧掷骰**（与语音同一套机制，见 core/send-dice.js）：
        // 每次唤醒桥掷一次，把 [Meme] dice HIT/MISS 写进唤醒正文；sendCooldownMs 管同一会话的连发。
        sendProbability: 0.3,      // 0~1；0 = 不主动发表情（只有被明确要求才发）
        sendCooldownMs: 180000,    // 刚发过表情包后这段时间内不再抽中（默认 3 分钟）
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      // 内置表情包（meme packs，多包）：详见 mcp-napcat-safe.js 顶部那段注释。
      // 一份包 = 一个目录（manifest.json + index.db + memes/<tag>/<文件名>），可能出现在：
      //   ① <runtime>/meme/<packId>（出厂）② <runtime>/meme-packs/<packId>（后装/上传）
      //   ③ <角色库根>/<角色slug>/meme-packs/<packId>（角色专属）
      meme: {
        enabled: true,             // 总开关：false = qq_meme_search / qq_send_meme 都不注册（模型看不到）
        packs: [],                 // 只搜这些包（包 id 数组）；空 = 出厂包 + 后装包 + 角色包全都搜
        personaPacks: {},          // 角色 slug -> [包 id]；当前角色绑定的包排最前（角色包优先、全局包回落）
        activePersona: ''          // 当前导入进 persona.md 的角色 slug（管理端「角色库导入」时写）
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      // 【2026-09-16】上下文与轮换的两个"窗口"旋钮：
      //   contextWindow = 新会话**首轮**往提示里贴多少条历史；resetWindow = **轮换后首轮**贴多少条。
      // 两者语义不同（一个是历史窗口大小，一个是"只此一次"的加长窗口），别当成重复项；
      // 读取处见 wake-send.js：ctxBase = max(6, contextWindow||12)、resetBase = max(ctxBase, resetWindow||24)、
      // 实际条数 = min(60, resetBase)（轮换首轮）/ min(24, ctxBase)（普通首轮）。
      // 这里补上缺省值只是为了让"没写过这两个键的旧配置"也有一份明确的默认，
      // 读取处本来就有 || 兜底，所以改不改行为一致（注意外层 `...(file.social ?? {})` 是浅合并）。
      context: {
        recentLimit: 100,          // 每会话内存里保留的最近消息条数（超出丢最旧；历史都已落 SQLite，可查）
        unreadLimit: 30,           // 未读队列上限（超出丢最旧）
        contextWindow: 20,         // 新会话首轮贴给模型的最近消息条数（普通首轮上限 24）
        resetWindow: 24            // 轮换后首轮贴给模型的条数（只此一次；取 max(contextWindow, 它)，上限 60）
      },
      // 自动轮换（会话上下文换新）：wake-send.js 里 rotateThreshold / prewarmAhead 读的就是这两个键，
      // 缺省分别是 10 / 3。以前这里没有默认块，全新安装的 config.json 里也就没有这两个键 ——
      // 管理端「上下文与轮换」卡只画配置里存在的键，于是新人**看不到轮换旋钮**（同一类"旋钮没接线"）。
      // 【2026-09-18】wakeThreshold 由 12 调到 10：轮换得更勤一点，把单会话上下文压小。
      // 注意它只是"缺省值"——真正生效的是 config.json 里的值，而且读取处每轮现读、热加载原地合并，
      // 所以改配置文件对跑着的老会话立即生效（详见 wake-send.js 的 rotateThresholdOf 注释）。
      autoReset: {
        wakeThreshold: 10,         // 累计多少真实来回后换新会话（最小 5）
        prewarmAhead: 3,           // 到阈值前提前几轮预建并预热下一代会话（最小 1）
        /* 【2026-09-19 主人要求："一个会话永久使用、但不让上下文堆积，省掉每次切新会话的首轮 token"】
         * true = **不按轮数换会话**（wakeThreshold 失效，但保留作为参考值）；
         * 上下文改由隔离 DSH 自己的压缩治理（见 dshCompaction 段 + lib/dsh-compaction.js）：
         * 先剪掉超大工具结果（不发模型请求、聊天记录不动），聊天本身超阈值时才把最老一段摘要成
         * <compacted-summary>。谨慎开启的两点理由：
         *   ① agentPreset 只在建会话时绑定 —— 换 preset 后老会话仍用旧提示词（改 persona.md 不受影响，
         *      它是每轮注入的正文）；② 万一压缩配置被写坏，单会话会一直长下去，所以留了 wakeThreshold 兜底。 */
        permanent: false
      },
      ...(file.social ?? {})
    }
  };

  // social.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.social.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    // 语音能力（MiMo TTS/ASR）：默认开启，但 config 里 voice.enabled 不打开时工具仍会被语音模块拒绝
    sendVoice: true,
    transcribeVoice: true,
    ...(cfg.social.tools ?? {})
  };

  // social.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.social.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    // 注意：collect 必须留在下面的用户样式展开之后，否则用户自己的 collect 会整体覆盖深合并结果
    // （缺失的子项不再回填默认值）。此处以前还写过一份完全相同的 collect，已删除。
    ...(cfg.social?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.social?.sticker?.collect) ?? {})
    }
  };

  // social.meme 也要深合并：旧 config.json 完全没有这一段时，不能因为外层 spread 丢掉默认值；
  // personaPacks 是"角色 -> 包 id 数组"的映射，单独再合一层，避免用户只写一个角色就把别的角色顶掉。
  // （packs 归一化放在对象字面量之后做：同一个键在字面量里出现两次会被 check-scope 判为重复键。）
  const rawMeme = cfg.social?.meme ?? {};
  cfg.social.meme = {
    enabled: true,
    activePersona: '',
    ...rawMeme,
    personaPacks: { ...((rawMeme.personaPacks) ?? {}) }
  };
  cfg.social.meme.packs = (Array.isArray(rawMeme.packs) ? rawMeme.packs : []).map(String).filter(Boolean);

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
export let state = { sessions: {} };

export function loadState() {
  const loaded = readJsonSafe(STATE_FILE, null);
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
}

export function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── 配置热加载（管理端保存即时生效） ─────────────────────────────────────────
// 【为什么需要】桥接启动时 `const cfg = loadConfig()` 只读一次，而这个对象被 initXxxCore(cfg) 注入到十几个
// 模块里（social/mux/wake-send…）。管理器改 config.json 后桥接毫无感知，更要命的是桥接自己还有 **10 处**会把内存
// 里的旧 cfg **写回** config.json（console-server.js 5 处 + mux.js 4 处 + tunables.js 1 处），
// 于是管理端的改动不但不生效，还会被**回滚**掉 —— 这就是"管理端改的模型/配置根本到不了 DSH 里"的根因。
// 修法：in-place 热加载（下两函数）+ 桥接启动时挂上监听。
export function configFilePath() { return path.join(ROOT, 'config.json'); }

/**
 * 把 next 合并进 target **原地**（不换对象引用，旧引用继续有效）。
 * @returns {string[]} 变化的字段路径（'a.b.c'），无变化返回 []
 */
export function applyConfigInPlace(target, next, pathPrefix = '') {
  const changed = [];
  for (const key of Object.keys(next)) {
    const nv = next[key];
    const tv = target[key];
    const p = pathPrefix ? pathPrefix + '.' + key : key;
    if (nv && typeof nv === 'object' && !Array.isArray(nv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      changed.push(...applyConfigInPlace(tv, nv, p));
    } else if (JSON.stringify(tv) !== JSON.stringify(nv)) {
      target[key] = nv;
      changed.push(p);
    }
  }
  // loadConfig 会补齐全部默认键，因此 target 里多出来的键说明用户已从文件中删除 → 同步删掉，避免用旧值
  for (const key of Object.keys(target)) {
    if (!(key in next)) { delete target[key]; changed.push((pathPrefix ? pathPrefix + '.' : '') + key + '(删除)'); }
  }
  return changed;
}

/**
 * 监听 config.json 并热加载到 target（管理器保存 / 手工编辑都会触发）。
 * 自己写盘时也会收到事件，但此时文件与内存一致 → changed 为空 → 不触发 onChange，不会自激循环。
 *
 * 【2026-09-19 修：热加载"看起来装了、其实早就死了"】
 *   原来写的是 `fs.watch(config.json)` —— Linux 上它盯的是**那个 inode**。而管理端保存服务端配置走的是
 *   「临时文件 → 备份 → mv 原子替换」，**rename 一覆盖，inode 就换了**，监视器从此盯在一个已被 unlink 的
 *   旧 inode 上：**之后任何改动都不再触发事件**，直到桥重启为止。
 *   线上实测（VPS，ZFS 根）：桥 07:34 启动时装好监视，07:39:54 管理端做了一次 mv 覆盖；此后
 *   「原地写」与「原子替换」两种写法都被实验证伪 —— 桥日志里一条 `已热加载` 都没有（同一台机器上
 *   单独测 fs.watch 是好的：原地写给 change、mv 覆盖给 change+rename，坏的只是"文件级 watch 被 rename 弄失聪"）。
 *   后果正是主人反复遇到的"管理端改了配置没生效 / 白名单移除了还在唤醒"。
 *
 *   现在的双保险：
 *     ① **监听目录**（`fs.watch(dir)`，按文件名过滤）—— 目录 inode 不会因为文件被替换而失效，
 *        mv 覆盖会给出 rename 事件，实测可靠；
 *     ② **2 秒轮询兜底**（`fs.watchFile`，stat 比较）—— 跨 inode、跨文件系统都能发现变化。
 *   事件驱动依旧毫秒级，轮询只是保险，成本可忽略。
 * @returns {() => void} 停止监听
 */
export function watchConfigFile(target, { onChange, debounceMs = 400 } = {}) {
  const file = configFilePath();
  const dir = path.dirname(file);
  const base = path.basename(file);
  let timer = null;
  let dirWatcher = null;
  const reload = () => {
    timer = null;
    let next;
    try { next = loadConfig(); } catch (e) { log('[config] 热加载失败（保留旧配置）:', e?.message ?? e); return; }
    const changed = applyConfigInPlace(target, next);
    if (!changed.length) return;
    log(`[config] config.json 已热加载，变更字段: ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ` …共 ${changed.length} 项` : ''}`);
    try { onChange?.(changed); } catch (e) { log('[config] 热加载回调失败:', e?.message ?? e); }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(reload, debounceMs); };

  try {
    dirWatcher = fs.watch(dir, (_ev, name) => {
      const n = String(name ?? '');
      // 只认 config.json 本身和它的临时/备份邻居，别让目录里其它文件的写入白唤醒一次 reload
      if (!n || n === base || n.startsWith(base + '.')) schedule();
    });
    dirWatcher.on('error', (e) => log('[config] config.json 目录监听出错:', e?.message ?? e));
    log('[config] 已监听 config.json（目录监听 + 2s 轮询兜底）：管理端保存后无需重启桥接即生效');
  } catch (e) { log('[config] 无法监听 config.json 所在目录:', e?.message ?? e); }
  try { fs.watchFile(file, { interval: 2000 }, () => schedule()); } catch (e) { log('[config] 轮询兜底启动失败:', e?.message ?? e); }

  return () => {
    try { if (timer) clearTimeout(timer); dirWatcher?.close(); fs.unwatchFile(file); } catch { /* 忽略 */ }
  };
}
