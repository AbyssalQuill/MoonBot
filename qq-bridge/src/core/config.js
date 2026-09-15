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
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
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
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20
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
 * @returns {() => void} 停止监听
 */
export function watchConfigFile(target, { onChange, debounceMs = 400 } = {}) {
  const file = configFilePath();
  let timer = null;
  let watcher = null;
  const reload = () => {
    timer = null;
    let next;
    try { next = loadConfig(); } catch (e) { log('[config] 热加载失败（保留旧配置）:', e?.message ?? e); return; }
    const changed = applyConfigInPlace(target, next);
    if (!changed.length) return;
    log(`[config] config.json 已热加载，变更字段: ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ` …共 ${changed.length} 项` : ''}`);
    try { onChange?.(changed); } catch (e) { log('[config] 热加载回调失败:', e?.message ?? e); }
  };
  try {
    watcher = fs.watch(file, () => { if (timer) clearTimeout(timer); timer = setTimeout(reload, debounceMs); });
    watcher.on('error', (e) => log('[config] config.json 监听出错:', e?.message ?? e));
    log('[config] 已监听 config.json：管理端保存后无需重启桥接即生效');
  } catch (e) { log('[config] 无法监听 config.json:', e?.message ?? e); }
  return () => { try { if (timer) clearTimeout(timer); watcher?.close(); } catch { /* 忽略 */ } };
}
