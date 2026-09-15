import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getBridgeConfig, saveBridgeConfig, saveActivityHours, getActivityTargets, resetSpeechRules, listCharacters, importCharacter, instanceAction, listProfiles, saveProfile, deleteProfile, getRemoteBridgeConfig, saveRemoteBridgeConfig, type CharacterEntry, type ConfigProfile, type ActivityTarget } from '../api';
import { TOOL_SCHEMA_CHARS, SLIM_PREFIX, charsToTokens } from '../tool-schema-chars';
import { ArrowLeft, Save, Upload, FileText, X, HelpCircle, Loader2, Coffee, Activity, Users, MessagesSquare, RotateCcw, Library, BookOpen, Terminal, Layers, Trash2, Check, Server, AlertTriangle, Mic } from 'lucide-react';
import NapcatTokensCard from '../components/NapcatTokensCard';
import NumInput from '../components/NumInput';

/** remote：连上服务器时把「服务端」那套传进来（配置读写服务端 /root/qq-bridge），null = 编辑本机 */
interface Props { onBack: () => void; onRefresh: () => void; onOpenLearning: () => void; onOpenPortrait: () => void; onOpenVoice: () => void; remote?: { id: string; name: string; host: string } | null; }

/* 【2026-09-12】隔离 DSH 里**实际生效**的模型段（settings.yaml 的 agent-default-model）。
 * 管理端保存模型配置时写的就是它；这里读回来只为两件事：
 *   ① 「推理档位」下拉里认得出 DSH 里已经配好的档位（off / xhigh / max … 不再被写死成低/中/高）；
 *   ② 在同一张卡里显示"DSH 当前是 xxx"，避免"我改的和它在用的不是一回事"。
 * 用模块级变量是因为 Field 是通用的深层组件，为一处提示把 hint 一层层透传只会更难维护。 */
let DSH_EFFECTIVE: { provider?: string; model?: string; reasoningEffort?: string } = {};

/* 【2026-09-13】每个服务商**实际可用的模型清单**（服务端从 DSH 自己的配置里读出来）：
 *   · 小米等 pi-ai 服务商 → 隔离 DSH 的 settings.yaml 里 `llm-pi-ai.providers.<id>.models`
 *   · deepseek-official → DSH 内置目录 (@deepseek-ai/dsh-llm-deepseek)
 * 管理端用它实现"切服务商就切模型列表"。*/
let DSH_MODELS: { providers: Record<string, Array<{ id: string; name?: string; vision?: boolean }>>; sources?: Record<string, string> } = { providers: {} };

/** 当前该看哪个服务商的模型列表：优先管理端下拉里选的那个，空则用 DSH 里实际生效的服务商 */
function modelListFor(provider: string) {
  const cat = DSH_MODELS.providers || {};
  if (provider && cat[provider]) return cat[provider];
  const eff = String(DSH_EFFECTIVE.provider || '');
  if (!provider && eff && cat[eff]) return cat[eff];
  return [];
}
function modelListSource(provider: string) {
  const src = (DSH_MODELS.sources || {})[provider];
  return src === 'settings.yaml' ? 'DSH 配置（settings.yaml）' : src === 'dsh-llm-deepseek' ? 'DSH 内置模型目录' : '出厂兜底表';
}
/** 服务商下拉：内置三项 + DSH 里已经配好的其它服务商（别人自己加过 pi-ai 服务商也能直接选） */
function providerChoices() {
  const known = [
    { id: '', label: '自动探测（用隔离 DSH 里已配置的服务商）' },
    { id: 'deepseek-official', label: 'DeepSeek 官方（deepseek-official）' },
    { id: 'xiaomi-token-plan-cn', label: '小米 MiMo（MiMo Pro）' },
  ];
  const extra = Object.keys(DSH_MODELS.providers || {}).filter((p) => !known.some((k) => k.id === p));
  return known.concat(extra.map((p) => ({ id: p, label: `${p}（DSH 里已配置）` })));
}

/* ---------- 界面文字：全中文，不带英文括号/版本前缀 ---------- */
const LABEL: Record<string, string> = {
  // 模型与推理
  baseUrl: 'DSH 地址', provider: '模型服务商', apiKey: 'API Key', model: '主模型',
  visionModel: '识图模型', reasoningEffort: '推理档位',
  // NapCat
  wsUrl: 'WebSocket 地址', wsAccessToken: 'WS 访问令牌', httpUrl: 'HTTP 地址', accessToken: 'HTTP 访问令牌',
  launcherPath: '启动器路径', homeDir: '运行目录', allowProcessControl: '允许进程控制',
  // 基础与会话
  agentPreset: '人设预设', workspaceTitle: '工作区名称', ownerQQ: '主人 QQ', adminQQ: '管理员',
  sessionCwd: '会话工作目录', ackMessage: '收到回执语', sendDelayMs: '发送间隔', questionTimeoutMs: '问题等待超时',
  consolePort: '本机服务端口', allowAllWhenEmpty: '名单为空时全部放行',
  // 名单
  private: '私聊', groups: '群聊',
  // 唤醒
  defaultMode: '默认模式', recommendedProbability: '普通消息唤醒概率', activeProbability: '活跃模式搭话概率', recommendedKeywords: '唤醒关键词',
  recommendedAtMention: '被 @ 唤醒', recommendedNameMention: '被喊名字唤醒', recommendedQuestion: '被提问唤醒',
  recommendedPoke: '被戳一戳唤醒', recommendMsgProbability: '消息触发概率', batchWindowMs: '连发合并窗口',
  maxWakePerMinute: '每分钟唤醒上限', maxWakePerHour: '每小时唤醒上限', maxWakePerMinutePrivate: '私聊每分钟上限',
  maxWakePerHourPrivate: '私聊每小时上限', sleepMinMs: '最短休眠', sleepMaxMs: '最长休眠',
  preSleepWaitEnabled: '睡前观察', preSleepWaitMs: '睡前观察时长', recommendedSleepMinMs: '推荐潜水下限',
  recommendedSleepMaxMs: '推荐潜水上限', recommendedDefaultInfinite: '默认无限潜水', noActionLimit: '无行动上限',
  maxWakeConfigReminders: '唤醒提醒上限', recommendedHint: '唤醒行为提示', mustReplyKeywords: '必回关键词',
  // 发送节奏（2026-09-15：只保留「按字数」一套，gap*/burstInterval* 已废弃，标签一并删掉）
  burstEnabled: '允许连发', burstMaxMessages: '单次最多条数',
  longGapProbability: '长停顿概率', longGapMinMs: '长停顿最短',
  longGapMaxMs: '长停顿最长', maxSendPerMinute: '每分钟发送上限', maxSendPerHour: '每小时发送上限',
  maxMessageChars: '单条最长字数', maxGapMs: '最大间隔',
  maxReplyChars: '回复最大字数', skipProbability: '跳过概率', surrenderProbability: '认输概率',
  linearEnabled: '按字数打字节拍', linearPerCharMs: '每个字的打字时间', linearMinMs: '两条气泡最小间隔',
  linearCapMs: '两条气泡最大间隔', linearJitterRatio: '打字速度抖动', linearResetMs: '静默后重新秒回',
  // 主动闲聊 / 旧社交参数
  proactiveEnabled: '主动闲聊', proactiveProbability: '主动闲聊概率', proactiveIdleThresholdMs: '空闲阈值',
  proactiveCheckMinMs: '检查下限', proactiveCheckMaxMs: '检查上限', idleWindowMs: '冷场判定', idleRetryProbability: '试探概率',
  idleRetryWaitMs: '试探等待', activeCheckMinMs: '活跃检查下限', activeCheckMaxMs: '活跃检查上限',
  activeReplyDelayMinMs: '回复延迟下限', activeReplyDelayMaxMs: '回复延迟上限', activeDurationEnabled: '活跃持续',
  activeDurationMinMs: '活跃持续下限', activeDurationMaxMs: '活跃持续上限', contextWindow: '上下文窗口',
  triggerProbability: '触发概率',
  // 主动闲聊卡实际字段（v2 键名）
  checkIntervalMinMs: '群聊检查间隔下限', checkIntervalMaxMs: '群聊检查间隔上限',
  idleThresholdMs: '冷场判定时长', probability: '主动找话题概率',
  privateCheckIntervalMinMs: '私聊检查间隔下限', privateCheckIntervalMaxMs: '私聊检查间隔上限',
  privateProbability: '私聊主动概率',
  // 上下文 / 轮换
  recentLimit: '内存最近条数', unreadLimit: '未读上限', wakeThreshold: '唤醒轮换阈值', prewarmAhead: '提前预建预热',
  // 表情包 / 等待
  stickerEnabled: '表情包', syncTtlMs: '同步缓存', maxListCount: '列表上限', includeInPrompt: '提示里附带',
  promptMaxStickers: '提示最多表情', collectEnabled: '自动收藏', maxPerMinute: '每分钟上限', maxPerHour: '每小时上限',
  maxRemarkChars: '备注字数上限', defaultMs: '默认等待', minMs: '最短等待', maxMs: '最长等待',
  defaultQuietMs: '默认静默', minQuietAfterNewMs: '新消息后最短静默', sendProbability: '发表情概率（桥侧掷骰）', sendCooldownMs: '表情包冷却（毫秒）',
  typingEnabled: '私聊等对方打完字', typingHoldMaxMs: '最多等多久（毫秒）', typingBreakProbability: '中途插话概率', typingRefreshOnMessageMs: '收到消息后续多久（毫秒）',
  unfinishedQuietMs: '话没说完时的静默', burstQuietMs: '对方连发时的静默',
  deepsleepGroups: '单群静默名单',
  // 智能体其他
  enabled: '启用', autoReplyCheckMs: '回复检查间隔', provideRecommendations: '给模型推荐参数',
  deepsleep: '全程静默群聊', autoFriendApproval: '自动同意好友', autoFriendGuard: '好友守卫',
  trustedCrossSessionUids: '可信跨会话账号', docxDailyQuotaChars: '文档每日额度',
  // 整路径优先（同一字段名在不同卡里含义不同）
  'social.enabled': '启用整套智能体',
  'social.sticker.enabled': '启用表情包',
  'social.sticker.collect.enabled': '自动收藏表情',
  'social.docx': 'Word 文档额度',
  dailyQuotaChars: '每日额度', interactionCount: '互动次数',
  // 通用
  security: '安全', interceptNotify: '拦截通知', burstIntervalMinMsLegacy: '',
  // 投递 / 省额度（2026-09-12 新增到管理端）
  steerEnabled: '在途回合注入', slimTools: '工具 schema 精简',
  // 回合保持（social.turnHold）：以前管理端完全没有露出来，主人问"投递与回合那张卡没错吧"时才发现
  turnHold: '回合保持', maxExchanges: '最多来回次数', idleCloseMs: '空闲关闭时长', maxWaitMs: '最长保持时长',
  requestBudgetMs: '每段等待预算', privateOnly: '只对私聊保持', keys: '限定会话',
};

/** MCP 工具中文名（工具与规则页） */
const TOOL_LABEL: Record<string, string> = {
  getPrompt: '查看人设与工具', getUnread: '读取未读消息', getRecent: '读取最近消息', socialState: '查看社交状态',
  sendGroup: '发群消息', sendPrivate: '发私聊消息', reply: '引用回复', sendBurst: '连发多条', sendMessage: '发送消息',
  waitMessages: '等待新消息', feedback: '反馈给主人', getMyRecent: '看我最近发言', getMessageDetail: '查看消息详情',
  getActiveMembers: '活跃成员', setWakeConfig: '设置唤醒条件', markRead: '标记已读', memory: '记忆读写',
  slangQuery: '查黑话', slangSubmit: '提交黑话', getImages: '查看消息图片', getForwardMsg: '读取转发',
  sendPoke: '发戳一戳', sendSticker: '发表情包', listStickers: '表情包列表', getStickerImage: '取表情图',
  setStickerRemark: '改表情备注', stickerNote: '表情备注', collectSticker: '收藏表情', getSelfImage: '我的图片',
  getFileContent: '读文件内容', sendQqFace: '发 QQ 表情', faceList: 'QQ 表情列表', memorySearch: '搜聊天记录',
  historyDelete: '删聊天记录', historyClear: '清空记录', sendDocx: '发 Word 文档', sendRich: '发卡片消息',
  musicSearch: '搜歌', globalOverview: '全局总览', scheduleMessage: '定时发消息', withdrawMessage: '撤回消息',
  sendForward: '合并转发', like: '点赞', proactiveSend: '主动私聊', getGroupOwner: '查群主',
  getGroupMembers: '查成员', adminSet: '管理设置', whitelist: '白名单', blacklist: '拉黑',
  profileSet: '改档案', profileQuery: '查档案', qzone: '空间互动（看/评/赞/发）', qzoneView: '看空间', sendQzone: '发说说', memeSearch: '搜表情包',
  sendMeme: '发表情包（内置表情库）', scheduleList: '定时列表', scheduleCancel: '取消定时', activityHours: '活跃时段',
};

/**
 * 每个开关实际对应的 MCP 工具原名（界面上以「中文名 · 工具名」显示）。
 * 映射来自「工具注册处 → 它调的 console 路径 → 该路径上的 ToolEnabled(key)」这条链，
 * 由 scripts 里的脚本从 mcp-napcat-safe.js + console-server.js 自动推出来再人工补齐，
 * 加/改工具时请一并更新这里（否则界面会显示不出英文名，但开关本身仍生效）。
 * 一个 key 管多个工具的直接列出全部，用 / 分隔。
 */
const TOOL_MCP: Record<string, string> = {
  getPrompt: 'qq_get_prompt', getUnread: 'qq_get_unread_messages', getRecent: 'qq_get_recent_messages',
  socialState: 'qq_social_state', sendGroup: 'qq_send_group_message', sendPrivate: 'qq_send_private_message',
  reply: 'qq_reply', sendBurst: 'qq_send_burst', sendMessage: 'qq_send_message',
  waitMessages: 'qq_wait_for_messages', feedback: 'qq_report_feedback', getMyRecent: 'qq_get_my_recent_messages',
  getMessageDetail: 'qq_get_message_detail', getActiveMembers: 'qq_get_active_members',
  setWakeConfig: 'qq_set_wake_config', markRead: 'qq_mark_read',
  memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
  slangQuery: 'qq_slang_query', slangSubmit: 'qq_slang_submit', getImages: 'qq_get_message_images',
  getForwardMsg: 'qq_get_forward_msg', sendPoke: 'qq_send_poke', listStickers: 'qq_list_stickers',
  getStickerImage: 'qq_get_sticker_image', sendSticker: 'qq_send_sticker',
  setStickerRemark: 'qq_set_sticker_remark', stickerNote: 'qq_sticker_note',
  collectSticker: 'qq_collect_sticker', getSelfImage: 'qq_get_self_image', getFileContent: 'qq_get_file_content',
  sendQqFace: 'qq_send_qq_face', faceList: 'qq_face_list', memorySearch: 'qq_memory_search',
  historyDelete: 'qq_history_delete', historyClear: 'qq_history_clear', sendDocx: 'qq_send_docx',
  sendRich: 'qq_send_rich', musicSearch: 'qq_music_search', globalOverview: 'qq_global_overview',
  scheduleMessage: 'qq_schedule_message / qq_schedule_list / qq_schedule_cancel',
  withdrawMessage: 'qq_withdraw_message', sendForward: 'qq_send_forward',
  qzone: 'qq_qzone_view / qq_qzone_comment / qq_qzone_like / qq_qzone_reply_comment / qq_send_qzone',
  // 以下 key 当前线上 config 没有（保留映射，切到含它们的配置时也能显示）
  activityHours: 'qq_get_activity_hours / qq_set_activity_hours', adminSet: 'qq_admin_set',
  whitelist: 'qq_whitelist', blacklist: 'qq_blacklist / qq_remove_friend',
  profileSet: 'qq_profile_set', profileQuery: 'qq_profile_get',
  memeSearch: 'qq_meme_search', sendMeme: 'qq_send_meme',
  qzoneView: 'qq_qzone_view', sendQzone: 'qq_send_qzone',
};

