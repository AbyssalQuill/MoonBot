import { useEffect, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import type { ReactNode } from 'react';
import { sshServiceAction } from '../api';
import { api, getBridgeConfig, saveBridgeConfig, saveActivityHours, getActivityTargets, resetSpeechRules, listCharacters, importCharacter, instanceAction, listProfiles, saveProfile, deleteProfile, getRemoteBridgeConfig, saveRemoteBridgeConfig, memePacks, memePackUpload, memePackDelete, memePackBind, getMemoryStats, type MemoryStats, type CharacterEntry, type ConfigProfile, type ActivityTarget, type MemePackEntry, type MemePackUploadReport } from '../api';
import { TOOL_SCHEMA_CHARS, SLIM_PREFIX } from '../tool-schema-chars';
import { ArrowLeft, Save, Upload, FileText, X, HelpCircle, Loader2, Coffee, Activity, Users, MessageSquare, MessagesSquare, RotateCcw, Library, BookOpen, Terminal, Layers, Trash2, Check, Server, AlertTriangle, Mic, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react';
import NapcatTokensCard from '../components/NapcatTokensCard';
import NumInput from '../components/NumInput';
import Dropdown from '../components/Dropdown';
import { CFG_BRIDGE_LOCAL, bridgeRemoteKey, getCachedConfig, rememberConfig } from '../config-cache';

/** remote：连上服务器时把「服务端」那套传进来（配置读写服务端 /root/qq-bridge），null = 编辑本机 */
interface Props { onBack: () => void; onRefresh: () => void; onOpenLearning: () => void; onOpenPortrait: () => void; onOpenChat: () => void; onOpenVoice: () => void; remote?: { id: string; name: string; host: string } | null; }

/* 2026-09-12：隔离 DSH 里实际生效的模型段（settings.yaml 的 agent-default-model）。
 * 管理端保存模型配置时写的就是它；这里读回来只为两件事：
 *   ① 「推理档位」下拉里认得出 DSH 里已经配好的档位（off / xhigh / max … 不再被写死成低/中/高）；
 *   ② 在同一张卡里显示"DSH 当前是 xxx"，避免"我改的和它在用的不是一回事"。
 * 用模块级变量是因为 Field 是通用的深层组件，为一处提示把 hint 一层层透传只会更难维护。 */
let DSH_EFFECTIVE: { provider?: string; model?: string; reasoningEffort?: string } = {};

/* 2026-09-13：每个服务商实际可用的模型清单（服务端从 DSH 自己的配置里读出来）：
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
  return src === 'settings.yaml' ? 'DSH 配置（settings.yaml）' : src === 'dsh-llm-deepseek' ? 'DSH 内置模型目录' : '内置兜底表';
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
/** 2026-09-18：标签表兜底：config 里出现「标签表还没登记」的键时显示这一句，
 *  绝不再把 refreshOnMessageMs 这类原始英文键名当字段名糊在界面上。
 *  这种情况不会静默丢信息：Field 会自动给这类字段配一个说明标记，里面写清桥里的键名与当前值。 */
const UNNAMED_LABEL = '未登记名称的配置项';
const LABEL: Record<string, string> = {
  // 模型与推理
  baseUrl: 'DSH 地址', provider: '模型服务商', apiKey: '语言模型密钥', model: '主模型',
  visionModel: '识图模型', reasoningEffort: '推理档位',
  visionBaseUrl: '识图模型请求地址', visionApiKey: '识图模型密钥',
  // NapCat
  wsUrl: 'WebSocket 地址', wsAccessToken: 'WS 访问令牌（已移到「NapCat 鉴权令牌」卡）', httpUrl: 'HTTP 地址', accessToken: 'HTTP 访问令牌（已移到「NapCat 鉴权令牌」卡）',
  launcherPath: '启动器路径', homeDir: '运行目录', allowProcessControl: '允许进程控制',
  imageFileMode: '图片文件传法', tmpDir: '临时文件目录', dockerPathMap: '容器路径映射',
  // 基础与会话
  agentPreset: '人设预设', workspaceTitle: '工作区名称', ownerQQ: '主人 QQ', adminQQ: '管理员',
  sessionCwd: '会话工作目录', ackMessage: '收到回执语', sendDelayMs: '发送间隔', questionTimeoutMs: '问题等待超时',
  consolePort: '本机服务端口', consoleToken: '本机服务令牌', allowAllWhenEmpty: '名单为空时全部放行（两边都放）',
  allowAllPrivate: '私聊：名单为空时全部放行', allowAllGroups: '群聊：名单为空时全部放行',
  'pixiv.cookie': 'Pixiv 登录 cookie（PHPSESSID，只用于按画师名字搜人）',
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
  activeDurationMinMs: '活跃持续下限', activeDurationMaxMs: '活跃持续上限',
  triggerProbability: '触发概率',
  // 主动闲聊卡实际字段（v2 键名）
  checkIntervalMinMs: '群聊检查间隔下限', checkIntervalMaxMs: '群聊检查间隔上限',
  idleThresholdMs: '冷场判定时长', probability: '主动找话题概率',
  privateCheckIntervalMinMs: '私聊检查间隔下限', privateCheckIntervalMaxMs: '私聊检查间隔上限',
  privateProbability: '私聊主动概率',
  // 上下文 / 轮换（2026-09-16 反馈问「这个界面 resetWindow 是不是和唤醒轮换阈值一样的、重复了」）
  //   ① 不是重复项：contextWindow/resetWindow 是「带多少条历史」，wakeThreshold/prewarmAhead 是「聊多少轮换新会话」。
  //   ② 但它看着像重复：`resetWindow` 以前在 LABEL 里没有条目，pretty() 直接回落成原始英文键名
  //      （见 BridgeConfig 的 pretty()），又和「上下文窗口」平铺在同一张卡里；配置里两个值又常常一样（都 24），
  //      于是"同一个旋钮写了两遍"的观感完全是界面造成的。
  //   ③ 现在标签本身就说明"它管什么、什么时候生效"，配合卡内分组（见 GroupCard 的 ① / ② / ③），
  //      并逐个核对了实际读取点（wake-send.js / social-flow.js / console-server.js），不再名不副实：
  recentLimit: '每会话内存保留条数', unreadLimit: '未读队列上限',
  contextWindow: '首轮带入历史条数', resetWindow: '轮换后首轮带入条数',
  wakeThreshold: '聊多少轮换新会话', prewarmAhead: '提前几轮预建新会话',
  permanent: '永久会话（不轮换）',
  // 上下文治理（整路径写死：这些字段名只在这一段里出现，但按路径写更醒目、也不会被别处的同名标签顶掉）
  // 2026-09-19：不再有 摘要模型服务商 / 摘要模型 两栏：摘要一律用主模型（全局语言模型服务商）。
  'dshCompaction.thresholdRatio': '触发比例', 'dshCompaction.retainRatio': '逐字保留比例',
  'dshCompaction.toolResultMaxChars': '工具结果保留字数',
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
  // 2026-09-21 反馈：「表情包」卡里两个字段都显示成「备注字数上限」
  //   social.sticker.maxRemarkChars（本机 60）与 social.sticker.collect.maxRemarkChars（20）末段同名，
  //   而 Field/pretty 取名字是按「完整路径 → 末段」逐级回落，两条都命中末段那一句 → 一个名字出现两遍。
  //   这里按整路径各给一个名字（只改界面显示，桥里的键名一个字不动）：
  //   「表情备注」= 给已有收藏表情写备注时的上限；「收藏备注」= 自动收藏时顺手写的那句。
  'social.sticker.maxRemarkChars': '表情备注字数上限',
  'social.sticker.collect.maxRemarkChars': '收藏备注字数上限',
  'social.docx': 'Word 文档额度',
  dailyQuotaChars: '每日额度', interactionCount: '互动次数',
  // 通用
  security: '安全', interceptNotify: '拦截通知', burstIntervalMinMsLegacy: '（已废弃）连发间隔下限（旧键名）',
  // 投递 / 省额度（2026-09-12 新增到管理端）
  steerEnabled: '在途回合注入', slimTools: '工具 schema 精简', schemes: '命名方案',
  // 回合保持（social.turnHold）：以前管理端完全没有露出来，被问"投递与回合那张卡没错吧"时才发现
  turnHold: '回合保持', maxExchanges: '最多来回次数', idleCloseMs: '空闲关闭时长', maxWaitMs: '最长保持时长',
  requestBudgetMs: '每段等待预算', privateOnly: '只对私聊保持', keys: '限定会话',
  answeredIdleCloseMs: '答后空闲关闭',
  /* 2026-09-18 变更要求「界面上英文键一个别留」
     这一段的由来：config.json 里对象型的键自己也会被当成"小分组标题"渲染
     （Field 遇到 isObj 就 renderLabel()），而平时没人给它写标签 —— 于是界面上出现过
     光秃秃的 collect / docx / slimTools 这类英文分组名。分组名一律在这里登记，
     同时把「管理端目前没单独开卡、但键确实存在于配置里」的那些键也一并登记：
     它们是按完整路径渲染的，哪天真开了卡也不会再回落成英文键名。
     规范：标签必须自解释（不许"参数一/参数二"），看不出行为的再配 HELP 里的说明标记。 */
  // 分组名（对象型键当小标题时用）
  dsh: '模型与推理', napcat: 'NapCat 连接', social: '社交模块', allow: '允许名单', deny: '拒绝名单',
  guard: 'NapCat 会话守护（§ 探针已去除，本节配置全部不再生效）', slang: '黑话学习', tools: 'QQ 工具开关', collect: '自动收藏',
  sessionArchive: '空闲会话自动归档', feedback: '反馈上报',
  context: '上下文', autoReset: '会话轮换', send: '发送节奏', wake: '唤醒与潜水',
  dshCompaction: '上下文治理',
  wait: '回复前停顿', sticker: '表情包', proactive: '主动闲聊', typing: '私聊打字等待',
  // 路径专属（同名键在不同分组里含义不同，必须按完整路径写死）
  'social.agentPreset': '社交模块的人设预设',
  'social.proactive.enabled': '主动闲聊总开关',
  'social.slimTools.enabled': '启用精简名单',
  'social.slimTools.deny': '不注册给模型的工具名单',
  'social.sessionArchive.enabled': '空闲会话自动归档',
  // 会话守护（guard）—— 2026-09-23 变更要求：探针与状态检测已整体去除
  // 这些键保留登记只为不让界面回落成英文键名；桥已经完全不读它们，填什么都不生效。
  'guard.enabled': '会话守护总开关（已去除，不生效）', probeIntervalMs: '探活间隔（已去除，不生效）',
  failThreshold: '连续失败判定阈值（已去除，不生效）', cooldownMs: '自愈冷却（已去除，不生效）',
  maxHealsPerHour: '每小时最多自愈几次（已去除，不生效）', restartGraceSec: '重启宽限（已去除，不生效）',
  recoverWaitMs: '重启后等待恢复（已去除，不生效）', autoHeal: '自动自愈（已去除，不生效）',
  // 黑话学习（slang）
  'slang.enabled': '黑话学习开关', extractMinMessages: '凑够几条消息才提取',
  extractCooldownMs: '两次提取的最小间隔（毫秒）', inferenceThresholds: '推断阈值（出现次数）',
  injectMax: '最多注入几条黑话', injectIntoPrompt: '把黑话写进提示词',
  learnerPreset: '学习会话的人设预设', 'slang.workspaceTitle': '学习工作区名称',
  autoResearch: '自动联网考究', charactersDir: '角色库目录',
  // 内置表情包（social.meme）：多包 + 角色绑定，详见 README 的「内置表情包（meme-packs）」一节
  'social.meme': '表情包库（多包）', 'social.meme.enabled': '表情包库总开关',
  'social.meme.packs': '只搜这几个表情包', 'social.meme.personaPacks': '角色专属表情包绑定',
  'social.meme.activePersona': '当前角色（自动写入）',
  // 空闲会话自动归档（social.sessionArchive）
  intervalMs: '巡检间隔（毫秒）', idleMinutes: '闲置多少分钟算空闲',
  batchMax: '单批最多归档几个', pruneDays: '归档保留天数',
  // 反馈上报（social.feedback）
  maxLength: '反馈字数上限', notifyOwnerOnError: '出错时通知主人',
  // 私聊打字等待（social.typing）：键名就是 typing.*，这里按完整路径登记
  'social.typing.enabled': '私聊等对方打完字', 'social.typing.holdMaxMs': '最多等多久（毫秒）',
  'social.typing.refreshOnMessageMs': '收到消息后续多久（毫秒）', 'social.typing.breakProbability': '中途插话概率（0~1）',
  /* 已废弃的旧发送节奏键（config.json 里可能还留着）：
     桥早已改成「只有按字数一套节拍」，这些键写了也不生效 —— 标签写清"已废弃"，
     免得用户以为还能调。说明标记里写了替代项。 */
  'social.send.linearBaseMs': '（已废弃）首条气泡延迟', 'social.send.linearStepMs': '（已废弃）每条递增间隔',
  'social.send.gapBaseMs': '（已废弃）间隔基数', 'social.send.gapPerCharMs': '（已废弃）每字追加间隔',
  'social.send.gapJitterRatio': '（已废弃）间隔抖动比例',
  'social.burstIntervalMinMs': '（已废弃）连发间隔下限', 'social.burstIntervalMaxMs': '（已废弃）连发间隔上限',
  /* 2026-09-19：搜图的镜像站地址：反馈镜像站会换域名/镜像挂掉，所以要能自己改。
   * 这一项没登记的话 tools/audit-ui-labels.mjs 会报"未翻译键"（界面会裸奔一个英文键名）。 */
  pixiv: '搜/发 Pixiv 插画', 'pixiv.base': 'Pixiv 镜像站地址',
  'pixiv.refreshToken': 'Pixiv 长期登录态（自动续期写入，一般不用手填）',
  /* 2026-09-21：本次新增的三处设置（[Style] 语感行 / /token 计价 / 工具压缩档）：
   * tools/audit-ui-labels.mjs 只认这张表，登记在这里界面上才不会裸奔英文键名。 */
  prompt: '提示词与语感', 'prompt.styleLine': '每轮语感提醒（[Style] 行）',
  tokenCost: '计价口径（/token 指令）',
  'tokenCost.pHit': '缓存命中单价（¥/百万 tok）', 'tokenCost.pMiss': '未命中输入单价（¥/百万 tok）',
  'tokenCost.pOut': '输出单价（¥/百万 tok）', 'tokenCost.peakMult': '高峰时段倍率',
  'tokenCost.peakHours': '高峰小时（北京时）',
  'social.slimTools.level': '工具名单档位（本卡固定为 custom）',
  'social.slimTools.schemaLevel': '描述文字压缩档位（不裁功能）',
  'social.toolCompressor': '工具压缩代理', 'social.toolCompressor.enabled': '启用压缩代理',
  'social.toolCompressor.level': '代理压缩档位', 'social.toolCompressor.excludeTools': '代理额外排除的工具',
  'social.toolCompressor.toonify': '工具结果转 TOON',
};

/** MCP 工具中文名（工具与规则页） */
const TOOL_LABEL: Record<string, string> = {
  getPrompt: '查看人设与工具', getUnread: '读取未读消息', getRecent: '读取最近消息', socialState: '查看社交状态',
  sendGroup: '发群消息', sendPrivate: '发私聊消息', reply: '引用回复', sendMessage: '发送消息',
  waitMessages: '等待新消息', feedback: '反馈给主人', getMyRecent: '看我最近发言', getMessageDetail: '查看消息详情',
  getActiveMembers: '活跃成员', setWakeConfig: '设置唤醒条件', markRead: '标记已读', memory: '记忆读写',
  slangQuery: '查黑话', slangSubmit: '提交黑话', getImages: '查看消息图片', getForwardMsg: '读取转发',
  sendPoke: '发戳一戳', sendSticker: '发表情包', listStickers: '表情包列表', getStickerImage: '取表情图',
  setStickerRemark: '改表情备注', stickerNote: '表情备注', collectSticker: '收藏表情', getSelfImage: '我的图片',
  getFileContent: '读文件内容', sendQqFace: '发 QQ 表情', faceList: 'QQ 表情列表', memorySearch: '搜聊天记录',
  /* 2026-09-21 记忆架构升级：新增的写记忆开关（qq_memory_remember）——工具与规则页要能关掉它 */
  memoryRemember: '写长期记忆',
  historyDelete: '删聊天记录', historyClear: '清空记录', sendDocx: '发 Word 文档', sendRich: '发卡片消息',
  musicSearch: '搜歌', videoSearch: '看/搜视频', imageSearch: '联网找图发图', pixiv: '搜/发 Pixiv 插画', globalOverview: '全局总览', scheduleMessage: '定时发消息', withdrawMessage: '撤回消息',
  sendForward: '合并转发', like: '点赞', proactiveSend: '主动私聊',
  adminSet: '管理设置', whitelist: '白名单',
  qzone: '空间互动（看/评/赞/发）', qzoneView: '看空间',
  activityHours: '活跃时段',
  /* 2026-09-19 删废开关：这里原来还有 blacklist / profileSet / profileQuery / memeSearch /
     sendMeme / sendQzone 六个开关名，以及 getGroupOwner / getGroupMembers / scheduleList /
     scheduleCancel 四个对不上任何开关的标签 —— 桥侧全树 grep 0 命中，勾了不生效，一并删掉
     （群信息由 getGroupInfo 管、定时只有 scheduleMessage、qzone 由 qzone/qzoneView 统管）。 */
  // 2026-09-18：config.example.json 里已有、但标签表漏登的开关：漏了就会在「工具与规则」页裸奔英文 key
  characterCards: '角色卡（角色库）',
  // 2026-09-19：同样漏登的四个：桥确实会读这四个开关（console-server 的 ToolEnabled('sendVoice'/
  // 'transcribeVoice'/'crosschat') 与 mcp-napcat-safe.js 的 tools?.getGroupInfo），
  // 而线上 config.json 里已经写着 sendVoice / transcribeVoice —— 漏了它们，页面上就是两行裸英文 key。
  // 门禁在 tools/audit-ui-tool-names.mjs，加工具/开关时它会把这类漏登直接报出来。
  sendVoice: '发语音（说话）', transcribeVoice: '语音转文字',
  crosschat: '跨会话互知与留言', getGroupInfo: '查群主/群成员',
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
  reply: 'qq_reply', sendMessage: 'qq_send_message',
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
  // 2026-09-21 记忆架构升级：新工具与它的开关（没有这条映射，审计会判定"这个工具在页面上会消失"）
  memoryRemember: 'qq_memory_remember',
  historyDelete: 'qq_history_delete', historyClear: 'qq_history_clear', sendDocx: 'qq_send_docx',
  sendRich: 'qq_send_rich', musicSearch: 'qq_music_search', videoSearch: 'qq_video_parse / qq_video_search', imageSearch: 'qq_image_search / qq_send_image', pixiv: 'qq_pixiv_search / qq_send_pixiv', globalOverview: 'qq_global_overview',
  scheduleMessage: 'qq_schedule_message / qq_schedule_list / qq_schedule_cancel',
  withdrawMessage: 'qq_withdraw_message', sendForward: 'qq_send_forward',
  qzone: 'qq_qzone_view / qq_qzone_comment / qq_qzone_like / qq_qzone_reply_comment / qq_send_qzone',
  // 以下 key 当前线上 config 没有（保留映射，切到含它们的配置时也能显示）
  activityHours: 'qq_get_activity_hours / qq_set_activity_hours', adminSet: 'qq_admin_set',
  whitelist: 'qq_whitelist',
  qzoneView: 'qq_qzone_view',
  /* 2026-09-19 删废开关：这里原来还有 blacklist / profileSet / profileQuery / memeSearch /
     sendMeme / sendQzone 六个键 —— 桥侧从来不读它们（`git grep` 全树 0 命中，桥只读
     `cfg.social?.tools?.[key] !== false`）：拉黑走 /api/blacklist 的令牌鉴权、qzone 那组由
     `qzone` / `qzoneView` 统管、群信息由 `getGroupInfo` 管。它们对应的工具（qq_blacklist /
     qq_remove_friend / qq_profile_get / qq_profile_set / qq_meme_search / qq_send_meme）
     都是无条件注册 —— 见下面 TOOLS_NO_SWITCH。
     留着这些行 = 页面上摆着一个"勾了不生效"的开关，比缺行更糟。 */
  // 2026-09-19：角色库四个工具由 social.tools.characterCards 一个开关统管（false = 四个都不注册）。
  characterCards: 'qq_character_list / qq_character_read / qq_character_pack / qq_character_search',
  // 2026-09-19：语音两个与跨会话/群信息三个：同样要显示英文原名，否则开关行只有中文名、
  // 无法与 config.json 里的 social.tools.* 对照（也便于照抄进 social.slimTools.deny）。
  sendVoice: 'qq_send_voice', transcribeVoice: 'qq_transcribe_voice',
  crosschat: 'qq_crosschat_inbox / qq_crosschat_send',
  getGroupInfo: 'qq_get_group_owner / qq_get_group_members',
  // 2026-09-19：点赞与主动私聊：桥有开关（mcp-napcat-safe.js 的 tools?.like / tools?.proactiveSend）、
  // 中文名表里也有，但这里漏了工具原名，于是「显示 MCP 工具原名」时这两行看不到映射。
  like: 'qq_like', proactiveSend: 'qq_proactive_send',
};

/**
 * 没有独立开关的工具：桥侧无条件注册，在「QQ 工具开关」里既开不了也关不了。
 * 列出来只为一件事 —— 页面上的工具清单要完整（用户才知道这套 bot 到底能做什么），
 * 以及指明"想彻底不给模型看，只能去下面那张『工具 schema 精简』卡里在注册期排除"。
 * 门禁：tools/audit-ui-tool-names.mjs 会断言 （TOOL_MCP 覆盖的工具 ∪ 这张表）= 桥定义的全部工具。
 */
const TOOLS_NO_SWITCH: string[] = [
  // 宿主侧（mcp-host-server.js）：进程控制默认不注册，只在管理员私聊的 default 模式里可用
  'napcat_status', 'start_napcat', 'stop_napcat', 'qq_learning_corpus', 'qq_learning_submit',
  // 联网（mcp-web-search-safe.js）
  'web_search', 'web_fetch',
  // 无条件注册的 QQ 工具：状态/群列表/群历史/桥配置读写/静默/人格学习
  'qq_status', 'qq_list_groups', 'qq_get_group_history', 'qq_get_system_config', 'qq_set_system_config',
  'qq_deepsleep', 'qq_persona_learn_start', 'qq_persona_learn_stop', 'qq_persona_learn_status',
  // 2026-09-19：原来挂在六个废开关下面的工具（开关已删，工具照旧无条件注册）：
  // 表情包两个、档案读写两个、拉黑与删好友两个。
  'qq_meme_search', 'qq_send_meme', 'qq_profile_get', 'qq_profile_set', 'qq_blacklist', 'qq_remove_friend',
  // 2026-09-24：注册表里新增/原先漏登记的两条。get_time 是桥自己实现的取时工具（裸名，不带 qq_ 前缀，
  // 由提示词 [TOOLS] 1d 指定为唯一时钟来源）；qq_character_switch 只在会话里切角色卡，没有独立开关。
  // 漏登记的表现是页面上整行看不到它们（既开不了也关不了），tools/audit-ui-tool-names.mjs 会报出来。
  'get_time', 'qq_character_switch',
];

/**
 * MCP 工具原名的中文名（键 = `mcp__napcat__` 前缀之后的名字）。
 *
 * 「为什么要单独一张表」「工具 schema 精简」卡会把 src/tool-schema-chars.ts 里
 * 每一个 mcp__napcat__ 工具逐行列出来勾选。以前每行显示的就是 `qq_send_message`
 * 这种原始工具名 —— 用户看到的是一屏英文标识符（2026-09-18 变更要求「一个别留」）。
 * 现在行标题一律是这里的中文名，原名默认不显示；要跟 config.json 里的
 * social.slimTools.deny 对照时，勾上卡片里的「显示 MCP 工具原名」即可（原名必须逐字一致）。
 *
 * 加工具时请一并补这张表：漏了的话（① 中文名缺失）tools/audit-ui-labels.mjs 会直接报错拦下。
 */
const MCP_LABEL: Record<string, string> = {
  qq_get_prompt: '查看人设与工具', qq_get_unread_messages: '读未读消息', qq_get_recent_messages: '读最近消息',
  qq_social_state: '查看社交状态', qq_send_group_message: '发群消息', qq_send_private_message: '发私聊消息',
  qq_reply: '引用回复', qq_send_message: '发送消息',
  qq_wait_for_messages: '等待新消息', qq_report_feedback: '反馈给主人', qq_get_my_recent_messages: '看我最近发言',
  qq_get_message_detail: '查看消息详情', qq_get_active_members: '查活跃成员', qq_set_wake_config: '设置唤醒条件',
  qq_mark_read: '标记已读', qq_memory_append: '追加记忆', qq_memory_query: '查记忆',
  qq_memory_remove: '删记忆', qq_memory_clear: '清空记忆', qq_memory_search: '搜聊天记录',
  qq_slang_query: '查黑话', qq_slang_submit: '提交黑话', qq_get_message_images: '查看消息图片',
  qq_get_forward_msg: '读取转发', qq_send_poke: '发戳一戳', qq_list_stickers: '表情包列表',
  qq_get_sticker_image: '取表情图', qq_send_sticker: '发表情包', qq_set_sticker_remark: '改表情备注',
  qq_sticker_note: '写表情备注', qq_collect_sticker: '收藏表情', qq_get_self_image: '取我的图片',
  qq_get_file_content: '读文件内容', qq_send_qq_face: '发 QQ 表情', qq_face_list: 'QQ 表情列表',
  qq_history_delete: '删聊天记录', qq_history_clear: '清空聊天记录', qq_send_docx: '发 Word 文档',
  qq_send_rich: '发卡片消息', qq_music_search: '搜歌', qq_video_parse: '看视频链接（B站/抖音）', qq_video_search: '搜视频', qq_image_search: '联网找图', qq_send_image: '联网找图并发送', qq_pixiv_search: '搜 Pixiv 插画', qq_send_pixiv: '搜 Pixiv 并发图', qq_global_overview: '全局总览',
  qq_schedule_message: '定时发消息', qq_schedule_list: '定时消息列表', qq_schedule_cancel: '取消定时消息',
  qq_withdraw_message: '撤回消息', qq_send_forward: '合并转发', qq_like: '点赞',
  qq_proactive_send: '主动私聊', qq_get_group_owner: '查群主', qq_get_group_members: '查群成员',
  qq_get_group_history: '读群聊历史', qq_admin_set: '管理设置', qq_whitelist: '加白名单',
  qq_blacklist: '拉黑', qq_remove_friend: '删好友', qq_profile_set: '改档案',
  qq_profile_get: '查档案', qq_qzone_view: '看空间', qq_qzone_comment: '评论空间',
  qq_qzone_like: '赞空间', qq_qzone_reply_comment: '回空间评论', qq_send_qzone: '发说说',
  qq_meme_search: '搜表情包', qq_send_meme: '发内置表情',
  qq_get_activity_hours: '读活跃时段', qq_set_activity_hours: '设活跃时段',
  qq_persona_learn_start: '启动人格学习',
  qq_persona_learn_stop: '停止人格学习', qq_persona_learn_status: '人格学习状态',
  qq_deepsleep: '群聊静默', qq_crosschat_send: '跨会话发话', qq_crosschat_inbox: '跨会话收件箱',
  qq_status: '机器人状态', qq_list_groups: '列出群聊', qq_get_system_config: '读桥系统配置',
  qq_set_system_config: '改桥系统配置',
  // 2026-09-19：漏登的六个（工具加了、中文名没跟着加 → 精简卡里会显示"未登记"占位）：
  // 语音两个（注册是无条件的，但调用期由 console-server 的 ToolEnabled('sendVoice'/'transcribeVoice') 把关）
  // 与角色库四个（social.tools.characterCards 控制注册）。
  qq_send_voice: '发语音（说话）', qq_transcribe_voice: '语音转文字',
  qq_character_list: '列角色库', qq_character_read: '读角色卡文件',
  qq_character_pack: '取整套角色卡', qq_character_search: '搜角色库',
  // 2026-09-19：没有独立开关的那批（条目名字也要有中文名：见下面 TOOLS_NO_SWITCH 一栏）
  napcat_status: 'NapCat 运行状态', start_napcat: '启动 NapCat', stop_napcat: '停止 NapCat',
  qq_learning_corpus: '读学习语料', qq_learning_submit: '提交学习结果',
  web_search: '联网搜索', web_fetch: '抓取网页',
  // 2026-09-24：补登记三条 —— 它们先前没进中文名表，精简卡里会显示成「未登记」。
  // get_time 是桥自己实现的取时工具（裸名，提示词里的唯一时钟来源）；另两条是记忆写入与角色卡切换。
  get_time: '查看当前时间', qq_memory_remember: '记住这件事', qq_character_switch: '切换角色卡',
};

/** 精简名单里某一行该显示的中文名；未登记时回落到「未登记」占位（绝不显示英文原名） */
function mcpLabel(fullName: string) {
  const short = fullName.startsWith(SLIM_PREFIX) ? fullName.slice(SLIM_PREFIX.length) : fullName;
  return MCP_LABEL[short] || UNNAMED_LABEL;
}

/** 进阶项说明（点旁侧说明标记展开），只为不易自明的项提供 */const HELP: Record<string, string> = {
  baseUrl: 'DSH（DeepSeek Harness）Web 服务地址。本机内置隔离实例默认 http://127.0.0.1:10721，也可用环境变量 QQB_DSH_BASE_URL 覆盖。注意：不要填桌面端 3210。',
  provider: '模型服务商标识，由 DSH 端已配置的 provider 决定。用法：不确定时保持默认。注意：填错会导致会话无法建立，日志中会有提示。',
  apiKey: '「语言模型密钥」：专供语言模型（聊天本体）使用的一把 Key。'
    + '它不写入 qq-bridge/config.json，而是在点「保存」时由管理端写入隔离 DSH 自身的凭据文件 `.credentials.yaml`（权限 600，仅本机该用户可读）；'
    + '变量名按「模型服务商」在 DSH settings.yaml 中声明的 `apiKeyEnv` 决定，例如服务商 `xiaomi-token-plan-cn` 对应变量名 `XIAOMI_TOKEN_PLAN_CN_API_KEY`；随后自动重启隔离 DSH 使新值生效（必须重启：DSH 仅在启动时读取凭据文件）。'
    + '三点注意：① 留空表示不改动已保存的密钥，不会清除已有 Key；需要删除请点下方「清除已保存的密钥」；'
    + '② 它只影响语言模型，与「识图模型密钥」「语音模型密钥」是三把互不影响的密钥；'
    + '③ DSH 的取值优先级为「启动进程的环境变量 > 凭据文件」，若系统中另设过同名环境变量，后者会覆盖此处所填的值。',
  model: '主对话模型，留空由 DSH 默认决定。',
  visionModel: '识图（多模态）模型，用于含图片消息的会话。语言模型与识图模型分开配置：上方「主模型」负责文字回话，此处负责看图。'
    + '三种用法：① 三个识图字段全部留空时，图片按原有方式作为附件发给主模型（要求主模型本身支持多模态，默认已支持）；'
    + '② 只填「识图模型」而不填地址时，仍走 DSH 通路，仅在本次会话中显式指定该模型读图；'
    + '③ 填了「识图模型请求地址」时，桥直接以 OpenAI 兼容接口（POST /chat/completions，图片走 image_url 的 data: URL）请求识图模型，'
    + '再把返回的文字描述交给语言模型，识图因此可使用不同厂商与额度，并为主模型节省开销（主模型只接收文字）。',
  visionBaseUrl: '识图模型的 OpenAI 兼容请求地址，例如 https://api.siliconflow.cn/v1 或 http://127.0.0.1:8000/v1。'
    + '用法：桥会自行在其后接 `/chat/completions`，故填写到 `/v1` 为止，不要带 `/chat/completions`。'
    + '注意：留空即不使用该独立通路，图片按原有方式经 DSH 作为附件发送；填写本项必须同时填写「识图模型」，否则无法确定调用的模型；「识图模型密钥」可留空（本机自建服务通常无需密钥）。',
  visionApiKey: '「识图模型密钥」：识图独立通路自用的 Key，仅在填写了「识图模型请求地址」时使用。'
    + '它随配置保存，用于请求上述地址；留空则不携带（适用于本机自建或内网服务）。注意：与「语言模型密钥」是两个不同的字段，互不影响。',
  reasoningEffort: '推理强度档位，仅对支持该参数的服务商生效（如 deepseek-reasoner 一类深度思考模型）。档位越高越慢但更细致；'
    + '实测这是单次调用耗时与思考 token 的最大变量（出现过单次 37 秒），嫌慢或嫌贵应先下调本项。'
    + '`xhigh` / `max` 仅部分服务商支持（小米 MiMo 不支持）：选择不支持的档位时，桥自动退回该服务商默认档位并在日志中记录一行，会话不会因此卡住。'
    + '修改后自动重启隔离 DSH 生效。'
    + '下拉中每项为「英文档位 id · 中文说明」，英文 id 即真正写入 DSH settings.yaml 的值，保留以便与配置文件对应：'
    + 'off=关闭思考、none=同「关闭思考」、minimal=最低、low=快但粗略、medium=平衡、high=仔细但慢、xhigh=更高、max=最高。',
  launcherPath: '仅在手动静默拉取 QQ 网关时使用。本项目 NapCat 已内置并由管理端拉起，一般保持留空。',
  homeDir: '网关侧可写目录（容器映射等）。本机 NapCat 一般不需要。',
  allowProcessControl: '是否允许 DSH 内的 agent 自动启停本机 QQ 网关。仅在对运行环境完全信任时开启。',
  'napcat.imageFileMode': '发送图片与表情时，桥交给 NapCat 的文件传递方式：path=直接给路径（本机裸机部署）；base64=读为 base64 传入（跨容器、跨机均可发送）；auto=先按「容器路径映射」换算为容器内路径（服务器 Docker 场景），无法换算时退回 base64。服务器上推荐 auto。',
  'napcat.tmpDir': '桥写临时文件（表情、语音、文档）的目录。服务器上须指向 NapCat 容器挂载出来的目录（例如 /root/napcat/config/moonbot-tmp），否则容器读不到文件，图片与语音无法发出。',
  'napcat.dockerPathMap': '宿主目录到容器内目录的映射表，配合 imageFileMode=auto 使用。服务器 NapCat 运行在 Docker 中时填写 [{"host":"/root/napcat/config","container":"/app/napcat/config"}] 一类取值。',
  accessToken: '「HTTP 访问令牌」：桥接进程经 HTTP 接口（http://127.0.0.1:3000，NapCat 的 httpServers）收发消息时使用的令牌，须与 NapCat WebUI 中 HTTP 服务的 token 一致。'
    + '它与「WS 访问令牌」是两种传输各自的令牌，即使取值相同也是分开的字段，修改其一不影响另一；填错会导致 HTTP 工具全部返回 401。',
  wsAccessToken: '「WS 访问令牌」：桥接进程经 WebSocket 接口（ws://127.0.0.1:3001，NapCat 的 websocketServers）收发消息时使用的令牌，须与 NapCat WebUI 中 WS 服务的 token 一致。'
    + '与「HTTP 访问令牌」相互独立（默认值相同亦然）；填错会导致 WS 连接被拒，机器人收不到也发不出消息。',
  consolePort: '桥接内部服务端口。本机管理端会探测该端口以判断桥是否在运行。',
  consoleToken: '本机桥接内部接口令牌，一般不必修改；修改后管理端需同步。',
  sessionCwd: 'DSH 会话工作目录。留空时每个会话在 state/agents 下独立建目录。',
  allowAllWhenEmpty: '白名单为空时是否放行所有会话（私聊与群聊同时放行）。建议先填好私聊与群白名单，再开启本项。',
  allowAllPrivate: '私聊专属开关：私聊名单为空时放行全部私聊，适用于群内严格按名单、私聊不限来客的场景。'
    + '注意：① 仅在该类名单为空时生效，私聊名单中已填对象时以名单为准；② 拒绝名单始终优先，已拉黑者仍不能进入。',
  allowAllGroups: '群聊专属开关，语义与上一条相同，仅作用于群聊。默认两项均不勾选，即空名单时一律不放行。',
  security: '安全选项分组。',
  'prompt.styleLine': '唤醒正文中每轮都会携带的一行语感提醒（默认 `[Style] 说人话：短、有态度，别讲课别列举`）。'
    + '单独可配的原因：系统提示词中写明「别讲课」也压不住单轮语气，小模型对最近一段上下文权重最高，此行是最后一道约束。'
    + '它每轮仅数十字符且逐轮完全相同（稳定前缀，按缓存价计费），成本可忽略。'
    + '修改要求：① 保持每轮完全相同，不要放入时间或随机数，否则会破坏前缀缓存；② 只描述「怎么说」，不要写具体规则条款（那些属于系统提示词）；③ 留空即完全不注入该行。'
    + '保存后下一条消息生效（配置文件热加载，无需重启桥）。',
  'tokenCost.pHit': '缓存命中的输入单价（¥ / 百万 token）。DeepSeek 谷时的缓存命中价约为未命中价的 1/50，本值填大会使 /token 报出的金额虚高。默认 0.02。',
  'tokenCost.pMiss': '未命中（新读入）输入的单价（¥ / 百万 token）。默认 1。',
  'tokenCost.pOut': '输出 token 的单价（¥ / 百万 token）。默认 4。',
  'tokenCost.peakMult': '高峰时段整体倍率。默认 2，即高峰时上述三项单价均乘 2；填 1 即不分时段计价。',
  'tokenCost.peakHours': '计为高峰的北京时小时（0-23）。默认 [9,10,11,14,15,16,17]，即上午 09:00-11:59 与下午 14:00-17:59。',
  'pixiv.refreshToken': 'Pixiv 的长期登录态（OAuth refresh_token）。一般不必手填：引导流程会用一次性的 PHPSESSID 换取长期 refresh_token 并自动写入此处，此后按画师名字搜人不再依赖手工粘贴 cookie。'
    + '填错或过期会导致「按名字搜画师」失败，但按作品 id 发图不受影响（该路径走公开接口）。',
  prompt: '提示词可调项分组，目前仅一项：唤醒正文每轮携带的语感提醒。',
  tokenCost: 'QQ 中发送 /token 时算钱所用的单价分组（¥ / 百万 token）。默认值与管理端「学习」页的实测计量同源；修改本组只影响 /token 报出的金额，不影响提供方的实际计费。',
  'social.toolCompressor': '开源 mcp-compressor 代理：DSH 不再直连 napcat MCP，改为连接代理；代理只向模型发送 2 个包装工具（napcat_get_tool_schema / napcat_invoke_tool），工具清单被压入其描述。'
    + '实测相对完整工具表：低 38.8% / 中 14.0% / 高 6.2% / 极限 3.6%。'
    + '代价是调用本轮未使用过的工具时须「先查 schema 再调用」，步数由 1 步增至 2 步；桥侧已按真实工具名解包，不影响发送判定与幂等账本。'
    + '注意：压缩机未安装（pip3 install mcp-compressor）时自动回退直连，工具表不会被清空；修改后必须重启隔离 DSH。',
  'social.toolCompressor.enabled': '是否让隔离 DSH 经压缩代理。关闭即直连（默认）。'
    + '桥每次启动会做一次轻量探测：找不到 mcp-compressor 可执行文件即自动回退直连，并把原因写入日志。',
  'social.toolCompressor.level': '代理压缩档位（对应 mcp-compressor 的 --compression）：低 = 保留完整描述；中 = 每条描述只留第一句；高 = 工具清单不带描述；极限 = 连参数也不带。'
    + '档位越低，模型越依赖「先查 schema」，调用步数越多。建议先用中档实测若干轮，并以 /token 对账后再定。',
  'social.toolCompressor.excludeTools': '交给代理之前先从后端排除的工具（后端原名，如 qq_send_pixiv），以逗号或换行分隔。'
    + '与「工具 schema 精简」卡中的名单为叠加关系：两处都会把工具挡在模型视线之外。',
  'social.toolCompressor.toonify': '把工具返回的 JSON 转为 TOON 后再交给模型，更省 token，但模型所见格式随之改变。'
    + '默认关闭：格式变化可能改变模型对该工具结果的读法，建议先在低价值工具上试用。',
  'social.slimTools.schemaLevel': '描述文字压缩档，与「工具名单（自定义方案）」是两个正交的旋钮：后者决定注册哪些工具，本项决定已注册工具的 schema 写多长。'
    + '压缩的是描述文字，工具数量与参数数量不变（名称、类型、枚举、必填照旧）。档位语义沿用开源 mcp-compressor（atlassian-labs）：medium = 每条描述只留第一句；high = 完全不发描述。'
    + '在真实 JSON Schema 格式下实测（90 个工具）：不压 100% / 中度 71.4% / 高度 31.1%。'
    + '注意：high 为激进档，描述是模型判断「何时使用该工具」的主要依据，去掉后只能依据工具名推测；其差额约为每步 1.9 万 token（本机口径）。修改后必须重启隔离 DSH 才会重新注册工具表。',
  'social.slimTools.level': '工具名单档位。本项只在管理端「工具 schema 精简」卡中按「自定义预设方案」使用：名单由卡内勾选（或载入命名方案）产生，'
    + '卡在挂载、改动名单与载入方案时都会把本项写为 custom，因为桥仅在 custom 档下读取手写名单（`social.slimTools.deny` 与白名单），其余档位一律忽略手写名单。'
    + '注意：改动后必须重启隔离 DSH 才生效（工具表只在 DSH 启动时取一次）；`social.tools.*` 那些开关只是调用时返回「工具未启用」，省不下这份描述，只有「注册期不注册」才会使其从请求中消失。',
  trustedCrossSessionUids: '允许 agent 跨会话读取或带话的 QQ 号（数组）。一般只填自己最信任的好友。',
  deepsleep: '总开关：开启后所有群聊的消息入库但不唤醒、不回复、不主动冒泡（省 token），私聊照常。拍一拍等群内事件同样被静默。主人发送 /start 可随时恢复（该命令不经过模型，始终有效）。',
  recommendedHint: '交给模型的「潜水与唤醒行为规则」长文本。内容改动会影响唤醒判定，一般不建议新手修改。',
  activeProbability: '「活跃模式搭话概率」：把某个群或私聊转为活跃时所用的随机搭话概率（默认 0.3，即三成）。'
    + '此前转活跃会沿用潜水那套 0.05（每 20 条才醒一次），与潜水难以区分；本值用于区分二者：调大更活跃，调小更省额度（由「群每小时唤醒上限」兜底）。',
  preSleepWaitMs: '转潜水前的「静默观察」窗口时长：窗口内若无人说话，即可安心进入潜水。',
  wakeThreshold: '「聊多少轮换新会话」：同一会话累计到这么多轮后，下一次唤醒切换到下一代会话（旧会话归档，记忆文件保留，不丢记忆）。'
    + '计入的只有真实来回：私聊消息、被 @、被提问、被叫名字、拍一拍、命中关键词等触发唤醒各计 1 轮，`qq_wait_for_messages` 每取回一批新消息亦计 1 轮；'
    + '回复检查、主动冒泡等内部唤醒不计入（计入会导致上下文在一两小时内被切换十几次、机器人频繁失忆）。桥里最小 5，默认 10。'
    + '本值每轮现读配置，修改后对正在运行的老会话立即生效，无需等待其自然轮换，也无需重启桥；轮次计数落在 state/social-state.json，重启桥不清零。'
    + '它与「轮换后首轮带入条数」是两件事：本项决定换会话的时机，后者决定换完之后第一轮看到多少历史。',
  prewarmAhead: '「提前几轮预建新会话」：在到达「聊多少轮换新会话」之前这么多轮，桥即建好下一代会话并预热一次，到点直接切换，首轮不卡顿且可命中提示缓存。'
    + '填 1 = 仅在最后一轮才建（最省，但轮换瞬间稍慢）；填得与轮换阈值一样大 = 第一轮就建（没有必要）。默认 3。'
    + '说明：本项此前在未写入 config.json 时失效（读取处 `Number(x) ?? 3` 在缺键时算出 NaN，预热分支永不触发），现已修复。',
  permanent: '「永久会话（不轮换）」：勾选后不再按轮数换会话，一个会话长期使用，省去每次换新会话那一轮的首轮 token（新会话的系统提示词、工具清单、历史窗口均为冷启动，无前缀缓存可用）。'
    + '配套使用「上下文治理（dshCompaction）」：由隔离 DSH 自行剪掉过大的工具结果、必要时把最旧一段摘要，故不换会话也不会使上下文持续增长。两点注意：'
    + '① `agentPreset`（人设预设）只在建会话时绑定，开启永久会话后修改预设不会影响老会话（修改 persona.md 不受影响，该文件每轮注入正文）；确需更换预设，先取消勾选，等其轮换一次后再开启。'
    + '② 若压缩配置被写坏，会话会一直增长，故「聊多少轮换新会话」的值仍然保留：关闭本项即立刻恢复按轮数轮换。'
    + '本项修改立即生效，无需重启桥，正在进行的会话也不会被打断。',
  dshCompaction: '上下文治理：使一个会话可长期使用而不堆积上下文。桥不直接修改 DSH 的历史（DSH 会话是内存中的事件溯源日志，外部改文件会撞 `seq gap` 校验），'
    + '而是把策略写入隔离 DSH home 的 `cordis.patch.yml`（home 级 patch 层），交由 DSH 自身的压缩组件执行：'
    + '① 先剪掉过大的工具结果（`tool-result-pruner`），不发起模型请求，聊天记录一字不动；'
    + '② 剪完仍超阈值、或提供方报上下文溢出时，才把最旧一段摘要为 `<compacted-summary>`（`compaction-basic`）。'
    + '阈值一律按模型窗口的比例给出，换模型自动等比缩放。修改后立即生效（DSH 会热加载该 patch），无需重启 DSH 或桥。',
  thresholdRatio: '「触发比例」：上下文占用达到模型窗口的百分之多少时开始治理（当前推荐 0.16，即 16%）。'
    + '窗口 1M 的模型约 16 万 token 触发，窗口 128k 的模型约 2 万 token 触发；同一比例换模型自动缩放，无需手改。'
    + '\n\n推荐值按线上实测重算，不再写死：按上下文区间分桶计量，上下文本身几乎只按缓存命中价计费（实测回归：每次成本 ≈ ¥0.0020 + 0.022 ¥/M × 上下文），'
    + '真正花钱的是「压缩、换会话、长时间空闲之后需要整段重读一次」（实测每次 ≈ ¥0.036）。'
    + '因此最省的做法是少压缩，而不是把小上下文当作目标：阈值越低，压缩越频繁，重建费用越亏。'
    + '\n推荐公式：`阈值比例 = clamp((固定开销 + 逐字保留 + 余量) / 模型窗口, 0.10, 0.30)`。'
    + '其中「固定开销」为 system 提示词与工具 schema 的实测 token（该项每一步都要重发，故阈值必须明显大于它，否则会被顶穿成每一步压缩一次）；「余量」取 24k token（保证压缩后距阈值仍有距离，不会压完立刻又压）。固定开销的当前实测值见本卡上方读数。'
    + '\n实测扫描（模型窗口 1M）：0.08 → ¥3.34/天（重建 15~29 次/天）· 0.12 → ¥2.67 · 0.16 → ¥2.53 · 0.18 → ¥2.53 · 0.25 → ¥2.66。'
    + '最省区间为 0.16~0.18，稳健区间为 0.14~0.20。复算脚本：`qq-bridge/tools/compaction-threshold.mjs`（参数均从线上 `state/token-usage.jsonl` 现场量取，改价后重跑）。'
    + '\n\n不要低于 0.08（8%，桥的下限，低于该值会被自动夹回并记录日志）：阈值一旦被固定开销顶穿，就会变成每一步都压缩一次——每次压缩额外发起一次「读完整段上下文写摘要」的模型请求，并改写会话历史（提示词前缀缓存随之作废，下一步只能全量重读）。'
    + '2026-09-20 线上实测：0.06 时 114 个模型步中触发 46 次摘要，每步之间多耗 15~20 秒，一个搜索回合拖延至 6 分钟。'
    + 'DSH 的硬性要求：本值必须大于「逐字保留比例」，否则插件拒绝加载（桥会自动夹到合法范围并记录日志）。',
  retainRatio: '「逐字保留比例」：最近这一部分上下文原样保留，压缩只作用于更早的部分（默认 0.02，即 2%；1M 窗口约 2.1 万 token）。'
    + '必须小于「触发比例」。压缩后上下文 ≈ 该段 + 固定开销 2.75 万，须明显低于触发阈值，否则会压完立刻又压。'
    + '调大 = 最近内容记得更牢、费用更高；调小 = 更省，但模型更容易忘记前几轮细节。',
  toolResultMaxChars: '「工具结果保留字数」：单个工具结果超过该字符数（Unicode 码点）即被剪成「开头 60% + 一行 `[... tool result middle pruned ...]` + 结尾 20%」（默认 1500）。'
    + '这是省 token 最直接的一项：QQ 机器人的上下文大头几乎都是工具结果（群成员列表、聊天记录、网页正文、图片信息）。'
    + '剪枝不发起模型请求、不改动聊天记录，被剪掉的原文本仍留在会话日志中（可回放、可检索）。'
    + '代价是每次剪枝都会改写这段历史，其之前的前缀缓存随之失效——因此这是「省 token」与「少改写」之间的折中：工具结果普遍不大（数百字）时可适当调大（例如 4000），使改写更少发生、缓存更易命中，响应更稳定。'
    + 'DSH 的硬性要求：保留的头 + 标记 + 尾不得超过该字数，桥会自动按 60/20 拆分并校验。',
  'dshCompaction.enabled': '总开关。关闭即不覆盖 DSH 默认：DSH 默认要等上下文占用达窗口 80% 才压缩（等同不压缩），上下文会一直增长到轮换为止。',
  contextWindow: '「首轮带入历史条数」：新会话首次唤醒时向提示中贴入最近多少条聊天记录（每个会话仅贴这一次，此后各轮只发一行哨兵，不再重贴）。'
    + '下限 6，普通首轮上限 24，填 30 也只按 24 执行；若要让轮换后的第一轮看到更长历史，须同时调整「轮换后首轮带入条数」。'
    + '本项决定新会话开局掌握多少上下文，越大越懂但越贵（这段窗口之后每一步都会被重读计价）。桥里默认 12。',
  resetWindow: '「轮换后首轮带入条数」：会话轮换之后的第一轮贴入多少条历史，仅此一次，之后回到「首轮带入历史条数」。'
    + '桥取 `max(首轮带入历史条数, 本值)`，因此填得比「首轮带入历史条数」小完全无效（并非故障，而是不会生效）；上限 60。'
    + '它与「聊多少轮换新会话」不是一回事：本项是历史窗口的大小，后者是轮换的时机。'
    + '仅轮换后的第一轮读取本值（未发生轮换的普通首轮不读取，填写不影响其行为）。桥里默认 24。',
  recentLimit: '「每会话内存保留条数」：桥在内存中为每个会话保留这么多条最近消息，新消息进入即挤掉最旧的。'
    + '它只决定桥当前持有多少条；真正贴入提示的条数由「首轮带入历史条数」决定。'
    + '历史消息本就会逐条写入 SQLite，内存中被挤掉的仍可用 `qq_get_recent_messages` / `qq_memory_search` 查到。'
    + '调大更占内存（每个会话各一份），一般无需改动。桥里默认 100。',
  unreadLimit: '「未读队列上限」：每个会话在内存中最多排这么多条未读，超出时丢弃最旧的（不是最新的）。'
    + '重启后从 SQLite 恢复未读时也按该数量取。它不改变已读与未读的判定，只限制排队长度。桥里默认 30。',
  mustReplyKeywords: '命中这些词时必须回应（每行一个）。',
  recommendedKeywords: '潜水模式下可将机器人唤醒的关键词（每行一个）。',
  // —— 等待：回复前的停顿（模拟真人节奏，别让机器人秒回）——
  'social.wait.defaultMs': '「假装在想」的基础停顿：收到该回的消息后，先停这么久再开始组织回复（毫秒）。太短=秒回机器人，太长=反应迟钝。建议保留默认。',
  'social.wait.minMs': '每次停顿的随机下限（毫秒）。实际停顿会在 最短~最长 之间随机挑一个，避免每次都一模一样、显得机械。',
  'social.wait.maxMs': '每次停顿的随机上限（毫秒）。上下限差得越大，节奏越自然；设成和下限一样 = 每次都固定停这么久。',
  'social.wait.defaultQuietMs': '「默认静默」：轮到开口之前先安静观察这么久，留出判断「这一话题是否该接」的时间，群聊中尤为适用。',
  'social.wait.unfinishedQuietMs': '「话未说完时的静默」：对方末句明显未说完（如以「然后…」「等我一下」结尾）时，再多等这么久才开口，避免打断。',
  'social.wait.burstQuietMs': '「对方连发时的静默」：对方在短时间内连续发送多条（15 秒内不少于 3 条）时，再多等这么久，待其说完后一并回应。',
  'social.send.linearPerCharMs': '「每个字的打字时间」：一次回复中自第 2 条气泡起，等待 `本条字数 × 本值` 毫秒后发出（默认 150）。长句自然等得久、短句快，这是唯一的节奏规则。',
  'social.send.linearMinMs': '「两条气泡最小间隔」：再短的气泡也至少间隔这么久（默认 250ms），避免两条紧挨着刷出。',
  'social.send.linearCapMs': '「两条气泡最大间隔」：按上述方式算出的等待不超过该值（默认 4000ms），避免长句等待过久形似卡住。',
  'social.send.linearJitterRatio': '「打字速度抖动」：每条打字时间上下浮动的比例（默认 0.25，即 ±25%）。真人的速度不会每条一致，填 0 即完全机械。',
  'social.send.linearResetMs': '「静默后重新秒回」：安静达到该时长后计数归零，下一条回复重新从「第 1 条气泡立即发出」开始。',
  'social.send.linearEnabled': '「按字数打字节拍」：开启时自第 2 条气泡起按字数等待（第 1 条始终立发）；关闭时完全不等，多条气泡连续发出。',
  'social.wait.minQuietAfterNewMs': '「新消息后最短静默」：群内刚有人发言时至少安静这么久再插话，防止抢话、刷屏或显得急促。',
  'social.typing.enabled': '「私聊等对方打完字」：开启后，私聊中检测到对方正在输入（QQ 输入状态）便等其打完再回，不抢话。等待期间到达的消息全部排队：无论模型是否正在回复，都不会中途逐条塞入，待其打完才合并为一次（对话中只出现一个 [Mid-turn] 块，机器人只回一次）。关闭即不参考输入状态，按正常节奏回复。',
  'social.typing.holdMaxMs': '「最多等多久」：对方持续输入时，最多等这么久（默认 12000 毫秒）即插话，避免遇到始终「输入中」的对象而永不作答。',
  'social.typing.breakProbability': '「中途插话概率」（由桥侧掷骰）：每次唤醒掷一次骰，命中即不等对方打完，按正常节奏接话，这是「智能接话」的来源。0 = 绝不抢话，只等对方停止；0.15 = 偶尔接（默认）；0.5 以上 = 多半会接。',
  'social.typing.refreshOnMessageMs': '「收到消息后续多久」：QQ 的输入状态事件并不可靠（有时仅在开始与结束各发一次），故收到对方一条消息即视为「仍在输入」，将状态续期这么久（默认 5000 毫秒）。这是「对方连续发消息期间输入状态保持连续」的实现方式。',
  // —— 表情包 ——
  'social.sticker.enabled': '表情包总开关。开启时机器人以你 QQ 的收藏表情回消息（接梗、赞同、晚安等场合）；关闭时只以文字聊天。',
  'social.sticker.syncTtlMs': '向 QQ 同步收藏表情的间隔（毫秒）。同步一次可长期使用，无需每条消息都拉取；调小只会刷新更频繁、更耗资源。',
  'social.sticker.maxListCount': '单次最多同步多少个收藏表情。收藏较多时建议保持默认，过大反而拖慢。',
  'social.sticker.includeInPrompt': '把「有哪些表情、备注是什么」写入发给模型的提示。开启后模型才知道该用哪个表情；关闭则只能盲发。',
  'social.sticker.promptMaxStickers': '提示中最多列出几个表情。列得过多会占用 token，足够模型挑选即可。',
  'social.sticker.maxRemarkChars': '「表情备注字数上限」：模型为已有收藏表情撰写备注（挑表情时依据的即这句描述）时的字数上限。备注越准确，下次越清楚该表情适用于什么场合。它与「自动收藏」一组中的「收藏备注字数上限」并非同一项，后者只约束新收藏进来的表情。',
  'social.sticker.collect.enabled': '自动收藏：模型在群内见到高度贴合语境的表情时，可将其存入你的 QQ 收藏，逐步积累表情库。',
  'social.sticker.collect.maxPerMinute': '自动收藏每分钟的次数上限，防止短时间内大量收藏。',
  'social.sticker.collect.maxPerHour': '自动收藏每小时的次数上限。',
  'social.sticker.sendProbability': '「发表情概率」：由桥侧掷骰决定，不再依赖模型自行把握。每次唤醒掷一次，结果写入唤醒提示（[Meme] dice HIT / MISS）：HIT 本轮最多发 1 个表情，MISS 则只发文字（有人明确索要表情包时不受骰子约束）。0 = 不主动发；0.3 ≈ 偶尔一张（默认）；0.5 以上 ≈ 几乎每轮都有。',
  'social.sticker.sendCooldownMs': '表情包冷却（毫秒）：同一会话刚发过表情包后，该时段内不再抽中，防止概率虽小却连续发出。默认 180000（3 分钟）。',
  'social.deepsleepGroups': '「单群静默名单」：只对这些群静默（每行一个群号，可留空）。名单内群的消息入库但不唤醒、不回复，其余群照常。需要全群静默请使用上方总开关。',
  // —— 智能体开关与自动回复 ——
  'social.enabled': '社交模块总开关。开启时机器人读取消息、判断是否回复并按人设互动；关闭则完全不理任何消息。',
  'social.autoReplyCheckMs': '检查「是否有值得回复的新消息」的间隔（毫秒）。越小响应越快，但更费 token；越大越省，响应越慢。',
  'social.provideRecommendations': '把适配当前设置的推荐参数（如唤醒概率建议）一并交给模型，便于其按人设行事。一般保持开启。',
  // —— 好友相关 ——
  'social.autoFriendApproval': '自动同意好友申请：有人添加机器人为好友时直接通过，无需人工批准。建议配合好友守卫生效，以防陌生人骚扰。',
  'social.autoFriendGuard': '好友守卫：开启后仅名单内或受信任账号可触发敏感操作（管理、拉黑、跨会话读取等）。属安全开关，建议开启。',
  'social.docx.dailyQuotaChars': '模型每天可生成的 Word 文档总字数上限，防止持续生成文档耗尽额度。',
  // —— 主动闲聊（冷场找话题、主动私聊）——
  'social.proactive.enabled': '主动闲聊总开关。开启时群内长时间无人发言（超过 idleThresholdMs）后，机器人每隔一阵检查一次并按概率主动开启话题；关闭则始终等待他人先开口。',
  'social.proactive.checkIntervalMinMs': '群聊主动找话题的检查间隔下限（毫秒）。机器人每隔「下限至上限」之间的随机时长检查一次群是否冷场足够久、是否该主动发言。',
  'social.proactive.checkIntervalMaxMs': '群聊主动找话题的检查间隔上限（毫秒）。与下限构成随机区间：差值越大越无规律，越小越勤快。',
  'social.proactive.idleThresholdMs': '冷场判定时长（毫秒）：群内无人发言达到该时长才算冷场。冷场不足时机器人不会主动开口，以免抢话或刷屏。',
  'social.proactive.probability': '群聊主动找话题概率（0~1）：每次检查确认冷场后真正开口的概率。0.3 ≈ 十次冷场中约三次主动开话题；0 则基本只在被叫到时发言。',
  'social.proactive.privateCheckIntervalMinMs': '私聊主动检查间隔下限（毫秒）：机器人主动私聊前的最小间隔，逻辑同群聊检查，私聊独立计时。',
  'social.proactive.privateCheckIntervalMaxMs': '私聊主动检查间隔上限（毫秒）：与下限构成私聊主动发起私聊的随机间隔区间。',
  'social.proactive.privateProbability': '私聊主动概率（0~1）：机器人主动私聊的概率。较高 ≈ 常主动问候或分享近况；较低 ≈ 基本只在收到消息时回复。',
  // —— 投递与省额度 ——
  'social.steerEnabled': '「在途回合注入」总开关，默认开启。开启时，模型思考（执行某一步）期间收到的新消息会被直接并入同一回合的下一个节点，模型在本次回复中一并考虑，可省去一整轮唤醒、一次整包重发与一次对话注入。'
    + '关闭后，新消息一律等当前回合结束再作为新一轮处理，更慢也更费，且旧实现中曾出现消息滞留于 DSH 队列而不再产出的故障。'
    + '真正的安全阀并非本开关，而是桥内「必须确有回合在运行」的守卫，故一般保持开启。',
  'social.slimTools': '工具 schema 精简：名单内的 MCP 工具将不再注册给模型，其 JSON 描述自此不出现在任何一次请求中。'
    + '该举措效果最大的原因：单次请求约 85,800 字符中 tools 占 72,858（约 87%），且每一步都会重发一遍。'
    + '而 config 中「QQ 工具开关」一组仅在调用时返回拒绝（403），一个字符也省不掉。'
    + '修改后必须重启隔离 DSH 方生效（工具表仅在 DSH 启动时读取一次）。',
  // —— 回合保持（social.turnHold）：持段协议的管理端说明 ——
  'social.turnHold.enabled': '「回合保持」总开关。开启时桥在一次唤醒内将 DSH 的该回合保留一段时间，期间你连续补充的若干句会被并入同一回合处理，无需逐条重新唤醒（省一次整包提示与一轮排队）。关闭则回到「每条消息各起一轮」的原有行为。',
  'social.turnHold.keys': '限定生效的会话（每行一个，如 `private:10001` 或 `group:123456789`）。留空表示不按会话限制，具体范围由下方「只对私聊保持」决定。',
  'social.turnHold.privateOnly': '只对私聊保持：群聊不开启保持（群内人多且话题分散，长期占用回合既费额度又容易答错对象）。'
    + '若需某个群也保持，在此关闭本项，再用上方「限定会话」写明这些群号。',
  'social.turnHold.maxExchanges': '一次保持内最多的来回轮数，达到即放行，防止持续发言导致回合不结束（回合数直接等于模型步数，即额度）。',
  'social.turnHold.idleCloseMs': '空闲关闭：连续这么久（毫秒）没有新消息即主动放开该回合，让 DSH 正常收尾。',
  'social.turnHold.maxWaitMs': '最长保持：无论有无新消息，达到该时长（毫秒）必须结束，避免回合长期挂起。',
  'social.turnHold.answeredIdleCloseMs': '答后空闲关闭（毫秒）：本回合已经发过气泡、手上也没有待交付消息时，再静默这么久就收回合'
    + '（界面上那句「深度求索中…」随之结束）。0 = 已经答过就立刻放行，不等静默窗口，适合「回了就停、别挂着」；'
    + '填大于 0 的值则等静默到点；留空或非法值按 90000（90 秒）处理。它只影响「已经答过一轮」之后的收尾，'
    + '不改变对方连发时把几句并进同一回合的行为（那由 maxExchanges / idleCloseMs 管）。',
  'social.turnHold.requestBudgetMs': '每段等待预算（毫秒，默认 55000）：桥并非一次性占用整个回合，而是分若干段向插件续问；'
    + '每段最多等待这么久，插件若要求继续则返回 `again:true` 进入下一段。本值必须小于 DSH 插件侧的单次请求超时，否则回合会在预算用尽前被断开。',
  /* ================= 为「界面不得出现英文键」补齐的说明 =================
     这些键此前在管理端没有卡片、也没有说明，仅有标签而无解释；现逐个补上，
     统一写清三件事：管什么、默认值、桥内的键名（审计脚本按标签表检查，说明供使用者阅读）。 */
  // —— 已废弃的旧发送节奏键（老配置中可能仍保留，读取后不生效）——
  'social.send.linearBaseMs': '已废弃（老版「首条气泡延迟」，桥内键名 social.send.linearBaseMs）。'
    + '桥现仅保留「按字数」一套打字节拍：第 1 条气泡立即发出，第 2 条起按字数等待。该键写入后不生效，保留仅为兼容旧配置文件；'
    + '调整节奏请改用「按字数打字节拍 / 每个字的打字时间 / 两条气泡最小间隔 / 两条气泡最大间隔 / 打字速度抖动 / 静默后重新秒回」。',
  'social.send.linearStepMs': '已废弃（老版「每条递增间隔」，桥内键名 social.send.linearStepMs），桥不读取、写入不生效；替代项为「每个字的打字时间」。',
  'social.send.gapBaseMs': '已废弃（老版「间隔基数」，桥内键名 social.send.gapBaseMs），桥不读取、写入不生效；替代项为「两条气泡最小间隔」。',
  'social.send.gapPerCharMs': '已废弃（老版「每字追加间隔」，桥内键名 social.send.gapPerCharMs），桥不读取、写入不生效；替代项为「每个字的打字时间」。',
  'social.send.gapJitterRatio': '已废弃（老版「间隔抖动比例」，桥内键名 social.send.gapJitterRatio），桥不读取、写入不生效；替代项为「打字速度抖动」。',
  'social.burstIntervalMinMs': '已废弃（老版「连发间隔下限」，桥内键名 social.burstIntervalMinMs），桥不读取；连发间隔现由「按字数打字节拍」一组决定。',
  'social.burstIntervalMaxMs': '已废弃（老版「连发间隔上限」，桥内键名 social.burstIntervalMaxMs），桥不读取；连发间隔现由「按字数打字节拍」一组决定。',
  burstIntervalMinMsLegacy: '更旧的键名（桥内键名 burstIntervalMinMsLegacy），任何版本均不生效。出现该键说明这份配置自很旧的版本沿用而来，'
    + '可在「JSON 进阶」页直接删除。',
  // —— NapCat 会话守护（guard）：2026-09-23 起探针与状态检测已整体去除 ——
  // 桥侧每 60s 探活、连续失败自动重启容器与「立即自愈」按钮均已删除。
  // 原因（如实写在界面上）：该套探针会占用 WebUI 页面自身的登录额度
  //（NapCat 登录接口限制为每 IP 每 60 秒 loginRate 次，页面自身亦需登录一次），
  // 额度被后台耗尽后页面即报「获取QQ列表失败: Unauthorized」「获取二维码失败: Unauthorized」；
  // 且探针「60 秒未换码即换一张」会将用户正在扫描的二维码作废，导致首扫即报鉴权失败。
  // 以下仅为不再生效的旧键说明，勿再认为调整它们可改变行为。
  'guard.enabled': '【已去除】会话守护总开关（桥内键名 guard.enabled）。自 2026-09-23 起桥不再探活，'
    + '该键不再产生任何效果；此前开启时桥会定期探活并在连续失败后重启容器自愈。'
    + '去除原因：探针会占用 WebUI 页面自身的登录额度，导致页面随后报「获取QQ列表失败: Unauthorized」；'
    + '且它定期更换二维码，会将用户正在扫描的那张作废。现在判断 NapCat 是否正常，请直接打开 NapCat 自身的界面。',
  probeIntervalMs: '【已去除】探活间隔（桥内键名 guard.probeIntervalMs）。桥不再启动任何探活定时器，此键无效。',
  failThreshold: '【已去除】连续失败多少次判定假死（桥内键名 guard.failThreshold）。探针已去除，此键无效。',
  cooldownMs: '【已去除】自愈冷却（桥内键名 guard.cooldownMs）。桥不再自动重启容器，此键无效。',
  maxHealsPerHour: '【已去除】每小时最多自愈几次（桥内键名 guard.maxHealsPerHour）。桥不再自动重启容器，此键无效。',
  restartGraceSec: '【已去除】重启宽限（桥内键名 guard.restartGraceSec）。该值仅被自动自愈使用，已随自愈一并去除；'
    + '现需重启请使用首页的容器或进程控制。',
  recoverWaitMs: '【已去除】重启后等待恢复（桥内键名 guard.recoverWaitMs）。已随自愈一并去除，此键无效。',
  autoHeal: '【已去除】自动重启自愈（桥内键名 guard.autoHeal）。桥不再自动或手动重启 NapCat 以自愈，此键无效。',
  // —— 空闲会话自动归档（social.sessionArchive）——
  'social.sessionArchive.enabled': '空闲会话自动归档开关（桥内键名 social.sessionArchive.enabled，默认开启）：将闲置过久的 DSH 会话归档，'
    + '避免常驻会话持续累积、上下文不断增长。归档不等于删除：会话文件仍在桥的 state 目录下，需要时可被重新唤醒。',
  intervalMs: '巡检间隔（毫秒，桥内键名 social.sessionArchive.intervalMs，默认 600000，即 10 分钟）：桥每隔该时长巡检一次有无应归档的会话。',
  idleMinutes: '闲置多少分钟算空闲（桥内键名 social.sessionArchive.idleMinutes，默认 30）：超过该时长且当前无回合在运行的会话才会被归档。',
  batchMax: '单批最多归档几个（桥内键名 social.sessionArchive.batchMax，默认 20）：每次巡检最多处理该数量，避免集中归档使桥拥塞。',
  pruneDays: '归档保留天数（桥内键名 social.sessionArchive.pruneDays，默认 0，即不清理）：大于 0 时，归档超过该天数的会话文件将被删除；'
    + '填 0 表示仅归档、永不删除。',
  // —— 反馈上报（social.feedback）——
  maxLength: '反馈字数上限（桥内键名 social.feedback.maxLength，默认 500）：机器人经「反馈给主人」工具发送的内容最长字数，超出即被截断。',
  notifyOwnerOnError: '出错时通知主人（桥内键名 social.feedback.notifyOwnerOnError，默认关闭）：开启后机器人自身遇到错误会主动私聊告知。',
  // —— 黑话学习（slang）：管理端暂无单独卡片，键仍登记，需要时可在「JSON 进阶」中修改 ——
  'slang.enabled': '黑话学习开关（桥内键名 slang.enabled，默认开启）：关闭后桥跳过全部黑话学习任务，聊天中发送 /slang learn 亦不会执行。',
  extractMinMessages: '凑够几条消息才提取（桥内键名 slang.extractMinMessages，默认 10）：语料中消息过少时不值得调用一次模型，直接跳过。',
  extractCooldownMs: '两次提取的最小间隔（毫秒，桥内键名 slang.extractCooldownMs，默认 300000，即 5 分钟）：防止短时间内反复提取耗尽额度。',
  inferenceThresholds: '推断阈值（桥内键名 slang.inferenceThresholds，默认 [2,4,8]）：某词出现达到这些次数时触发不同深度的考究，数值越小越容易触发。',
  injectMax: '最多注入几条黑话（桥内键名 slang.injectMax，默认 8）：唤醒提示中最多携带几条已学到的黑话，避免提示词过大。',
  injectIntoPrompt: '把黑话写入提示词（桥内键名 slang.injectIntoPrompt）：开启时模型每次都能看到已学到的黑话；关闭时仅能经主动查询工具读取。',
  learnerPreset: '学习会话的人设预设（桥内键名 slang.learnerPreset）：黑话学习单独启动一个 DSH 会话运行，此处指定其使用的预设。',
  'slang.workspaceTitle': '学习工作区名称（桥内键名 slang.workspaceTitle）：黑话学习会话工作区的名称，仅用于显示，不影响行为。',
  autoResearch: '自动联网考究（桥内键名 slang.autoResearch，默认开启）：提取到新词后自动联网查询其含义，查不到则标记为「未确认」待下次处理。',
  charactersDir: '角色库目录（桥内键名 social.charactersDir）：一个角色对应一个子目录，即一个角色包（SKILL.md / personality.md / manifest.json 等）。'
    + '出厂自带 21 个角色包（另有 1 个散装卡）；留空即使用默认目录（用户主目录下的 Downloads/characters/characters）。四个角色卡工具对该目录均只读，不会写盘。',
  // —— 表情包库（social.meme）：三处包目录与角色绑定 ——
  'social.meme': '表情包库（桥内键名 social.meme）：一份表情包即一个目录（manifest.json + index.db + memes/<分类>/图片），包 id 取自该包 manifest.json 的 id 字段。'
    + '桥同时识别三个存放位置：运行目录 meme/、运行目录 meme-packs/（上传的包落于此）、角色库中的 <角色>/meme-packs/。通常无需手工编辑本段，'
    + '在「常用设置」的「表情包库」卡中导入并勾选即可。表情包须由使用者自行导入，产品不随附任何表情包。',
  'social.meme.enabled': '表情包库总开关（桥内键名 social.meme.enabled，默认开启）：关闭时 qq_meme_search / qq_send_meme 直接不注册给模型'
    + '（从工具列表中消失、描述不再占用额度），并非在调用时才拒绝。',
  'social.meme.packs': '只搜这几个表情包（桥内键名 social.meme.packs）：填包 id 数组（如 ["my-pack-001"]），包 id 取自该包 manifest.json 的 id 字段；'
    + '留空即把 meme/、meme-packs/ 与角色专属包全部纳入搜索。非空时，除点名的包外，当前角色绑定的包也一定在搜索范围内。',
  'social.meme.personaPacks': '角色专属表情包绑定（桥内键名 social.meme.personaPacks）：形如 {"atri": ["atri-pack-001"]}。'
    + '两份包中存在同名表情时，优先使用此处绑定的那一份。一般无需手写，在「表情包库」卡中按角色勾选即可。',
  'social.meme.activePersona': '当前角色（桥内键名 social.meme.activePersona）：记录最近一次从角色库导入 persona.md 的角色，用于决定哪份角色专属表情包排在最前。'
    + '由管理端导入角色卡时自动写入，无需手工修改。',
  // —— 同名键按路径区分说明 ——
  'social.agentPreset': '社交会话使用的人设预设（桥内键名 social.agentPreset，默认 default）：仅作用于社交模块创建的会话；'
    + 'config.json 顶层的 agentPreset 为全局预设，两者同时存在时以社交模块该项为准。',
  'social.slimTools.enabled': '启用精简名单（桥内键名 social.slimTools.enabled）：勾选表示名单内的工具不注册给模型，其 JSON 描述从每一次请求中彻底消失（切实节省额度）；'
    + '不勾选则全部正常注册。工具表仅在隔离 DSH 启动时读取一次，故修改后必须重启隔离 DSH。',
  'social.slimTools.deny': '不注册给模型的工具名单（桥内键名 social.slimTools.deny）：填写 MCP 工具原名（形如 mcp__napcat__qq_send_message），'
    + '必须与桥侧注册的名称逐字一致，写错不会报错但也不生效。',
  /* ══════════════════════════════════════════════════════════════════════════════════════
   * 上述条目为历史逐条补充者，仅覆盖不易自明的项。以下部分把其余全部配置键补齐，
   * 使每一个输入框旁侧的说明标记均有内容；「工具与规则」中的每一个工具开关亦逐条写明开启后模型可做什么。
   * 维护约定：新增配置键必须同时在此补一条 —— tools/audit-config-help.mjs 可审计覆盖率
   * （它以 config.example.json 与本机 config.json 的键比对本表，缺失即退出码 1）。
   * ══════════════════════════════════════════════════════════════════════════════════════ */

  // ── 顶层分组（卡片标题）──
  dsh: '隔离 DSH（模型执行器）段落：所跑厂商、模型、推理档位、超时，以及隔离实例与 DSH CLI 的位置。修改后由管理端同步进隔离 DSH 的 settings.yaml 并重启该实例方生效。',
  napcat: 'NapCat（QQ 协议端）段落：OneBot 的 WebSocket 与 HTTP 地址及令牌、NapCat 安装位置、图片落盘的临时目录与容器路径映射。其中 accessToken / wsAccessToken 不在此卡修改，请用「NapCat 鉴权令牌」卡（该卡会同时写入 NapCat 自身配置并重启 NapCat）。',
  pixiv: 'Pixiv 相关两项：镜像站地址（qq_pixiv_search / qq_send_pixiv 兜底使用）与可选的登录 cookie（仅用于按画师名字搜人）。按画师号或作品链接发原图均不需要 cookie。',
  guard: '【已去除】NapCat 会话守护段落（探活与连续失败后自动重启容器自愈）已整体删除。'
    + '原因：探针会占用 WebUI 页面自身的登录额度（NapCat 登录接口按 IP 限流，页面自身亦需登录一次），'
    + '额度耗尽后页面即报「获取QQ列表失败: Unauthorized」；探针还会定期更换二维码，使用户正在扫描的那张作废。'
    + '此处的旧键仅为避免界面回落成英文键名，填任何值均不生效；查看 NapCat 状态请直接打开其自身界面。',
  slang: '黑话学习：从聊天中抽取群内黑话与缩写并沉淀为词表，模型撰写回复时可自然使用。抽取阈值、抽取间隔与注入条数均在此设置。',
  social: '社交行为总段：唤醒、发送节奏、上下文与轮换、表情包、主动闲聊、等待、打字等待、投递与回合、活跃时段与工具开关均在本段之下。social.enabled 为总开关。',
  'social.tools': '工具开关：其中每个键对应一个 MCP 工具（键名为桥侧注册的工具名去掉 qq_ 前缀后的驼峰形式）。关闭即不注册该工具，模型看不到它。',
  'social.wake': '唤醒与潜水：机器人何时被叫醒、默认潜水还是活跃、推荐的沉睡时长、概率与关键词，以及唤醒频率上限。被 @、被叫名字、被提问、被拍一拍等直接叫到的情况始终会唤醒。',
  'social.send': '发送节奏与限额：一次最多几条、单条多少字、条间间隔、每分钟与每小时发送上限、长间隔概率。这一组直接决定是否会刷屏。',
  'social.wait': '等待工具（qq_wait_for_messages）的默认值与上下限：默认等多久、最短多久、收到新消息后至少再静默多久。等待过久容易把一个回合拖成数分钟。',
  'social.sticker': '表情包：总开关、收藏表情同步间隔、列表上限、是否将可用表情写入提示词、提示词中最多列出几张。',
  'social.sticker.collect': '自动收藏：模型遇到语境内合适的表情时自动存入收藏库的节流设置（每分钟与每小时最多几张）。',
  'social.proactive': '主动闲聊：无人发言时机器人自行开启话题的间隔与概率。间隔为随机区间，概率 0 表示永不主动。',
  'social.feedback': '反馈（qq_report_feedback）：模型将「本次回复效果如何」上报回桥的通道，以及是否在出错时通知主人。',
  'social.context': '上下文窗口：唤醒时给模型贴入多少条近期消息、未读最多携带几条、轮换后第一轮给出多长的窗口。这三项直接决定 token 成本。',
  'social.autoReset': '会话轮换（更换新会话，避免上下文持续增长）：聊多少轮后更换、换完第一回合给出多少条历史、提前预热几个会话。',
  'social.sessionArchive': '会话归档：闲置多久将 DSH 会话归档、多久巡检一次、一次最多归档几个、保留多少天。',
  'social.turnHold': '回合保持：在连续对话中使 DSH 会话保持「处于回合中」，省去每次重新唤醒的整轮开销。私聊专用，另有最大来回数与空闲关闭时长。',
  'social.typing': '私聊打字等待：对方仍在输入时先等待再回复（最多等多久、多久刷新一次、多大概率打断直接回）。',
  'social.docx': 'Word 文档（qq_send_docx）：每天可生成与发送多少篇、单篇多少字、临时目录。',
  'social.deepsleep': '静默群聊：勾选表示这些群的消息完全不处理（连唤醒都不排队），用于临时静默。',
  // social.steerEnabled 的说明见上方长条目，此处不再重复登记，否则 TypeScript 会报重复键。

  // ── 基础与会话 ──
  ownerQQ: '主人 QQ。填入后该对象的私聊带 [OWNER] 标记，可用自然语言修改配置，并可调用主人专属工具；留空表示没有主人（所有人均非主人）。须为机器人能看到消息的 QQ 号。',
  adminQQ: '额外的管理员 QQ 列表（可多人）。这些人可下达管理命令（加白名单、静默等），但不能修改配置，也不是主人。',
  agentPreset: '默认 agent 预设名（preset）：决定系统提示词的骨架。social.agentPreset 为聊天所用者，两者同时存在时以社交模块为准。',
  workspaceTitle: 'DSH 工作区标题（显示在会话列表中，仅用于展示，不影响行为）。',
  ackMessage: '收到消息后先回一条的垫话（例如「🤔 收到，正在思考…」）。留空即不垫话，直接等待正式回复。',
  sendDelayMs: '每条消息之间的基础延迟（毫秒）。0 = 立即发送；调大则类似打字较慢。',
  questionTimeoutMs: '需要用户回答的提问（审批或选择）最多等待多久，超时即视为未答复并继续执行。',
  'security.interceptNotify': '安全拦截通知：命中敏感词或危险指令被拦下时，是否在会话中告知（不勾选即静默拦截）。',

  // ── 名单 ──
  allow: '允许名单：仅名单内的会话会被处理（发消息、唤醒、回复）。名单为空时以下方三个放行开关为准。拒绝名单始终优先。',
  'allow.private': '允许的私聊 QQ 号，每行一个或以逗号分隔。为空且未开启放行开关时，任何私聊均不处理。',
  'allow.groups': '允许的群号。为空且未开启放行开关时，任何群均不处理（机器人等同于沉默）。',
  deny: '拒绝名单：命中即一律不处理，即使同时位于允许名单中也会被拦截（拉黑优先）。',
  'deny.private': '拉黑的 QQ 号：不处理其私聊，也不会被其添加好友或拉入群聊。',
  'deny.groups': '拉黑的群号：这些群的消息完全不理。',

  // ── NapCat 连接 ──
  'napcat.httpUrl': 'NapCat 的 OneBot HTTP 接口地址（桥用于发送消息、查询状态）。本机部署通常为 http://127.0.0.1:3000。',
  'napcat.wsUrl': 'NapCat 的 OneBot WebSocket 地址（桥用于接收消息事件）。本机部署通常为 ws://127.0.0.1:3001。填错的表现是「连接成功但收不到任何消息」。',

  // ── Pixiv ──
  'pixiv.base': 'Pixiv 第三方镜像站地址，仅在官网直连失败时兜底（官方 ajax 接口实际免登录可用；镜像站较慢，同一张图 2.7~5.7 秒）。留空即使用内置默认 https://x.pixigraph.xyz。',
  'pixiv.cookie': 'Pixiv 登录 cookie（PHPSESSID）：仅用于按画师名字搜人（官网用户搜索接口对匿名请求一律返回 400）。免费账号即可；填一次即可长期使用：每解出一个画师号都会落盘缓存（state/pixiv-artists.json），cookie 此后过期，已查询过的名字仍可用；真正过期时桥会自检并主动在 QQ 中提醒。不填也可使用 authorId（画师号，如 1554775）或作品链接。安全说明：只发送给 pixiv 自身域名，绝不发送给镜像站；写入请使用 tools/set-pixiv-cookie.mjs（从文件读取、写完删除文件、仅回显掩码）。',

  // ── 工具开关（逐个写明开启后模型可做什么）──
  'social.tools.getPrompt': '读提示词（qq_get_prompt）：模型主动重新读取当前生效的人设、发言规则与工具说明。一般无需调用，但可让模型自查「我现在的人设是什么」。',
  'social.tools.getUnread': '读未读（qq_get_unread）：取出尚未处理的消息。关闭后模型只能依赖唤醒正文中携带的未读内容。',
  'social.tools.getRecent': '读最近消息（qq_get_recent_messages）：按会话翻取最近若干条历史，含自己发过的。追旧话题时需要使用。',
  'social.tools.socialState': '查社交状态（qq_social_state）：当前处于潜水还是活跃、下次唤醒时间、限额已用多少。排障时最为有用。',
  'social.tools.sendGroup': '发群消息（qq_send_group_message）：向白名单内的群发送文本。关闭即模型不能在群内发言。',
  'social.tools.sendPrivate': '发私聊消息（qq_send_private_message）：向白名单内的 QQ 发送文本。',
  'social.tools.reply': '引用回复（qq_reply）：带引用地回复某条消息（QQ 中显示「回复 xxx」）。',
  'social.tools.sendMessage': '统一发送（qq_send_message）：最常用的发送入口，支持 text 与 images、引用、@，也支持多条。',
  'social.tools.waitMessages': '等待新消息（qq_wait_for_messages）：沉睡前先观察一段时间，也可用 triggers 等待特定的人或关键词。',
  'social.tools.feedback': '反馈（qq_report_feedback）：将「本次回复效果如何、哪里出了问题」上报回来，供后续学习与排障。',
  'social.tools.getMyRecent': '读自己最近说的话（qq_get_my_recent_messages）：避免重复并保持一致。',
  'social.tools.getMessageDetail': '查单条消息详情（qq_get_message_detail）：拆解引用、转发、图片等结构，用于排障。',
  'social.tools.getActiveMembers': '查活跃成员（qq_get_active_members）：查看群内谁最近在发言，以便决定 @ 谁。',
  'social.tools.setWakeConfig': '设置唤醒条件（qq_set_wake_config）：潜多久、何种条件唤醒（@、名字、关键词、提问、拍一拍），每轮收尾都需调用一次。',
  'social.tools.markRead': '标记已读（qq_mark_read）：推进已读水位，避免同一条消息被反复处理。',
  'social.tools.memory': '记忆（qq_memory_append/search 等）：把长期事实写入记忆库，需要时检索出来。',
  'social.tools.slangQuery': '查黑话（qq_slang_query）：查询某词在群内的含义。',
  'social.tools.slangSubmit': '提交黑话（qq_slang_submit）：学到新词时上报给黑话库。',
  'social.tools.getImages': '读消息中的图片（qq_get_message_images）：取回图片内容交给模型查看。关闭后图片消息只剩占位文字。',
  'social.tools.getForwardMsg': '读合并转发（qq_get_forward_msg）：把转发的聊天记录展开为可读文本。',
  'social.tools.sendPoke': '拍一拍（qq_send_poke）：戳一下对方。',
  'social.tools.listStickers': '列收藏表情（qq_list_stickers）：查看自己收藏了哪些表情（含备注），以便挑选。',
  'social.tools.getStickerImage': '看表情图（qq_get_sticker_image）：把某张收藏表情取回给模型查看，避免盲发。',
  'social.tools.sendSticker': '发收藏表情（qq_send_sticker）：把收藏中的某张发送出去。',
  'social.tools.setStickerRemark': '给表情写备注（qq_set_sticker_remark）：记录「这张适合什么场合」，以便下次选得更准。默认关闭（属整理动作，日常无需使用）。',
  'social.tools.stickerNote': '表情学习笔记（qq_sticker_note）：见到新表情时记下自己的理解。',
  'social.tools.collectSticker': '收藏表情（qq_collect_sticker）：把他人发送且语境内适用的表情存入自己的收藏库。',
  'social.tools.getSelfImage': '取自己的形象图（qq_get_self_image）：assets/deepseek娘.png，需要发自拍或头像时使用。',
  'social.tools.characterCards': '角色库（qq_character_list/read/pack/search）：读取 characters 目录下的角色卡，用于角色扮演。',
  'social.tools.faceList': 'QQ 原生表情表（qq_face_list）：列出可用的 QQ 大表情与小表情及其含义，以便挑选发送。',
  'social.tools.sendQqFace': '发 QQ 原生表情（qq_send_qq_face）：发送内置大表情（比自行书写 emoji 自然得多）。',
  'social.tools.musicSearch': '点歌搜索（qq_music_search）：按关键词搜歌，取得 musicId 后用 qq_send_rich 发送音乐卡片。',
  'social.tools.sendRich': '发卡片或音乐（qq_send_rich）：音乐卡（网易云、QQ 音乐）、名片、骰子等富消息。音乐卡只传 musicId，标题、封面与音频由桥自行拼装，手写 JSON 会导致手机端显示空白卡。',
  'social.tools.imageSearch': '联网找图（qq_image_search）：按关键词搜索图片（Bing、百度），并可直接把结果图发送出去，适用于不知该用什么图的场合。',
  'social.tools.videoSearch': '视频解析（qq_video_parse）：把 B 站、抖音等分享链接解析为可发送的内容（B 站会发小程序卡片）。',
  'social.tools.sendForward': '发合并转发（qq_send_forward）：把多条消息打包成聊天记录一次发出。',
  'social.tools.scheduleMessage': '定时消息（qq_schedule_message）：用于「几点提醒你」一类场景。',
  'social.tools.withdrawMessage': '撤回消息（qq_withdraw_message）：发错时可撤回（需要 messageId）。',
  'social.tools.historyDelete': '删单条历史（qq_history_delete）：把某条消息从桥的会话历史中删除（仅删桥的记录，不删 QQ 上的）。',
  'social.tools.historyClear': '清空历史（qq_history_clear）：清掉整个会话的历史记录并重置上下文。影响面较大，默认关闭。',
  'social.tools.memorySearch': '搜记忆（qq_memory_search）：在长期记忆库中检索相关条目。',
  'social.tools.globalOverview': '全局概览（qq_global_overview）：一次查看所有会话的未读与状态，繁忙时很省 token。',
  'social.tools.qzone': 'QQ 空间（qq_qzone_*）：查看或发布说说、点赞与评论。默认关闭（属对外发布动作，须谨慎开启）。',
  'social.tools.sendDocx': '发 Word 文档（qq_send_docx）：把长文或报告转为 .docx 以文件发送，不走聊天正文。',
  'social.tools.getFileContent': '读群文件（qq_get_file_content）：下载并读取群文件或收到的文件内容，需要模型查看文档时使用。',

  // ── 唤醒 ──
  'social.wake.defaultMode': '默认模式：diving = 潜水（按触发条件才醒）/ active = 活跃（群内发言均接）。单个会话可用 /set active 或 /set diving 覆盖，也可带时段，如 /set diving 00:00-21:00。',
  'social.wake.preSleepWaitEnabled': '沉睡之前先观察：开启后 qq_wait_for_messages 会先等待一个安静窗口，确认无人发言再睡，避免刚睡下即被叫醒。',
  'social.wake.recommendedDefaultInfinite': '给模型的推荐值：是否建议无限期潜水（自行判断该醒时再醒）。这只是提示词中的建议，不具强制性。',
  'social.wake.sleepMinMs': '允许的最短沉睡时长（毫秒）：模型希望睡得过短时会被顶到该下限。',
  'social.wake.sleepMaxMs': '允许的最长沉睡时长（毫秒）：0 = 不限制（可睡至无限期）。',
  'social.wake.recommendedSleepMinMs': '推荐沉睡时长下限（毫秒）：写入提示词，引导模型不要过于频繁地唤醒。',
  'social.wake.recommendedSleepMaxMs': '推荐沉睡时长上限（毫秒）：写入提示词。',
  'social.wake.recommendedProbability': '推荐「随机被唤醒」概率：模型沉睡时，普通消息将其叫醒的概率。0.05 = 二十分之一。',
  'social.wake.recommendedAtMention': '推荐开关：被 @ 时唤醒。建议保持开启。',
  'social.wake.recommendedNameMention': '推荐开关：消息中叫到机器人名字时唤醒。',
  'social.wake.recommendedQuestion': '推荐开关：有人提问时唤醒。',
  'social.wake.recommendedPoke': '推荐开关：被拍一拍时唤醒。',
  'social.wake.batchWindowMs': '唤醒合批窗口（毫秒）：该时段内的多条消息合并为一批一并交给模型，避免每来一条就唤醒一次。',
  'social.wake.maxWakePerMinute': '每分钟最多唤醒几次：超出即排队（防抖、防循环）。',
  'social.wake.maxWakePerHour': '每小时最多唤醒几次：成本刹车。',
  'social.wake.noActionLimit': '连续几次唤醒均未执行任何动作（既不回复也不设置唤醒条件）即强制提醒并收尾，防止空转消耗 token。',
  'social.wake.maxWakeConfigReminders': '同一回合最多提醒几次「尚未设置唤醒条件」。',
  'social.wake.maxWakePerMinutePrivate': '私聊每分钟最多唤醒几次（默认 12）：私聊由主人自己发起，允许比群聊更密。',
  'social.wake.maxWakePerHourPrivate': '私聊每小时最多唤醒几次（默认 0 = 不限）：私聊默认不设小时上限，以免主人夜间发言被挡。',

  // ── 发送节奏 ──
  'social.send.burstEnabled': '允许一次发送多条气泡：关闭后只能发一条，模型强行发多条会被拒绝。',
  'social.send.burstMaxMessages': '一次最多几条气泡：超出直接拒绝。',
  'social.send.longGapProbability': '出现长间隔的概率：模拟「打了一半停一下再发」的真人节奏。',
  'social.send.longGapMinMs': '长间隔的最小毫秒数。',
  'social.send.longGapMaxMs': '长间隔的最大毫秒数。',
  'social.send.maxSendPerMinute': '每分钟最多发几条消息（跨会话合计），0 = 不限。超出即直接拒绝并结束回合。',
  'social.send.maxSendPerHour': '每小时最多发几条，0 = 不限。被垃圾回复刷屏时的兜底刹车。',
  'social.send.maxMessageChars': '单条消息最多多少字：超出即拒绝，防止一句话占满整屏。',
  'social.send.maxGapMs': '条间最大间隔（毫秒）：上限，防止节奏参数配得过大而把一个回合拖很久。',

  // ── 分组键亦登记一条，以便审计一次通过（部分卡片会将分组键名显示为标题旁的说明标记）──
  'social.sticker.collect.maxRemarkChars': '「收藏备注字数上限」：自动收藏一张新表情时顺手写下的备注最多几个字（过长会显得啰嗦）。与卡中单列的「表情备注字数上限」分开管理：后者管已有收藏的表情，本项只约束新收藏进来的。',
};

/** 与 LABEL 分开维护：这里只补"历史上漏登记中文名"的键 */
const LABEL_EXTRA: Record<string, string> = {
  'pixiv.cookie': 'Pixiv 登录 cookie（PHPSESSID，只用于按画师名字搜人）',
  'pixiv.base': 'Pixiv 镜像站地址',
  // 工具开关的中文名：官方审计工具（tools/audit-ui-labels.mjs）要求"每个键都要有中文标签"，
  // 这些是 2026-09-19 补说明文时一并补上的（原来只有 TOOL_LABEL 里的一部分）。
  'social.tools.faceList': 'QQ 原生表情表', 'social.tools.sendQqFace': '发 QQ 原生表情',
  'social.tools.musicSearch': '点歌搜索', 'social.tools.sendRich': '发卡片/音乐',
  'social.tools.imageSearch': '联网找图', 'social.tools.videoSearch': '视频解析',
  'social.tools.sendForward': '发合并转发', 'social.tools.scheduleMessage': '定时消息',
  'social.tools.withdrawMessage': '撤回消息', 'social.tools.historyDelete': '删单条历史',
  'social.tools.historyClear': '清空历史', 'social.tools.memorySearch': '搜记忆',
  'social.tools.globalOverview': '全局概览', 'social.tools.qzone': 'QQ 空间',
  'social.tools.sendDocx': '发 Word 文档',
  'social.tools.getFileContent': '读群文件',
  'social.wake.maxWakePerMinutePrivate': '私聊每分钟唤醒上限', 'social.wake.maxWakePerHourPrivate': '私聊每小时唤醒上限',
  // 2026-09-21：[Style] 语感行 + /token 计价参数（两者都在「Core 设置」的通用页签里可改）
  'prompt.styleLine': '每轮语感提醒（[Style] 行）',
  'tokenCost.pHit': '缓存命中单价（¥/百万 tok）',
  'tokenCost.pMiss': '未命中输入单价（¥/百万 tok）',
  'tokenCost.pOut': '输出单价（¥/百万 tok）',
  'tokenCost.peakMult': '高峰时段倍率',
  'tokenCost.peakHours': '高峰小时（北京时）',
};

/** 开关下方的一行小字提示（按完整路径或字段名精确命中） */
const TIP: Record<string, string> = {
  'social.enabled': '关闭后不回复任何消息',
  'social.sticker.enabled': '关闭后仅使用文字回复',
  'social.sticker.collect.enabled': '遇到贴合语境的图自动存入收藏',
  'social.autoFriendApproval': '有人申请好友时直接通过，无需人工确认',
  'social.autoFriendGuard': '敏感操作仅对名单内或可信账号开放',
  'social.deepsleep': '群聊完全静默，私聊照常',
  'social.provideRecommendations': '一并把推荐参数交给模型',
  'social.deepsleepGroups': '每行一个群号，仅静默所列群',
  'social.steerEnabled': '思考期间收到的新消息直接并入本轮',
  'social.turnHold.enabled': '一次唤醒内保留回合，连续补充无需重新唤醒',
  'social.turnHold.privateOnly': '群聊默认不保持；确有需要时关闭此开关并写明群号',
  'social.turnHold.requestBudgetMs': '须小于 DSH 插件侧的单次请求超时',
  'prompt.styleLine': '留空即不注入该行',
  'tokenCost.peakHours': '每行一个小时，或写成 [9,10,11,14,15,16,17]',
};

function pretty(label: string) {
  // 兜底一律是中文占位，绝不回落成原始英文键名（审计脚本 tools/audit-ui-labels.mjs 会盯着这张表）
  return LABEL[label] || UNNAMED_LABEL;
}
function prettyTool(k: string) {
  return TOOL_LABEL[k] || LABEL[k] || mcpLabel(k);
}

function get(o: any, p: string) { return p ? p.split('.').reduce((x, k) => (x ? x[k] : undefined), o) : o; }
function setIn(o: any, p: string, v: any) { const ks = p.split('.'); const last = ks.pop()!; let c = o; for (const k of ks) { if (!c[k] || typeof c[k] !== 'object') c[k] = {}; c = c[k]; } c[last] = v; }
function setVal(current: any, path: string, value: any) { const n = JSON.parse(JSON.stringify(current ?? {})); setIn(n, path, value); return n; }

const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);

/** 把后端说明文字里的 粗体 与 `行内代码` 渲染成界面元素（与新手文档同一观感，
 *  免得把 `/root/qq-bridge/config.json` 这种路径当普通文字混在句子里）。 */
function RichText({ text }: { text: string }) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('') && p.endsWith('') && p.length > 4) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}
const isArr = (v: any) => Array.isArray(v);