/** 进阶项说明（点 ⓘ 展开），只给对新手不友好的项加 */const HELP: Record<string, string> = {
  baseUrl: 'DSH（DeepSeek Harness）Web 服务地址。本地内置隔离实例默认 http://127.0.0.1:10721；也可用环境变量 QQB_DSH_BASE_URL 覆盖。不要填桌面端 3210。',
  provider: '模型服务商标识，由 DSH 端已配置的 provider 决定；不确定时保持默认，改错会导致会话建不起来（日志会提示）。',
  apiKey: '如你的服务商需要在 DSH 侧配置密钥，请到隔离 DSH 的密钥/设置页配置；此处填写的 Key 只会随本配置保存，不会注入运行进程。',
  model: '主对话模型。留空由 DSH 默认决定。',
  visionModel: '识图（多模态）模型，用于带图片消息的会话。留空时自动使用上面的主模型——请保证主模型是多模态的（默认已是）。',
  reasoningEffort: '推理强度档位，只对支持该参数的服务商生效（如 deepseek-reasoner / 深度思考类）。档位越高越慢但更仔细；实测**这是单次调用耗时与思考 token 最大的一块**（出现过单次 37 秒），嫌慢嫌贵先降它。`xhigh`/`max` 只有部分服务商支持（小米 MiMo 不支持）：选了不支持的档位时，桥会自动退回该服务商的默认档位并在日志里写一行，不会卡住会话。改完会自动重启隔离 DSH 生效。',
  launcherPath: '仅在你手动拉 QQ 网关时使用；本项目 NapCat 已内置并由管理端拉起，一般保持留空。',
  homeDir: '网关侧可写目录（容器映射等），本地 NapCat 一般不需要。',
  allowProcessControl: '是否允许 DSH 内的 agent 自动启停本机 QQ 网关。请仅在完全信任时开启。',
  accessToken: '「HTTP 访问令牌」：桥接进程通过 HTTP 接口（http://127.0.0.1:3000，NapCat 的 httpServers）收发消息时使用的令牌，需与 NapCat WebUI 里 HTTP 服务的 token 一致。它和下面的「WS 访问令牌」是两种不同传输各自的令牌——即使值相同也是分开的字段，改一个不影响另一个；填错会导致 HTTP 工具全部 401。',
  wsAccessToken: '「WS 访问令牌」：桥接进程通过 WebSocket 接口（ws://127.0.0.1:3001，NapCat 的 websocketServers）收发消息时使用的令牌，需与 NapCat WebUI 里 WS 服务的 token 一致。与「HTTP 访问令牌」相互独立（哪怕默认值相同）；填错会导致 WS 连接被拒、机器人收不到/发不出消息。',
  consolePort: '桥接内部服务端口（本地管理端会探测它判断是否在运行）。',
  consoleToken: '本机桥接内部接口令牌，一般不用改；改动后管理端会需要同步。',
  sessionCwd: 'DSH 会话工作目录；留空 = 每个会话在 state/agents 下独立建目录。',
  allowAllWhenEmpty: '白名单为空时是否放行所有会话。强烈建议先把私聊/群白名单填上再开它。',
  security: '安全选项分组。',
  trustedCrossSessionUids: '允许 agent 跨会话读取/带话的 QQ 号（数组），一般只放你自己最信任的好友。',
  deepsleep: '总开关：开启后**所有群聊**的消息入库但不唤醒、不回复、不主动冒泡（省 token）；**私聊照常**。拍一拍等群内事件同样被静默。主人发 /start 可随时恢复（这条命令不经过模型，永远有效）。',
  recommendedHint: '喂给模型的“潜水/唤醒行为规则”长文本；一般不建议新手改动。',
  activeProbability: '「活跃模式搭话概率」：把某个群/私聊**转成活跃**时用的随机搭话概率（默认 0.3 = 三成）。以前转活跃会沿用潜水那套 0.05（每 20 条才醒一次），看起来跟潜水没区别 —— 这个值就是用来区分两者的：调大=更活跃，调小=更省额度（配合「群每小时唤醒上限」兜底）。',
  preSleepWaitMs: '想潜水前先“静默观察”的窗口时长：窗口内若没人说话就可以安心睡。',
  wakeThreshold: '同一大会话累计多少轮后自动归档并轮换到“预热的下一代会话”，防上下文膨胀。',
  prewarmAhead: '到达轮换阈值前提前多少轮预建新会话并预热，让首轮命中缓存、不卡顿。',
  contextWindow: '唤醒时带入的最近消息条数；越大越懂上下文，但更费 token。',
  recentLimit: '内存里保留的最近消息条数（超出进 SQLite，仍可查）。',
  unreadLimit: '未读队列上限。',
  mustReplyKeywords: '命中这些词时必须回应（每行一个）。',
  recommendedKeywords: '潜水模式下能把你唤醒的关键词（每行一个）。',
  // —— 等待：回复前的停顿（模拟真人节奏，别让机器人秒回）——
  'social.wait.defaultMs': '「假装在想」的基础停顿：收到该回的消息后，先停这么久再开始组织回复（毫秒）。太短=秒回机器人，太长=反应迟钝。建议保留默认。',
  'social.wait.minMs': '每次停顿的随机下限（毫秒）。实际停顿会在 最短~最长 之间随机挑一个，避免每次都一模一样、显得机械。',
  'social.wait.maxMs': '每次停顿的随机上限（毫秒）。上下限差得越大，节奏越自然；设成和下限一样 = 每次都固定停这么久。',
  'social.wait.defaultQuietMs': '「默认静默」：轮到你开口前，先安静观察这么久。给自己留出判断“这话题该不该接”的时间，群聊里尤其管用。',  'social.wait.unfinishedQuietMs': '「话没说完时的静默」：对方最后一句看起来还没说完（例如结尾是“然后…”“等我一下”），就多等这么久再开口，别急着插话。',
  'social.wait.burstQuietMs': '「对方连发时的静默」：对方在很短时间内连着发了好几条（15 秒内 ≥3 条），就多等这么久，等他把话说完再一次性回应。',
  'social.send.linearPerCharMs': '「每个字的打字时间」：一次回复里，第 2 条气泡起，等 `这条字数 × 这个值` 毫秒再发（默认 150）。长句自然等得久、短句快 —— 这是唯一的节奏规则。',
  'social.send.linearMinMs': '「两条气泡最小间隔」：再短的气泡也至少隔这么久（默认 250ms），避免两条贴在一起刷出来。',
  'social.send.linearCapMs': '「两条气泡最大间隔」：上面算出来的等待最长不超过这个值（默认 4000ms），免得长句等太久像卡住。',
  'social.send.linearJitterRatio': '「打字速度抖动」：每条打字时间上下浮动的比例（默认 0.25 = ±25%）。真人不会每条都一模一样快，0 = 完全机械。',
  'social.send.linearResetMs': '「静默后重新秒回」：安静这么久之后计数归零 —— 下一条回复重新从"第 1 条气泡立即发出"开始。',
  'social.send.linearEnabled': '「按字数打字节拍」：开着 = 第 2 条气泡起按字数等（第 1 条永远秒回）。关掉 = 完全不等，多条气泡直接连发。',
  'social.wait.minQuietAfterNewMs': '「新消息后最短静默」：群里刚有人说话时，至少安静这么久再插嘴，防止抢话、刷屏、显得很急。',
  'social.typing.enabled': '「私聊等对方打完字」：开启后，私聊里检测到对方正在输入（QQ 的输入状态）就先等 ta 打完再回，不抢话；等待期间到的消息会全部排队，最后**合并成一次**发给模型（省注入轮数）。关掉 = 不看打字状态，按正常节奏回。',
  'social.typing.holdMaxMs': '「最多等多久」：对方一直不停地打字时，最多等这么久（默认 12000 毫秒）就插话，避免遇到"打字没完"的人永远不回复。',
  'social.typing.breakProbability': '「中途插话概率」（桥侧掷骰）：每次唤醒掷一次骰子，命中就**不等 ta 打完**、按正常节奏接话 —— 这是"智能接话"的来源。0 = 绝不抢话，只等对方停；0.15 = 偶尔接（默认）；0.5 以上 = 多半会接。',
  'social.typing.refreshOnMessageMs': '「收到消息后续多久」：QQ 的输入状态事件并不可靠（有时只在开始/结束各来一次），所以收到对方一条消息就认为"他还在打字"，把状态再续这么久（默认 5000 毫秒）。这就是"对方不停发消息时打字状态一直是连续的"的实现方式。',
  // —— 表情包 ——
  'social.sticker.enabled': '表情包总开关。开着：机器人会用你 QQ 的收藏表情回消息（接梗、赞同、晚安等场合）；关掉：只用文字聊天。',
  'social.sticker.syncTtlMs': '隔多久向 QQ 同步一次收藏表情（毫秒）。同步一次够用很久，不用每条消息都去拉，调小只会更频繁地刷新、多花资源。',
  'social.sticker.maxListCount': '一次最多同步多少个收藏表情。收藏很多时建议保持默认，太多了反而拖慢。',
  'social.sticker.includeInPrompt': '把“你有哪些表情、备注是什么”写进发给 AI 的提示里。开着 AI 才知道该用哪个表情；关掉它会“盲发”。',
  'social.sticker.promptMaxStickers': '提示里最多列出几个表情。列太多会占 token；够 AI 挑就行了。',
  'social.sticker.maxRemarkChars': 'AI 给表情写备注时最多写多少个字。备注越准，下次越知道这表情适合什么场合。',
  'social.sticker.collect.enabled': '自动收藏：AI 在群里看到表情很贴语境时，可以把它存进你的 QQ 收藏，慢慢攒自己的表情库。',
  'social.sticker.collect.maxPerMinute': '自动收藏每分钟最多几次，防止突然疯狂收藏刷屏。',
  'social.sticker.collect.maxPerHour': '自动收藏每小时最多几次。',
  'social.sticker.sendProbability': '「发表情概率」：**由桥侧掷骰决定**，不再靠 AI 自己拿捏。每次唤醒桥掷一次，把结果显示在唤醒提示里（[Meme] dice HIT / MISS）：HIT 这一轮最多发 1 个表情，MISS 就只发文字（有人明确要表情包时无视骰子）。0 = 不主动发；0.3≈偶尔来一张（默认）；0.5 以上≈几乎每轮都有。',
  'social.sticker.sendCooldownMs': '表情包冷却（毫秒）：同一个会话刚发过表情包后，这段时间内不再抽中，防止"概率虽小却连着发"。默认 180000（3 分钟）。',
  'social.deepsleepGroups': '「单群静默名单」：只对这几个群静默（每行一个群号，可留空）。名单里的群消息入库但不唤醒、不回复，其它群照常。想全群静默用上面的总开关。',
  // —— 智能体开关与自动回复 ——
  'social.enabled': '整套社交模块的总开关。开着：机器人读消息、判断要不要回、按人设互动；关掉：完全不理任何消息（相当于下班）。',
  'social.autoReplyCheckMs': '每隔多久检查一次“有没有值得回复的新消息”（毫秒）。越小响应越快，但也越费 token；越大越省，反应越慢。',
  'social.provideRecommendations': '把适合当前设置的推荐参数（如唤醒概率建议）一起喂给模型，帮它更好按人设行事。一般保持开着。',
  // —— 好友相关 ——
  'social.autoFriendApproval': '自动同意好友申请：有人加机器人好友时直接通过，不用你手动批。建议配合好友守卫/名单使用，防陌生人骚扰。',
  'social.autoFriendGuard': '好友守卫：开启后，只有名单里/受信任的账号能触发敏感操作（如管理、拉黑、跨会话读取）。安全开关，建议开着。',
  'social.docx.dailyQuotaChars': 'AI 每天最多生成 Word 文档的总字数。防止它不停写文档把额度烧光。',
  // —— 主动闲聊（冷场找话题 / 主动私聊）——
  'social.proactive.enabled': '主动闲聊总开关。开着：群里长时间没人说话（超过 idleThresholdMs）时，机器人会隔一阵检查一次，按概率主动开个话题；关掉：永远只等别人先开口。',
  'social.proactive.checkIntervalMinMs': '群聊主动找话题的检查间隔下限（毫秒）。机器人每过 检查下限~检查上限 之间随机时长，就看一下“群冷场够久了吗、该不该主动说句话”。',
  'social.proactive.checkIntervalMaxMs': '群聊主动找话题的检查间隔上限（毫秒）。和下限组成随机区间：差得越大越“没规律”，越小越勤快。',
  'social.proactive.idleThresholdMs': '冷场判定时长（毫秒）：群里这么久没人说话，才被算作“冷场/没话聊”。冷场不够久时机器人不会主动开口，避免抢话、刷屏。',
  'social.proactive.probability': '群聊主动找话题概率（0~1）：每次检查发现冷场时，真的主动开口的概率。0.3≈十次冷场约三次会主动找话题；0 基本只在被叫时才说话。',
  'social.proactive.privateCheckIntervalMinMs': '私聊主动检查间隔下限（毫秒）：机器人主动私聊你之前的最小间隔（逻辑同群聊检查，私聊独立计时）。',
  'social.proactive.privateCheckIntervalMaxMs': '私聊主动检查间隔上限（毫秒）：与下限组成私聊主动私聊的随机间隔区间。',
  'social.proactive.privateProbability': '私聊主动概率（0~1）：机器人主动私聊你的概率。较高≈常来主动问你在干嘛/分享近况；较低≈基本只在收到消息时回复。',
  // —— 投递与省额度（2026-09-12）——
  'social.steerEnabled': '「在途回合注入」总开关，默认开启。开着的时候：模型正在思考（跑一步）期间你发的新消息，会被直接塞进**同一个回合**的下一个节点，模型在本次回复里就一起考虑掉了——少一整轮唤醒、少一次整包重发、也少一次对话注入。'
    + '关掉之后：新消息一律等当前回合结束再作为新的一轮处理（更慢、更费，而且在旧实现里曾出现"消息停在 DSH 队列里再也出不来"的故障）。'
    + '真正的安全阀不是这个开关，而是桥里的"必须确实有回合在跑"守卫，所以一般**保持开启**。',
  'social.slimTools': '工具 schema 精简：名单里的 MCP 工具会被**直接不注册**给模型，它的 JSON 描述从此不出现在任何一次请求里。'
    + '为什么这个最值钱：单次请求约 85,800 字符里 tools 占 72,858（约 87%），而且每一步都会重发一遍。'
    + '改成 config 里那组「QQ 工具开关」只在调用时拒绝（403），**一个字符都省不掉**。'
    + '改动后必须重启隔离 DSH 才生效（工具表只在 DSH 启动时取一次）。',
  // —— 回合保持（social.turnHold）：4.49 之后重写的持段协议，管理端逐项说明 ——
  'social.turnHold.enabled': '「回合保持」总开关。开着的时候：桥在一次唤醒里把 DSH 那个回合**留住**一段时间，你在这段时间里连着补的几句话会被并进同一个回合处理，'
    + '不用每条都重新唤醒（省一次整包提示 + 少一轮排队）。关掉就回到"每条消息各自起一轮"的老行为。',
  'social.turnHold.keys': '限定哪些会话生效（每行一个，如 `private:1736784911` 或 `group:123456789`）；留空 = 不按会话限制，具体范围由下面「只对私聊保持」决定。',
  'social.turnHold.privateOnly': '只对私聊保持：群聊不开保持（群里人多、话题散，一直占着回合既费额度又容易答错对象）。'
    + '想让某个群也保持，就在这里关掉它，再用上面的「限定会话」写死那几个群号。',
  'social.turnHold.maxExchanges': '一次保持里最多来回多少轮：到数就放行，防止你一直说话害它一直不结束（回合数直接等于模型步数，就是额度）。',
  'social.turnHold.idleCloseMs': '空闲关闭：这么久（毫秒）没有新消息就主动放开这个回合，让 DSH 正常收尾。',
  'social.turnHold.maxWaitMs': '最长保持：不管有没有新消息，到这个时长（毫秒）都必须结束，避免回合永久挂着。',
  'social.turnHold.requestBudgetMs': '每段等待预算（毫秒，默认 55000）：桥不是一次把回合攥到底，而是**一段一段**跟插件续问；'
    + '每段最多等这么久，插件要它继续就回 `again:true` 续下一段。这个值必须**小于** DSH 插件那侧的单次请求超时，否则回合会在预算到点前被断开。',
};