/* 2026-09-23 反馈：切页面先闪一下"出厂默认值"。原先这份骨架照 load() 的补齐口径填了具体数值
 *  （0.16 / 0.02 / 8192 / 永久会话 等），配置还没回来就先画出一整套"看起来像真的"的值 ——
 *  与桥上实际保存的配置不一致，属于假数据。现在骨架一律留空：
 *    · 字符串 → 空串（输入框空白，靠 placeholder 说明）；
 *    · 数字   → NaN（NumInput 对 NaN 显示为空，且仍是 typeof number，字段照常画得出来）；
 *    · 布尔   → false（不受控地默认勾选会造成"已开启"的假象；2026-09-24 起不再靠整块置灰兜底，
 *               读不到配置时开关可点，但保存会被 save() 拒绝：不会把空骨架写回桥上）；
 *    · 空对象 → 不臆造子项（如 social.autoReset 为空时「轮换」一节暂不出现，而不是假装勾了"永久会话"）。
 *  真正的缺键补齐仍由 load() 负责，规则一字未改。 */
const EMPTY_CFG: any = {
  dsh: { baseUrl: '', provider: '', apiKey: '', model: '', visionModel: '', visionBaseUrl: '', visionApiKey: '', reasoningEffort: '' },
  dshCompaction: { enabled: false, thresholdRatio: NaN, retainRatio: NaN, toolResultMaxChars: NaN, summarizationProvider: '', summarizationModel: '' },
  prompt: { styleLine: '' },
  tokenCost: { pHit: NaN, pMiss: NaN, pOut: NaN, peakMult: NaN, peakHours: [] },
  social: { tools: {}, autoReset: {}, sticker: {} },
  allow: { private: [], groups: [] },
  deny: { private: [], groups: [] },
};