/** 开关下方的一行小字提示（按完整路径/字段名精确命中） */
const TIP: Record<string, string> = {
  'social.enabled': '关掉 = 机器人完全不回消息（下班）',
  'social.sticker.enabled': '关掉 = 只用文字聊天',
  'social.sticker.collect.enabled': '看到贴语境的图自动存进收藏',
  'social.autoFriendApproval': '有人加好友直接通过，无需手动',
  'social.autoFriendGuard': '敏感操作只信名单内/可信账号',
  'social.deepsleep': '群里彻底静默，私聊照常',
  'social.provideRecommendations': '把推荐参数一起喂给模型',
  'social.deepsleepGroups': '每行一个群号；只静默这些群',
  'social.steerEnabled': '思考中收到的新消息直接塞进这一轮',
  'social.turnHold.enabled': '一次唤醒里留住回合，连着补话不用重新唤醒',
  'social.turnHold.privateOnly': '群里不开保持；确有需要再关掉并写死群号',
  'social.turnHold.requestBudgetMs': '必须小于 DSH 插件那侧的单次请求超时',
};

function pretty(label: string) {
  return LABEL[label] || label;
}
function prettyTool(k: string) {
  return TOOL_LABEL[k] || LABEL[k] || k;
}

function get(o: any, p: string) { return p ? p.split('.').reduce((x, k) => (x ? x[k] : undefined), o) : o; }
function setIn(o: any, p: string, v: any) { const ks = p.split('.'); const last = ks.pop()!; let c = o; for (const k of ks) { if (!c[k] || typeof c[k] !== 'object') c[k] = {}; c = c[k]; } c[last] = v; }
function setVal(current: any, path: string, value: any) { const n = JSON.parse(JSON.stringify(current ?? {})); setIn(n, path, value); return n; }

const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);

/** 把后端说明文字里的 **粗体** 与 `行内代码` 渲染成界面元素（与新手文档同一观感，
 *  免得把 `/root/qq-bridge/config.json` 这种路径当普通文字混在句子里）。 */
function RichText({ text }: { text: string }) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}
const isArr = (v: any) => Array.isArray(v);