export default function BridgeConfig({ onBack, onRefresh, onOpenLearning, onOpenPortrait, onOpenChat, onOpenVoice, remote }: Props) {
  const [tab, setTab] = useState<'common' | 'tools' | 'persona' | 'json' | 'profiles'>('common');
  /* 2026-09-14 修改要求：SSH 模式下这一页读写的是服务端 /root/qq-bridge/config.json：
   *  · target 记录本页当前编辑的是哪一套（local / remote）—— 横幅必须一眼看见，别让人以为在改本机；
   *  · remoteMeta 存服务端路径/说明/写入校验结果，供横幅与保存提示使用。 */
  const [target, setTarget] = useState<'local' | 'remote'>('local');
  const [remoteMeta, setRemoteMeta] = useState<{ dir?: string; path?: string; notes?: string[]; message?: string }>({});
  /* 2026-09-23：cfg 的初值先取模块级缓存（上次成功读到的那份，按 local / remote 分开存）：
   *  切走再切回来时，页面上直接是上次读到的真实配置，不会再出现"先闪一下默认值"。
   *  缓存取不到时保持 null —— 此时各页签渲染空骨架且整块表单禁用，绝不拿默认值冒充桥上配置。 */
  const [cfg, setCfg] = useState<any>(() => getCachedConfig<any>(remote ? bridgeRemoteKey(remote.id) : CFG_BRIDGE_LOCAL));
  /* 渲染用的配置视图：配置未回来时先渲染空白骨架，回来后即为真实配置。 */
  const view = cfg ?? EMPTY_CFG;
/** 配置是否已读到（缓存命中或本轮读取成功）。未读到时：表单禁用、保存按钮禁用。 */
  const cfgReady = cfg !== null;
/** 2026-09-19 修「读失败时整页空白」以前 load() 没有 try/catch：读配置抛错（config.json 损坏、
   *  服务端没连上、接口 500）时 cfg 一直是 null，而每个页签都是 `cfg && <Tab/>` 写法 ——
   *  于是页面只剩页签栏，一个字都不说，看起来像"配置页坏了"。现在错误有地方落：一条可重试的提示。
   *  注意这跟"桥有没有在跑"无关：这份配置读的是磁盘上的 qq-bridge/config.json。 */
  const [loadErr, setLoadErr] = useState('');
  /* 2026-09-30 修改要求：读取失败时不再给「重试」按钮，改为自动退避重读：
   * 失败 → 5 → 10 → 20 → 40 → 60 秒（封顶 60 秒），读到即清零。
   * 这里只存"下一次隔多久自动重读"，0 表示已读到、不需要重读。 */
  const [autoRetryMs, setAutoRetryMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [persona, setPersona] = useState('');
  const [speechRules, setSpeechRules] = useState('');
  const [personaHasFile, setPersonaHasFile] = useState(false);
  const [speechHasFile, setSpeechHasFile] = useState(false);
/** 隔离 DSH 里「语言模型密钥」到底配没配（后端只回 {env, from, set, len}，不含密钥本身） */
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  // 「指令速查」：弹窗（与说明文档同款弹窗/小节样式）
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

/** 本页配置的缓存键：本机与服务端各存一份，互不顶替（拿本机配置冒充服务端只会更糟）。 */
  const cfgCacheKey = remote ? bridgeRemoteKey(remote.id) : CFG_BRIDGE_LOCAL;
/** 目标（本机 / 某台服务端）在挂载期间发生变化时，改用该目标自己的缓存重新起底：
   *  有缓存即显示缓存，无缓存则回到空骨架（宁可为空，也不显示另一套配置）。 */
  const cfgCacheKeyRef = useRef(cfgCacheKey);
  useEffect(() => {
    if (cfgCacheKeyRef.current === cfgCacheKey) return;
    cfgCacheKeyRef.current = cfgCacheKey;
    setCfg(getCachedConfig<any>(cfgCacheKey));
    setLoadErr('');
  }, [cfgCacheKey]);

/** load() 的序号：晚到的旧响应不许覆盖新响应（详见下面 refresh 的注释） */
  const loadSeq = useRef(0);

  /** /
   * 读配置。
   * @param opts.forceRefresh 服务端模式下绕过后端 45 秒预热缓存（保存之后必须用）
   *
   * 2026-09-19 修"点保存、切出去回来又变回去，第二次点保存才真的生效"
   * 后端对服务端配置有一份预热缓存；POST 写入后只 delete 缓存、不做代次校验，于是
   * "写入之前发出的那次预热"可能在写入之后把旧内容塞回缓存 —— 紧接着的这次重载就读到旧值。
   * 现在两头都堵：保存后的重载带 refresh=1（后端也改成 refresh=1 时不复用正在飞的预热），
   * 且这里给 load 加了序号保护，避免旧请求后到把新值覆盖回去。
   */
  const load = async (opts: { forceRefresh?: boolean } = {}) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    /* 2026-09-30：开头不再清 loadErr：自动退避重读时若每轮先清空，失败提示会一闪一闪，
     * 而且看不出"上一次是因为什么读不到"。改为成功时才清（见下面的 setLoadErr('')）。 */
    try {
      // 连上服务器 → 读服务端 /root/qq-bridge/config.json（经已有 SSH 连接，不新建连接）
      const r: any = remote
        ? await getRemoteBridgeConfig(remote.id, { refresh: opts.forceRefresh === true })
        : await getBridgeConfig();
      if (seq !== loadSeq.current) return;   // 已经有更新的读取在路上了，丢弃这份旧结果
      const c = r.config || {};
      if (remote) {
        setTarget('remote');
        setRemoteMeta({ dir: r.dir, path: r.path, notes: r.notes, message: r.ok ? '' : (r.message || '读取服务端配置失败') });
        if (!r.ok) {
          setMsg('读取服务端配置失败：' + (r.message || '未知原因'));
          // 2026-09-30：服务端读失败同样自动退避重读（页面上不再有「重试」按钮）。
          setAutoRetryMs((ms) => (ms === 0 ? 5000 : Math.min(ms * 2, 60000)));
        }
      } else {
        setTarget('local');
        setRemoteMeta({});
      }
      // 保证模型区“识图模型 / API Key”输入框总是可见（留空即默认）
      if (!c.dsh) c.dsh = {};
      if (c.dsh.apiKey === undefined) c.dsh.apiKey = '';
      if (c.dsh.visionModel === undefined) c.dsh.visionModel = '';
      if (c.dsh.visionBaseUrl === undefined) c.dsh.visionBaseUrl = '';
      if (c.dsh.visionApiKey === undefined) c.dsh.visionApiKey = '';
      if (!c.dsh.model) c.dsh.model = '';
      if (!c.dsh.provider) c.dsh.provider = '';
      /* 上下文治理：老配置里没有这一段，也要把输入框画出来（缺键时按默认值显示，保存即落盘）。
       * 服务端模式同理 —— 远程 config.json 里没有这些键时不补，卡片就是空的。 */
      if (!c.dshCompaction || typeof c.dshCompaction !== 'object') c.dshCompaction = {};
      const dc = c.dshCompaction;
      if (dc.enabled === undefined) dc.enabled = true;
      /* 2026-09-21 修：这里原来回填 0.12/0.03，而桥侧默认（qq-bridge/src/core/config.js）是 0.08/0.02 ——
       * 老配置打开这张卡再点保存，就等于把"上下文治理"悄悄放宽回 0.12：上下文长期停在 ~11.7 万 token，
       * 实测"一句话 1 分钱"。回填值必须与服务端默认逐字一致，否则界面本身就是个改错值的陷阱。 */
      if (dc.thresholdRatio === undefined) dc.thresholdRatio = 0.16;   // 2026-09-22：与桥缺省对齐（原来回填 0.08，一保存就把实测最省值改回更贵的旧值）
      if (dc.retainRatio === undefined) dc.retainRatio = 0.02;
      if (dc.toolResultMaxChars === undefined) dc.toolResultMaxChars = 8192;
      if (dc.summarizationProvider === undefined) dc.summarizationProvider = '';
      if (dc.summarizationModel === undefined) dc.summarizationModel = '';
      /* 2026-09-21：提示词可调项：`prompt.styleLine` 是唤醒正文每轮那句语感提醒，
       * 缺键时要把输入框画出来（否则老配置打开这张卡是空的）。 */
      if (!c.prompt || typeof c.prompt !== 'object') c.prompt = {};
      if (c.prompt.styleLine === undefined) c.prompt.styleLine = '[Style] 说人话：短、有态度，别讲课别列举';
      /* 2026-09-21：/token 计价参数（¥ / 百万 tok），默认值与管理端「学习」页实测区同源。 */
      if (!c.tokenCost || typeof c.tokenCost !== 'object') c.tokenCost = {};
      const tc = c.tokenCost;
      if (tc.pHit === undefined) tc.pHit = 0.02;
      if (tc.pMiss === undefined) tc.pMiss = 1;
      if (tc.pOut === undefined) tc.pOut = 4;
      if (tc.peakMult === undefined) tc.peakMult = 2;
      if (tc.peakHours === undefined) tc.peakHours = [9, 10, 11, 14, 15, 16, 17];
      if (!c.social) c.social = {};
      if (!c.social.autoReset || typeof c.social.autoReset !== 'object') c.social.autoReset = {};
      if (c.social.autoReset.permanent === undefined) c.social.autoReset.permanent = true;   // 2026-09-22：与桥缺省对齐（实测最省 = 永久会话）
      // 「语言模型密钥」：的真实状态（在隔离 DSH 的凭据文件里，不在 config.json 里）
      setApiKeyStatus((r as any).apiKeyStatus || null);
      // 出厂 ownerQQ=null（未设置/无 owner）→ 显示为空串，便于输入真实 QQ
      if (c.ownerQQ === null || c.ownerQQ === undefined) c.ownerQQ = '';
      // DSH 里实际生效的模型段（推理档位下拉用它识别"已经是 off/xhigh/max"这类档位）
      DSH_EFFECTIVE = (r as any).dshEffective && typeof (r as any).dshEffective === 'object' ? (r as any).dshEffective : {};
      // 每个服务商的模型清单（切服务商时模型列表跟着换）
      const dm = (r as any).dshModels;
      DSH_MODELS = dm && typeof dm === 'object' && dm.providers && typeof dm.providers === 'object' ? dm : { providers: {} };
      setCfg(c);
      setLoadErr('');            // 读到了才清错误提示（见 load 开头那条注释）
      setAutoRetryMs(0);         // 读到了就停止自动退避重读
      /* 读到即入缓存（按 local / remote 分开存）：切走再切回这一页时，先显示这份配置再后台刷新，
       * 不会再出现"先按默认值渲染、再跳成真实值"的闪动。 */
      rememberConfig(remote ? bridgeRemoteKey(remote.id) : CFG_BRIDGE_LOCAL, c);
      setPersona(r.persona || '');
      setSpeechRules(r.speechRules || '');
      setPersonaHasFile(!!r.personaHasFile);
      setSpeechHasFile(!!r.speechHasFile);
    } catch (e: any) {
      // 2026-09-19：读失败必须说出来。以前这里会直接抛出 promise 未处理，cfg 一直是 null，
      // 每个页签又都是 `cfg && <Tab/>`，于是页面变成"只有页签栏"的空壳 —— 连"读失败了"都不显示。
      setLoadErr(String(e?.message ?? e));
      // 2026-09-30：失败后自动退避重读，不再要求人点「重试」。
      setAutoRetryMs((ms) => (ms === 0 ? 5000 : Math.min(ms * 2, 60000)));
    } finally {
      setLoading(false);
    }
  };

  /* 2026-09-30 修改要求：读取失败一律自动退避重读：5 → 10 → 20 → 40 → 60 秒（封顶 60 秒），
   * 读到即由 load() 把 autoRetryMs 清零。页面上不再出现任何「重试」按钮，只保留一行如实说明。 */
  useEffect(() => {
    if (autoRetryMs <= 0) return;
    const t = setTimeout(() => { void load(); }, autoRetryMs);
    return () => clearTimeout(t);
  }, [autoRetryMs, loading]);

/** 保存通路：local → 本机 /api/bridge/config（原行为不变）；remote → /api/ssh/bridge-config（服务端）。 */
/**  服务端那条会「临时文件 → 备份 config.json.bak-<时间戳> → mv 原子替换 → 回读比对关键字段」， */
/**  返回值里的 verified / mismatched 会原样展示，失败绝不谎报"已保存"。 */
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
    /* 配置尚未读取完成时禁止写盘：否则会把界面上的占位骨架当成整份配置写回。 */
    if (!cfg) { setMsg('配置尚未读取完成，请稍候再保存'); return; }
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
      // 同步结果如实显示出来 —— 以前无论同步成功与否都只说"已保存"，用户以为改的模型生效了，
      // 实际 DSH 还在用旧模型（"管理端改的模型配置无法默认到 DSH 里"的直接成因之一）。
      // 服务端模式：写的是服务器上的 config.json（桥按 mtime 热加载），返回里带回读比对结果。
      const r = await writeBridge(body);
      // 「语言模型密钥」：的落地结果要单独说清楚：它不在 config.json 里，而是写进隔离 DSH 的凭据文件
      const keyNote = (() => {
        const w = r?.apiKeyWrite;
        if (w && w.ok === false) return ` · 语言模型密钥未写入：${w.error || '未知原因'}`;
        if (w && w.ok && w.action === 'set') return ` · 语言模型密钥已写入隔离 DSH 凭据（${w.env}）`;
        if (w && w.ok && w.action === 'removed') return ` · 语言模型密钥已从隔离 DSH 凭据中清除（${w.env}）`;
        const st = (r?.steps ?? []).find((x: any) => /DSH 凭据/.test(x.step || ''));
        if (st) return st.ok ? ` · ${st.msg}` : ` · 语言模型密钥未写入：${st.msg}`;
        return '';
      })();
      if (target === 'remote') {
        setMsg(remoteResultText(r) + keyNote);
      } else if (r?.dshChanged) {
        setMsg((r.modelSynced
          ? '已保存 · 模型配置已同步到隔离 DSH，约 15 秒后生效'
          : '已保存，但模型配置未写入 DSH：' + (r.modelSyncMessage || '未知原因')) + keyNote);
      } else setMsg('已保存' + keyNote);
      onRefresh();
      // 2026-09-19：保存后的这次重载必须绕过服务端预热缓存，否则会把"写之前的旧值"读回来 ——
      // 看到的现象就是"点了保存、切出去再回来又变回去了，得再点一次保存才真的生效"。
      await load({ forceRefresh: target === 'remote' });
    } catch (e: any) { setMsg('保存失败：' + (e?.message || '')); }
    finally { setSaving(false); }
  };

/** 清除隔离 DSH 凭据文件里的那条密钥（界面上的输入框是密码框，看不出"到底配没配"， */
/**  所以给一个显式清除入口；后端只删这一行，文件里 DSH 自己写的其它块原样保留）。 */
  const clearApiKey = async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await writeBridge({ config: { dsh: { clearApiKey: true, provider: cfg?.dsh?.provider || '' } } });
      const w = r?.apiKeyWrite;
      const st = (r?.steps ?? []).find((x: any) => /DSH 凭据/.test(x.step || ''));
      if ((w && w.ok) || (st && st.ok)) {
        setCfg((c: any) => (c ? { ...c, dsh: { ...(c.dsh || {}), apiKey: '' } } : c));
        setMsg(`已清除隔离 DSH 凭据里的语言模型密钥（${w?.env || st?.msg || ''}）`);
      } else setMsg('清除失败：' + (w?.error || st?.msg || r?.message || '未知原因'));
      await load({ forceRefresh: target === 'remote' });
    } catch (e: any) { setMsg('清除失败：' + (e?.message || '')); }
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

/** 恢复默认发言规则（写内置英文模板）。服务端模式下写的是服务端的 speech-rules.md。 */
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
            <div className="page-title" title="MoonBot — 本地与服务端的拟人 QQ Bot 集成配置工具">MoonBot · 功能配置</div>
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
          <button className="btn btn-soft btn-tip" title="支持本项目：扫码请作者喝杯奶茶" onClick={() => setTipOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d' }}>
            <Coffee size={14} /> 请作者喝奶茶
          </button>
          <button className="btn btn-soft" onClick={onOpenPortrait} title="群友画像 / 主人画像 · 直读本机桥记忆库">
            <Users size={14} /> 群友画像
          </button>
          <button className="btn btn-soft" onClick={onOpenChat} title="聊天记录：查看与管理各群聊/私聊的历史消息">
            <MessageSquare size={14} /> 聊天
          </button>
          <button className="btn btn-soft" onClick={onOpenVoice} title="语音：合成音色、音色设计/复刻、语音识别（MiMo 语音模型）">
            <Mic size={14} /> 语音
          </button>
          <button className="btn btn-soft-primary" onClick={onOpenLearning} title="黑话 / 人格学习与 Token 用量统计">
            <Activity size={14} /> 学习与用量
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}
            title={!cfgReady ? '配置还没读到，点保存会提示稍候；不会用界面上的默认值覆盖桥上的配置' : undefined}>
            {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
          </button>
        </div>
      </div>

      <div className="page-body">
        <NoticeBar msg={msg} onClose={() => setMsg(null)} />

        {/* 2026-09-23 修改要求：界面保持干净 —— 原来这里有一整块 <details>「保存规则总览」，
            内容与「写入说明文档 · 每一项功能与配置」里新增的《保存规则总览》一节完全重复，
            页面上等于同一段话出现两遍。现在只在说明文档里留一份（说明书是它的归属地），
            页面顶部不再堆折叠条。原文可在 git 历史里找回。 */}

        {/* 2026-09-14 修改要求：明显的横幅标明"当前编辑的是服务端配置"：
            没有这条横幅，用户很容易以为在改本机（两套实例并存时这正是最容易踩的坑）。 */}
        {/* 2026-09-14 修改要求：横幅配色跟新手文档一致（不再自己写死蓝色），
            里面的路径/命令一律按行内代码渲染：说明文字干净、技术名词一眼可辨。 */}
        {target === 'remote' && remote && (
          <div className="notice-bar server-config-banner" style={{ borderColor: 'var(--nc-primary-400)', display: 'block' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
              <Server size={15} /> 服务端模式 · 正在修改服务器上的桥配置
              <span className="badge badge-info">服务端</span>
            </div>
            {/* 2026-09-19 修改要求：这里只说明"改的是服务器上那份配置"；原子写/备份/热加载这些原理不再堆在页面上。 */}
            <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
              {remote.name}（{remote.host}）· 保存后立即生效，不用重启桥。
            </div>
          </div>
        )}
        {target === 'remote' && remoteMeta.message && (
          <div className="notice-bar" style={{ borderColor: '#e5484d', background: '#fef2f2', color: '#912018' }}>
            <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> {remoteMeta.message}
            {autoRetryMs > 0
              ? <span style={{ marginLeft: 10 }}>{`（正在自动重试：约每 ${Math.max(1, Math.round(autoRetryMs / 1000))} 秒重读一次）`}</span>
              : null}
          </div>
        )}
        {target === 'local' && remote && !loading && (
          <div className="notice-bar" style={{ fontSize: 12 }}>
            已连上服务器 <b>{remote.name}</b>，但本页仍在读写<b>本机</b>的 qq-bridge 配置（服务端配置读取失败时会这样回退，避免误写）。
          </div>
        )}
        {/* 2026-09-24 主人要求（原话）："不要有正在核实的状态机和不能点的卡片状态机，
            就是我们刚启动应用的时候"。原实现把四个页签整体裹在 <fieldset disabled={!cfgReady}> 里、
            并挂一条"正在核实 …是否有更新／读到之前各字段为空白且不可编辑"的横幅 —— 现在两样都去掉：
              · 卡片、开关、输入框从第一帧起一律可点（有缓存就显示缓存里的真实配置）；
              · 读不到配置时不再预先置灰，改由「保存」自己把关（save() 里 `if (!cfg)` 直接拒绝并说明原因），
                这样"状态还没回来"不会让整页变成点不动的样子。 */}
        {loading && !cfgReady && !loadErr && (
          <div className="notice-bar" style={{ fontSize: 12 }}>
            正在读取{remote ? ` ${remote.name}（${remote.host}）` : '本机'}的桥配置；页面照常可操作，保存会等到读到之后才生效。
          </div>
        )}

        <div className="bridge-body">
        <div className="tabs">
          {(['common', 'tools', 'persona', 'json'] as const).map((t) => (
            <button key={t} className={`btn ${tab === t ? 'btn-primary' : 'btn-soft'}`} onClick={() => setTab(t)}>
              {t === 'common' ? '常用设置' : t === 'tools' ? '工具与规则' : t === 'persona' ? '人设与发言规则' : 'JSON 进阶'}
            </button>
          ))}
          {/* 2026-09-12 修改要求：JSON 进阶旁边加一个「方案」页签：浅蓝，与 Token 用量面板同一支色 */}
          <button className={`btn ${tab === 'profiles' ? 'btn-tb-primary' : 'btn-tb-soft'}`} onClick={() => setTab('profiles')}
            title="把当前配置存为命名方案，或在已存方案间套用与回退">
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

        {/* 配置读自磁盘上的 qq-bridge/config.json（本机或服务端），不经过桥进程：
            桥未运行时同样可读可改。读取失败只提示原因，不使页面整体失效。 */}
        {/* 读取中不拦操作：状态只由上面那一条（还没读到配置时）说，其余情况静默重读。 */}
        {loadErr && (
          <div className="card">
            <div className="lrn-error">
              <AlertTriangle size={15} />
              <div style={{ flex: 1 }}>
                读取配置失败：{loadErr}
                <div className="lrn-error-detail">
                  本卡读取的是 {remote ? '服务端 /root/qq-bridge/config.json' : '本机 qq-bridge/config.json'} 文件本身，
                  <b>不需要桥在运行</b>；读不到通常是文件损坏、目录不符{remote ? '，或 SSH 未连通' : ''}。
                  {autoRetryMs > 0
                    ? ` 本页会自动重读：约每 ${Math.max(1, Math.round(autoRetryMs / 1000))} 秒一次（失败后按 5／10／20／40／60 秒退避，最长 60 秒一次），无需手动刷新。`
                    : ''}
                </div>
              </div>
              {loading && <Loader2 size={14} className="spin" />}
            </div>
          </div>
        )}
        {/* 2026-09-23 曾在配置未读到时把四个页签裹进 <fieldset disabled> 里整体置灰；
            2026-09-24 按主人要求去掉（"不能点的卡片状态机"）：配置没读到时页面照常可点可编辑，
            真正的把关放在 save() —— `if (!cfg)` 时不写盘，只提示"配置尚未读取完成"。 */}
        {tab === 'common' && <CommonTab cfg={view} ch={ch} onHelp={setHelp} uploadStickers={uploadStickers} remote={remote} writeConfig={(next) => writeBridge({ config: next })} onCfgChange={setCfg}
          apiKeyStatus={apiKeyStatus} onClearApiKey={clearApiKey} saving={saving} target={target} />}
        {tab === 'tools' && <ToolsTab cfg={view} ch={ch} onSave={save} target={target} remoteServerId={remote?.id} />}

        {tab === 'persona' && (
          <div className="dp-grid">
            {/* 人设卡：persona.md */}
            <div className="card dp-card">
              <div className="card-title">
                <FileText size={17} /> 人设 · persona.md
                <span className={`badge ${personaHasFile ? 'badge-success' : 'badge-soft'}`}>
                  {personaHasFile ? '文件已存在' : '尚未写入'}
                </span>
              </div>
              <div className="cfg-card-desc">
                角色描述与人设提示词，<b>原样注入给模型，中英文均注入</b>。用法：初始为空，可上传 .md/.txt，或点「角色库导入」载入完整角色，再点「保存人设」写入 persona.md。
                人设为空即默认助手（框内的 <i>You're a helpful assistant.</i> 只是灰色占位提示，不会写入文件，也不注入模型）。
                它与内置规则分属<b>两层</b>：内置规则（安全边界、工具用法、唤醒协议、发言纪律）始终生效，人设决定「你是谁、何种性情、如何与主人相处」；<b>人设文件中自定义的规矩同样生效</b>。
                注意：保存后下一条消息即采用新人设（桥检测文件变更并重新注入完整提示词），无需重启任何进程。
              </div>
              <textarea className="textarea persona-text" rows={18}
                placeholder="You're a helpful assistant."
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
                {/* 2026-09-20：表情包卡在「常用设置」页（挨着上面那张「表情包」卡）；这里给个入口，
                    省得用户记得"它到底在哪一页"——点它切页并滚到那张卡。 */}
                <button className="btn btn-soft btn-sm" title="表情包库：导入包 / 给角色绑包（位于「常用设置」页）"
                  onClick={() => { setTab('common'); setTimeout(() => document.getElementById('meme-packs-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); }}>
                  <Layers size={14} /> 表情包库
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
                消息发送的言行规矩（投入角色 / 发送与引用协议 / 分段节奏 / 表情包用法 / 去 AI 味 / 看场合）。文件为英文短句模板，可直接编辑覆盖，也可点「恢复默认」写回内置模板。
                与 persona.md 同目录，每次唤醒注入提示词顶部；文件变更后无需重启。
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
            {cfg ? (
              <textarea id="bridge-json" className="textarea json-text" rows={30} spellCheck={false}
                defaultValue={JSON.stringify(cfg, null, 2)} />
            ) : (
              <div className="lrn-inline-note">配置读取完成后，此处显示 config.json 全文。</div>
            )}
          </div>
        )}

        {tab === 'profiles' && (
          <div className="card profile-panel">
            <div className="card-title" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Layers size={17} /> 配置方案</span>
              <span style={{ fontSize: 11.5, fontWeight: 400 }}>把当前整套参数存为命名方案，可随时套用或回退</span>
            </div>
            <div className="profile-note">
              方案保存的是<b>完整的 config.json</b>（模型与推理、唤醒与节奏、名单、主动闲聊等全部参数）。
              套用方案即把该份配置整份写回桥，通路与「保存」完全相同（模型段变化会自动同步隔离 DSH 并重启，约 15 秒生效）。
              <b>参数完全相同的配置不会重复新增</b>，保存时自动识别并复用已有方案。方案存于管理端（<code>~/.qq-bridge-manager/profiles.json</code>），更换浏览器或清除缓存均不丢失。
            </div>

            <div className="profile-new">
              <input className="input" placeholder="为方案命名，例如「省钱档」「质量档」「群聊专用」"
                value={profName} maxLength={40}
                onChange={(e) => setProfName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createProfile(); }} />
              {/* 【图标被同色底淹没的成因与修法】本面板的 `.profile-panel *`（src/styles/app.css:963）
                  把每一个后代元素的文字色统一写成湛蓝；lucide 图标以 currentColor 作描边，
                  于是 SVG 自身取到的也是湛蓝，压在同为湛蓝的 `.btn-primary`（app.css:967）上即完全看不见。
                  通配选择器直接命中 svg 元素，父按钮的白色对它不构成继承，故在 svg 上以内联样式写
                  `color: inherit`（内联样式优先级高于该通配规则），令图标一律跟随按钮文字色，
                  按钮配色日后调整亦无需再改此处。 */}
              <button className="btn btn-primary" disabled={profBusy || !cfg} onClick={createProfile}>
                {profBusy
                  ? <Loader2 size={14} className="spin" style={{ color: 'inherit' }} />
                  : <Save size={14} style={{ color: 'inherit' }} />} 存为新方案
              </button>
              <button className="btn" disabled={profBusy} onClick={loadProfiles}>
                {profBusy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} 刷新
              </button>
            </div>

            {profMsg && (
              <div className="profile-note" style={{ marginTop: 10, background: profMsgKind === 'ok' ? 'hsl(199 100% 95% / .95)' : 'hsl(199 100% 92% / .95)' }}>{profMsg}</div>
            )}

            {profiles.length === 0 ? (
              <div className="profile-empty">尚未保存过方案。调整好配置后，在上方填入名称并点「存为新方案」即可。</div>
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
                        <Check size={13} style={{ color: 'inherit' }} /> 套用
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
            <div style={{ fontSize: 18, fontWeight: 700, color: '#78350f', marginBottom: 6 }}>请作者喝杯奶茶</div>
            <div style={{ fontSize: 13, color: '#92640a', marginBottom: 16, lineHeight: 1.6 }}>若本项目对你有帮助，可扫码支持作者，感谢。</div>
            <img src="/wechat-pay.png" alt="微信收款码" style={{ width: 260, height: 260, objectFit: 'contain', background: '#fff', borderRadius: 12, border: '1px solid #fde68a', padding: 8 }} />
            <div style={{ fontSize: 12, color: '#b45309', marginTop: 14 }}>微信扫码 · 感谢支持</div>
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
              <DocSection title="使用方式">
                <ul>
                  <li>在 QQ 群聊或私聊中单独发送指令；指令以 <code>/</code> 开头，参数以空格分隔，机器人执行后回一句话确认。</li>
                  <li><b>管理类指令仅对主人与管理员生效</b>（主人 = 配置中的「主人 QQ」；管理员 = 主人用 <code>/op</code> 添加者）。其他人发送将收到「管理命令仅管理员可用」。</li>
                  <li>群聊与私聊均可发送：只要发送者是主人或管理员，在群内发送同样生效。</li>
                </ul>
              </DocSection>

              <DocSection title="会话管理">
                <ul>
                  <li><code>/reset</code> 或 <code>/new</code>：清空当前会话的 DSH 上下文，下一条消息开启新会话；长期记忆、档案与聊天库均保留，同时取消该会话尚未发出的待发任务。</li>
                  <li><code>/status</code>：返回当前会话编号、白名单是否通过、角色与模式。</li>
                  {/* /help（发《小鲸鱼能力概览》docx）已整条删除，这里不再列出 */}
                </ul>
              </DocSection>

              <DocSection title="唤醒与静默">
                <ul>
                  <li><code>/sleep</code>：无限期暂停，不调 DSH、不回复；消息仍然入库但不唤醒。用 <code>/wake</code> 恢复。</li>
                  <li><code>/wake</code>：恢复（<code>/sleep</code> 的反命令），并清除定时休息留下的定时器。</li>
                  <li><code>/deepsleep</code>：<b>所有群</b>的总开关；群内消息只入库，不读、不唤醒、不回复、不收集（省 token）。<b>私聊不受影响</b>。</li>
                  <li><code>/start</code>：解除 <code>/deepsleep</code>，群聊恢复正常。该指令<b>由桥直接执行、不经过模型，静默期间始终可用</b>。</li>
                  <li><code>/silent</code> 或 <code>/quiet</code>：<b>当前会话</b>静默；群友消息只记录、不投递给模型（被 @ 亦不回复）。</li>
                  <li><code>/active</code> 或 <code>/speak</code>：恢复当前会话的正常回应。</li>
                </ul>
              </DocSection>

              <DocSection title="模式与作息">
                <ul>
                  <li><code>/set active</code>：本会话转为全天活跃，同时清除该会话的活跃时段限制。</li>
                  <li><code>/set active 09:00-01:00</code>：仅在<b>指定时段</b>活跃，其余时间潜水（只回 @ 与点名）；跨午夜照此写法即可。</li>
                  <li><code>/set diving</code>：本会话全天潜水，平时不打扰群，被 @、被点名或有人提问时回应。</li>
                  <li><code>/set diving 00:00-21:00</code>：<b>指定时段</b>潜水（只回 @ 与点名），其余时间照常活跃。</li>
                  <li><code>/set sleep 01:00-06:00</code>：设置每日作息窗口（北京时间）。窗口内群聊只回 @，其余不读以省 token；私聊不受限。</li>
                  <li><code>/set sleep 30m</code> 或 <code>/set sleep 2h</code>：定时休息 30 分钟或 2 小时，到点自动恢复。</li>
                  <li><code>/set wake</code> 或 <code>/set cancel</code>：取消全部睡眠状态（含作息窗口与定时休息）。</li>
                  <li>斜杠命令<b>一律使用英文</b>；中文表述（如「转活跃」「这个点别理群」）直接陈述即可，模型会自行调用相应工具。</li>
                </ul>
              </DocSection>

              <DocSection title="角色与权限">
                <ul>
                  <li><code>/role 角色名</code>：切换到 <code>qq-bridge/roles/角色名.md</code> 中定义的角色。</li>
                  <li><code>/role off</code> 或 <code>/role clear</code>：清除角色，恢复正常人格。</li>
                  <li><code>/op QQ号或昵称</code>：将某人设为管理员（仅主人可用；昵称会到通讯录中查找）。</li>
                  <li><code>/op del QQ号或昵称</code>：取消某人的管理员身份。</li>
                </ul>
              </DocSection>

              <DocSection title="黑话学习">
                <ul>
                  <li><code>/slang learn</code>：立即执行一次黑话学习。</li>
                  <li><code>/slang stop</code>：停止正在运行的黑话学习或研究任务。</li>
                  <li><code>/slang</code>：查看黑话模块的用法说明。</li>
                </ul>
              </DocSection>

              <DocSection title="群友画像学习">
                <ul>
                  <li><code>/portrait learn</code>：按当前筛选条件立即挑选对象执行一轮画像学习；不带参数时自动从聊天库中选人。</li>
                  <li><code>/portrait stop</code>：停止正在运行的画像学习（已在进行的目标不会留下半成品）。</li>
                  <li><code>/portrait status</code>：返回是否启用、自动触发方式、筛选条件与最近一轮学习的对象。</li>
                  <li>仅主人与管理员可发送；其他人发送将收到「画像学习只有主人能指挥」。</li>
                </ul>
              </DocSection>

              <DocSection title="用量与统计">
                <ul>
                  <li><code>/token</code>：报告当天 token 用量与费用。<b>由桥直接计算、不经过模型</b>，随时可用且不消耗额度。</li>
                  <li><code>/token 7</code>：报告最近 7 天合计（<code>1</code>~<code>60</code> 天，不带参数即为当天）。</li>
                  <li>返回内容分两个口径，均逐行标注出处，与「学习」页的实测区一致：<b>今日总量</b>取<b>平台计费日</b>（北京时 08:00 换日，与提供方控制台一致）；<b>命中 / 未命中 / 输出</b>与<b>金额</b>取<b>北京自然日</b> 00:00 起的分时实测（含 00:00–08:00 段，平台将其计入前一日，故单独列一行说明）。</li>
                  <li>单价在「常用设置 → 计价口径」中修改（命中、未命中、输出三个单价与高峰倍率），修改后 <code>/token</code> 与面板同时更新。</li>
                  <li>「按今天的节奏，全天大概 N tok」为按时段习惯曲线外推的预估，仅供参考，不计入费用。</li>
                </ul>
              </DocSection>

              <DocSection title="互动与其它">
                <ul>
                  <li><code>/like QQ号 [次数]</code>：为对方点赞，次数默认 1、最多 10。</li>
                  <li>其他任何 <code>/xxx</code>（例如 <code>/model</code>）：原样交给 DSH 执行，桥不拦截。</li>
                  <li>日常管理亦可不用斜杠，直接陈述需求（例如「转活跃」「别理这个群了」「把某人拉黑」），模型会自行判断并调用相应工具。</li>
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
                  <li><b>常用设置</b>：最常用的可视化配置，按功能分卡片（模型与推理、NapCat 连接、允许与拒绝名单、唤醒与潜水、发送节奏、上下文与轮换、主动闲聊、回复停顿、表情包、静默群聊、好友信任等）。</li>
                  <li><b>工具与规则</b>：上卡为桥提供给模型的 QQ 工具开关（发消息、读未读、戳一戳、撤回、表情包等），关闭即不授予该工具，<b>但不省 token</b>；下卡「工具 schema 精简」才真正让工具描述不再随请求发送给模型，改完须重启隔离 DSH。</li>
                  <li><b>人设与发言规则</b>：编辑 persona.md（角色人设，初始为空，可上传 .md 或从「角色库导入」整包载入）与 speech-rules.md（言行规矩，含恢复默认）。<b>人设原样注入给模型</b>（中英文均注入），与内置规则分属两层：内置规则管安全、工具与唤醒协议，人设管「你是谁」；人设文件中自定义的规矩同样生效。</li>
                  <li><b>JSON 进阶</b>：直接编辑 config.json 全文，适合批量修改或引用新字段。</li>
                  <li><b>方案</b>：把当前整套配置存为命名方案，可套用或回退；参数完全相同的配置会自动识别、不重复新增；方案存于管理端，更换浏览器不丢失。</li>
                  <li><b>指令速查</b>（页签右侧按钮）：聊天中可发送的全部 <code>/</code> 指令与解释。</li>
                </ul>
              </DocSection>
              <DocSection title="模型与推理（dsh）">
                <ul>
                  <li><b>DSH 地址</b>：内置隔离 DeepSeek Harness 的地址（默认 http://127.0.0.1:10721），一般不改。</li>
                  <li><b>模型服务商</b>：自动探测（留空 = 用 DSH 端默认）/<code>deepseek-official</code>（DeepSeek 官方，需 DEEPSEEK_API_KEY）/<code>xiaomi-token-plan-cn</code>（小米 MiMo）。默认为官方 DeepSeek。</li>
                  <li><b>主模型 / 识图模型 / API Key</b>：<b>下拉中只列当前服务商真实可用的模型</b>（读取 DSH 自身配置：小米一类 pi-ai 服务商取自 settings.yaml，DeepSeek 官方取自 DSH 内置目录）；<b>切换服务商时列表与主模型一并更换</b>（新模型不在新列表中时自动替换为该服务商默认模型并给出提示）。留空即用 DSH 默认；识图模型留空则跟随主模型；需要清单外的模型可点「自定义…」手输 id。</li>
                  <li><b>推理档位</b>：此处给出各服务商<b>真实的英文档位</b>（off / none / minimal / low / medium / high / xhigh / max，也可点「自定义…」手输）。DSH 中已配置的档位会被识别并回显，旁侧小字显示 <b>DSH 当前生效</b>的值以便核对。保存后自动同步给隔离 DSH 并重启实例生效。</li>
                </ul>
              </DocSection>
              <DocSection title="NapCat 连接（napcat）">
                <ul>
                  <li><b>WebSocket 地址</b>：OneBot WS 服务端，默认 ws://127.0.0.1:3001（由 NapCat 自动配置）。</li>
                  <li><b>HTTP 访问令牌 / WS 访问令牌</b>：分别为 HTTP(3000) 与 WS(3001) 的 token，须与 NapCat WebUI 中的一致，默认 truefriend；两个字段相互独立。</li>
                  <li><b>HTTP 地址 / 启动器路径 / 运行目录</b>：本地一键启动时保持默认即可。</li>
                </ul>
              </DocSection>
              <DocSection title="常用设置中的几个关键项">
                <ul>
                  <li><b>主人 QQ / 管理员</b>：初始为空（无主人模式，白名单空放行全部）；填入后模型据此识别主人与管理员权限。主人 QQ 须为机器人可见的 QQ 号。</li>
                  <li><b>允许 / 拒绝名单</b>：私聊与群的 QQ 列表，每行一个；拒绝名单优先。</li>
                  <li><b>唤醒 · 潜水 / 活跃</b>：机器人平时潜水，被 @、被叫名字、命中关键词、被提问、被戳一戳或按概率触发时醒来；潜水时长与唤醒概率可调。</li>
                  <li><b>主动闲聊</b>：冷场（无人发言超过 idleThresholdMs）后按概率主动找话题或主动私聊；群聊与私聊各设间隔与概率。</li>
                  <li><b>上下文与轮换</b>：三组旋钮，各管一件事——①「首轮带入历史条数 / 轮换后首轮带入条数」决定新会话第一轮贴入多少条聊天记录（后者仅对轮换后的第一轮生效，上限 60，填得比前者小则不生效，默认 24）；②「每会话内存保留条数 / 未读队列上限」只决定桥在内存中保留多少条（超出的历史仍在 SQLite 中，可检索）；③「聊多少轮换新会话 / 提前几轮预建新会话」决定累计多少真实来回后归档轮换到新会话（默认 12，并提前预热下一代以避免首轮卡顿），防止上下文膨胀。注意：第 ① 组与第 ③ 组并非重复项，前者为历史窗口大小，后者为换会话的时机；细节见各字段旁的 ⓘ。</li>
                  <li><b>发送节奏 / 回复停顿</b>：连发条数、条间间隔与回复前停顿，用于贴近真人打字节奏。</li>
                  <li><b>表情包</b>：以 QQ 收藏表情回消息、自动收藏贴合语境的图、导入自定义图库。</li>
                </ul>
              </DocSection>
              <DocSection title="人设与角色导入">
                <ul>
                  <li>persona.md 初始为空，且不预置任何默认角色：可直接用「上传载入」放入 .md/.txt，或点「角色库导入」扫描角色库（默认目录为桥目录 <code>characters</code>（含 <code>_template</code> 模板与角色库说明）或桌面 <code>characters</code>，也可手动输入任意目录），载入后点「保存人设」即生效。</li>
                  <li>speech-rules.md 初始为通用英文模板（行为规矩，不含人设），可「恢复默认」。</li>
                </ul>
              </DocSection>
              <DocSection title="学习系统（黑话 / 人格 / 群友画像）">
                <ul>
                  <li><b>三套学习在「学习」页分开管理</b>，互不干扰：<b>黑话</b>（提取群内网络用语并联网考究）、<b>人格学习</b>（学习指定的 <code>targetQQ</code>，结果落档案）、<b>群友画像</b>（自动挑选活跃群友，落库方式与人格学习完全一致，故「群友画像」页无需改动即可看到）。</li>
                  <li><b>触发方式</b>：面板上的「立即学习」按钮；<code>/slang learn</code>、<code>/portrait learn</code> 一类聊天指令；以及配置中的<b>每日定时</b>（北京时 <code>HH:MM</code>，留空即关闭）与<b>间隔学习</b>（每 N 小时）。初始仅人格学习的间隔触发为开启状态。</li>
                  <li><b>群友画像的筛选条件</b>：近 N 天（默认 30 天 / 720 小时）发言数 ≥ <code>minMessages</code>（默认 10）的非自己、未撤回、含正文消息；按发言数降序取前 <code>maxTargets</code>（默认 20）人。这两个旋钮即成本开关，调高会明显更贵。</li>
                  <li><b>画像学习与人格学习互不污染</b>：画像走 <code>auto:false</code> 路径，不写 <code>persona.lastRunAtMs</code> 水位，故两套学习的间隔各自独立计时。</li>
                  <li><b>失败退避</b>：整批失败时不推进水位并退避 30 分钟；定时触发失败另节流 5 分钟，避免每分钟重试而反复刷新学习会话。</li>
                  <li><b>学习会话的产出方式</b>：模型不把结果作为文本返回，而是调用落库工具（如 <code>qq_learning_submit</code>）直接写库，随后仅返回 <code>OK</code>，既省 token，学习会话中也不再留存大段 JSON。桥侧仍保留「解析文本 JSON」的兜底，模型偶尔不按格式返回也不会丢数据。</li>
                  <li><b>发给模型的任务说明与提醒均为英文指令框架</b>（中文仅保留样本原文与待落库的字段值），更省 token，跨模型更稳定。改写这些文案时须把 <code>SLANG_BRIEF_VERSION</code> / <code>PERSONA_BRIEF_VERSION</code> 加一，桥据此为旧学习会话重新注入说明。</li>
                </ul>
              </DocSection>

              <DocSection title="空闲会话自动归档">
                <ul>
                  <li>桥每 10 分钟巡检一次，把闲置超过 30 分钟（且不在运行回合中）的 DSH 会话归档，避免常驻会话累积、上下文持续膨胀。</li>
                  <li>归档不等于删除：会话文件仍在 <code>qq-bridge/state/</code> 下，需要时可被重新唤醒或重建。</li>
                  <li>界面状态与手动触发位于桥控制台接口 <code>/api/social/session-archive</code>。</li>
                </ul>
              </DocSection>

              <DocSection title="Token 用量面板">
                <ul>
                  <li><b>两种口径须分清</b>：<b>实测</b>区为日志中的精确值，不作任何反推；<b>预算</b>区按手输的缓存命中率估算，两者分开显示。</li>
                  <li><b>用量口径</b>：每次请求 = 未命中输入 + 缓存命中 + 输出，三项相加。不要使用提供方返回的 <code>total_tokens</code>，那是<b>会话累计快照</b>，直接累加会虚高数倍。</li>
                  <li><b>缓存命中率为实测值</b>：仅以带缓存字段的请求计算（命中 ÷ (命中 + 未命中)）；不带缓存字段的请求不参与，也不反推。</li>
                  <li><b>实时刷新</b>：经 SSE 推流，新的用量记录一到即更新；连接失败时自动退回 60 秒轮询。</li>
                </ul>
              </DocSection>

              <DocSection title="图片处理">
                <ul>
                  <li>收发的图片会在桥内做一次「保证可投递」的预处理：单边超过 <b>4096 像素</b>或超过 <b>5MB</b> 时自动缩放与重压。</li>
                  <li>编解码器为内置纯 JS 实现（PNG/JPEG），不依赖 sharp；更换机器或重装不会因缺少原生模块而使整条链路报错。</li>
                  <li>输出格式按<b>字节嗅探</b>决定，不沿用输入声明的 mime，避免「PNG 字节却标注 jpeg」导致整条提示词被拒。</li>
                </ul>
              </DocSection>

              <DocSection title="工具 schema 精简（省额度最有效的一项）">
                <ul>
                  <li><b>原理</b>：工具描述（JSON schema）随每一次请求整包下发，且<b>每一步都要重发一次</b>，
                    是请求体中最占篇幅的一块，故「少一个工具」比「把提示词写短几个字」重要得多。</li>
                  <li><b>另一组开关为何无效</b>：「QQ 工具开关」在<b>调用时</b>返回「工具未启用」，工具描述仍每次全量下发，<b>一个字符也省不掉</b>。</li>
                  <li><b>本卡才是实际生效的一项</b>：勾选 = 该工具<b>不注册</b>给模型，其 JSON 描述从每一次请求中<b>完全消失</b>。</li>
                  <li><b>自定义预设方案</b>：名单完全由用户勾选产生，勾选结果即 <code>social.slimTools.deny</code>；
                    当前名单可存为命名方案（<code>social.slimTools.schemes</code>，形如 <code>{'{ "方案名": ["qq_xxx", …] }'}</code>），
                    日后一键载入、改名或删除。载入方案会立即同步卡内的勾选状态与计数。
                    卡内亦提供「常用精简名单」按钮，可一次套用一份常用名单，再按需增删。</li>
                  <li><b>生效条件</b>：工具表仅在 <b>DSH 启动时取一次</b>，故改完必须<b>重启隔离 DSH</b>（卡内有「保存并重启」按钮）。只重启桥无效。</li>
                  <li><b>名单档位</b>：桥只在 <code>social.slimTools.level === 'custom'</code> 时读取手写名单，其余档位一律忽略，
                    故该卡在挂载、改动名单与载入方案时都会把该档位写为 <code>custom</code>。</li>
                  <li><b>核心工具</b>：标红的 <code>send_message / mark_read / wait_for_messages / set_wake_config / get_unread_messages</code> 为核心，精简后机器人基本失能。
                    其余工具（定时提醒、记忆检索、空间互动、表情包、撤回、管理等）是否裁撤由你决定。</li>
                </ul>
              </DocSection>

              <DocSection title="保存规则总览：哪些项点顶部「保存」即可，哪些卡片需自行保存一次">
                <ul>
                  <li><b>点顶部「保存」（写入整份 config.json）：</b>常用设置中的全部字段——模型与厂商、NapCat 地址与路径、允许与拒绝名单、唤醒与潜水、发送节奏、上下文与轮换、主动闲聊、等待、打字等待、表情包参数、静默群聊、投递与回合、好友申请、Word 额度，以及「工具与规则」中的工具开关与工具 schema 精简。</li>
                  <li><b>卡片自行写盘、无需点顶部保存：</b>人设（persona.md，点「保存人设」）、发言规则（speech-rules.md，点「保存发言规则」）、群聊活跃时段（点「保存这个」，写入桥的 state/activity-windows.json，不是 config.json）、NapCat 鉴权令牌（写入 NapCat 配置并重启 NapCat）、表情包导入（写入表情库并重启桥）、「保存并重启」（先代执行一次顶部保存，再重启 DSH 与桥）。</li>
                  <li><b>会一并写入 config.json 的两个按钮：</b>「活跃时段 → 添加群」（把群加入允许名单）与「活跃时段 → 关闭静默，恢复群聊响应」（关闭 deepsleep）；两者立即写盘，无需再点顶部保存。</li>
                  <li><b>配置方案页签：</b>点「存为新方案」只写方案文件；点「套用」写整份 config.json（等同一次全局保存）。</li>
                </ul>
              </DocSection>

              <DocSection title="常见问题">
                <ul>
                  <li><b>提示「桥没在运行」</b>（学习、语音、NapCat 等页读取桥侧数据时）：该数据须从桥获取。先确认 NapCat 已登录（QQ 在线）、DSH 已启动，再启动 QQ-Bridge，或直接使用首页「一键启动整套」。
                    本页配置读自磁盘上的 config.json，<b>不受影响</b>，桥停止运行时同样可查看与修改。</li>
                  <li><b>提示「桥在运行，但没有这条接口」</b>：<b>这才是版本过旧</b>（桥返回 404 或非 JSON）。将桥代码更新至最新并重启桥即可；与上一条不同，桥未启动时无需更新。</li>
                  <li><b>模型不回话</b>：检查隔离 DSH 日志与隔离 home 的 .credentials.yaml 是否已配置 DEEPSEEK_API_KEY；确认 NapCat 在线。</li>
                  <li><b>端口</b>：管理端 1921 · NapCat 6099/3000/3001 · 隔离 DSH 10721（可在实例配置中修改）· 桥 3100。</li>
                  <li><b>重启顺序</b>：重启管理器会连带停止其托管的 DSH、NapCat 与桥。若隔离 DSH 端口被残留进程占用（新实例启动即退出、桥持续报连接失败），按「杀掉占用 10721 的进程 → 删 <code>qq-bridge/state/bridge.lock</code> → 启动 DSH → 启动桥」的顺序恢复。</li>
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
              <NoticeBar msg={charMsg} onClose={() => setCharMsg(null)} style={{ marginBottom: 10 }} />
              {!charList.length && !charBusy && (
                <div style={{ color: '#9a8fb0', fontSize: 13, padding: '18px 4px' }}>点「扫描」列出角色。每个角色优先使用 ULTIMATE_ROLEPLAY_PROMPT.md，没有时自动拼装各维度 md。</div>
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
function CommonTab({ cfg, ch, onHelp, uploadStickers, remote, writeConfig, onCfgChange,
  apiKeyStatus, onClearApiKey, saving, target }: {
  cfg: any; ch: (p: string) => (v: any) => void;
  onHelp: (h: any) => void;
  uploadStickers: (files: File[]) => Promise<void>;
  remote?: { id: string; name?: string } | null;
/** 活跃时段卡要用：整份配置写回 + 回写页面状态（加群要落进 allow.groups） */
  writeConfig: (next: any) => Promise<any>;
  onCfgChange: (next: any) => void;
/** 隔离 DSH 里「语言模型密钥」的真实状态（只有 env/from/set/len，不含密钥） */
  apiKeyStatus?: { env?: string; from?: string; set?: boolean; len?: number; path?: string; readable?: boolean } | null;
  onClearApiKey?: () => Promise<void>;
  saving?: boolean;
  target?: string;
}) {
  // 精简后的基础项已随「基础与会话」整卡去除（2026-09-30 变更要求），这里不再保留白名单。
  return (
    <div className="cfg-grid">
      <GroupCard title="模型与推理" path="dsh" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="指定连接的隔离 DSH 与回话所用的模型。用法：「模型服务商」留空即自动探测（使用隔离 DSH 中已配置的官方 DeepSeek），也可显式指定；模型留空即用 DSH 默认。注意：修改本卡会在保存后重启隔离 DSH 才生效；「推理档位」是单次调用耗时与思考 token 的最大变量（实测同一次调用出现过 37 秒），嫌慢或嫌贵应先调整本项与「工具与规则」页的精简名单。">
        {/* 语言模型密钥不再是"保存了但不生效"的空字段：
            保存时写进隔离 DSH 的凭据文件（600），这里显示其配置状态。 */}
        <div className="cfg-card-desc" style={{ marginTop: 6 }}>
          {apiKeyStatus?.env
            ? <>
              语言模型密钥写入{target === 'remote' ? '服务端' : '本机隔离'} DSH 凭据文件
              {apiKeyStatus.path ? `（${apiKeyStatus.path}）` : ''}的 <code>{apiKeyStatus.env}</code> 一项：
              {apiKeyStatus.set
                ? <b> 已配置（{apiKeyStatus.len} 个字符）</b>
                : <b> 尚未配置</b>}
              {apiKeyStatus.from ? `（变量名来源：${{ 'settings.yaml': '服务端/隔离 DSH 的 settings.yaml 声明', 'known-provider': '已知服务商对照表', 'derived': '按服务商 id 推导' }[apiKeyStatus.from] || apiKeyStatus.from}）` : ''}
              。填写保存即写入或覆盖；留空不改动该文件。
              {apiKeyStatus.set && onClearApiKey
                ? <> <button type="button" className="btn btn-sm" disabled={saving} onClick={() => { void onClearApiKey(); }}>清除已保存的密钥</button></>
                : null}
            </>
            : '语言模型密钥随保存写入隔离 DSH 的凭据文件（systemd 环境变量）。配置状态读取成功后在此显示，读取失败不影响填写与保存。'}
        </div>
      </GroupCard>
      {/* 令牌字段只保留下面那张卡：这里改白名单，仅列地址与运行路径等连接项。 */}
      <GroupCard title="NapCat 连接（地址与路径）"
        blocks={[{ path: 'napcat', only: ['wsUrl', 'httpUrl', 'launcherPath', 'homeDir', 'imageFileMode', 'tmpDir', 'dockerPathMap', 'allowProcessControl'] }]}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="机器人与 NapCat 通信所用的地址与运行路径，本地一键启动时一般无需修改。注意：WebUI、HTTP、WS 三个令牌均不在本卡，统一在下方「NapCat 鉴权令牌」卡配置；该卡会同时写入 NapCat 自身配置与桥的配置，并重启 NapCat 生效。" />
      {/* 令牌要真正写进 NapCat 才生效：见 NapcatTokensCard 的注释 */}
      <NapcatTokensCard />
      {/* 2026-09-30 变更要求：整张「基础与会话」卡已去除（人设预设、owner QQ、工作区与发送节奏
/**  等基础项不再在管理端出现）。这些键仍会被读进桥：需要时可在「JSON 进阶」里改，
       *  或按下面 renderAgentPreset 那段注释把键删掉。 */}

      <div className="card-stack">
        <GroupCard title="允许名单" cfg={cfg} ch={ch} onHelp={onHelp}
          blocks={[{ path: 'allow' }, { path: '', only: ['allowAllPrivate', 'allowAllGroups', 'allowAllWhenEmpty'] }]}
          desc="允许陪聊的私聊与群，每行一个。用法：逐行填写对象；留空并启用「全部放行」时不做限制。注意：名单为空且未选择全部放行时，机器人不响应任何会话。" />
        <GroupCard title="拒绝名单" path="deny" cfg={cfg} ch={ch} onHelp={onHelp}
          desc="永不响应的私聊与群，每行一个；判定优先于允许名单。" />
      </div>
      <GroupCard title="唤醒 · 潜水 / 活跃" path="social.wake" cfg={cfg} ch={ch} onHelp={onHelp}
        /* 不再把「默认无限潜水」作为旋钮暴露：该键仍兼容老配置，缺省已改为"潜水给有限时长"。 */
        filter={(k: string) => k !== 'recommendedDefaultInfinite'}
        desc="默认即为活跃（每条消息都唤醒）。需要安静时设为潜水。注意：不再提供「无限期潜水」，潜水一律为有限时长，由下方「推荐潜水时长上/下限」控制，到点自动恢复活跃。" />

      <GroupCard title="发送节奏与间隔" path="social.send" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="连发间隔、停顿与字数上限，用于控制发消息的节奏是否接近真人打字。" />
      {/* 2026-09-17 反馈问「resetWindow 是不是和唤醒轮换阈值一样的、重复了」
          不是重复项，是以前"看着像重复"：这张卡把 `social.context` 与 `social.autoReset` 的键平铺成一排，
          而 `resetWindow` 在 LABEL 里没有中文名 → 界面上直接显示原始键名，紧挨着「上下文窗口」，
          两个值在配置里又都是 24 —— 于是像"同一个旋钮写了两遍"。
          现在按语义分成三组，一眼能看出它们管的是三件事：
            ① 每次开新会话往提示里贴多少条聊天记录（contextWindow / resetWindow）
            ② 桥内存里留多少条（recentLimit / unreadLimit，与贴出去的历史无关）
            ③ 聊多少轮把上下文换成新会话（autoReset）
          注意：两个 block 用同一个 path（social.context），所以下面 GroupCard 的 key 不能再只用 s.path。 */}
      <GroupCard title="上下文与轮换"
        blocks={[
          { title: '① 每次开新会话，贴给模型多少条历史', path: 'social.context', only: ['contextWindow', 'resetWindow'] },
          { title: '② 桥内存里保留多少条（跟贴出去的历史无关，只影响桥手头留多少）', path: 'social.context', only: ['recentLimit', 'unreadLimit'] },
          { title: '③ 聊多少轮自动换新会话（上下文轮换）', path: 'social.autoReset' },
        ]}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="三组分别管理三件不同的事，彼此不重复：① 新会话首轮向提示中贴入的聊天记录条数（「轮换后首轮带入条数」仅对轮换后的第一轮生效，故须大于「首轮带入历史条数」才有意义）；② 桥在内存中保留的条数，用于控制内存占用；③ 多少轮后把上下文换成新会话——它决定换会话的时机，与历史条数无关。勾选「永久会话（不轮换）」后不再换会话，上下文改由下方「上下文治理」卡负责。" />
      {/* 2026-09-19 修改要求："一个会话永久使用，但别让上下文堆积" —— 策略写进隔离 DSH 的 home 级
          cordis.patch.yml（lib/dsh-compaction.js），由 DSH 自己的 compaction-basic + tool-result-pruner 执行。
          为什么不在桥侧删历史：DSH 的会话是内存事件溯源日志，外部改文件只会撞 seq gap / zstd 校验和。 */}
      <GroupCard title="上下文治理（工具历史剪枝）" path="dshCompaction" cfg={cfg} ch={ch} onHelp={onHelp}
        only={['enabled', 'thresholdRatio', 'retainRatio', 'toolResultMaxChars']}
        desc="让一个会话长期使用而不堆积上下文。用法：上下文用量达到「触发比例」时，隔离 DSH 先剪掉过大的工具结果（不发起模型请求，聊天记录不变）；剪后仍超阈值，才把最旧的一段摘要为 <compacted-summary>。阈值按模型窗口的比例给出，换模型后自动缩放。注意：本卡修改即时生效（DSH 热加载该 patch），无需重启 DSH 或桥；摘要由主模型（全局语言模型服务商）生成，不提供单独的服务商与模型。" />
      <GroupCard title="主动闲聊" path="social.proactive" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="冷场或长时间无人发言时，机器人是否主动找话题、主动私聊。" />
      <MemoryCard />
      <ActivityHoursCard cfg={cfg} remote={remote} writeConfig={writeConfig} onCfgChange={onCfgChange} />

      <GroupCard title="等待：回复前的停顿" path="social.wait" cfg={cfg} ch={ch} onHelp={onHelp}        desc="模拟真人回复前的停顿：停多久、新消息到达后再静默多久。三项全部为 0 即秒回。" />
      {/* 2026-09-15 修改要求：私聊看对方打字状态：等 ta 打完再回、不停发消息时状态连续、
          概率骰子决定要不要插话；等待期间的消息合并成一次注入。见 qq-bridge/src/core/typing-hold.js */}
      <GroupCard title="私聊打字等待（不抢话 / 智能接话）" path="social.typing" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="私聊中先判断对方是否正在输入：正在输入即等其打完再回，不抢话；对方连续发送消息时输入状态会持续延续；每次唤醒再掷一次骰子，命中即插话接上。等待期间到达的消息全部排队，最后合并为一次交给模型，可省注入轮数。" />
      <StickerCard cfg={cfg} ch={ch} onHelp={onHelp} uploadStickers={uploadStickers} />
      {/* 表情包库（meme pack）：包列表 / 导入（zip 或文件夹）/ 角色绑定 / 删除。
          紧接上方「表情包」卡：同一件事的两半——上方管是否使用表情与同步周期，本卡管库中有哪些包。 */}
      <MemePacksCard remote={remote} />
      <GroupCard title="静默群聊" path="social" only={['deepsleep', 'deepsleepGroups']} cfg={cfg} ch={ch} onHelp={onHelp}
        desc="想省钱/想安静：全群静默（总开关），或只让名单里的个别群静默。" />

      {/* 2026-09-19 修改要求：这张卡只留"模型总开关"：另外两项（回复检查间隔 / 推荐参数）
          一个在「调参」里也有、一个一直没人动过，留在页面上只会让人以为"这些设置还管用"。
          键本身仍在桥里生效（config.json 不动），只是不再从这里编辑。 */}
      <GroupCard title="提示词与语感（[Style] 行）" path="prompt" cfg={cfg} ch={ch} onHelp={onHelp}
        only={['styleLine']}
        desc="唤醒正文每轮都会带的那一句语感提醒。它是离模型最近的一句话，对小模型的语气影响比几十 k 字符的系统提示词更直接 —— 觉得回话「像人机」就改这里。填中文短句；留空 = 不注入这一行。改完保存下一条消息就生效，不用重启桥、也不用等会话轮换。" />
      <GroupCard title="计价口径（/token 指令）" path="tokenCost" cfg={cfg} ch={ch} onHelp={onHelp}
        only={['pHit', 'pMiss', 'pOut', 'peakMult', 'peakHours']}
        desc="QQ 里发 /token 时算钱用的单价（¥ / 百万 token）。默认值与管理端「学习」页的实测计量一致：命中按缓存价、未命中按输入价、输出按输出价，高峰时段整体乘一个倍率。改这里只影响 /token 报出来的钱，不影响计费本身。" />
      <GroupCard title="智能体总开关" path="social" only={['enabled']}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="整套智能体的总开关：关掉 = 桥不再把消息交给模型（只记录、不回复）。" />
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
/** JSON 注释键（`_note` / `_linearNote` 这类"说明文字塞在键里"的写法）：桥运行时不读它。
 *  2026-09-18：以前它会被通用卡片当成普通设置项渲染成一个输入框 —— 字段名是 `_linearNote`
 *  这种英文键名，值是一整段说明，又长又不能改。现在按约定不渲染（说明照样留在 config.json 里）。 */
function isCommentKey(k: string, v: any) { return k.startsWith('_') && typeof v === 'string'; }
function keysOf(cfg: any, path: string, only?: string[], filter?: (k: string) => boolean) {
  const v = at(cfg, path);
  if (v === undefined || !isObj(v)) return [];
  return Object.keys(v).filter((k) => !isCommentKey(k, v[k]) && (!only || only.includes(k)) && (!filter || filter(k)));
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
        // key 必须带上序号：同一个 path 可以出现在两个 block 里（「上下文与轮换」卡的 ① / ② 就是），
        // 只写 key={s.path} 会撞 key、React 复用错 DOM（历史上这里只写了 path）。
        return (
          <div key={s.path + '#' + i} className={sub ? 'cfg-block' : undefined}>
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

/** 群聊活跃时段卡（2026-09-15 按要求加在管理端；同日改成"列表化"）
 *  「对象清单不写死」：群号/QQ 全从桥运行态枚举：GET /api/bridge/activity-targets →
 *  桥的 /api/social/targets（允许名单 ∪ 已建会话 ∪ 已设时段的键，附群名）→ 点哪一行就展开设哪一行。
 *  时段数据不在 config.json，而在桥的 state/activity-windows.json（按会话存，支持跨午夜如 09:00-01:00）。
 *  「添加群号」：会同时补进允许名单（配置由本卡整份写回），否则机器人根本不处理那个群。 */
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

  /* 2026-09-19 修改要求：这张表只列白名单内的对象：
   * 原来把"桥认识但不在允许名单里"的会话也列出来了（行上标一句"不在允许名单"），
   * 于是列表里混着一堆设了也没用的行。现在按桥给的门禁结论过滤（`allowed === false` 一律不显示），
   * 并把被隐藏的数量写出来 —— 用户想给它设时段，第一步应该是先把它加进允许名单。 */
  const allowedTargets = targets.filter((t) => t.allowed !== false);
  const hiddenCount = targets.length - allowedTargets.length;
  const groups = allowedTargets.filter((t) => t.kind === 'group');
  const privates = allowedTargets.filter((t) => t.kind === 'private');
  const visible = showPrivate ? allowedTargets : groups;

/** 保存单个对象的时段（留空 = 不限） */
  const saveOne = async (key: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await saveActivityHours([{ key, windows: drafts[key] ?? '' }], { scope, serverId: remote?.id });
      const one = (r.results ?? [])[0];
      if (!one?.ok) { setMsg(`保存未成功：${one?.error || r.message || '未知原因'}`); return false; }
      setMsg(`已保存${remote ? '到服务端' : ''}：${key.replace(':', ' ')} = ${one.windows || '不限（全天随意）'}`);
      await refresh();
      return true;
    } catch (e) { setMsg('保存失败：' + (e as Error).message); return false; }
    finally { setBusy(false); }
  };

/** 添加群号：先补进允许名单（否则桥不处理该群），再设它的活跃时段 */
  const addGroup = async () => {
    const gid = newGid.replace(/\D/g, '');
    if (!gid) { setMsg('请先填入群号（纯数字）'); return; }
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
      setMsg(`群 ${gid} 已加入允许名单（点上方「保存」后长期生效）；接下来可设置其活跃时段`);
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
        列表由机器人当前认识的对象自动生成（允许名单与已建会话），点其中一行即可单独设置该对象的时段。
        时间为北京时间，支持跨午夜（如 <code>09:00-01:00</code>），多个时段以逗号分隔。<br />
        时段内正常参与，不必急于潜水；时段外若无正事即潜水。留空表示不设时段。
        被 @、被叫名字、被提问一类唤醒不受时段限制，始终会回应。
      </div>

      {meta.deepsleep && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0', padding: '6px 8px', border: '1px solid #d9822b', borderRadius: 6 }}>
          <AlertTriangle size={14} />
          <span style={{ fontSize: 12 }}>
            「静默群聊」总开关处于开启状态，所有群消息均被跳过，此处设置的时段一律不生效。
          </span>
          <button type="button" className="btn btn-soft-primary btn-sm" disabled={busy} onClick={turnOffSilence}>关闭静默，恢复群聊响应</button>
        </div>
      )}

      {meta.deepsleepGroups.length > 0 && (
        <div className="cfg-card-desc" style={{ fontSize: 12 }}>
          单群静默名单：{meta.deepsleepGroups.join('、')}（这些群的消息同样被跳过，调整前需先从名单中移除）
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '6px 0', flexWrap: 'wrap' }}>
        {/* 2026-09-24：刷新按钮不再因"正在读"而置灰（主人要求：不要不能点的卡片状态机）；
            按钮上的转圈只表示这一份读取还在飞，重复点只是多发一次请求，没有副作用。 */}
        <button type="button" className="btn btn-sm" onClick={refresh}>
          {loading ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} 刷新列表
        </button>
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={showPrivate} onChange={(e) => setShowPrivate(e.target.checked)} />
          连私聊一起列（{privates.length}）
        </label>
        <span style={{ fontSize: 12, opacity: 0.7 }}>群 {groups.length} 个</span>
        {hiddenCount > 0 && (
          <span style={{ fontSize: 12, color: '#d9822b' }} title="这些会话桥认识、但不在允许名单里（或当前模式不允许），设了时段也不会生效，所以不列出来">
            已隐藏 {hiddenCount} 个不在允许名单里的对象
          </span>
        )}
      </div>

      {!visible.length ? (
        <div className="cfg-card-desc">
          {loading
            ? '正在读取对象清单，读取期间可继续编辑本卡以外的内容。'
            : hiddenCount > 0
              ? `允许名单里还没有对象（另有 ${hiddenCount} 个不在允许名单里的会话已隐藏）。先在「允许名单」里加群，或点下面的「添加群」，后者会同时把群写入允许名单。`
              : '桥尚未识别任何对象。在下方填入群号添加，或先在「允许名单」里加群。'}
        </div>
      ) : (
        <div className="cfg-fields">
          {visible.map((t) => {
            const open = openKey === t.key;
            return (
              <div key={t.key} style={{ marginBottom: 6, borderBottom: '1px solid rgba(128,128,128,0.18)', paddingBottom: 6 }}>
                {/* 【修「群名撑破按钮/溢出卡片」】名称原为按钮的裸文本：.btn 是 inline-flex 且 nowrap，
                    长群名会把它自己撑到卡片之外，并把同行按钮挤走。现在名称单独放进一个可压缩的行内块：
                    min-width:0 + overflow:hidden + text-overflow:ellipsis + white-space:nowrap，
                    按钮本身也允许收缩（不再只有 min-width），行尾各标签 flex:none 保持原尺寸。
                    名称被截断时以 title 提供完整文本。布局全部用行内样式兜底，不依赖新 CSS 类
                    （className="act-row-name" 仅为后续统一样式预留）。 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                  {/* 2026-09-30：按钮只统一"样式"、不统一"宽度"：这里原本写死 minWidth: 190，
                      会把每一行都撑成同宽，短群名也跟着占一大块。改为按内容自适应；
                      名字过长由下面那层 maxWidth: 100% + 省略号兜住，行内元素用 gap 对齐。 */}
                  <button
                    type="button" className="btn btn-sm"
                    title={t.name ? `${t.name}（${t.id}）` : t.id}
                    style={{ maxWidth: '100%', overflow: 'hidden', justifyContent: 'flex-start' }}
                    onClick={() => setOpenKey(open ? '' : t.key)}
                  >
                    <span style={{ flex: 'none' }}>{open ? '▾' : '▸'}</span>
                    <span
                      className="act-row-name"
                      style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}
                    >
                      {t.kind === 'group' ? '群 ' : '私聊 '}{t.name ? `${t.name}（${t.id}）` : t.id}
                    </span>
                  </button>
                  <span style={{ fontSize: 12, opacity: 0.85, flex: 'none' }}>时段：{t.windows || '不限'}</span>
                  <span style={{ fontSize: 12, opacity: 0.6, flex: 'none' }}>{statusText(t)}</span>
                  {/* 过滤之后这里理论上不会再有"不在允许名单"的行（见上面的 allowedTargets）；
                      万一桥那版没给 allowed 字段，仍然把这句提示留着，免得看不出为什么设了没用。 */}
                  {t.kind === 'group' && !t.inAllowList && <span style={{ fontSize: 12, color: '#d9822b', flex: 'none' }}>不在允许名单</span>}
                  {!!t.unread && <span style={{ fontSize: 12, opacity: 0.6, flex: 'none' }}>未读 {t.unread}</span>}
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

      {/* 群号输入行：输入框与按钮的尺寸统一由 app.css 的 .grp-add-row 控制，此处不再写死宽度。
          「添加群」按钮 2026-09-24 起改用与「添加服务器」一致的 btn-primary 配色（红/pink），
          并收成紧凑尺寸；「并加入允许名单」这层含义放在 title 上，不占按钮宽度。 */}
      <div className="grp-add-row">
        <input
          className="input" placeholder="群号，如 123456789"
          value={newGid} onChange={(e) => setNewGid(e.target.value)}
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={addGroup}
          title="添加群（并加入允许名单）：加群的同时把它写进允许名单，否则桥不处理该群">
          <Users size={14} /> 添加群
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
      <div className="cfg-card-desc">表情库由两部分构成：你 QQ 的收藏表情与本地导入的图库（须自行导入，产品不随附表情包）。本卡控制是否启用表情、同步间隔、发送频率，以及导入自定义表情。</div>
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

/** 包来源的中文说法：置于桥运行目录 meme/ 的包在本页只读，上传的与角色专属的可以删除 */
const MEME_SOURCE_LABEL: Record<string, string> = { factory: 'meme 目录', global: '全局', character: '角色专属' };

/* ================= 表情包库（meme-packs） =================
 * 一张卡管四件事：① 查看包（含坏包）② 导入包（zip 或文件夹）③ 给角色绑包 ④ 删包。
 *
 * 磁盘约定（已冻结，勿改）：一份 pack = 一个目录，
 *   <包目录>/manifest.json + index.db(SQLite) + memes/<分类>/<文件名>.<ext>（webp/png/jpg/jpeg/gif）
 *  包 id 取自该包 manifest.json 的 id 字段。
 * 三个存放位置：① <runtime>/meme/<包名>/ ② <runtime>/meme-packs/<包名>/（上传的包落此）
 *              ③ <charactersDir>/<角色slug>/meme-packs/<包名>/（角色专属）
 *
 * 上传不在前端拼目录：原样把文件交给管理端（POST /api/bridge/meme-packs/upload，base64-in-JSON），
 * 由后端校验图片 → 落临时目录 → 用桥里的规整脚本重排目录并重建 index.db → 再整体 rename 就位。
 * 故"收到几个文件、入库几张、跳过哪些、有无备份旧包"一律以后端报告为准，界面只如实显示，不自行推算。 */
function MemePacksCard({ remote }: { remote?: { id: string; name?: string } | null }) {
  const zipRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [packs, setPacks] = useState<MemePackEntry[]>([]);
  const [bindings, setBindings] = useState<Record<string, string[]>>({});
  const [libRoles, setLibRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [report, setReport] = useState<MemePackUploadReport | null>(null);
  const [packIdInput, setPackIdInput] = useState('');
  const [toCharacter, setToCharacter] = useState('');
/** 每个角色"正在改但还没保存"的勾选（没改过的角色直接看 bindings） */
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  /* 2026-09-21 修改要求：「哪个角色用哪些包」这段能折叠：
     角色库里角色一多，这段的角色卡就把整张卡撑得比上面「表情包」那张高一大截。
     默认展开（免得看着像少了一块）；收起只影响这一段，勾选/草稿状态照旧留在 drafts 里。 */
  const [bindOpen, setBindOpen] = useState(true);

  const load = async () => {
    setLoading(true); setLoadErr(null);
    try {
      const r = await memePacks();
      if (!r.success) { setLoadErr(r.message || '管理端没给出原因'); setPacks([]); setBindings({}); return; }
      setPacks(Array.isArray(r.packs) ? r.packs : []);
      setBindings(r.bindings ?? {});
    } catch (e: any) { setLoadErr(e?.message || '请求失败'); setPacks([]); setBindings({}); }
    finally { setLoading(false); }
  };
  // 角色行：角色库里扫到的 ∪ 已经有专属包的 ∪ 已经绑过包的（_template 这类模板不算角色）
  const roleRows = Array.from(new Set([
    ...libRoles,
    ...packs.filter((p) => p.character).map((p) => String(p.character)),
    ...Object.keys(bindings),
  ])).filter((s) => s && !s.startsWith('_')).sort();

  useEffect(() => {
    void load();
    // 角色清单走「角色库导入」那套扫描（只用来给绑定行起名，扫不到也不影响看包/传包）
    (async () => {
      try {
        const r = await listCharacters();
        setLibRoles((r.characters ?? []).map((c) => c.slug).filter((s) => s && !s.startsWith('_')));
      } catch { /* 忽略：没有角色库不代表不能用包 */ }
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

/** 文件 → base64（与「表情包图库上传」同一套写法：分块 fromCharCode，避免大文件爆栈） */
  const toB64 = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
    return btoa(bin);
  };

  const upload = async (kind: 'zip' | 'folder', fileList: File[]) => {
    if (!fileList.length) return;
    setBusy(true); setMsg(null); setReport(null); setStage('');
    try {
      const payload: { packId?: string; character?: string; files?: Array<{ path: string; data: string }>; zip?: { name: string; data: string } } = {};
      if (packIdInput.trim()) payload.packId = packIdInput.trim();
      if (toCharacter) payload.character = toCharacter;
      if (kind === 'zip') {
        const f = fileList[0];
        setStage(`正在读取 ${f.name}…`);
        payload.zip = { name: f.name, data: await toB64(f) };
      } else {
        // 只挑图片：其它文件传上去也只会被后端算进"跳过"，白占上传体积
        const imgs = fileList.filter((f) => /\.(webp|png|jpe?g|gif)$/i.test(f.name));
        if (!imgs.length) { setMsg('该文件夹内没有 webp / png / jpg / gif 图片'); return; }
        const total = imgs.reduce((n, f) => n + f.size, 0);
        if (total > 40 * 1024 * 1024) {
          setMsg(`该文件夹内的图片共 ${(total / 1048576).toFixed(1)} MB，一次无法传完（上限约 40 MB）。请改选仅含图片的小文件夹，或先压缩为 zip 再上传`);
          return;
        }
        setStage(`正在读取 ${imgs.length} 张图片…`);
        const files: Array<{ path: string; data: string }> = [];
        for (const f of imgs) files.push({ path: f.webkitRelativePath || f.name, data: await toB64(f) });
        payload.files = files;
        setStage(`正在上传 ${imgs.length} 张图片（约 ${(total / 1048576).toFixed(1)} MB）…`);
      }
      if (kind === 'zip') setStage('正在上传…');
      const r = await memePackUpload(payload);
      if (!r.success) { setMsg(r.message || '上传失败'); setReport(r.report ?? null); if (r.keptTemp) await load(); return; }
      const rep = r.report;
      const restartNote = r.restart?.ok ? '，桥接已重启' : (r.restart?.message ? `；${r.restart.message}` : '');
      setReport(rep ?? null);
      setMsg(`已入库「${r.packId}」：${rep?.images ?? 0} 张图`
        + (rep?.skipped ? `，跳过 ${rep.skipped} 个不是图片的文件` : '')
        + (rep?.deduped ? `，去掉 ${rep.deduped} 张重复` : '')
        + (rep?.backup ? `（原来的同名包已备份成 ${rep.backup}）` : '')
        + restartNote);
      setPackIdInput('');
      await load();
    } catch (e: any) { setMsg('上传失败：' + (e?.message || '')); }
    finally { setBusy(false); setStage(''); }
  };

  const del = async (p: MemePackEntry) => {
    if (!window.confirm(`删掉表情包「${p.id}」？\n\n它所在的目录会先改名成 ${p.id}.deleted-<时间戳> 再删，删错了还能从那个目录里把图捞回来。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await memePackDelete(p.id);
      if (!r.success) { setMsg(r.message || `未能删除「${p.id}」`); return; }
      const restartNote = r.restart?.ok ? '，桥接已重启' : (r.restart?.message ? `；${r.restart.message}` : '');
      setMsg(`已删除「${p.id}」${r.trash ? `（未彻底删除，目录保留在 ${r.trash}）` : ''}${restartNote}`);
      await load();
    } catch (e: any) { setMsg('删除失败：' + (e?.message || '')); }
    finally { setBusy(false); }
  };

  const saveBind = async (role: string) => {
    const picked = drafts[role] ?? bindings[role] ?? [];
    setBusy(true); setMsg(null);
    try {
      const r = await memePackBind(role, picked);
      if (!r.success) { setMsg(r.message || `「${role}」的绑定保存未成功`); return; }
      setMsg(r.message || `已保存「${role}」的绑定`);
      await load();
    } catch (e: any) { setMsg('保存绑定失败：' + (e?.message || '')); }
    finally { setBusy(false); }
  };

  return (
    <div className="cfg-card" id="meme-packs-card">
      <div className="cfg-card-title">表情包库（meme-packs）</div>
      <div className="cfg-card-desc">
        包内的图按<b>分类</b>取材（开心 / 生气 / 无奈…），机器人按聊天语境挑选发送，比 QQ 收藏表情更易检索。
        磁盘上每份包即一个目录：<code>manifest.json</code> + <code>index.db</code> + <code>memes/&lt;分类&gt;/图</code>；
        包 id 取自该包 <code>manifest.json</code> 的 <code>id</code> 字段。
        表情包须自行导入：上传的包落在桥运行目录的 <code>meme-packs/</code>，也可置于该目录的 <code>meme/</code> 下（该位置只读，不在本页删除）；包还可只绑给指定角色。
        {remote ? '本卡读取的是本机目录；服务端的包需在服务器上放置。' : ''}
      </div>

      <NoticeBar msg={msg} onClose={() => setMsg(null)} />

      {/* ---------- ① 包列表 ---------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
        <b style={{ fontSize: 13 }}>现有包（{packs.length}）</b>
        <button className="btn btn-sm" onClick={() => void load()}>
          {loading ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} 重新读取
        </button>
      </div>
      {loading && <div className="lrn-inline-note"><Loader2 size={13} className="spin" /> 正在读取表情包目录；下方上传与角色绑定不受影响。</div>}
      {loadErr && (
        <div className="lrn-inline-note" style={{ color: '#b3261e' }}>
          <AlertTriangle size={13} /> 读不到包列表：{loadErr}
          <span>（本卡为按需读取：点上方「重新读取」可再取一次）</span>
        </div>
      )}
      {!loadErr && packs.length === 0 && (
        <div className="lrn-inline-note">{loading ? '正在读取表情包目录。' : '尚无表情包。用下方「选 zip 上传」或「选文件夹上传」传入一份即可使用。'}</div>
      )}
      {!loadErr && packs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '4px 0 8px' }}>
          {packs.map((p) => (
            <div key={p.dir} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', border: '1px solid var(--nc-content2, #eee)', borderRadius: 8, padding: '7px 10px' }}>
              <b style={{ fontSize: 13.5, color: '#3d2b4f' }}>{p.id}</b>
              <span className={`badge ${p.source === 'factory' ? 'badge-soft' : 'badge-success'}`}>{MEME_SOURCE_LABEL[p.source] ?? p.source}</span>
              {p.character ? <span className="badge badge-soft">角色 {p.character}</span> : null}
              {p.broken
                ? <span style={{ fontSize: 12, color: '#b3261e' }}>
                    <AlertTriangle size={12} style={{ verticalAlign: -2 }} /> 坏包：{p.broken}（磁盘上仍有 {p.imageCount} 张图）
                  </span>
                : <span style={{ fontSize: 12, color: '#6b5f80' }}>
                    {p.count} 张 · {p.tags.length} 个分类{p.imageCount !== p.count ? `（磁盘上 ${p.imageCount} 张，与索引不一致）` : ''}
                  </span>}
              <span style={{ fontSize: 11.5, color: '#a99fc0', marginLeft: 'auto', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.dir}>{p.dir}</span>
              {p.source === 'factory'
                ? <span style={{ fontSize: 12, color: '#a99fc0' }}>位于 meme 目录，本页不可删除</span>
                : <button className="btn btn-outline-danger btn-sm" disabled={busy} onClick={() => void del(p)}><Trash2 size={13} /> 删除</button>}
            </div>
          ))}
        </div>
      )}

      {/* ---------- ② 上传 ---------- */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        <input className="input" style={{ maxWidth: 190 }} placeholder="包名（留空自动取名）" value={packIdInput} onChange={(e) => setPackIdInput(e.target.value)} />
        <Dropdown className="input" style={{ maxWidth: 380 }} value={toCharacter} onChange={setToCharacter}
          options={[
            { value: '', label: '谁都能用（公共包）' },
            ...roleRows.map((r) => ({ value: r, label: `只给 ${r} 用` })),
          ]} />
        <input ref={zipRef} type="file" hidden accept=".zip,application/zip,application/x-zip-compressed"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload('zip', [f]); }} />
        <input ref={dirRef} type="file" hidden multiple {...({ webkitdirectory: '' } as Record<string, string>)}
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) void upload('folder', fs); }} />
        <button className="btn btn-soft-primary btn-sm" disabled={busy} onClick={() => zipRef.current?.click()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} 选 zip 上传
        </button>
        <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => dirRef.current?.click()}>
          {busy ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />} 选文件夹上传
        </button>
        <span className="upload-hint">
          {busy ? (stage || '正在处理…') : '包名只允许字母、数字与 . _ - 三种符号；zip 内多套一层目录亦可（会自动识别为包根）'}
        </span>
      </div>

      {/* ---------- 逐文件报告 ---------- */}
      {report && (
        <div style={{ fontSize: 12.5, margin: '8px 0', padding: '7px 9px', borderRadius: 8, background: 'var(--nc-content2, #f6f4fb)', color: '#4a3d5c' }}>
          收到 {report.received} 个文件 · 入库 {report.images} 张 · 跳过 {report.skipped} 个
          {report.deduped ? ` · 去掉重复 ${report.deduped} 张` : ''}
          {report.backup ? ` · 旧包已备份为 ${report.backup}` : ''}
          {report.skippedNames?.length ? (
            <div style={{ marginTop: 4, color: '#8a7f9e' }}>
              跳过：{report.skippedNames.join('、')}{report.skippedMore ? `…另有 ${report.skippedMore} 个` : ''}
            </div>
          ) : null}
          {report.relayoutOutput ? (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: '#8a7f9e' }}>规整脚本输出（排错时查看）</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, margin: '4px 0 0', maxHeight: 160, overflow: 'auto' }}>{report.relayoutOutput}</pre>
            </details>
          ) : null}
        </div>
      )}

      {/* ---------- ③ 角色绑定 ---------- */}
      {/* 标题行 = 折叠开关（整行可点，键盘 Enter/空格也能切；不用 <button> 是为了不跟行内其它元素抢焦点）。
          收起时连下面那句说明一起收掉，这样折叠才真的省高度。 */}
      <div style={{ marginTop: 10 }}>
        <div
          role="button" tabIndex={0} aria-expanded={bindOpen}
          title={bindOpen ? '收起「哪个角色用哪些包」' : '展开「哪个角色用哪些包」'}
          onClick={() => setBindOpen((v) => !v)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBindOpen((v) => !v); } }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
        >
          {bindOpen ? <ChevronDown size={14} color="#8a7f9e" /> : <ChevronRight size={14} color="#8a7f9e" />}
          <b style={{ fontSize: 13 }}>哪个角色用哪些包</b>
          <span style={{ fontSize: 12, color: '#a99fc0' }}>{bindOpen ? '收起' : '展开'}</span>
        </div>
        {bindOpen && (
          <>
            <div style={{ fontSize: 12.5, color: '#8a7f9e', margin: '2px 0 6px' }}>
              勾选结果写入桥的 <code>config.json</code>（<code>social.meme.personaPacks</code>），保存后立刻生效；
              一个都不勾 = 该角色不绑定专属包，仅参与公共包的检索。
            </div>
            {roleRows.length === 0 ? (
              <div className="lrn-inline-note">尚无可用角色：先到「人设」页用「角色库导入」放入角色，或在上传时把「谁都能用」改为指定角色。</div>
            ) : (
              /* 角色卡列表固定高度内滚（角色多也不会把卡片顶高）：
                 maxHeight 240 是照上面「表情包」卡量的 —— 那张卡的字段块（social.sticker 十来个字段，
                 两列排下来约 190px）就是"心里有数的高度"，这里只比它高一点点（+50px），
                 别再往上加，否则两张卡又不成比例。边框/圆角沿用「工具 schema 精简」那张卡的滚动区同款值。 */
              <div style={{ maxHeight: 240, overflowY: 'auto', overscrollBehavior: 'contain', border: '1px solid var(--nc-border-200, #e5e5e5)', borderRadius: 8, padding: 8 }}>
                {roleRows.map((r) => {
                  const picked = drafts[r] ?? bindings[r] ?? [];
                  const dirty = JSON.stringify(picked) !== JSON.stringify(bindings[r] ?? []);
                  return (
                    <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid var(--nc-content2, #eee)', borderRadius: 8, padding: '6px 10px', marginBottom: 6 }}>
                      <b style={{ fontSize: 13, color: '#3d2b4f', minWidth: 90 }}>{r}</b>
                      {packs.length === 0 && <span style={{ fontSize: 12.5, color: '#9a8fb0' }}>暂无可选包</span>}
                      {packs.map((p) => (
                        <label key={p.id} style={{ fontSize: 12.5, display: 'flex', gap: 4, alignItems: 'center', color: '#4a3d5c' }}>
                          <input type="checkbox" checked={picked.includes(p.id)} disabled={busy}
                            onChange={(e) => setDrafts((d) => {
                              const cur = d[r] ?? bindings[r] ?? [];
                              return { ...d, [r]: e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id) };
                            })} />
                          {p.id}
                        </label>
                      ))}
                      <button className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={busy || !dirty} onClick={() => void saveBind(r)}>
                        {dirty ? '保存这个角色' : '已保存'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ToolsTab({ cfg, ch, onSave, target, remoteServerId }: { cfg: any; ch: (p: string) => (v: any) => void; onSave: () => Promise<void>; target?: string; remoteServerId?: string }) {
  const v = get(cfg, 'social.tools');
  // MCP 工具原名（qq_send_message 等英文标识符）默认不显示：界面上统一用中文名；
  // 需要与 config.json 中 social.tools.* 逐字比对时再勾选该开关。
  const [showRaw, setShowRaw] = useState(true);
  if (!v || !isObj(v)) return <div className="empty-state">当前配置没有可开关的 MCP 工具</div>;
  /* 行集取「桥侧全部开关（TOOL_MCP 的键）∪ 本配置已有的键」，而非只列 config 里已有的键：
     config 是历史产物，线上只写了 45 个键、出厂示例 30 个，桥实际识别 57 个开关，
     未被写入的开关（如 sendVoice / transcribeVoice / crosschat）会因此消失。
     缺失的键按桥的语义（`!== false` 即开）显示为「开」。 */
  const cfgKeys = Object.keys(v);
  /* 配置中既无映射又无中文名的键属历史遗留废开关，桥不读取，故不渲染，
     仅在下方一行中列出，便于在 config.json 中清理。 */
  const knownKeys = new Set(Object.keys(TOOL_MCP));
  const deadKeys = cfgKeys.filter((k) => !knownKeys.has(k) && !TOOL_LABEL[k]).sort();
  const keys = Array.from(new Set([...knownKeys, ...cfgKeys.filter((k) => TOOL_LABEL[k])]))
    .sort((a, b) => prettyTool(a).localeCompare(prettyTool(b), 'zh'));
  const isOn = (k: string) => (k in v ? v[k] !== false : true);
  const fromCfg = (k: string) => k in v;
  return (
    <div className="card-stack">
      <div className="card">
        <div className="card-title">
          QQ 工具开关
          <label className="switch-row" style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12.5 }}>
            <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
            <span>显示 MCP 工具原名（比对 config.json 时使用）</span>
          </label>
        </div>
        <div className="switch-grid">
          {keys.map((k) => (
            <label key={k} className="switch-row" title={LABEL[k] || undefined}>
              <input type="checkbox" checked={isOn(k)} onChange={() => ch('social.tools.' + k)(!isOn(k))} />
              <span style={{ minWidth: 0 }}>
                {prettyTool(k)}
                {showRaw && TOOL_MCP[k] ? (
                  <span style={{
                    color: 'var(--nc-foreground-400)', fontSize: 12,
                    fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace",
                    overflowWrap: 'anywhere',
                  }}> · {TOOL_MCP[k]}</span>
                ) : null}
                {!fromCfg(k) ? (
                  <span style={{ color: 'var(--nc-foreground-400)', fontSize: 12 }}>（默认开，保存后写入配置）</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        {deadKeys.length ? (
          <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginTop: 10 }}>
            配置中另有 {deadKeys.length} 个<b>桥侧不读取</b>的旧开关，此处不再显示；
            如需清理，可在 config.json 的工具开关一节中删除：{deadKeys.join('、')}
          </div>
        ) : null}
        <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginTop: 14 }}>
          关闭某项即停用对应的 QQ 工具（模型调用时被拒绝）；该开关不影响人设文本中已有的自然语言规则。
          需按 config.json 中的英文键名逐项核对时，勾选右上角「显示 MCP 工具原名」。
          <br />
          <b style={{ color: 'var(--nc-foreground-300, inherit)' }}>注意：这组开关<b>不省 token</b></b>，工具描述无论如何都会随每次请求发给模型，
          关闭只等于拒绝调用。要真正降低开销，请使用下方「工具 schema 精简」卡。
        </div>
      </div>
      <div className="card">
        <div className="card-title">没有独立开关的工具（{TOOLS_NO_SWITCH.length} 个）</div>
        <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 10 }}>
          这些工具由桥<b>无条件注册</b>，上方开关对其无效：进程控制三项默认不注册（仅管理员私聊可用），
          联网两项随桥常开。若要让模型<b>完全看不到</b>它们，只能在下方的「工具 schema 精简」卡中把它们加入名单
          （注册期即不注册才真正省 token）。
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 13 }}>
          {TOOLS_NO_SWITCH.map((t) => (
            <span key={t}>
              {mcpLabel(t)}
              {showRaw ? (
                <span style={{
                  color: 'var(--nc-foreground-400)', fontSize: 12,
                  fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace",
                }}> · {t}</span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
<ToolCompressorCard cfg={cfg} ch={ch} onSave={onSave} target={target} remoteServerId={remoteServerId} />
      <SlimToolsCard cfg={cfg} ch={ch} onSave={onSave} />
    </div>
  );
}

/** 关掉就会让机器人失能的核心工具：在精简名单里高亮提醒（不硬锁，由用户自行决定）。 */
const SLIM_CORE_TOOLS = new Set([
  'mcp__napcat__qq_send_message',
  'mcp__napcat__qq_mark_read',
  'mcp__napcat__qq_wait_for_messages',
  'mcp__napcat__qq_set_wake_config',
  'mcp__napcat__qq_get_unread_messages',
]);

/** 出厂推荐精简名单（= 出厂默认就关掉的那批，共 21 个）。
 *  2026-09-23：界面按钮改称「常用精简名单」原先那句"用过的次数为 0"的统计依据已从界面撤下，
 *  此处只作为一份常用的精简名单备用，是否采用由用户自行判断。 */
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
  'mcp__napcat__qq_get_self_image',
  /* 2026-09-22 反馈「不能群聊里认识人」这三条从推荐名单里撤掉：
   * qq_get_active_members（群里谁在说话）/ qq_profile_get（某人的档案）/ qq_get_group_history（群聊历史）。
   * 它们原来既在配置 deny 里、也在 low 档 drop 里 → 群里谁都不认识、也不记得群里聊过什么。 */
];

/**
 * 「工具 schema 精简」：卡 —— 真正让 schema 消失的那一刀（2026-09-23 起改为「自定义预设方案」）。
 *
 * 只有一个旋钮：`social.slimTools.deny`。勾选（＝写进该名单）的工具在桥的 MCP server
 * （mcp-napcat-safe.js）启动时不注册给模型，其 JSON 描述自此不出现在任何一次请求中；
 * config 里的 `social.tools.*` 开关只在调用时拒绝，一个字符都省不掉。
 *
 * 方案存于 `social.slimTools.schemes`：{ "方案名": ["qq_xxx", ...] }，值是要精简掉的工具名数组。
 * 桥只在 `social.slimTools.level === 'custom'` 时读取手写名单，故本卡始终把该档位写为 custom。
 *
 * 按要求，本卡不再显示桥侧实测读数（原读 state/tool-schema-stats.json 的那一块已删除），
 * 也不再显示任何按字符数换算的省量。
 */

/** `social.slimTools.schemes` 的容错读取：整体不是普通对象即当作空对象；
 *  某个方案的值不是数组即跳过该方案；数组内只保留字符串项。
 *  目的是配置里出现缺失或非法形态时既不报错，也不把脏数据写回去。 */
function readSlimSchemes(raw: any): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    if (!Array.isArray(v)) continue;
    out[k] = v.filter((x: any): x is string => typeof x === 'string');
  }
  return out;
}
/** 「长期记忆」：卡（记忆架构升级后）——只读，不改数据。
 *
 * 记忆此前不可见（写入 SQLite 后无从核对），分层（永久/长期/短期）与全文索引上线后须可查：
 *   · 永久层（）每轮出现在唤醒正文的 `[Recall]` 中，写错会一直错，应点开核对；
 *   · `chat_fts` / `mem_fts` 为检索用全文索引，显示 -1 表示该库无 FTS5 或索引尚未建立
 *     （检索自动退回模糊匹配：可用，但较慢且无相关性排序）。
 * 数据来自 manager 只读打开的 qq-bridge/state/memory.db。 */
function MemoryCard() {
  const [s, setS] = useState<MemoryStats | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let alive = true;
    getMemoryStats()
      .then((r) => { if (!alive) return; if (r?.ok) { setS(r); setMsg(''); } else setMsg(r?.message || '读不到记忆库'); })
      .catch((e: any) => { if (alive) setMsg(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, []);
  const tierLabel: Record<string, string> = { permanent: '永久（每轮都注入）', durable: '长期（默认）', working: '短期（会过期）' };
  return (
    <div className="card">
      <div className="card-title">长期记忆与档案（SQLite）</div>
      {s ? (
        <>
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            档案 <b>{s.profiles}</b> 人 · 记忆条目 <b>{s.entries}</b> 条（其中永久 <b>{s.permanent}</b> 条）· 聊天记录 <b>{(s.chat || 0).toLocaleString()}</b> 条
            <br />
            分层：{(s.tiers || []).map((t) => `${tierLabel[t.tier] || t.tier} ${t.count} 条`).join(' · ') || '（空）'}
            <br />
            全文索引：聊天 <b>{s.fts?.chat_fts === -1 ? '未建（检索退回模糊匹配）' : (s.fts?.chat_fts ?? 0).toLocaleString()}</b>
            {' · '}记忆 <b>{s.fts?.mem_fts === -1 ? '未建' : (s.fts?.mem_fts ?? 0)}</b>
            {s.ftsRebuiltAt ? ` · 最近重建 ${new Date(s.ftsRebuiltAt).toLocaleString()}` : ''}
          </div>
          {s.top && s.top.length > 0 ? (
            <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.8 }}>
              <b>永久层（= 每轮都会出现在模型眼前的条目，写错会一直错）</b>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {s.top.map((e) => (
                  <li key={e.id}>[{e.category}] {e.content}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>
              尚无永久记忆条目。在 QQ 中对机器人说「记住：……」并由它调用 <code>qq_memory_remember</code> 写入永久层即可。
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--nc-foreground-400)', lineHeight: 1.7 }}>
            记忆存于桥的 <code>state/memory.db</code>：聊天记录永久保存且逐条进入全文索引，
            模型称"看不到更早的消息"时可直接检索回来；永久层条目每轮注入，长期与短期按闲置时间淡出。
            本卡只读，不改动任何数据。
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', lineHeight: 1.7 }}>
          {msg ? `读不到记忆库：${msg}` : '正在读取记忆库。'}
          <br />
          记忆存于桥的 <code>state/memory.db</code>，由管理端只读打开；数据未到达时本卡不阻塞其他设置。
        </div>
      )}
    </div>
  );
}

/** 「工具压缩代理」：卡（2026-09-21 按要求新增）：接开源的 mcp-compressor 当代理。
 *
 * 它与下面那张「工具 schema 精简」是两层不同的压缩：
 *   · 这里（代理层）：DSH 不再直连 napcat MCP，改连代理；代理只把 2 个包装工具发给模型，
 *     把压缩过的工具清单塞进包装工具的描述里。实测（挂我们真实的 90 个工具跑）：
 *       low 38.8% · medium 14.0% · high 6.2% · max 3.6%。
 *   · 下面那张（注册层）：桥自己按自定义名单决定注册哪些工具、按描述压缩档压描述文字。
 * 两层可以叠加：代理开着时，桥侧那份 schema 也会被代理再压一次。
 *
 * 代价（要如实说）：模型遇到本轮没用过的工具要先 `get_tool_schema` 再 `invoke_tool`，
 * 调用从 1 步变 2 步。桥侧已按真实工具名解包（core/mux.js 的 unwrapCompressedToolName），
 * 所以发送判定、幂等账本、回合收尾这些逻辑不受影响。
 * 压缩机没装时自动回退直连（绝不把工具表搞没）；改完必须重启隔离 DSH。 */
function ToolCompressorCard({ cfg, ch, onSave, target, remoteServerId }: { cfg: any; ch: (p: string) => (v: any) => void; onSave: () => Promise<void>; target?: string; remoteServerId?: string }) {
  const enabled = get(cfg, 'social.toolCompressor.enabled') === true;
  const level = String(get(cfg, 'social.toolCompressor.level') ?? 'medium');
  const toonify = get(cfg, 'social.toolCompressor.toonify') === true;
  const excludeRaw = get(cfg, 'social.toolCompressor.excludeTools');
  const exclude: string[] = Array.isArray(excludeRaw) ? excludeRaw : [];
  const [draft, setDraft] = useState(exclude.join('\n'));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ratio: Record<string, string> = { low: '38.8%', medium: '14.0%', high: '6.2%', max: '3.6%' };
  const saveAndRestart = async () => {
    setBusy(true); setMsg(null);
    try {
      ch('social.toolCompressor.excludeTools')(draft.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean));
      await onSave();
      /* 2026-09-21 修「配了 max、服务器上还是 medium」
       * 现场：config.json 已经是 level:"max"，但 cordis.patch.yml 写着 high、跑着的代理是 -c medium ——
       * 三份东西各说各话。原因有两条，缺一不可：
       *   ① 档位是桥启动时写进 cordis.patch.yml 的 → 不重启桥，patch 就是旧的；
       *   ② 代理是隔离 DSH 启动时按 patch 里的 args 起的 → 不重启 DSH，进程就是旧的。
       * 而这里原来只调了 instanceAction('dsh-isolated')，那是本机实例：目标是服务器时，
       * 服务器上桥和 DSH 一个都没重启，于是"改了没生效"，界面上还显示"已保存并重启"。
       * 现在按 target 走，并且先桥后 DSH（顺序反了 DSH 会按旧 patch 起代理）。 */
      if (target === 'remote') {
        if (!remoteServerId) throw new Error('目标选了服务器但没选具体哪台');
        await sshServiceAction(remoteServerId, 'bridge', 'restart');
        await new Promise((r) => setTimeout(r, 3000));
        await sshServiceAction(remoteServerId, 'dsh', 'restart');
        setMsg('已保存并重启服务器上的桥 + 隔离 DSH（约 30 秒后工具表才换过来）');
      } else {
        await instanceAction('bridge-local', 'restart');
        await new Promise((r) => setTimeout(r, 3000));
        await instanceAction('dsh-isolated', 'restart');
        setMsg('已保存并重启本机的桥 + 隔离 DSH（约 30 秒后工具表才换过来）');
      }
    } catch (e: any) { setMsg('失败：' + (e?.message || '')); }
    finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-title">① 工具压缩代理（开源 mcp-compressor）— 决定「模型看到几个工具」</div>
      {/* 2026-09-24 修改要求：本卡说明加 `.cute-note`：里面的 `<code>napcat_get_tool_schema</code>`
          这类片段原来被全站的等宽规则压成 JetBrains Mono，要求"字体都用可爱字体"。 */}
      <div className="cute-note" style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 12, lineHeight: 1.7 }}>
        本卡决定工具表以何种形态发给模型：隔离 DSH 不直连 napcat MCP，改为连接压缩代理；
        代理仅向模型发送 <b>2 个</b> 包装工具（<code>napcat_get_tool_schema</code> / <code>napcat_invoke_tool</code>），
        压缩后的工具清单写入包装工具的描述。
        <br />
        本步恒开，无总开关：直连等于每一步都重发整张工具表，费用更高。
        「代理档位」在下方选择，实测保留比例（相对完整工具表）：
        <b>低档 38.8% · 中档 14.0% · 高档 6.2% · 极限档 3.6%</b>。
        <br />
        注意：模型调用<b>本轮未用过</b>的工具时须先查 schema 再调用，步数由 1 步增至 2 步；
        桥已按真实工具名解包，发送判定、幂等账本、回合收尾均不受影响。
        压缩机未安装时自动回退直连，工具表不会被清空；修改后须重启隔离 DSH。
        <br />
        两处旋钮的分工：本卡「代理档位」决定工具表以何种形态发给模型（模型始终只见那 2 个包装工具，差别在压缩程度）；
        下方「工具名单（自定义方案）」决定<b>后端注册哪些工具</b>，即代理那份清单的条目数。
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>代理档位</span>
        <Dropdown className="input" style={{ maxWidth: 380 }} value={level} onChange={(v) => ch('social.toolCompressor.level')(v)}
          options={['low', 'medium', 'high', 'max'].map((id) => ({ value: id, label: `${id}｜约保留 ${ratio[id]}` }))} />
        <label className="switch-row" style={{ marginBottom: 0, fontWeight: 400, fontSize: 12.5 }}>
          <input type="checkbox" checked={toonify} onChange={(e) => ch('social.toolCompressor.toonify')(e.target.checked)} />
          <span>工具返回的 JSON 转为 TOON（更省 token，格式随之改变）</span>
        </label>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12.5, marginBottom: 4 }}>
          额外排除的后端工具名（每行一个，填 <code>qq_xxx</code> 原名；留空即不排除）
        </div>
        <textarea className="textarea" style={{ minHeight: 70, fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace", fontSize: 12 }}
          value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={'qq_send_pixiv\nqq_schedule_message'} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={saveAndRestart}>
          {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存并重启隔离 DSH
        </button>
        {msg && <span style={{ fontSize: 13 }}>{msg}</span>}
      </div>
    </div>
  );
}

function SlimToolsCard({ cfg, ch, onSave }: { cfg: any; ch: (p: string) => (v: any) => void; onSave: () => Promise<void> }) {
  const denyRaw = get(cfg, 'social.slimTools.deny');
  const deny: string[] = Array.isArray(denyRaw) ? denyRaw.filter((x: any) => typeof x === 'string') : [];
  const enabled = get(cfg, 'social.slimTools.enabled') === true;
  /* 2026-09-23 修改要求：本卡改为「自定义预设方案」档位（off/low/medium/high/extreme/custom）
   * 那套选择器整块删除，名单一律由用户自己勾；方案存于 social.slimTools.schemes。 */
  const schemes = readSlimSchemes(get(cfg, 'social.slimTools.schemes'));
  const schemeNames = Object.keys(schemes);

  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  /* 2026-09-23 修改要求：勾选清单不再默认收起：本卡已无档位选择器，名单全靠用户勾选，
   * 那份清单就是本卡的主体控件，直接展开可见。 */
  // 2026-09-19 改主意：原来这一屏行标题只有中文名、原始工具名默认收起（当时要求「一个别留」），
  // 现在要求把原工具名加回来 —— 所以 showRaw 默认勾上：中文名 + `qq_xxx` 原名并排显示。
  // 对照 config.json 的 deny 名单时也终于不用再手动勾一次了。
  const [showRaw, setShowRaw] = useState(true);
  // 方案名输入一律用受控 input + useState（不用 window.prompt）：新建用 newName，改名用 renameDraft。
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  /* 2026-09-23：桥只在 `social.slimTools.level === 'custom'` 时读取手写名单（lib/tool-tiers.js 的
   * resolveToolTier），其余档位一律忽略 allow/deny。本卡即手写名单的唯一入口，故挂载时即把
   * level 写为 custom；此后每次改动名单与载入方案也一并写入（见 setDeny）。 */
  useEffect(() => {
    if (String(get(cfg, 'social.slimTools.level') ?? '') !== 'custom') ch('social.slimTools.level')('custom');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all = Object.keys(TOOL_SCHEMA_CHARS)
    .filter((n) => n.startsWith(SLIM_PREFIX))
    .sort((a, b) => TOOL_SCHEMA_CHARS[b] - TOOL_SCHEMA_CHARS[a]);
  const denySet = new Set(deny);
  const keptCount = all.filter((n) => !denySet.has(n)).length;
  const extraDeny = deny.filter((n) => !TOOL_SCHEMA_CHARS[n]);
  const kw = q.trim().toLowerCase();
  const shown = kw ? all.filter((n) => n.toLowerCase().includes(kw)) : all;
  const short = (n: string) => n.slice(SLIM_PREFIX.length);

  /* 写名单的唯一入口：一律连同 level=custom 一起写入 —— 桥端读的是同一份配置，
   * 若 level 停在别的档位，手写名单会被整体忽略（沿用现有的 allow/deny 手写名单逻辑）。 */
  const setDeny = (next: string[]) => {
    ch('social.slimTools.level')('custom');
    ch('social.slimTools.deny')([...new Set(next)].sort());
  };
  const toggle = (n: string) => setDeny(denySet.has(n) ? deny.filter((x) => x !== n) : [...deny, n]);
  const writeSchemes = (next: Record<string, string[]>) => ch('social.slimTools.schemes')(next);

  /* 方案操作：载入即调用 setDeny，把方案内的名单原样写回 social.slimTools.deny ——
   * deny 一变，勾选态、计数与 level 随之同步，不必等保存。 */
  const applyScheme = (name: string) => {
    const list = schemes[name] || [];
    setDeny(list);
    setMsg(`已载入方案「${name}」（${list.length} 个工具）；勾选清单已同步，保存并重启隔离 DSH 后生效。`);
  };
  const saveAsScheme = () => {
    const name = newName.trim();
    if (!name) { setMsg('请先输入方案名，再点「存为方案」。'); return; }
    const exists = Object.prototype.hasOwnProperty.call(schemes, name);
    writeSchemes({ ...schemes, [name]: [...deny].sort() });
    setNewName('');
    setMsg(`${exists ? '已覆盖' : '已新建'}方案「${name}」，内容为当前名单（${deny.length} 个工具）。`);
  };
  const overwriteScheme = (name: string) => {
    writeSchemes({ ...schemes, [name]: [...deny].sort() });
    setMsg(`已用当前名单覆盖方案「${name}」（${deny.length} 个工具）。`);
  };
  const deleteScheme = (name: string) => {
    const next: Record<string, string[]> = {};
    for (const k of Object.keys(schemes)) if (k !== name) next[k] = schemes[k];
    writeSchemes(next);
    if (renaming === name) { setRenaming(null); setRenameDraft(''); }
    setMsg(`已删除方案「${name}」；当前勾选名单不受影响。`);
  };
  const commitRename = (from: string) => {
    const to = renameDraft.trim();
    if (!to) { setMsg('方案名不能为空。'); return; }
    if (to === from) { setRenaming(null); setRenameDraft(''); return; }
    if (Object.prototype.hasOwnProperty.call(schemes, to)) { setMsg(`已存在名为「${to}」的方案，请换一个名字。`); return; }
    const next: Record<string, string[]> = {};
    for (const k of Object.keys(schemes)) next[k === from ? to : k] = schemes[k];
    writeSchemes(next);
    setRenaming(null);
    setRenameDraft('');
    setMsg(`方案「${from}」已更名为「${to}」。`);
  };

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

  const effectiveKept = enabled ? keptCount : all.length;

  return (
    <div className="card">
      <div className="card-title">② 桥侧工具裁剪（自定义预设方案）— 决定「后端注册哪些工具」</div>
      <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 12, lineHeight: 1.7 }}>
        本卡决定<b>后端向模型注册哪些工具</b>。上一张卡的压缩代理决定工具表以何种形态发给模型，
        其条目数由本卡决定：少注册一个用不到的工具，代理那份清单与真实工具表都会随之变短。
        <br />
        用法：先在下方勾选要精简的工具（<b>勾选 = 精简掉</b>，该工具不再注册给模型）；
        再把当前名单存为命名方案，日后可一键载入、改名或删除。载入方案会立即把方案内的名单写入当前名单，
        勾选状态与计数随之同步，无需等待保存。
        <br />
        注意：本卡使用<b>自定义名单（<code>social.slimTools.level = 'custom'</code>）</b>——
        桥只在 custom 档下读取手写名单，其余档位一律忽略手写名单，故本卡在挂载、改动名单与载入方案时都会把该档位写回 custom。
        工具表只在隔离 DSH 启动时取一次，改动后必须点下方按钮重启隔离 DSH，只重启桥不生效。
        <code>social.tools.*</code> 那组开关在调用时才返回「工具未启用」，省不下这份描述。
      </div>

      <label className="switch-row" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => ch('social.slimTools.enabled')(e.target.checked)} />
        <span>启用名单裁剪（取消勾选 = 所有工具都注册）</span>
      </label>

      {/* ── 自定义预设方案 ────────────────────────────────────────
          一份方案 = 一份「要精简的工具名单」，即 social.slimTools.deny 的取值。
          载入方案直接写回名单（见 applyScheme → setDeny），勾选态与计数立即同步。 */}
      <div style={{ border: '1px solid var(--nc-border-200, #e5e5e5)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>自定义预设方案</div>
        <div style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)', lineHeight: 1.7, marginBottom: 8 }}>
          一份方案即一份「要精简的工具名单」，存于配置的 <code>social.slimTools.schemes</code>（形如
          <code>{'{ "方案名": ["qq_xxx", …] }'}</code>）。保存方案只写方案本身；名单要在桥侧生效，
          仍须点下方按钮保存并重启隔离 DSH。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <input className="input" style={{ maxWidth: 240 }} placeholder="方案名（如：日常精简）" value={newName}
            onChange={(e) => setNewName(e.target.value)} />
          <button className="btn btn-soft btn-sm" onClick={saveAsScheme}>存为方案（当前名单 {deny.length} 个）</button>
          <span style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>同名保存即覆盖该方案。</span>
        </div>
        {schemeNames.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>
            尚无已保存的方案。勾选下方工具后输入方案名点「存为方案」即可建立第一份方案。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {schemeNames.map((name) => (
              <div key={name} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {renaming === name ? (
                  <>
                    <input className="input" style={{ maxWidth: 200 }} value={renameDraft} autoFocus
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitRename(name); if (e.key === 'Escape') { setRenaming(null); setRenameDraft(''); } }} />
                    <button className="btn btn-soft btn-sm" onClick={() => commitRename(name)}>确认改名</button>
                    <button className="btn btn-soft btn-sm" onClick={() => { setRenaming(null); setRenameDraft(''); }}>取消</button>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 120 }}>{name}</span>
                    <span style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>
                      {schemes[name].length} 个工具
                    </span>
                    <button className="btn btn-soft btn-sm" onClick={() => applyScheme(name)}>载入</button>
                    <button className="btn btn-soft btn-sm" onClick={() => overwriteScheme(name)}>用当前名单覆盖</button>
                    <button className="btn btn-soft btn-sm" onClick={() => { setRenaming(name); setRenameDraft(name); }}>改名</button>
                    <button className="btn btn-soft btn-sm" onClick={() => deleteScheme(name)}>删除</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 13 }}>
          后端注册：<b>{effectiveKept}</b> 个工具（全部 {all.length} 个）· 本卡已精简{' '}
          <b>{enabled ? all.length - keptCount : 0}</b> 个
          {enabled ? '' : '（「启用名单裁剪」未勾选，名单暂不生效）'}
        </span>
      </div>

      {/* ── 勾选清单（本卡主体控件，不折叠）──────────────────────────────────
          勾选 = 精简掉：该工具写进 social.slimTools.deny，桥在注册期即不注册它。
          该清单始终展开，因为它就是本卡唯一决定名单的地方。 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <button className="btn btn-soft btn-sm" onClick={() => setDeny(SLIM_RECOMMENDED)}>常用精简名单（21 个）</button>
        <button className="btn btn-soft btn-sm" onClick={() => setDeny([])}>全部恢复</button>
        <input className="input" style={{ maxWidth: 220 }} placeholder="筛选工具名…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="switch-row" style={{ marginBottom: 0, fontWeight: 400, fontSize: 12.5 }}>
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          <span>显示 MCP 工具原名（排错、比对 config.json 时使用）</span>
        </label>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)', marginBottom: 8 }}>
        勾选 = <b>精简掉</b>（不注册该工具）；取消勾选 = 恢复注册。当前已勾选 <b>{deny.length}</b> 个。
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
                  <span style={{ fontSize: 12.5, color: core ? '#c0392b' : undefined }}>
                    {mcpLabel(n)}
                  </span>
                  {showRaw ? (
                    <span style={{ fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace", color: 'var(--nc-foreground-400)', fontSize: 12, overflowWrap: 'anywhere' }}>
                      {' · '}{short(n)}
                    </span>
                  ) : null}
                  <span style={{ color: 'var(--nc-foreground-400)', fontSize: 12 }}> · {TOOL_SCHEMA_CHARS[n]} 字符</span>
                  {core ? <span style={{ color: '#c0392b', fontSize: 12 }}> · 核心，慎关</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)', marginTop: 10, lineHeight: 1.7 }}>
        只有 <code>mcp__napcat__</code> 系列受本名单控制；另有 <code>todo_write</code> / <code>ask_user_question</code> 两个模型侧工具
        已随人设预设卸载对应插件，不在此列。<br />
        本页只决定是否<b>注册</b>；能否<b>调用</b>仍由上面那张「QQ 工具开关」决定。
        每行显示中文名，勾选上方「显示 MCP 工具原名」可按原名逐字比对 config.json 中的名单。
        {extraDeny.length > 0 ? (
          showRaw
            ? <><br />名单中另有 {extraDeny.length} 个当前未注册的名字将原样保留：{extraDeny.slice(0, 6).join(', ')}{extraDeny.length > 6 ? ' …' : ''}</>
            : <><br />名单中另有 {extraDeny.length} 个当前未注册的工具名将原样保留（勾选「显示 MCP 工具原名」可查看）。</>
        ) : null}
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

/** 「推理档位」：下拉：不写死低/中/高（2026-09-12 变更要求）
 *  · 选项就是各服务商真实的英文档位 id（off/none/minimal/low/medium/high/xhigh/max…），
 *    2026-09-18：但下拉里显示的改成中文名（英文 id 写在说明提示里，随时可查），
 *    免得界面上又是一串 off/low/xhigh；
 *  · DSH 里已经配好、但不在预设列表里的值（例如某些厂商的 `xhigh`）会直接以自定义输入框
 *    回显，不会"显示成空白、一保存就被悄悄改掉"；
 *  · 下面一行显示隔离 DSH 的 settings.yaml 里现在实际生效的档位，方便核对。 */
const EFFORT_PRESETS: Array<{ id: string; hint: string }> = [
  { id: 'off', hint: '关闭思考' },
  { id: 'none', hint: '同「关闭思考」' },
  { id: 'minimal', hint: '最低（想得最少）' },
  { id: 'low', hint: '快但粗略' },
  { id: 'medium', hint: '平衡' },
  { id: 'high', hint: '仔细但慢' },
  { id: 'xhigh', hint: '更高（部分服务商不支持）' },
  { id: 'max', hint: '最高（部分服务商不支持）' },
];
/** 档位 id → 显示名。英文 id 一定保留在前面（2026-09-18 变更要求："low/high/max/xhigh 那些字带上别删除，这样清晰"）——
 *  之前只显示中文名（"快但粗略"），配置和 DSH 的 settings.yaml 对不上号，改完不知道写进去的是什么。
 *  认不出来的值（服务商自定义档位）只能原样显示 —— 那是数据不是键名。 */
function effortLabel(id: string) {
  const hit = EFFORT_PRESETS.find((p) => p.id === id);
  return hit ? `${id} · ${hit.hint}` : id;
}
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
  const hint = dshVal ? `DSH 当前生效：${effortLabel(dshVal)}` : 'DSH 当前未写死档位（用服务商默认）';
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
          <Dropdown className="select" value={cur}
            onChange={(v) => { if (v === '__custom__') setCustom(true); else ch(path)(v); }}
            options={[
              /* 2026-09-30 修改要求：「off 这些后面的说明文字去掉」下拉里只留档位 id，
               * 原来跟在后面的「· 说明」以及两个括号里的解释全部去掉，顺带不再撑宽控件。 */
              { value: '', label: '自动探测' },
              ...EFFORT_PRESETS.map((p) => ({ value: p.id, label: p.id })),
              { value: '__custom__', label: '自定义…' },
            ]} />
        )}
        <em style={{ fontStyle: 'normal', fontSize: 11.5, opacity: .75 }}>{hint}</em>
      </span>
    </label>
  );
}

/** 「主模型 / 识图模型」：下拉里给的是当前服务商真实可用的模型（来自 DSH 自己的配置），
 *  换服务商 → 列表跟着换；当前值不在新列表里也能回显，不会被悄悄改掉；想要清单外的模型点「自定义…」手输。
 *  2026-09-13 变更要求："切换模型商时自动切换对应的模型列表" */
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
          <Dropdown className="select" value={cur}
            onChange={(v) => { if (v === '__custom__') setCustom(true); else ch(path)(v); }}
            options={[
              { value: '', label: vision ? '留空（跟随主模型）' : '留空（用 DSH 默认）' },
              /* 2026-09-30 修改要求：识图模型只显示模型本身的 id，不再后缀显示名称（`id（名称）`）。 */
              ...list.map((m) => ({
                value: m.id,
                label: vision ? m.id : `${m.id}${m.name && m.name !== m.id ? `（${m.name}）` : ''}`,
              })),
              { value: '__custom__', label: '自定义…（手输模型 id）' },
            ]} />
        )}
        <em style={{ fontStyle: 'normal', fontSize: 11.5, opacity: .75 }}>
          {list.length ? `${list.length} 个可用模型 · ${srcLabel} · ${effLabel}` : 'DSH 里还没读到模型清单（可手输）'}
        </em>
      </span>
    </label>
  );
}

/** 2026-09-18：标签表里没登记的键，自动生成一条说明：写清桥里的键名、类型、当前值。
 *  这样即使配置里冒出一个全新键，界面上也不会出现"顶着英文名的无名字段"。 */
function unnamedHelp(path: string, val: any): string {
  const kind = typeof val === 'boolean' ? '开关（true = 开，false = 关）'
    : typeof val === 'number' ? '数字'
      : Array.isArray(val) ? '列表（每行一项）'
        : typeof val === 'string' ? '文本'
          : '一组设置（下面那一组就是它的子项）';
  const shown = Array.isArray(val) ? `共 ${val.length} 项`
    : (val && typeof val === 'object') ? '见下方子项'
      : String(val);
  return `本项为 config.json 中存在的设置，但界面尚未为其登记中文名，字段名暂以占位文字显示。\n`
    + `桥内键名：${path}\n类型：${kind}\n当前值：${shown}\n`
    + `修改前建议查阅「说明文档 · 每一项功能与配置」，或切到「JSON 进阶」页查找同名键。`;
}

/** 2026-09-23 修改要求：只有一个选项的下拉框锁死成灰色静态文字。
 *
 * 场景：`人设预设` 这类下拉在"那套 preset 已从项目里完全去除"之后只剩一项 ——
 * 点开发现只有一个选项、怎么选都是它，纯属噪音（还容易被误当成"能改"）。
 * 规则：
 *   · `options.length <= 1` → 渲染成灰色静态文本（不可点击、无下拉箭头），
 *     文本取那一项的名字（一项都没有时显示「（无）」），并带 `title="只有一个可选值，已锁定"`；
 *   · 选项 ≥ 2 时渲染自定义下拉 `Dropdown`，值与回调照原样透传，行为与原来完全一致。
 *
 * 样式全部复用既有 class（`input` / `select` / `field-row` / `f-label`），不新造一套。
 * 锁定的那个 span 用 `.input` 的底子 + 灰字灰底，看起来就像"填好的、只读的"值。 */
function renderLockedOrSelect(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
  opts?: {
    /**   / 下拉态的 class（默认 select） */
    className?: string;
    /**   / 锁定态的 class（默认 input） */
    lockedClassName?: string;
    style?: React.CSSProperties;
    title?: string;
  },
): ReactNode {
  if (options.length <= 1) {
    const label = options.length === 1 ? options[0].label : '（无）';
    return (
      <span
        className={opts?.lockedClassName ?? 'input'}
        title="只有一个可选值，已锁定"
        style={{
          cursor: 'default',
          color: 'var(--nc-foreground-400, #9a8fb0)',
          background: 'hsl(339.13 92% 97%)',
          display: 'inline-block',
          ...(opts?.style || null),
        }}
      >
        {label}
      </span>
    );
  }
  return (
    <Dropdown
      className={opts?.className ?? 'select'}
      value={value}
      title={opts?.title}
      style={opts?.style}
      onChange={onChange}
      options={options}
    />
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
  const registered = LABEL[path] ?? LABEL[last] ?? LABEL_EXTRA[path] ?? LABEL_EXTRA[last];
  const labelText = registered ?? label;              // label 已由 pretty() 兜底成中文占位
  // 连中文标签都没登记的键：自动配一条「这是哪个键」的最小说明，
  // 保证界面上不会出现一个查不到出处、还顶着英文名的字段。
  const helpText = HELP[path] ?? HELP[last] ?? (registered ? undefined : unnamedHelp(path, val));
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
        {/* 2026-09-12：改成纯输入：没有上下箭头、可以整个删空（保存/失焦时才按 0 落值），
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
          <Dropdown className="select" value={val} onChange={(v) => ch(path)(v)}
            options={[{ value: 'diving', label: '潜水' }, { value: 'active', label: '活跃' }]} />
        </label>
      );
    }
    // 下拉式配置：provider（空=自动探测用 DSH 端默认；DeepSeek 官方 / 小米 MiMo / DSH 里配过的其它服务商）
    // 2026-09-13：切服务商时模型列表跟着换：当前模型不属于新服务商时，自动换成新服务商的默认模型
    //（反馈的现象就是"服务商选了 DeepSeek 官方、主模型还停在 mimo-v2.5"）。
    if (last === 'provider') {
      const list = modelListFor(String(val ?? ''));
      return (
        <label className="field-row">
          {renderLabel()}
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
            <Dropdown className="select" value={val} onChange={(v) => {
              const next = v;
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
              }}
              options={providerChoices().map((p) => ({ value: p.id, label: p.label }))} />
            <em style={{ fontStyle: 'normal', fontSize: 11.5, opacity: .75 }}>
              {autoMsg || (list.length
                ? `该服务商有 ${list.length} 个可用模型 · 列表来自 ${modelListSource(String(val ?? ''))}`
                : 'DSH 里还没读到这个服务商的模型清单（可直接手输模型 id）')}
            </em>
          </span>
        </label>
      );
    }
    // 主模型 / 识图模型：只给当前服务商的模型（+ 自定义），换服务商即换列表
    if (last === 'model' || last === 'visionModel') {
      return <ModelField path={path} val={val} ch={ch} renderLabel={renderLabel} cfg={cfg} vision={last === 'visionModel'} />;
    }
    if (last === 'agentPreset') {
      /* 2026-09-22 变更要求「把那套 preset 从项目里完全去除，管理端也不再有」
       * 下拉里原来有第二项（一个仓库里根本不存在的 preset，装了也不会被拷进隔离 DSH）—— 已删掉。
       * 现在只剩 default：桥侧 installPresets 也只装仓库里真实存在的目录（default + qq-chat）。
       * 2026-09-23 变更要求：只剩一项的下拉框没有意义 → 交给 renderLockedOrSelect 锁成灰色静态文字。
       * 这一支同时管 `agentPreset`（基础与会话）与 `social.agentPreset`（社交模块）两处。 */
      /* 2026-09-30 变更要求：「人设预设 默认（QQ 聊天）这块的人设预设一整个条去掉」
       * → 该行整条不再渲染。下面这一支同时管 `agentPreset`（原「基础与会话」卡）与
       * `social.agentPreset`（社交模块）两处，所以两处的人设预设行一起消失；
       * 键本身没动，桥仍按 config.json 里的值走（缺省 default）。 */
      return null;
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
          {Object.keys(val).filter((k) => !isCommentKey(k, val[k])).map((k) => <Field key={path + '.' + k} path={path + '.' + k} val={val[k]} label={pretty(k)} ch={ch} onHelp={onHelp} cfg={cfg} />)}
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