export default function BridgeConfig({ onBack, onRefresh, onOpenLearning, onOpenPortrait, onOpenVoice, remote }: Props) {
  const [tab, setTab] = useState<'common' | 'tools' | 'persona' | 'json' | 'profiles'>('common');
  /* 【2026-09-14 主人要求】SSH 模式下这一页读写的是**服务端** /root/qq-bridge/config.json：
   *  · target 记录本页当前编辑的是哪一套（local / remote）—— 横幅必须一眼看见，别让人以为在改本机；
   *  · remoteMeta 存服务端路径/说明/写入校验结果，供横幅与保存提示使用。 */
  const [target, setTarget] = useState<'local' | 'remote'>('local');
  const [remoteMeta, setRemoteMeta] = useState<{ dir?: string; path?: string; notes?: string[]; message?: string }>({});
  const [cfg, setCfg] = useState<any>(null);
  const [persona, setPersona] = useState('');
  const [speechRules, setSpeechRules] = useState('');
  const [personaHasFile, setPersonaHasFile] = useState(false);
  const [speechHasFile, setSpeechHasFile] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  // 「指令速查」弹窗（与说明文档同款弹窗/小节样式）
  const [cmdsOpen, setCmdsOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [help, setHelp] = useState<{ key: string; title: string; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const personaFileRef = useRef<HTMLInputElement>(null);
  const speechFileRef = useRef<HTMLInputElement>(null);
  // ===== 角色库导入 =====
  const [charOpen, setCharOpen] = useState(false);
  const [charDir, setCharDir] = useState('');
  const [charList, setCharList] = useState<CharacterEntry[]>([]);
  const [charBusy, setCharBusy] = useState(false);
  const [charMsg, setCharMsg] = useState<string | null>(null);

  // ===== 方案（配置预设）=====
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [profName, setProfName] = useState('');
  const [profBusy, setProfBusy] = useState(false);
  const [profMsg, setProfMsg] = useState<string | null>(null);
  const [profMsgKind, setProfMsgKind] = useState<'ok' | 'warn'>('ok');

  useEffect(() => { load(); }, []);

  const load = async () => {
    // 连上服务器 → 读**服务端** /root/qq-bridge/config.json（经已有 SSH 连接，不新建连接）
    const r: any = remote
      ? await getRemoteBridgeConfig(remote.id)
      : await getBridgeConfig();
    const c = r.config || {};
    if (remote) {
      setTarget('remote');
      setRemoteMeta({ dir: r.dir, path: r.path, notes: r.notes, message: r.ok ? '' : (r.message || '读取服务端配置失败') });
      if (!r.ok) { setMsg('读取服务端配置失败：' + (r.message || '未知原因')); }
    } else {
      setTarget('local');
      setRemoteMeta({});
    }
    // 保证模型区“识图模型 / API Key”输入框总是可见（留空即默认）
    if (!c.dsh) c.dsh = {};
    if (c.dsh.apiKey === undefined) c.dsh.apiKey = '';
    if (c.dsh.visionModel === undefined) c.dsh.visionModel = '';
    if (!c.dsh.model) c.dsh.model = '';
    if (!c.dsh.provider) c.dsh.provider = '';
    // 出厂 ownerQQ=null（未设置/无主人）→ 显示为空串，便于输入真实 QQ
    if (c.ownerQQ === null || c.ownerQQ === undefined) c.ownerQQ = '';
    // DSH 里实际生效的模型段（推理档位下拉用它识别"已经是 off/xhigh/max"这类档位）
    DSH_EFFECTIVE = (r as any).dshEffective && typeof (r as any).dshEffective === 'object' ? (r as any).dshEffective : {};
    // 每个服务商的模型清单（切服务商时模型列表跟着换）
    const dm = (r as any).dshModels;
    DSH_MODELS = dm && typeof dm === 'object' && dm.providers && typeof dm.providers === 'object' ? dm : { providers: {} };
    setCfg(c);
    setPersona(r.persona || '');
    setSpeechRules(r.speechRules || '');
    setPersonaHasFile(!!r.personaHasFile);
    setSpeechHasFile(!!r.speechHasFile);
  };

  /** 保存通路：local → 本机 /api/bridge/config（原行为不变）；remote → /api/ssh/bridge-config（服务端）。
   *  服务端那条会「临时文件 → 备份 config.json.bak-<时间戳> → mv 原子替换 → 回读比对关键字段」，
   *  返回值里的 verified / mismatched 会原样展示，失败绝不谎报"已保存"。 */
  const writeBridge = async (body: Record<string, any>): Promise<any> => {
    if (target === 'remote' && remote) return await saveRemoteBridgeConfig({ ...body, serverId: remote.id });
    return await saveBridgeConfig(body);
  };

  /** 把服务端保存结果翻译成一句人话（成功/失败/校验不通过三种都说清楚） */
  const remoteResultText = (r: any): string => {
    if (!r) return '';
    if (r.ok && r.verified !== false) {
      const bak = r.backup ? `，原文件已备份为 ${r.backup}` : '';
      return `${r.message || '已保存到服务端'}${bak}`;
    }
    return `服务端保存未通过：${r.message || (r.mismatched?.length ? '关键字段回读不一致：' + r.mismatched.join('、') : '未知原因')}`;
  };

  /** 方案列表：只在切到「方案」页签时拉一次（不需要每次进页面都请求） */
  const loadProfiles = async () => {
    try { const r = await listProfiles(); setProfiles(Array.isArray(r.profiles) ? r.profiles : []); }
    catch (e: any) { setProfMsgKind('warn'); setProfMsg('读取方案失败：' + (e?.message || '')); }
  };
  useEffect(() => { if (tab === 'profiles') loadProfiles(); }, [tab]);

  /** 把当前配置存成一个命名方案；服务器会按"参数完全相同"去重，不会反复堆同样的方案 */
  const createProfile = async () => {
    if (!cfg) return;
    const name = profName.trim();
    if (!name) { setProfMsgKind('warn'); setProfMsg('先给方案起个名字（例如「省钱档」「质量档」）'); return; }
    setProfBusy(true); setProfMsg(null);
    try {
      const r = await saveProfile(name, cfg);
      await loadProfiles();
      setProfMsgKind(r.existed ? 'warn' : 'ok');
      setProfMsg(r.existed
        ? `参数与方案「${r.existed.name}」完全相同，已直接复用（没有重复新增）`
        : `已新增方案「${name}」`);
      if (!r.existed) setProfName('');
    } catch (e: any) { setProfMsgKind('warn'); setProfMsg('保存失败：' + (e?.message || '')); }
    finally { setProfBusy(false); }
  };

  /** 套用方案：把方案里的配置整份写回桥 config.json（走同一保存通路，模型段变化会自动同步 DSH） */
  const applyProfile = async (p: ConfigProfile) => {
    setProfBusy(true); setProfMsg(null);
    try {
      const r = await writeBridge({ config: p.config });
      const eff = target === 'remote'
        ? remoteResultText(r)
        : ((r as any)?.dshChanged
          ? ((r as any)?.modelSynced ? '已保存 · 模型配置已同步到隔离 DSH，约 15 秒后生效' : `已保存，但模型配置未写入 DSH：${(r as any)?.modelSyncMessage || '未知原因'}`)
          : '已保存');
      await load();
      setProfMsgKind((target === 'remote' && r?.ok === false) ? 'warn' : 'ok');
      setProfMsg(`已套用方案「${p.name}」到${target === 'remote' ? '服务端' : '本机'} · ${eff}`);
    } catch (e: any) { setProfMsgKind('warn'); setProfMsg('套用失败：' + (e?.message || '')); }
    finally { setProfBusy(false); }
  };

  const removeProfile = async (p: ConfigProfile) => {
    setProfBusy(true); setProfMsg(null);
    try { await deleteProfile(p.id); await loadProfiles(); setProfMsgKind('ok'); setProfMsg(`已删除方案「${p.name}」`); }
    catch (e: any) { setProfMsgKind('warn'); setProfMsg('删除失败：' + (e?.message || '')); }
    finally { setProfBusy(false); }
  };

  /** 打开角色库面板并扫描目录 */
  const openCharLib = async (dir?: string) => {
    setCharOpen(true);
    setCharMsg(null);
    await scanChars(dir);
  };
  const scanChars = async (dir?: string) => {
    setCharBusy(true); setCharMsg(null);
    try {
      const r = await listCharacters(dir);
      if (r.ok && r.characters) { setCharDir(r.dir || dir || ''); setCharList(r.characters); setCharMsg(null); }
      else { setCharMsg(r.message || '未找到角色库'); setCharList([]); }
    } catch (e: any) { setCharMsg('扫描失败：' + (e?.message || '')); }
    finally { setCharBusy(false); }
  };
  /** 载入角色 → 写入 persona 编辑器(不直接保存, 用户点保存生效); 失败也可仅预览 */
  const applyCharacter = async (c: CharacterEntry) => {
    if (!charDir) { setCharMsg('缺少角色库目录'); return; }
    setCharBusy(true); setCharMsg(null);
    try {
      const r = await importCharacter(charDir, c.slug, true, false); // 先不写盘
      if (r.success && r.preview != null) {
        setPersona(r.preview + '\n\n' + (r.chars && r.chars > 400 ? '\n（已载入完整内容，点「保存人设」生效）' : ''));
        setTab('persona');
        setCharMsg(`已载入「${c.name}」(${(r.chars ?? 0).toLocaleString()} 字符)，点下方「保存人设」写入并生效`);
      } else setCharMsg(r.message || '载入失败');
    } catch (e: any) { setCharMsg('载入失败：' + (e?.message || '')); }
    finally { setCharBusy(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: any = { config: cfg };
      // 人设/发言规则同页签：头部保存一并写两份文件，避免任一编辑器改动丢失（未保存缺陷修复）
      if (tab === 'persona') { body.persona = persona; body.speechRules = speechRules; }
      if (tab === 'json') {
        const ta = document.getElementById('bridge-json') as HTMLTextAreaElement;
        try { body.config = JSON.parse(ta.value); } catch { setMsg('JSON 格式有误，请检查'); setSaving(false); return; }
      }
      // 模型段（dsh）保存后由管理端写入隔离 DSH 的 settings.yaml 并重启它；这里必须把
      // 同步结果**如实**显示出来 —— 以前无论同步成功与否都只说"已保存"，用户以为改的模型生效了，
      // 实际 DSH 还在用旧模型（"管理端改的模型配置无法默认到 DSH 里"的直接成因之一）。
      // 服务端模式：写的是服务器上的 config.json（桥按 mtime 热加载），返回里带回读比对结果。
      const r = await writeBridge(body);
      if (target === 'remote') {
        setMsg(remoteResultText(r));
      } else if (r?.dshChanged) {
        setMsg(r.modelSynced
          ? '已保存 · 模型配置已同步到隔离 DSH，约 15 秒后生效'
          : '已保存，但模型配置未写入 DSH：' + (r.modelSyncMessage || '未知原因'));
      } else setMsg('已保存');
      onRefresh(); load();
    } catch (e: any) { setMsg('保存失败：' + (e?.message || '')); }
    finally { setSaving(false); }
  };

  /** 单卡保存：只写一份 .md（persona.md / speech-rules.md），避免误动另一张卡 */
  const saveCard = async (kind: 'persona' | 'speech') => {
    setSaving(true); setMsg(null);
    try {
      const body = kind === 'persona' ? { persona } : { speechRules };
      const r = await writeBridge(body);
      const where = target === 'remote' ? '服务端' : '本机';
      setMsg(target === 'remote'
        ? `${kind === 'persona' ? '人设' : '发言规则'}已保存到${where} ${kind === 'persona' ? 'persona.md' : 'speech-rules.md'} · ${remoteResultText(r)}`
        : (kind === 'persona' ? '人设已保存到 persona.md' : '发言规则已保存到 speech-rules.md'));
      await load();
    } catch (e: any) { setMsg('保存失败：' + (e?.message || '')); }
    finally { setSaving(false); }
  };

  /** 恢复默认发言规则（写内置英文模板）。服务端模式下写的是**服务端**的 speech-rules.md。 */
  const resetSpeech = async () => {
    setSaving(true); setMsg(null);
    try {
      if (target === 'remote') {
        const r = await writeBridge({ speechReset: true });
        const st = (r?.steps ?? []).find((x: any) => /恢复默认发言规则/.test(x.step || ''));
        if (r?.ok && st?.ok) { setMsg('已恢复默认发言规则并写入服务端 speech-rules.md'); await load(); }
        else setMsg('恢复失败：' + (st?.msg || r?.message || '未知原因'));
        return;
      }
      const r = await resetSpeechRules();
      setSpeechRules(r.speechRules || '');
      setSpeechHasFile(!!r.speechHasFile);
      setMsg('已恢复默认发言规则并写入 speech-rules.md');
    } catch (e: any) { setMsg('恢复失败：' + (e?.message || '')); }
    finally { setSaving(false); }
  };

  /** 人设上传：.md/.txt 直接载入编辑器（回显修正，保存才落盘）；.zip/.skill 走角色包目录 */
  const pickPersonaFile = async (f: File | null) => {
    if (!f) return;
    const fn = f.name.toLowerCase();
    if (fn.endsWith('.zip') || fn.endsWith('.skill')) { upload(f); return; }
    try {
      const txt = await f.text();
      setPersona(txt);
      setMsg(`已载入 ${f.name} 内容到编辑器，点「保存人设」即写入 persona.md`);
    } catch { setMsg('读取文件失败'); }
  };

  /** 发言规则上传 .md/.txt：载入编辑器，保存才落盘 */
  const pickSpeechFile = async (f: File | null) => {
    if (!f) return;
    try {
      const txt = await f.text();
      setSpeechRules(txt);
      setMsg(`已载入 ${f.name} 内容到编辑器，点「保存发言规则」即写入 speech-rules.md`);
    } catch { setMsg('读取文件失败'); }
  };

  const ch = (path: string) => (v: any) => setCfg((c: any) => setVal(c, path, v));

  const upload = async (f: File | null) => {
    if (!f) return;
    setUploading(true); setMsg(null);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = ''; const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
      const r = await api<any>('/bridge/upload', { method: 'POST', body: JSON.stringify({ filename: f.name, data: btoa(bin) }) });
      setMsg('已上传：' + r.name); load();
    } catch { setMsg('上传失败'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  /** 表情包图库上传：转 base64 交给 manager 存图 + 写 stickers.json + 重启 bridge */
  const uploadStickers = async (files: File[]) => {
    if (!files.length) return;
    setSaving(true); setMsg(null);
    try {
      const items: Array<{ name: string; data: string }> = [];
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = ''; const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
        items.push({ name: f.name.replace(/\.[^.]+$/, ''), data: btoa(bin) });
      }
      const r = await api<any>('/bridge/stickers/upload', { method: 'POST', body: JSON.stringify({ items }) });
      setMsg(`已入库 ${r.count} 张表情并重启桥接`);
    } catch (e: any) { setMsg('表情上传失败：' + (e?.message || '')); throw e; }
    finally { setSaving(false); onRefresh(); }
  };

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title" title="MoonBot — 一键配置本地和服务器的拟人 QQ Bot 集成配置工具">MoonBot · 功能配置</div>
            <div className="page-subtitle">可视化配置 · 本地与隔离 DSH 同步</div>
          </div>
        </div>
        <div className="page-actions">
          <button title="GitHub: AbyssalQuill/MoonBot" onClick={() => window.open('https://github.com/AbyssalQuill/MoonBot', '_blank', 'noopener')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 4, borderRadius: 8, color: '#57606a', lineHeight: 0 }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#24292f'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#57606a'; }}>
            <svg width="26" height="26" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </button>
          <button className="btn btn-soft" title="喜欢这个工具的话，请作者喝杯奶茶 🧋" onClick={() => setTipOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d' }}>
            <Coffee size={14} /> 请作者喝奶茶
          </button>
          <button className="btn btn-soft" onClick={onOpenPortrait} title="群友画像 / 主人画像 · 直读本机桥记忆库">
            <Users size={14} /> 群友画像
          </button>
          <button className="btn btn-soft" onClick={onOpenVoice} title="语音：合成音色、音色设计/复刻、语音识别（MiMo 语音模型）">
            <Mic size={14} /> 语音
          </button>
          <button className="btn btn-soft-primary" onClick={onOpenLearning} title="黑话 / 人格学习与 Token 用量统计">
            <Activity size={14} /> 学习与用量
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
          </button>
        </div>
      </div>

      <div className="page-body">
        {msg && <div className="notice-bar" onClick={() => setMsg(null)}>{msg}</div>}

        {/* 【2026-09-14 主人要求】明显的横幅标明"当前编辑的是服务端配置"：
            没有这条横幅，用户很容易以为在改本机（两套实例并存时这正是最容易踩的坑）。 */}
        {/* 【2026-09-14 主人要求】横幅配色跟新手文档一致（不再自己写死蓝色），
            里面的路径/命令一律按行内代码渲染：说明文字干净、技术名词一眼可辨。 */}
        {target === 'remote' && remote && (
          <div className="notice-bar server-config-banner" style={{ borderColor: 'var(--nc-primary-400)', display: 'block' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
              <Server size={15} /> 服务端模式 · 当前编辑的是服务器上的桥配置
              <span className="badge badge-info">服务端</span>
            </div>
            <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.75 }}>
              服务器：<b>{remote.name}</b>（{remote.host}）
              {remoteMeta.path ? <> · 文件：<code>{remoteMeta.path}</code></> : null}
              {remoteMeta.dir ? <>（读取自 <code>{remoteMeta.dir}</code>）</> : null}
            </div>
            <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.75 }}>
              保存时后端会：写临时文件 → 备份 <code>config.json.bak-&lt;时间戳&gt;</code> → <code>mv</code> 原子替换 → 回读比对关键字段；
              桥按 mtime 热加载，<b>下一条消息即生效</b>，不用重启桥。
            </div>
            {remoteMeta.notes?.length ? (
              <ul style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 12.5, lineHeight: 1.75 }}>
                {remoteMeta.notes.map((n, i) => <li key={i}><RichText text={n} /></li>)}
              </ul>
            ) : null}
          </div>
        )}
        {target === 'remote' && remoteMeta.message && (
          <div className="notice-bar" style={{ borderColor: '#e5484d', background: '#fef2f2', color: '#912018' }}>
            <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> {remoteMeta.message}
            <button className="btn btn-sm" style={{ marginLeft: 10 }} onClick={() => load()}>重试读取</button>
          </div>
        )}
        {target === 'local' && remote && (
          <div className="notice-bar" style={{ fontSize: 12 }}>
            已连上服务器 <b>{remote.name}</b>，但本页仍在读写<b>本机</b>的 qq-bridge 配置（服务端配置读取失败时会这样回退，避免误写）。
          </div>
        )}

        <div className="bridge-body">
        <div className="tabs">
          {(['common', 'tools', 'persona', 'json'] as const).map((t) => (
            <button key={t} className={`btn ${tab === t ? 'btn-primary' : 'btn-soft'}`} onClick={() => setTab(t)}>
              {t === 'common' ? '常用设置' : t === 'tools' ? '工具与规则' : t === 'persona' ? '人设与发言规则' : 'JSON 进阶'}
            </button>
          ))}
          {/* 【2026-09-12 主人要求】JSON 进阶旁边加一个「方案」页签：浅蓝，与 Token 用量面板同一支色 */}
          <button className={`btn ${tab === 'profiles' ? 'btn-tb-primary' : 'btn-tb-soft'}`} onClick={() => setTab('profiles')}
            title="把当前配置存成命名方案，或一键套用已存的方案">
            <Layers size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> 方案
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-soft doc-open-btn" onClick={() => setCmdsOpen(true)} title="聊天里可用的全部 / 指令与解释">
            <Terminal size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> 指令速查
          </button>
          <button className="btn btn-soft doc-open-btn" onClick={() => setDocOpen(true)} title="每一项功能与配置的详细说明">
            <BookOpen size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> 说明文档
          </button>
        </div>

        {tab === 'common' && cfg && <CommonTab cfg={cfg} ch={ch} onHelp={setHelp} uploadStickers={uploadStickers} remote={remote} writeConfig={(next) => writeBridge({ config: next })} onCfgChange={setCfg} />}
        {tab === 'tools' && cfg && <ToolsTab cfg={cfg} ch={ch} onSave={save} />}

        {tab === 'persona' && (
          <div className="dp-grid">
            {/* 人设卡：persona.md */}
            <div className="card dp-card">
              <div className="card-title">
                <FileText size={17} /> 人设 · persona.md
                <span className={`badge ${personaHasFile ? 'badge-success' : 'badge-soft'}`}>
                  {personaHasFile ? '文件已存在' : '出厂为空'}
                </span>
              </div>
              <div className="cfg-card-desc">
                角色描述/人设提示词（<b>原样注入给模型，中英文都会注入</b>）。出厂为空：可上传自己的 .md/.txt，或点「角色库导入」一键载入完整角色，再点「保存人设」写入 persona.md。
                它和内置规则是<b>两层</b>：内置规则（安全边界 / 工具用法 / 唤醒协议 / 发言纪律）永远生效，人设决定「你是谁、什么脾气、怎么跟主人相处」；<b>人设文件里写的自定义规矩同样生效</b>。
                保存后下一条消息就是新人设（桥会检测文件变化并重新注入完整提示词），不用重启任何东西。
              </div>
              <textarea className="textarea persona-text" rows={18}
                value={persona} onChange={(e) => setPersona(e.target.value)} spellCheck={false} />
              <div className="dp-actions">
                <input ref={personaFileRef} type="file" hidden accept=".md,.txt,.skill.zip,.zip"
                  onChange={(e) => { pickPersonaFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
                <button className="btn btn-soft-primary btn-sm" disabled={uploading} onClick={() => personaFileRef.current?.click()}>
                  {uploading ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} 上传载入
                </button>
                <button className="btn btn-soft btn-sm" disabled={uploading} onClick={() => openCharLib()}>
                  <Library size={14} /> 角色库导入
                </button>
                <span className="upload-hint">.md/.txt 载入编辑器（点右侧保存生效）；.skill.zip/.zip 上传到角色包目录</span>
                <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => saveCard('persona')}>
                  {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存人设
                </button>
              </div>
            </div>

            {/* 发言规则卡：speech-rules.md */}
            <div className="card dp-card">
              <div className="card-title">
                <MessagesSquare size={17} /> 发言规则 · speech-rules.md
                <span className={`badge ${speechHasFile ? 'badge-success' : 'badge-soft'}`}>
                  {speechHasFile ? '文件已存在' : '默认模板'}
                </span>
              </div>
              <div className="cfg-card-desc">
                消息发送的言行规矩（简短 ≤2 条 / 去 AI 味 / 群内矜持 / 不发中括号与句号 / 私聊不引用 / 错话撤回 / 工具纪律）。
                与 persona.md 同目录，每次唤醒注入提示词顶部；文件变更无需重启。
              </div>
              <textarea className="textarea persona-text" rows={18}
                value={speechRules} onChange={(e) => setSpeechRules(e.target.value)} spellCheck={false} />
              <div className="dp-actions">
                <input ref={speechFileRef} type="file" hidden accept=".md,.txt"
                  onChange={(e) => { pickSpeechFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
                <button className="btn btn-soft btn-sm" disabled={saving} onClick={() => speechFileRef.current?.click()}>
                  <Upload size={14} /> 上传 .md
                </button>
                <button className="btn btn-outline-danger btn-sm" disabled={saving} onClick={resetSpeech} title="写回内置默认英文模板">
                  <RotateCcw size={14} /> 恢复默认
                </button>
                <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => saveCard('speech')}>
                  {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存发言规则
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'json' && (
          <div className="card">
            <div className="card-title">config.json（进阶）</div>
            <textarea id="bridge-json" className="textarea json-text" rows={30} spellCheck={false}
              defaultValue={cfg ? JSON.stringify(cfg, null, 2) : ''} />
          </div>
        )}

        {tab === 'profiles' && (
          <div className="card profile-panel">
            <div className="card-title" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Layers size={17} /> 配置方案</span>
              <span style={{ fontSize: 11.5, fontWeight: 400 }}>把当前整套参数存成命名方案，随时一键套用 / 回退</span>
            </div>
            <div className="profile-note">
              方案保存的是<b>完整的 config.json</b>（模型与推理、唤醒与节奏、名单、主动闲聊……全部参数）。
              套用方案 = 把这份配置整份写回桥，并走和「保存」完全相同的通路（模型段变化会自动同步隔离 DSH 并重启它，约 15 秒生效）。
              <b>参数完全相同的配置不会重复新增</b>——保存时会自动识别并复用已有方案。方案存在管理端（<code>~/.qq-bridge-manager/profiles.json</code>），换浏览器/清缓存都不会丢。
            </div>

            <div className="profile-new">
              <input className="input" placeholder="给方案起个名字，例如「省钱档」「质量档」「群聊专用」"
                value={profName} maxLength={40}
                onChange={(e) => setProfName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createProfile(); }} />
              <button className="btn btn-primary" disabled={profBusy || !cfg} onClick={createProfile}>
                {profBusy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 存为新方案
              </button>
              <button className="btn" disabled={profBusy} onClick={loadProfiles}>
                {profBusy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} 刷新
              </button>
            </div>

            {profMsg && (
              <div className="profile-note" style={{ marginTop: 10, background: profMsgKind === 'ok' ? 'hsl(199 100% 95% / .95)' : 'hsl(199 100% 92% / .95)' }}>{profMsg}</div>
            )}

            {profiles.length === 0 ? (
              <div className="profile-empty">还没有保存过方案。调好配置后在上面起个名字点「存为新方案」即可。</div>
            ) : (
              <div className="profile-list">
                {profiles.map((p) => (
                  <div key={p.id} className="profile-item">
                    <div className="profile-item-h">
                      <b>{p.name}</b>
                      {p.builtin && <span className="badge badge-soft">出厂</span>}
                    </div>
                    <div className="profile-item-s">
                      {p.summary || '—'}
                      <br />
                      保存于 {new Date(p.createdAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                    <div className="profile-item-actions">
                      <button className="btn btn-primary btn-sm" disabled={profBusy} onClick={() => applyProfile(p)}>
                        <Check size={13} /> 套用
                      </button>
                      <button className="btn btn-sm btn-danger" disabled={profBusy} onClick={() => removeProfile(p)}>
                        <Trash2 size={13} /> 删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {help && (
        <div className="help-overlay" onClick={() => setHelp(null)}>
          <div className="help-panel" onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span>说明 · {help.title}</span>
              <button className="icon-btn" onClick={() => setHelp(null)}><X size={16} /></button>
            </div>
            <div className="help-body">{help.text}</div>
            <div className="help-foot">
              <button className="btn btn-sm" onClick={() => setHelp(null)}>知道了</button>
            </div>
          </div>
        </div>
      )}

      {tipOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(30,20,10,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setTipOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, padding: '26px 30px', maxWidth: 420, width: '100%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#78350f', marginBottom: 6 }}>请作者喝杯奶茶 🧋</div>
            <div style={{ fontSize: 13, color: '#92640a', marginBottom: 16, lineHeight: 1.6 }}>喵～如果这个工具帮到了你，可以扫码请作者喝杯奶茶喵，超感谢！</div>
            <img src="/wechat-pay.png" alt="微信收款码" style={{ width: 260, height: 260, objectFit: 'contain', background: '#fff', borderRadius: 12, border: '1px solid #fde68a', padding: 8 }} />
            <div style={{ fontSize: 12, color: '#b45309', marginTop: 14 }}>微信扫一扫 · 谢谢支持 💖</div>
            <button className="btn btn-sm" style={{ marginTop: 14, color: '#78350f', background: '#fef3c7', border: '1px solid #fcd34d' }} onClick={() => setTipOpen(false)}>关闭</button>
          </div>
        </div>
      )}

      {cmdsOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(40,20,40,0.45)', zIndex: 116, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setCmdsOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(860px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.22)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid #f0eef6' }}>
              <Terminal size={18} style={{ color: 'var(--nc-primary-500)' }} />
              <b style={{ fontSize: 16, color: 'var(--nc-primary-500)' }}>指令速查 · 聊天里能发的 / 指令</b>
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setCmdsOpen(false)}><X size={18} /></button>
            </div>
            <div className="doc-dialog-body" style={{ flex: 1, overflow: 'auto', padding: '4px 22px 16px' }}>
              <DocSection title="怎么用">
                <ul>
                  <li>在 QQ 里（群聊或私聊都可以）直接发这些指令，机器人会立刻照做并回一句话确认。</li>
                  <li><b>管理类指令只有管理员（ownerQQ）能生效</b>；其他人发会被回「管理命令仅管理员可用」。</li>
                  <li>指令要单独发一条，且以 <code>/</code> 开头；带参数时参数用空格隔开。</li>
                </ul>
              </DocSection>

              <DocSection title="会话管理">
                <ul>
                  <li><code>/reset</code> 或 <code>/new</code>：清空当前会话的 DSH 上下文，下一条消息开新会话（长期记忆、档案、聊天库都保留）。顺手取消该会话还没发出的待发任务。</li>
                  <li><code>/status</code>：回一条状态——当前 sessionId、白名单是否通过、角色、模式。</li>
                  {/* 【2026-09-13 主人要求】/help（发《小鲸鱼能力概览》docx）已整条删除，这里不再列出 */}
                </ul>
              </DocSection>

              <DocSection title="唤醒与静默">
                <ul>
                  <li><code>/sleep</code>：无限期暂停——不调 DSH、不回复；消息仍然入库，但不会唤醒它。用 <code>/wake</code> 恢复。</li>
                  <li><code>/wake</code>：恢复（<code>/sleep</code> 的反命令），同时清掉定时休息留下的定时器。</li>
                  <li><code>/deepsleep</code>：<b>所有群</b>的总开关——群里只入库，不读、不醒、不回、不收集（省 token）；<b>私聊不受影响</b>。</li>
                  <li><code>/start</code>：解除 <code>/deepsleep</code>，群聊恢复正常。<b>它由桥直接执行、不经过模型，所以静默期间永远可用</b>。</li>
                  <li><code>/silent</code> 或 <code>/quiet</code>：<b>当前会话</b>静默——群友消息只记录、不投递给 AI（被 @ 也不回）。</li>
                  <li><code>/active</code> 或 <code>/speak</code>：恢复当前会话的正常回应。</li>
                </ul>
              </DocSection>

              <DocSection title="模式与作息">
                <ul>
                  <li><code>/set mode active</code>（或 <code>/set mode 活跃</code>）：本会话转全天活跃——群里说啥都接；同时清掉该群的活跃时段限制。</li>
                  <li><code>/set mode diving</code>（或 <code>/set mode 潜水</code>）：转潜水——平时不打扰群，被 @、被点名或有人问时才出来。</li>
                  <li><code>/set sleep 01:00-06:00</code>：设每日作息窗口（北京时间）。窗口内群聊只回 @，其余不读以省 token；私聊不受限。</li>
                  <li><code>/set sleep 30m</code> / <code>/set sleep 2h</code>：定时休息 30 分钟 / 2 小时，到点自动醒。</li>
                  <li><code>/set wake</code> 或 <code>/set cancel</code>：一键取消所有睡眠状态（含作息窗口与定时休息）。</li>
                </ul>
              </DocSection>

              <DocSection title="角色与权限">
                <ul>
                  <li><code>/role 角色名</code>：切换到 <code>qq-bridge/roles/角色名.md</code> 里定义的角色。</li>
                  <li><code>/role off</code> 或 <code>/role clear</code>：清除角色，恢复正常人格。</li>
                  <li><code>/op QQ号或昵称</code>：把某人设为管理员（仅主人可用；昵称会去通讯录里找）。</li>
                  <li><code>/op del QQ号或昵称</code>：取消某人的管理员。</li>
                </ul>
              </DocSection>

              <DocSection title="黑话学习">
                <ul>
                  <li><code>/slang 学习</code> 或 <code>/slang learn</code>：立刻跑一次黑话学习。</li>
                  <li><code>/slang 停止</code> 或 <code>/slang stop</code>：停止正在跑的黑话学习 / 研究任务。</li>
                  <li><code>/slang</code>：看黑话模块的用法说明。</li>
                </ul>
              </DocSection>

              <DocSection title="群友画像学习">
                <ul>
                  <li><code>/portrait learn</code>（也认 <code>/portrait start</code>、<code>/群友画像学习</code>、<code>/画像学习</code>）：立刻按当前筛选条件挑人跑一轮画像学习。不带参数时自动从聊天库里选人。</li>
                  <li><code>/portrait stop</code>：停止正在跑的画像学习（已在跑的目标不会落半成品）。</li>
                  <li><code>/portrait status</code>：回一条状态——是否启用、自动触发方式、筛选条件、最近一轮学了哪几个人。</li>
                  <li>只有管理员（ownerQQ）能发；其他人发会被回「画像学习只有主人能指挥」。</li>
                </ul>
              </DocSection>

              <DocSection title="互动与其它">
                <ul>
                  <li><code>/like QQ号 [次数]</code>：给对方点赞，次数默认 1、最多 10。</li>
                  <li>其它任何 <code>/xxx</code>（例如 <code>/model</code>）：原样交给 DSH 执行，桥不拦截。</li>
                  <li>日常管理也可以不用斜杠——直接说人话（比如「转活跃」「别理这个群了」「把某人拉黑」），AI 会自己判断并调用对应工具。</li>
                </ul>
              </DocSection>
            </div>
          </div>
        </div>
      )}

      {docOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(40,20,40,0.45)', zIndex: 115, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={() => setDocOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(860px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.22)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid #f0eef6' }}>
              <BookOpen size={18} style={{ color: 'var(--nc-primary-500)' }} />
              <b style={{ fontSize: 16, color: 'var(--nc-primary-500)' }}>说明文档 · 每一项功能与配置</b>
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setDocOpen(false)}><X size={18} /></button>
            </div>
            <div className="doc-dialog-body" style={{ flex: 1, overflow: 'auto', padding: '4px 22px 16px' }}>
              <DocSection title="页面与五个页签">
                <ul>
                  <li><b>常用设置</b>：最常用的可视化配置，按功能分卡片（模型与推理 / NapCat 连接 / 基础与会话 / 允许·拒绝名单 / 唤醒潜水 / 发送节奏 / 上下文轮换 / 主动闲聊 / 回复停顿 / 表情包 / 静默 / 好友信任 等）。</li>
                  <li><b>工具与规则</b>：上卡是桥提供给 AI 的 QQ 工具开关（发消息、读未读、戳一戳、撤回、表情包……），关掉即不授予该工具（但<b>不省 token</b>）；下卡「工具 schema 精简」才是真的让工具描述不再随请求发给模型，改完要重启隔离 DSH。</li>
                  <li><b>人设与发言规则</b>：编辑 persona.md（角色人设，出厂为空，可上传 .md 或从「角色库导入」整包载入）与 speech-rules.md（言行规矩，含恢复默认）。<b>人设会被原样注入给模型</b>（中英文都注入，不再只认英文）、和内置规则是两层：内置规则管安全/工具/唤醒协议，人设管"你是谁"；人设文件里写的自定义规矩同样生效。</li>
                  <li><b>JSON 进阶</b>：直接编辑 config.json 全文，适合批量改或引用新字段。</li>
                  <li><b>方案</b>：把当前整套配置存成命名方案，一键套用 / 回退；参数完全相同的配置会自动识别、不重复新增；方案存在管理端，换浏览器不会丢。</li>
                  <li><b>指令速查</b>（页签右侧按钮）：聊天里能发的全部 <code>/</code> 指令与解释。</li>
                </ul>
              </DocSection>
              <DocSection title="模型与推理（dsh）">
                <ul>
                  <li><b>DSH 地址</b>：内置隔离 DeepSeek Harness 的地址（默认 http://127.0.0.1:10721），一般不改。</li>
                  <li><b>模型服务商</b>：自动探测（空=用 DSH 端默认）/<code>deepseek-official</code>（DeepSeek 官方，需 DEEPSEEK_API_KEY）/<code>xiaomi-token-plan-cn</code>（小米 MiMo）。默认官方 DeepSeek。</li>
                  <li><b>主模型 / 识图模型 / API Key</b>：<b>下拉里只列当前服务商真实可用的模型</b>（从 DSH 自己的配置读出来：小米这类 pi-ai 服务商来自 settings.yaml，DeepSeek 官方来自 DSH 内置目录）；<b>切换服务商时列表与主模型会一起跟着换</b>（新模型不在新列表里就自动换成该服务商的默认模型，并给出提示）。留空即 DSH 默认；识图模型留空跟随主模型；想要清单外的模型点「自定义…」手输 id。</li>
                  <li><b>推理档位</b>：这里给的是各服务商**真实的英文档位**（off / none / minimal / low / medium / high / xhigh / max，也可以点「自定义…」手输）。DSH 里已经配好的档位会被识别并回显，旁边那行小字显示 <b>DSH 当前生效</b> 的值，方便核对。保存后自动同步给隔离 DSH 并重启实例生效。</li>
                </ul>
              </DocSection>
              <DocSection title="NapCat 连接（napcat）">
                <ul>
                  <li><b>WebSocket 地址</b>：OneBot WS 服务端，默认 ws://127.0.0.1:3001（NapCat 自动配置）。</li>
                  <li><b>HTTP 访问令牌 / WS 访问令牌</b>：分别是 HTTP(3000) 与 WS(3001) 的 token，需与 NapCat WebUI 里的一致，默认 truefriend；两个字段相互独立。</li>
                  <li><b>HTTP 地址 / 启动器路径 / 运行目录</b>：本地一键启动时保持默认即可。</li>
                </ul>
              </DocSection>
              <DocSection title="常用设置里几个关键项">
                <ul>
                  <li><b>主人 QQ / 管理员</b>：出厂为空（无主人模式，白名单空放行全部）；填上后 AI 识别主人/管理员权限。主人 QQ 必须是机器人可见的 QQ 号。</li>
                  <li><b>允许/拒绝名单</b>：私聊与群的 QQ 列表，每行一个；拒绝名单优先。</li>
                  <li><b>唤醒 · 潜水 / 活跃</b>：机器人平时潜水，被 @/名字/关键词/提问/戳一戳 或概率触发才醒；可调潜水时长与唤醒概率。</li>
                  <li><b>主动闲聊</b>：冷场（没人说话超过 idleThresholdMs）后按概率主动找话题 / 主动私聊；分群聊与私聊两套间隔与概率。</li>
                  <li><b>上下文与轮换</b>：单会话累计多少真实回合后归档轮换到新会话（默认 12，提前预热下一代避免首轮卡顿），防止上下文膨胀。</li>
                  <li><b>发送节奏 / 回复停顿</b>：连发条数、条间间隔、回复前停顿——调得像真人打字。</li>
                  <li><b>表情包</b>：用 QQ 收藏表情回消息、自动收藏贴语境的图、上传自定义图库。</li>
                </ul>
              </DocSection>
              <DocSection title="人设与角色导入">
                <ul>
                  <li>出厂 persona.md 为空且不预置任何默认角色——直接从「上传载入」放自己的 .md/.txt，或点「角色库导入」扫描角色库（默认目录 = 桥目录 <code>characters</code>（含出厂 _template 模板与角色库说明）或桌面 <code>characters</code>，也可手动输入任意目录），载入后点「保存人设」即生效。</li>
                  <li>speech-rules.md 出厂带通用英文模板（行为规矩，不含人设），可「恢复默认」。</li>
                </ul>
              </DocSection>
              <DocSection title="学习系统（黑话 / 人格 / 群友画像）">
                <ul>
                  <li><b>三套学习在「学习」页分开管理</b>，互不干扰：<b>黑话</b>（提取群里的网络用语并联网考究）、<b>人格学习</b>（学指定的 <code>targetQQ</code>，结果落档案）、<b>群友画像</b>（自动挑活跃群友，落库方式与人格学习完全一致，所以「群友画像」页零改动就能看到）。</li>
                  <li><b>触发方式</b>：面板上的「立即学习」按钮；<code>/slang learn</code>、<code>/portrait learn</code> 这类聊天指令；以及配置里的<b>每日定时</b>（北京时 <code>HH:MM</code>，留空=关）和<b>间隔学习</b>（每 N 小时）。出厂默认只有人格学习的间隔触发是开的。</li>
                  <li><b>群友画像的筛选条件</b>：近 N 天（默认 30 天 / 720 小时）发言数 ≥ <code>minMessages</code>（默认 10）的非自己、未撤回、有正文消息；按发言数降序取前 <code>maxTargets</code>（默认 20）人。这两个旋钮就是成本开关——调高会明显更贵。</li>
                  <li><b>画像学习与人格学习不互相污染</b>：画像走 <code>auto:false</code> 路径，不写 <code>persona.lastRunAtMs</code> 水位，所以两套学习的间隔各自独立计时。</li>
                  <li><b>失败退避</b>：整批失败不推进水位并退避 30 分钟；定时触发失败额外节流 5 分钟，避免每分钟重试刷学习会话。</li>
                  <li><b>学习会话的产出方式</b>：模型不把结果当文本吐回来，而是调用落库工具（如 <code>qq_learning_submit</code>）直接写库，然后只回 <code>OK</code>——省 token，学习会话里也不再留一大坨 JSON。桥侧仍保留「解析文本 JSON」的兜底，模型偶尔不听话也不会丢数据。</li>
                  <li><b>发给模型的任务说明与提醒都是英文指令框架</b>（中文只保留样本原文和要落库的字段值），更省 token、跨模型更稳。改写这些文案时记得把 <code>SLANG_BRIEF_VERSION</code> / <code>PERSONA_BRIEF_VERSION</code> 加一，桥会据此给老学习会话重新注入说明。</li>
                </ul>
              </DocSection>

              <DocSection title="空闲会话自动归档">
                <ul>
                  <li>桥每 10 分钟巡检一次，把闲置超过 30 分钟（且不是当前正在跑回合）的 DSH 会话归档，避免常驻会话越堆越多、上下文越滚越大。</li>
                  <li>归档不是删除：会话文件仍在 <code>qq-bridge/state/</code> 下，需要时会被重新唤醒/重建。</li>
                  <li>界面上的状态与手动触发在桥控制台接口 <code>/api/social/session-archive</code>。</li>
                </ul>
              </DocSection>

              <DocSection title="Token 用量面板">
                <ul>
                  <li><b>两种口径要分清</b>：<b>实测</b>区是日志里的精确值、不做任何反推；<b>预算</b>区是拿「假设缓存命中率」手输算出来的估算，两者物理分开显示。</li>
                  <li><b>用量口径</b>：每次请求 = 未命中输入 + 缓存命中 + 输出，三项相加。不要用提供方返回的 <code>total_tokens</code>——那是<b>会话累计快照</b>，直接累加会虚高好几倍。</li>
                  <li><b>缓存命中率是实测值</b>：只用带缓存字段的请求算（命中 ÷ (命中 + 未命中)），不带缓存字段的请求不参与、更不反推。</li>
                  <li><b>实时刷新</b>：走 SSE 推流，新的用量记录一到就更新；连接失败会自动退回 60 秒轮询。</li>
                </ul>
              </DocSection>

              <DocSection title="图片处理">
                <ul>
                  <li>收到/要发的图片会在桥内做一次「保证可投递」的预处理：超过 <b>4096 像素单边</b>或 <b>5MB</b> 就自动缩放/重压。</li>
                  <li>编解码器是内置的纯 JS 实现（PNG/JPEG），不依赖 sharp，换机器/重装不会因为缺原生模块而整条链路报错。</li>
                  <li>输出格式按<b>字节嗅探</b>决定，不沿用输入声明的 mime，避免「PNG 字节却标成 jpeg」把整条提示词拒掉。</li>
                </ul>
              </DocSection>

              <DocSection title="工具 schema 精简（省额度最狠的一刀）">
                <ul>
                  <li><b>钱花在哪</b>：一次模型请求约 <b>85,800 字符</b>，其中 <b>工具描述（JSON schema）占 72,858 ≈ 87%</b>，system 只有 13,141。
                    更关键的是 <b>每一步都会把这整包重发一次</b>——所以「少一步」和「少一个工具」比「把提示词写短几个字」重要一个数量级。</li>
                  <li><b>为什么另一组开关不管用</b>：「QQ 工具开关」是在<b>调用时</b>返回「工具未启用」，工具描述照样每次全量下发，<b>一个字符都省不掉</b>。</li>
                  <li><b>这张卡才是真的</b>：打勾 = 该工具<b>不注册</b>给模型，它的 JSON 描述从每一次请求里<b>彻底消失</b>。
                    实测出厂默认：84 个工具 → <b>61 个</b>，工具 schema 72,858 → <b>55,033</b> 字符（<b>−24.5%</b>），
                    单次请求合计约 <b>26.9k → 21.3k tokens</b>（−21%，每一步都省）。</li>
                  <li><b>生效条件</b>：工具表只在 <b>DSH 启动时取一次</b>，所以改完必须<b>重启隔离 DSH</b>（卡里有「保存并重启」按钮）。只重启桥没用。</li>
                  <li><b>出厂默认就关了 21 个</b>（点「出厂默认名单」可一键回到这个状态）：那 21 个是 1,835 次真实工具调用里<b>用过 0 次</b>、且人设/规则里<b>从未教过</b>的；
                    其余工具（定时提醒、记忆检索、空间互动、表情包、撤回、管理…）都保留 —— 它们要么真被用过，要么是"现在没人用但真实可用"的能力，要不要砍由你决定。
                    标红的 <code>send_message / mark_read / wait_for_messages / set_wake_config / get_unread_messages</code> 是核心，关掉机器人基本就失能了。</li>
                  <li><b>口径</b>：卡片上的字符数是从真实会话转录的 <code>request/header.tools</code> 里量出来的，token 按 <b>3.2 字符/token</b> 估算。</li>
                </ul>
              </DocSection>

              <DocSection title="常见问题">
                <ul>
                  <li><b>保存提示「目标桥不可达」</b>：桥没在跑。先确认 NapCat 已登录（QQ 在线）、DSH 已启动，再启动 QQ-Bridge，或直接用首页「一键启动整套」。</li>
                  <li><b>模型不回话</b>：看隔离 DSH 日志/隔离 home 的 .credentials.yaml 是否配了 DEEPSEEK_API_KEY；NapCat 是否在线。</li>
                  <li><b>端口</b>：管理端 1921 · NapCat 6099/3000/3001 · 隔离 DSH 10721（实例配置里可改）· 桥 3100。</li>
                  <li><b>重启顺序</b>：重启管理器会连带停掉它托管的 DSH / NapCat / 桥。若隔离 DSH 端口被残留进程占住（新实例秒退、桥一直刷连接失败），按「杀掉占用 10721 的进程 → 删 <code>qq-bridge/state/bridge.lock</code> → 启动 DSH → 启动桥」的顺序恢复。</li>
                </ul>
              </DocSection>


            </div>
          </div>
        </div>
      )}

      {charOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(30,20,30,0.45)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setCharOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 18, width: 'min(760px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.22)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid #f0eef6' }}>
              <Library size={18} style={{ color: 'var(--nc-primary-500)' }} />
              <b style={{ fontSize: 15, color: 'var(--nc-primary-500)' }}>角色库导入（characters）</b>
              <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setCharOpen(false)}><X size={18} /></button>
            </div>
            <div style={{ padding: '14px 20px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="角色库根目录(留空自动探测: 桥 characters / 桌面 characters)"
                value={charDir} onChange={(e) => setCharDir(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') scanChars(charDir || undefined); }} />
              <button className="btn btn-soft btn-sm" disabled={charBusy} onClick={() => scanChars(charDir || undefined)}>
                {charBusy ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} 扫描
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 14px' }}>
              {charMsg && <div className="notice-bar" onClick={() => setCharMsg(null)} style={{ marginBottom: 10 }}>{charMsg}</div>}
              {!charList.length && !charBusy && (
                <div style={{ color: '#9a8fb0', fontSize: 13, padding: '18px 4px' }}>点「扫描」列出角色；每个角色会优先使用 ULTIMATE_ROLEPLAY_PROMPT.md（若无则自动拼维度 md）。</div>
              )}
              {charList.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {charList.map((c) => (
                    <button key={c.slug} className="btn" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-start', textAlign: 'left', padding: '9px 12px' }}
                      disabled={charBusy} onClick={() => applyCharacter(c)} title={c.game || c.slug}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.mainPrompt ? 'var(--nc-primary-400)' : '#d9d2e6', flexShrink: 0 }} />
                      <b style={{ fontSize: 13.5, color: '#3d2b4f', minWidth: 110 }}>{c.name}</b>
                      <span style={{ fontSize: 12, color: '#8a7f9e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.game || c.slug}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: c.mainPrompt ? 'var(--nc-primary-500)' : '#b3a9c4' }}>{c.mainPrompt ? '主提示 ✓' : `无主提示(${c.mdFiles}md)`}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================= 常用设置：一功能一卡片，3 列等高对齐 ================= */
function CommonTab({ cfg, ch, onHelp, uploadStickers, remote, writeConfig, onCfgChange }: {
  cfg: any; ch: (p: string) => (v: any) => void;
  onHelp: (h: any) => void;
  uploadStickers: (files: File[]) => Promise<void>;
  remote?: { id: string; name?: string } | null;
  /** 活跃时段卡要用：整份配置写回 + 回写页面状态（加群要落进 allow.groups） */
  writeConfig: (next: any) => Promise<any>;
  onCfgChange: (next: any) => void;
}) {
  // 精简后的基础项：删掉端口/令牌/会话目录等系统自管项，避免无效配置
  const topOnly = ['agentPreset', 'workspaceTitle', 'ownerQQ', 'adminQQ', 'ackMessage', 'sendDelayMs', 'questionTimeoutMs'];
  return (
    <div className="cfg-grid">
      <GroupCard title="模型与推理" path="dsh" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="连到哪个 DSH、用什么模型回话。服务商默认「自动探测」（即用隔离 DSH 里已配置的官方 DeepSeek），也可显式选 DeepSeek 官方；留空模型即用 DSH 默认。改这里会自动重启隔离 DSH 使其生效。「推理档位」是单次调用耗时与思考 token 最大的一块——实测同一次调用出现过 37 秒，嫌慢/嫌贵先从它和「工具与规则」页的精简名单入手。" />
      <GroupCard title="NapCat 连接" path="napcat" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="机器人与 NapCat 的通信地址和令牌；本地一键启动时一般不用改。注意：这里改的令牌只影响**桥**用哪个令牌去连；要让 NapCat 自己改用新令牌，用下面那张「NapCat 鉴权令牌」卡写入并重启。" />
      {/* 【2026-09-15 主人反馈】令牌要真正写进 NapCat 才生效：见 NapcatTokensCard 的注释 */}
      <NapcatTokensCard />
      <GroupCard title="基础与会话" path="" only={topOnly} cfg={cfg} ch={ch} onHelp={onHelp}
        desc="人设预设、主人 QQ、工作区与发送节奏等基础项。" />

      <div className="card-stack">
        <GroupCard title="允许名单" cfg={cfg} ch={ch} onHelp={onHelp}
          blocks={[{ path: 'allow' }, { path: '', only: ['allowAllWhenEmpty'] }]}
          desc="允许陪聊的私聊/群；留空 + 全部放行 = 谁都能聊。" />
        <GroupCard title="拒绝名单" path="deny" cfg={cfg} ch={ch} onHelp={onHelp}
          desc="永远不搭理的私聊/群，优先于允许名单。" />
      </div>
      <GroupCard title="唤醒 · 潜水 / 活跃" path="social.wake" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="机器人平时爱潜水，遇到这些词/被 @/被提问时才会醒过来。" />

      <GroupCard title="发送节奏与间隔" path="social.send" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="连发/停顿/字数上限——控制发消息像不像真人打字。" />
      <GroupCard title="上下文与轮换" blocks={[{ path: 'social.context' }, { path: 'social.autoReset' }]}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="每轮带多少历史、聊太久自动换新会话，防止记性爆掉。" />
      <GroupCard title="主动闲聊" path="social.proactive" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="冷场/没人说话时机器人会不会主动找话题、主动私聊。" />
      <ActivityHoursCard cfg={cfg} remote={remote} writeConfig={writeConfig} onCfgChange={onCfgChange} />

      <GroupCard title="等待：回复前的停顿" path="social.wait" cfg={cfg} ch={ch} onHelp={onHelp}        desc="模拟真人“想一想再回”：停顿多久、新消息后静默多久。全调 0 = 秒回机器人。" />
      {/* 【2026-09-15 主人要求】私聊看对方打字状态：等 ta 打完再回、不停发消息时状态连续、
          概率骰子决定要不要插话；等待期间的消息合并成一次注入。见 qq-bridge/src/core/typing-hold.js */}
      <GroupCard title="私聊打字等待（不抢话 / 智能接话）" path="social.typing" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="私聊里先看对方是不是正在打字：正在输入就先等 ta 打完再回（不抢话）；对方不停发消息时打字状态会一直延续；每次唤醒再掷一次骰子，命中就插话接上（智能接话）。等待期间到的消息全部排队、最后合并成一次发给模型，省注入轮数。" />
      <StickerCard cfg={cfg} ch={ch} onHelp={onHelp} uploadStickers={uploadStickers} />
      <GroupCard title="静默群聊" path="social" only={['deepsleep', 'deepsleepGroups']} cfg={cfg} ch={ch} onHelp={onHelp}
        desc="想省钱/想安静：全群静默（总开关），或只让名单里的个别群静默。" />

      <GroupCard title="智能体开关与自动回复" path="social" only={['enabled', 'autoReplyCheckMs', 'provideRecommendations']}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="整套智能体的总开关、检查新消息的频率、是否给模型喂推荐参数。" />
      <GroupCard title="投递与回合（速度 / 不吞消息）" blocks={[{ path: 'social', only: ['steerEnabled'] }, { path: 'social.turnHold' }]}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="「在途回合注入」：模型正在思考时，新消息会被直接塞进这一轮（而不是等它回完再另起一轮）。默认开启——关掉会让每条消息都要多等一整轮，而且容易卡在 DSH 的 next-turn 队列里出不来。下面一组是「回合保持」：一次唤醒后把这个回合留住多久、最多来回多少次，留住期间你可以连着补话而不用每条都重新唤醒（保持太久会一直占着会话，建议只对私聊开）。" />
      <GroupCard title="好友申请与信任" path="social" only={['autoFriendApproval', 'autoFriendGuard', 'trustedCrossSessionUids']}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="自动通过好友申请、敏感操作只信谁、允许跨会话读取的账号。" />
      <GroupCard title="Word 文档额度" path="social" only={['docx']} cfg={cfg} ch={ch} onHelp={onHelp}
        desc="AI 每天最多能生成多少 Word 文档（字数上限），防超支。" />
    </div>
  );
}

function at(o: any, p: string) { return p ? get(o, p) : o; }
function keysOf(cfg: any, path: string, only?: string[], filter?: (k: string) => boolean) {
  const v = at(cfg, path);
  if (v === undefined || !isObj(v)) return [];
  return Object.keys(v).filter((k) => (!only || only.includes(k)) && (!filter || filter(k)));
}

function GroupCard({ title, path, blocks, cfg, ch, onHelp, filter, only, desc, children }: {
  title: string;
  path?: string;
  blocks?: Array<{ title?: string; path: string; only?: string[] }>;
  cfg: any; ch: (p: string) => (v: any) => void;
  onHelp: (h: any) => void;
  filter?: (k: string) => boolean;
  only?: string[];
  desc?: string;
  children?: React.ReactNode;
}) {
  const sections: Array<{ title?: string; path: string; keys: string[] }> = blocks && blocks.length > 0
    ? blocks.map((b) => ({ title: b.title, path: b.path, keys: keysOf(cfg, b.path, b.only) }))
    : [{ title: undefined, path: path ?? '', keys: keysOf(cfg, path ?? '', only, filter) }];
  const avail = sections.filter((s) => s.keys.length > 0);
  if (avail.length === 0 && !children) return null;
  return (
    <div className="cfg-card">
      <div className="cfg-card-title">{title}</div>
      {desc && <div className="cfg-card-desc">{desc}</div>}
      {avail.map((s, i) => {
        const sub = avail.length > 1;
        return (
          <div key={s.path} className={sub ? 'cfg-block' : undefined}>
            {sub && s.title && <div className="cfg-block-title">{s.title}</div>}
            <div className="cfg-fields">
              {s.keys.map((k) => (
                <Field key={s.path + '.' + k} path={s.path ? s.path + '.' + k : k} val={at(cfg, s.path)[k]} label={pretty(k)} ch={ch} onHelp={onHelp} cfg={cfg} />
              ))}
            </div>
            {sub && i < avail.length - 1 && <div className="cfg-block-gap" />}
          </div>
        );
      })}
      {children}
    </div>
  );
}

/** 群聊活跃时段卡（2026-09-15 主人要求加在管理端；同日改成"列表化"）
 *  【对象清单不写死】群号/QQ 全从桥运行态枚举：GET /api/bridge/activity-targets →
 *  桥的 /api/social/targets（允许名单 ∪ 已建会话 ∪ 已设时段的键，附群名）→ 点哪一行就展开设哪一行。
 *  时段数据不在 config.json，而在桥的 state/activity-windows.json（按会话存，支持跨午夜如 09:00-01:00）。
 *  「添加群号」会同时补进允许名单（配置由本卡整份写回），否则机器人根本不处理那个群。 */
function ActivityHoursCard({ cfg, remote, writeConfig, onCfgChange }: {
  cfg: any;
  remote?: { id: string; name?: string } | null;
  /** 整份配置写回：本机走 /api/bridge/config，服务端走 /api/ssh/bridge-config */
  writeConfig: (next: any) => Promise<any>;
  onCfgChange: (next: any) => void;
}) {
  const scope = remote ? 'remote' : 'local';
  const [targets, setTargets] = useState<ActivityTarget[]>([]);
  const [meta, setMeta] = useState<{ deepsleep: boolean; deepsleepGroups: string[] }>({ deepsleep: false, deepsleepGroups: [] });
  const [openKey, setOpenKey] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showPrivate, setShowPrivate] = useState(false);
  const [newGid, setNewGid] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getActivityTargets({ scope, serverId: remote?.id });
      const list = Array.isArray(r.targets) ? r.targets : [];
      setTargets(list);
      setMeta({ deepsleep: !!r.deepsleep, deepsleepGroups: Array.isArray(r.deepsleepGroups) ? r.deepsleepGroups : [] });
      setDrafts((prev) => {
        const next = { ...prev };
        for (const t of list) if (next[t.key] === undefined) next[t.key] = t.windows || '';
        return next;
      });
      setMsg(r.ok ? '' : (r.message || '读取失败'));
    } catch (e) { setMsg('读取失败：' + (e as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scope, remote?.id]);

  const groups = targets.filter((t) => t.kind === 'group');
  const privates = targets.filter((t) => t.kind === 'private');
  const visible = showPrivate ? targets : groups;

  /** 保存单个对象的时段（留空 = 不限） */
  const saveOne = async (key: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await saveActivityHours([{ key, windows: drafts[key] ?? '' }], { scope, serverId: remote?.id });
      const one = (r.results ?? [])[0];
      if (!one?.ok) { setMsg(`没保存成功：${one?.error || r.message || '未知原因'}`); return false; }
      setMsg(`已保存${remote ? '到服务端' : ''}：${key.replace(':', ' ')} = ${one.windows || '不限（全天随意）'}`);
      await refresh();
      return true;
    } catch (e) { setMsg('保存失败：' + (e as Error).message); return false; }
    finally { setBusy(false); }
  };

  /** 添加群号：先补进允许名单（否则桥不处理该群），再设它的活跃时段 */
  const addGroup = async () => {
    const gid = newGid.replace(/\D/g, '');
    if (!gid) { setMsg('先填群号（纯数字）'); return; }
    setBusy(true); setMsg('');
    try {
      const list: string[] = Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups.map(String) : [];
      if (!list.includes(gid)) {
        const next = { ...(cfg || {}), allow: { ...(cfg?.allow || {}), groups: [...list, gid] } };
        const r = await writeConfig(next);
        if (r && r.ok === false) { setMsg('写入允许名单失败：' + (r.message || '未知原因')); return; }
        onCfgChange(next);
      }
      setNewGid('');
      setOpenKey('group:' + gid);
      await refresh();
      setMsg(`群 ${gid} 已加入允许名单（上方保存后长期生效），下面接着设它的活跃时段`);
    } catch (e) { setMsg('添加失败：' + (e as Error).message); }
    finally { setBusy(false); }
  };

  /** 一键关掉「静默群聊」总开关：开着的时候所有群消息都被跳过，活跃时段形同虚设 */
  const turnOffSilence = async () => {
    setBusy(true); setMsg('');
    try {
      const next = { ...(cfg || {}), social: { ...(cfg?.social || {}), deepsleep: false } };
      const r = await writeConfig(next);
      if (r && r.ok === false) { setMsg('关闭失败：' + (r.message || '未知原因')); return; }
      onCfgChange(next);
      setMsg('已关闭「静默群聊」——群消息会重新交给机器人处理');
      await refresh();
    } catch (e) { setMsg('关闭失败：' + (e as Error).message); }
    finally { setBusy(false); }
  };

  const statusText = (t: ActivityTarget) => {
    if (!t.allowed) return '当前模式不允许这个会话';
    if (!t.windows) return '不限时段（全天随意）';
    return t.inWindow ? '现在在时段内' : `现在不在时段内（下一个 ${t.nextWindowStart || '—'} 开始）`;
  };

  return (
    <div className="cfg-card">
      <div className="cfg-card-title">群聊活跃时段{remote ? '（服务端）' : ''}</div>
      <div className="cfg-card-desc">
        列表由机器人当前认识的对象自动生成（允许名单 + 已建会话），点一行就能单独设它的时段。
        时间是北京时间，支持跨午夜（如 <code>09:00-01:00</code>），多个用逗号分隔。<br />
        时段内：正常参与、别急着潜水；时段外：没正事就潜水。留空 = 不设时段。
        @、叫名字、提问这类唤醒不受时段限制，永远会回。
      </div>

      {meta.deepsleep && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0', padding: '6px 8px', border: '1px solid #d9822b', borderRadius: 6 }}>
          <AlertTriangle size={14} />
          <span style={{ fontSize: 12 }}>
            「静默群聊」总开关正开着 —— 所有群消息都会被跳过，这里的时段一个也不会生效。
          </span>
          <button type="button" className="btn btn-soft-primary btn-sm" disabled={busy} onClick={turnOffSilence}>关闭静默，恢复群聊响应</button>
        </div>
      )}

      {meta.deepsleepGroups.length > 0 && (
        <div className="cfg-card-desc" style={{ fontSize: 12 }}>
          单群静默名单：{meta.deepsleepGroups.join('、')}（这些群的消息照样被跳过，调之前先从名单里去掉）
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '6px 0', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={refresh}>
          {loading ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} 刷新列表
        </button>
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={showPrivate} onChange={(e) => setShowPrivate(e.target.checked)} />
          连私聊一起列（{privates.length}）
        </label>
        <span style={{ fontSize: 12, opacity: 0.7 }}>群 {groups.length} 个</span>
      </div>

      {!visible.length && !loading ? (
        <div className="cfg-card-desc">桥还没认识任何对象 —— 下面填群号加一个，或先在「允许名单」里加群。</div>
      ) : (
        <div className="cfg-fields">
          {visible.map((t) => {
            const open = openKey === t.key;
            return (
              <div key={t.key} style={{ marginBottom: 6, borderBottom: '1px solid rgba(128,128,128,0.18)', paddingBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button" className="btn btn-sm"
                    style={{ minWidth: 190, justifyContent: 'flex-start' }}
                    onClick={() => setOpenKey(open ? '' : t.key)}
                  >
                    {open ? '▾' : '▸'} {t.kind === 'group' ? '群 ' : '私聊 '}
                    {t.name ? `${t.name}（${t.id}）` : t.id}
                  </button>
                  <span style={{ fontSize: 12, opacity: 0.85 }}>时段：{t.windows || '不限'}</span>
                  <span style={{ fontSize: 12, opacity: 0.6 }}>{statusText(t)}</span>
                  {t.kind === 'group' && !t.inAllowList && <span style={{ fontSize: 12, color: '#d9822b' }}>不在允许名单</span>}
                  {!!t.unread && <span style={{ fontSize: 12, opacity: 0.6 }}>未读 {t.unread}</span>}
                </div>
                {open && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                    <input
                      className="input" style={{ maxWidth: 260 }}
                      placeholder="如 09:00-01:00 ，留空=不限"
                      value={drafts[t.key] ?? ''}
                      onChange={(e) => setDrafts((p) => ({ ...p, [t.key]: e.target.value }))}
                    />
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveOne(t.key)}>
                      {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存这个
                    </button>
                    <button
                      type="button" className="btn btn-sm" disabled={busy}
                      onClick={() => { setDrafts((p) => ({ ...p, [t.key]: '' })); void saveActivityHours([{ key: t.key, windows: '' }], { scope, serverId: remote?.id }).then(refresh); }}
                    >清空（不限时段）</button>
                    <span style={{ fontSize: 12, opacity: 0.6 }}>
                      快捷：<a style={{ cursor: 'pointer' }} onClick={() => setDrafts((p) => ({ ...p, [t.key]: '09:00-01:00' }))}>09:00-01:00</a>
                      {' · '}<a style={{ cursor: 'pointer' }} onClick={() => setDrafts((p) => ({ ...p, [t.key]: '08:00-12:00,14:00-23:00' }))}>白天+晚间</a>
                      {' · '}<a style={{ cursor: 'pointer' }} onClick={() => setDrafts((p) => ({ ...p, [t.key]: '00:00-24:00' }))}>全天</a>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <input
          className="input" style={{ maxWidth: 160 }} placeholder="群号，如 123456789"
          value={newGid} onChange={(e) => setNewGid(e.target.value)}
        />
        <button type="button" className="btn btn-soft-primary btn-sm" disabled={busy} onClick={addGroup}>
          <Users size={14} /> 添加群（并加入允许名单）
        </button>
        {msg && <span style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

/** 表情包卡：收藏表情设置 + 「发表情概率」+ 上传表情包图库 */
function StickerCard({ cfg, ch, onHelp, uploadStickers }: {
  cfg: any; ch: (p: string) => (v: any) => void;
  onHelp: (h: any) => void;
  uploadStickers: (files: File[]) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const fields = keysOf(cfg, 'social.sticker');
  if (!fields.length) return null;
  return (
    <div className="cfg-card">
      <div className="cfg-card-title">表情包</div>
      <div className="cfg-card-desc">表情库 = 你 QQ 的收藏表情 + 本地上传的图库。这里管能不能用表情、多久同步、发图频率、上传自己的表情。</div>
      <div className="cfg-fields">
        {fields.map((k) => (
          <Field key={'social.sticker.' + k} path={'social.sticker.' + k} val={at(cfg, 'social.sticker')[k]} label={pretty(k)} ch={ch} onHelp={onHelp} />
        ))}
      </div>
      <div className="sticker-upload">
        <input
          ref={fileRef} type="file" hidden multiple accept="image/*,.gif"
          onChange={async (e) => {
            const fs = e.target.files;
            if (fs?.length) {
              setBusy(true);
              try { await uploadStickers(Array.from(fs)); }
              catch { /* toast 由父级显示 */ }
              finally { setBusy(false); }
            }
            e.target.value = '';
          }}
        />
        <button type="button" className="btn btn-soft-primary btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} 上传表情包图库
        </button>
        <span className="upload-hint">选本地图片/动图入库，AI 也能用（存到 stickers-upload/ 并自动重启桥接）</span>
      </div>
    </div>
  );
}

function ToolsTab({ cfg, ch, onSave }: { cfg: any; ch: (p: string) => (v: any) => void; onSave: () => Promise<void> }) {
  const v = get(cfg, 'social.tools');
  if (!v || !isObj(v)) return <div className="empty-state">当前配置没有可开关的 MCP 工具</div>;
  const keys = Object.keys(v).sort((a, b) => prettyTool(a).localeCompare(prettyTool(b), 'zh'));
  return (
    <div className="card-stack">
      <div className="card">
        <div className="card-title">QQ 工具开关（中文名 · MCP 工具原名）</div>
        <div className="switch-grid">
          {keys.map((k) => (
            <label key={k} className="switch-row" title={LABEL[k] || undefined}>
              <input type="checkbox" checked={!!v[k]} onChange={() => ch('social.tools.' + k)(!v[k])} />
              <span style={{ minWidth: 0 }}>
                {prettyTool(k)}
                {TOOL_MCP[k] ? (
                  <span style={{
                    color: 'var(--nc-foreground-400)', fontSize: 12,
                    fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace",
                    overflowWrap: 'anywhere',
                  }}> · {TOOL_MCP[k]}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginTop: 14 }}>
          关闭某项即停用对应的 QQ 工具（AI 调用时会被拒绝）；开关不影响人设文本里已有的自然语言规则。点开关左边看不到英文名时，说明该键还没登记映射（开关依旧生效）。
          <br />
          <b style={{ color: 'var(--nc-foreground-300, inherit)' }}>注意：这一组开关<b>不省 token</b></b> —— 工具描述无论如何都会随每次请求发给模型，
          关掉只是"拒绝调用"。要真正少花钱，请用下面那张「工具 schema 精简」卡。
        </div>
      </div>
      <SlimToolsCard cfg={cfg} ch={ch} onSave={onSave} />
    </div>
  );
}

/** 关掉就会让机器人失能的核心工具：在精简名单里高亮提醒（不硬锁，主人自己决定）。 */
const SLIM_CORE_TOOLS = new Set([
  'mcp__napcat__qq_send_message',
  'mcp__napcat__qq_mark_read',
  'mcp__napcat__qq_wait_for_messages',
  'mcp__napcat__qq_set_wake_config',
  'mcp__napcat__qq_get_unread_messages',
]);

/** 出厂推荐精简名单（= 出厂默认就关掉的那批）：1835 次真实工具调用里用过 0 次、且提示词（人设/规则/协议）里从未教过。 */
const SLIM_RECOMMENDED = [
  'mcp__napcat__qq_crosschat_send',
  'mcp__napcat__qq_crosschat_inbox',
  'mcp__napcat__qq_sticker_note',
  'mcp__napcat__qq_set_sticker_remark',
  'mcp__napcat__qq_history_delete',
  'mcp__napcat__qq_history_clear',
  'mcp__napcat__qq_memory_query',
  'mcp__napcat__qq_memory_remove',
  'mcp__napcat__qq_memory_clear',
  'mcp__napcat__qq_remove_friend',
  'mcp__napcat__qq_report_feedback',
  'mcp__napcat__qq_persona_learn_start',
  'mcp__napcat__qq_persona_learn_stop',
  'mcp__napcat__qq_persona_learn_status',
  'mcp__napcat__qq_memory_append',
  'mcp__napcat__qq_deepsleep',
  'mcp__napcat__qq_get_sticker_image',
  'mcp__napcat__qq_profile_get',
  'mcp__napcat__qq_get_group_history',
  'mcp__napcat__qq_get_self_image',
  'mcp__napcat__qq_get_active_members',
];

/** 不归这张卡管的固定开销（另外几个 MCP server + DSH 自带的工具）。 */
const SLIM_FIXED_OTHER_CHARS = 2556;

/**
 * 「工具 schema 精简」卡 —— 真正省额度的那一刀。
 *
 * 背景（实测，见交接文档 §八.5）：单次模型请求 ≈ 85,800 字符，其中 `tools` 占 **72,858 字符 ≈ 87%**，
 * 而 system 只有 13,141。更关键的是**每一步都会把这整包重发一次**（靠前缀缓存按缓存读计价）。
 * config 里的 `social.tools.*` 开关只在调用时 403，一个字符都省不掉；
 * 只有"**根本不注册**"才真的让 schema 消失 —— 那就是这里改的 `social.slimTools.deny`，
 * 它在桥的 MCP server（mcp-napcat-safe.js）启动时生效。
 */
function SlimToolsCard({ cfg, ch, onSave }: { cfg: any; ch: (p: string) => (v: any) => void; onSave: () => Promise<void> }) {
  const denyRaw = get(cfg, 'social.slimTools.deny');
  const deny: string[] = Array.isArray(denyRaw) ? denyRaw : [];
  const enabled = get(cfg, 'social.slimTools.enabled') === true;
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const all = Object.keys(TOOL_SCHEMA_CHARS)
    .filter((n) => n.startsWith(SLIM_PREFIX))
    .sort((a, b) => TOOL_SCHEMA_CHARS[b] - TOOL_SCHEMA_CHARS[a]);
  const denySet = new Set(deny);
  const kept = all.filter((n) => !denySet.has(n));
  const keptChars = kept.reduce((s, n) => s + TOOL_SCHEMA_CHARS[n], 0);
  const savedChars = all.filter((n) => denySet.has(n)).reduce((s, n) => s + TOOL_SCHEMA_CHARS[n], 0);
  const extraDeny = deny.filter((n) => !TOOL_SCHEMA_CHARS[n]);
  const kw = q.trim().toLowerCase();
  const shown = kw ? all.filter((n) => n.toLowerCase().includes(kw)) : all;
  const short = (n: string) => n.slice(SLIM_PREFIX.length);
  const setDeny = (next: string[]) => ch('social.slimTools.deny')([...new Set(next)].sort());
  const toggle = (n: string) => setDeny(denySet.has(n) ? deny.filter((x) => x !== n) : [...deny, n]);

  const saveAndRestart = async (what: 'both' | 'bridge' | 'dsh') => {
    setBusy(what); setMsg(null);
    try {
      await onSave();
      if (what === 'both' || what === 'dsh') await instanceAction('dsh-isolated', 'restart');
      if (what === 'both' || what === 'bridge') await instanceAction('bridge-local', 'restart');
      setMsg('已保存并重启：' + (what === 'both' ? '隔离 DSH + 桥接' : what === 'dsh' ? '隔离 DSH' : '桥接') + '（约 15 秒后才完全就绪）');
    } catch (e: any) { setMsg('失败：' + (e?.message || '')); }
    finally { setBusy(''); }
  };

  const effectiveKept = enabled ? kept.length : all.length;
  const effectiveChars = enabled ? keptChars + SLIM_FIXED_OTHER_CHARS : all.reduce((s, n) => s + TOOL_SCHEMA_CHARS[n], 0) + SLIM_FIXED_OTHER_CHARS;

  return (
    <div className="card">
      <div className="card-title">工具 schema 精简（真省额度）</div>
      <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 12, lineHeight: 1.7 }}>
        每次请求里 <b>约 87% 的 token 是工具描述（JSON schema）</b>，而且<b>每一步都会重发一遍</b>——
        少注册一个用不到的工具，比把提示词写短几个字划算得多。<br />
        打勾 = <b>这个工具干脆不注册给模型</b>（它的 schema 从每一次请求里彻底消失）；
        不打勾 = 正常注册。<b>改完必须重启隔离 DSH</b>（工具表只在 DSH 启动时取一次）。
      </div>

      <label className="switch-row" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => ch('social.slimTools.enabled')(e.target.checked)} />
        <span>启用精简名单（关掉 = 所有工具都注册，回到默认）</span>
      </label>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 13 }}>
          当前生效：<b>{effectiveKept}</b> 个工具 · 约 <b>{effectiveChars.toLocaleString()}</b> 字符 ≈{' '}
          <b>{charsToTokens(effectiveChars).toLocaleString()}</b> tokens/步
        </span>
        <span style={{ fontSize: 13, color: 'var(--nc-foreground-400)' }}>
          （已精简 {enabled ? all.length - kept.length : 0} 个 · 省 {enabled ? savedChars.toLocaleString() : 0} 字符 ≈{' '}
          {charsToTokens(enabled ? savedChars : 0).toLocaleString()} tokens/步）
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className="btn btn-soft btn-sm" onClick={() => setDeny(SLIM_RECOMMENDED)}>出厂默认名单（21 个，从没用过）</button>
        <button className="btn btn-soft btn-sm" onClick={() => setDeny([])}>全部恢复</button>
        <input className="input" style={{ maxWidth: 220 }} placeholder="筛选工具名…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--nc-border-200, #e5e5e5)', borderRadius: 8, padding: 8 }}>
        <div className="switch-grid">
          {shown.map((n) => {
            const on = denySet.has(n);
            const core = SLIM_CORE_TOOLS.has(n);
            return (
              <label key={n} className="switch-row" title={core ? '核心工具：关掉机器人基本就失能了' : undefined}>
                <input type="checkbox" checked={on} onChange={() => toggle(n)} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace", fontSize: 12.5, color: core ? '#c0392b' : undefined }}>
                    {short(n)}
                  </span>
                  <span style={{ color: 'var(--nc-foreground-400)', fontSize: 12 }}> · {TOOL_SCHEMA_CHARS[n]} 字符</span>
                  {core ? <span style={{ color: '#c0392b', fontSize: 12 }}> · 核心，慎关</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)', marginTop: 10, lineHeight: 1.7 }}>
        只有 <code>mcp__napcat__</code> 系列受这张名单控制；另有两个模型侧工具（<code>todo_write</code> / <code>ask_user_question</code>）
        已经在人设预设里卸载了对应插件，不在这里。<br />
        本页只影响"注册不注册"；能否<b>调用</b>仍由上面那张「QQ 工具开关」决定。名单里的名字必须与下方的 MCP 原名完全一致。
        {extraDeny.length > 0 ? <><br />名单里还有 {extraDeny.length} 个当前未注册的名字会被原样保留：{extraDeny.slice(0, 6).join(', ')}{extraDeny.length > 6 ? ' …' : ''}</> : null}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => saveAndRestart('both')}>
          {busy === 'both' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存并重启（推荐）
        </button>
        <button className="btn btn-soft btn-sm" disabled={!!busy} onClick={() => saveAndRestart('dsh')}>只重启隔离 DSH</button>
        <button className="btn btn-soft btn-sm" disabled={!!busy} onClick={() => saveAndRestart('bridge')}>只重启桥接</button>
        {msg && <span style={{ fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}

/** 「推理档位」下拉：**不写死低/中/高**（2026-09-12 主人要求）
 *  · 选项就是各服务商**真实的英文档位 id**（off/none/minimal/low/medium/high/xhigh/max…），
 *    只有常见的几档后面带一句中文提示，其余一律原样显示 id；
 *  · DSH 里已经配好、但不在预设列表里的值（例如某些厂商的 `xhigh`）会直接以**自定义输入框**
 *    回显，不会"显示成空白、一保存就被悄悄改掉"；
 *  · 下面一行显示隔离 DSH 的 settings.yaml 里**现在实际生效**的档位，方便核对。 */
const EFFORT_PRESETS: Array<{ id: string; hint?: string }> = [
  { id: 'off', hint: '关闭思考' },
  { id: 'none', hint: '同 off' },
  { id: 'minimal', hint: '最低' },
  { id: 'low', hint: '快但粗略' },
  { id: 'medium', hint: '平衡' },
  { id: 'high', hint: '仔细但慢' },
  { id: 'xhigh', hint: '更高（部分服务商不支持）' },
  { id: 'max', hint: '最高（部分服务商不支持）' },
];
function EffortField({ path, val, ch, renderLabel }: {
  path: string; val: string;
  ch: (p: string) => (v: any) => void;
  renderLabel: () => ReactNode;
}) {
  const [custom, setCustom] = useState(false);
  const presetIds = EFFORT_PRESETS.map((p) => p.id);
  const cur = String(val ?? '');
  const isCustom = custom || (cur !== '' && !presetIds.includes(cur));
  const dshVal = String(DSH_EFFECTIVE.reasoningEffort ?? '');
  const hint = dshVal ? `DSH 当前生效：${dshVal}` : 'DSH 当前未写死档位（用服务商默认）';
  return (
    <label className="field-row">
      {renderLabel()}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {isCustom ? (
          <>
            <input className="input" style={{ width: 130 }} value={cur} placeholder="如 xhigh / max"
              onChange={(e) => ch(path)(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => { setCustom(false); ch(path)(''); }}>改用预设</button>
          </>
        ) : (
          <select className="select" value={cur}
            onChange={(e) => { if (e.target.value === '__custom__') setCustom(true); else ch(path)(e.target.value); }}>
            <option value="">自动探测（跟随 DSH / 服务商默认）</option>
            {EFFORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.id}{p.hint ? `（${p.hint}）` : ''}</option>)}
            <option value="__custom__">自定义…（手输档位 id）</option>
          </select>
        )}
        <em style={{ fontStyle: 'normal', fontSize: 11.5, opacity: .75 }}>{hint}</em>
      </span>
    </label>
  );
}

/** 「主模型 / 识图模型」：下拉里给的是**当前服务商真实可用的模型**（来自 DSH 自己的配置），
 *  换服务商 → 列表跟着换；当前值不在新列表里也能回显，不会被悄悄改掉；想要清单外的模型点「自定义…」手输。
 *  【2026-09-13 主人要求："切换模型商时自动切换对应的模型列表"】 */
function ModelField({ path, val, ch, renderLabel, cfg, vision }: {
  path: string; val: string;
  ch: (p: string) => (v: any) => void;
  renderLabel: () => ReactNode;
  cfg: any;
  vision?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const cur = String(val ?? '');
  const provider = String(cfg?.dsh?.provider ?? '');
  const list = modelListFor(provider);
  const ids = list.map((m) => m.id);
  const isCustom = custom || (cur !== '' && !ids.includes(cur));
  const effLabel = provider ? provider : `自动探测 → ${DSH_EFFECTIVE.provider || 'DSH 默认'}`;
  const srcLabel = modelListSource(provider || String(DSH_EFFECTIVE.provider || ''));
  return (
    <label className="field-row">
      {renderLabel()}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {isCustom ? (
          <>
            <input className="input" style={{ width: 220 }} value={cur} placeholder={vision ? '留空=跟随主模型' : '如 deepseek-v4-pro'}
              onChange={(e) => ch(path)(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => { setCustom(false); ch(path)(''); }}>用列表里的</button>
          </>
        ) : (
          <select className="select" value={cur}
            onChange={(e) => { if (e.target.value === '__custom__') setCustom(true); else ch(path)(e.target.value); }}>
            <option value="">{vision ? '留空（跟随主模型）' : '留空（用 DSH 默认）'}</option>
            {list.map((m) => <option key={m.id} value={m.id}>{m.id}{m.name && m.name !== m.id ? `（${m.name}）` : ''}</option>)}
            <option value="__custom__">自定义…（手输模型 id）</option>
          </select>
        )}
        <em style={{ fontStyle: 'normal', fontSize: 11.5, opacity: .75 }}>
          {list.length ? `${list.length} 个可用模型 · ${srcLabel} · ${effLabel}` : 'DSH 里还没读到模型清单（可手输）'}
        </em>
      </span>
    </label>
  );
}

function Field({ path, val, label, ch, onHelp, cfg }: {
  path: string; val: any; label: string;
  ch: (p: string) => (v: any) => void;
  onHelp: (h: any) => void;
  cfg?: any;
}) {
  const [txt, setTxt] = useState<string>(Array.isArray(val) ? val.join('\n') : '');
  // 切服务商时给的提示（"模型列表跟着换了"）
  const [autoMsg, setAutoMsg] = useState('');
  const last = path.split('.').pop() || '';
  const labelText = LABEL[path] ?? LABEL[last] ?? label;
  const helpText = HELP[path] ?? HELP[last];
  const tipText = TIP[path] ?? TIP[last];
  const helpBtn = helpText ? (
    <button type="button" className="icon-btn help-dot" title="点击查看说明"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onHelp({ key: last, title: labelText, text: helpText }); }}>
      <HelpCircle size={14} />
    </button>
  ) : null;

  const renderLabel = () => (
    <span className="f-label">{labelText}{helpBtn}</span>
  );

  if (typeof val === 'boolean') {
    return (
      <label className="switch-row">
        <input type="checkbox" checked={val} onChange={(e) => ch(path)(e.target.checked)} />
        <span>{labelText}{helpBtn}</span>
        {tipText && <em>{tipText}</em>}
      </label>
    );
  }
  if (typeof val === 'number') {
    const isProb = last === 'sendProbability' || last === 'probability' || last === 'privateProbability' || last.endsWith('Probability');
    return (
      <label className="field-row">
        {renderLabel()}
        {/* 【2026-09-12】改成纯输入：没有上下箭头、可以整个删空（保存/失焦时才按 0 落值），
            不再出现"删到最后还剩一个 0 得挪光标去删"的情况。 */}
        <NumInput className="input" value={val} onCommit={(n) => ch(path)(isProb ? Math.max(0, Math.min(1, n)) : n)} />
      </label>
    );
  }
  if (typeof val === 'string') {
    if (last === 'defaultMode') {
      return (
        <label className="field-row">
          {renderLabel()}
          <select className="select" value={val} onChange={(e) => ch(path)(e.target.value)}>
            <option value="diving">潜水</option>
            <option value="active">活跃</option>
          </select>
        </label>
      );
    }
    // 下拉式配置：provider（空=自动探测用 DSH 端默认；DeepSeek 官方 / 小米 MiMo / DSH 里配过的其它服务商）
    // 【2026-09-13】切服务商时**模型列表跟着换**：当前模型不属于新服务商时，自动换成新服务商的默认模型
    //（主人反馈的现象就是"服务商选了 DeepSeek 官方、主模型还停在 mimo-v2.5"）。
    if (last === 'provider') {
      const list = modelListFor(String(val ?? ''));
      return (
        <label className="field-row">
          {renderLabel()}
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
            <select className="select" value={val} onChange={(e) => {
              const next = e.target.value;
              ch(path)(next);
              const modelPath = path.replace(/\.provider$/, '.model');
              const cur = String(get(cfg ?? {}, modelPath) ?? '');
              const nextList = modelListFor(next);
              const ids = nextList.map((m) => m.id);
              if (cur && !ids.includes(cur)) {
                const pick = ids.length ? ids[0] : '';
                ch(modelPath)(pick);
                setAutoMsg(`已切到「${next || '自动探测'}」的模型列表，主模型 ${cur} → ${pick || '(留空，跟随 DSH 默认)'}`);
              } else {
                setAutoMsg(`已切到「${next || '自动探测'}」的模型列表（${ids.length} 个模型），当前主模型仍在列表里，保持不变`);
              }
            }}>
              {providerChoices().map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <em style={{ fontStyle: 'normal', fontSize: 11.5, opacity: .75 }}>
              {autoMsg || (list.length
                ? `该服务商有 ${list.length} 个可用模型 · 列表来自 ${modelListSource(String(val ?? ''))}`
                : 'DSH 里还没读到这个服务商的模型清单（可直接手输模型 id）')}
            </em>
          </span>
        </label>
      );
    }
    // 主模型 / 识图模型：只给**当前服务商**的模型（+ 自定义），换服务商即换列表
    if (last === 'model' || last === 'visionModel') {
      return <ModelField path={path} val={val} ch={ch} renderLabel={renderLabel} cfg={cfg} vision={last === 'visionModel'} />;
    }
    if (last === 'agentPreset') {
      return (
        <label className="field-row">
          {renderLabel()}
          <select className="select" value={val} onChange={(e) => ch(path)(e.target.value)}>
            <option value="default">默认（QQ 聊天）</option>
            <option value="liangshen">梁神模式</option>
          </select>
        </label>
      );
    }
    if (last === 'reasoningEffort') {
      return <EffortField path={path} val={val} ch={ch} renderLabel={renderLabel} />;
    }
    // 其余字符串字段：普通输入框（主模型/识图模型在上面已由 ModelField 处理）
    return (
      <label className="field-row">
        {renderLabel()}
        <input className="input" value={val} onChange={(e) => ch(path)(e.target.value)} />
      </label>
    );
  }
  if (isArr(val)) {
    return (
      <label className="field-row full">
        {renderLabel()}
        <textarea className="textarea" rows={Math.max(2, Math.min(5, val.length + 1))} value={txt}
          onChange={(e) => { setTxt(e.target.value); ch(path)(e.target.value.split('\n').filter((x) => x.trim().length > 0)); }} />
      </label>
    );
  }
  if (isObj(val)) {
    return (
      <div className="field-row full nested">
        {renderLabel()}
        <div className="cfg-fields">
          {Object.keys(val).map((k) => <Field key={path + '.' + k} path={path + '.' + k} val={val[k]} label={pretty(k)} ch={ch} onHelp={onHelp} cfg={cfg} />)}
        </div>
      </div>
    );
  }
  return null;
}

/** 说明文档里的一个小节 */
function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: '13px 0', borderBottom: '1px dashed hsl(339.13 92% 90%)' }}>
      <div style={{ fontWeight: 800, fontSize: 14.5, color: 'var(--nc-primary-500)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.8, color: '#5d5370' }}>{children}</div>
    </div>
  );
}
