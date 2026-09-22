import { useEffect, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import type { ReactNode } from 'react';
import { sshServiceAction } from '../api';
import { api, getBridgeConfig, saveBridgeConfig, saveActivityHours, getActivityTargets, resetSpeechRules, listCharacters, importCharacter, instanceAction, listProfiles, saveProfile, deleteProfile, getRemoteBridgeConfig, saveRemoteBridgeConfig, memePacks, memePackUpload, memePackDelete, memePackBind, getToolSchemaStats, getMemoryStats, getContextOverhead, type ToolSchemaStats, type MemoryStats, type ContextOverhead, type CharacterEntry, type ConfigProfile, type ActivityTarget, type MemePackEntry, type MemePackUploadReport } from '../api';
import { TOOL_SCHEMA_CHARS, SLIM_PREFIX, charsToTokens } from '../tool-schema-chars';
import { ArrowLeft, Save, Upload, FileText, X, HelpCircle, Loader2, Coffee, Activity, Users, MessagesSquare, RotateCcw, Library, BookOpen, Terminal, Layers, Trash2, Check, Server, AlertTriangle, Mic, FolderOpen, ChevronDown, ChevronRight , Wand2} from 'lucide-react';
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
/** 【2026-09-18】标签表兜底：config 里出现「标签表还没登记」的键时显示这一句，
 *  绝不再把 refreshOnMessageMs 这类原始英文键名当字段名糊在界面上。
 *  这种情况不会静默丢信息：Field 会自动给这类字段配一个 ⓘ，里面写清**桥里的键名**与当前值。 */
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
  // 上下文 / 轮换【2026-09-16 主人问「这个界面 resetWindow 是不是和唤醒轮换阈值一样的、重复了」】
  //   ① 不是重复项：contextWindow/resetWindow 是「带多少条历史」，wakeThreshold/prewarmAhead 是「聊多少轮换新会话」。
  //   ② 但它看着像重复：`resetWindow` 以前在 LABEL 里**没有条目**，pretty() 直接回落成原始英文键名
  //      （见 BridgeConfig 的 pretty()），又和「上下文窗口」平铺在同一张卡里；配置里两个值又常常一样（都 24），
  //      于是"同一个旋钮写了两遍"的观感完全是界面造成的。
  //   ③ 现在标签本身就说明"它管什么、什么时候生效"，配合卡内分组（见 GroupCard 的 ① / ② / ③），
  //      并逐个核对了实际读取点（wake-send.js / social-flow.js / console-server.js），不再名不副实：
  recentLimit: '每会话内存保留条数', unreadLimit: '未读队列上限',
  contextWindow: '首轮带入历史条数', resetWindow: '轮换后首轮带入条数',
  wakeThreshold: '聊多少轮换新会话', prewarmAhead: '提前几轮预建新会话',
  permanent: '永久会话（不轮换）',
  // 上下文治理（整路径写死：这些字段名只在这一段里出现，但按路径写更醒目、也不会被别处的同名标签顶掉）
  // 【2026-09-19】不再有 摘要模型服务商 / 摘要模型 两栏：摘要一律用主模型（全局语言模型服务商）。
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
  // 【2026-09-21 主人反馈】「表情包」卡里两个字段**都显示成「备注字数上限」**：
  //   social.sticker.maxRemarkChars（本机 60）与 social.sticker.collect.maxRemarkChars（20）末段同名，
  //   而 Field/pretty 取名字是按「完整路径 → 末段」逐级回落，两条都命中末段那一句 → 一个名字出现两遍。
  //   这里按整路径各给一个名字（**只改界面显示，桥里的键名一个字不动**）：
  //   「表情备注」= 给已有收藏表情写备注时的上限；「收藏备注」= 自动收藏时顺手写的那句。
  'social.sticker.maxRemarkChars': '表情备注字数上限',
  'social.sticker.collect.maxRemarkChars': '收藏备注字数上限',
  'social.docx': 'Word 文档额度',
  dailyQuotaChars: '每日额度', interactionCount: '互动次数',
  // 通用
  security: '安全', interceptNotify: '拦截通知', burstIntervalMinMsLegacy: '（已废弃）连发间隔下限（旧键名）',
  // 投递 / 省额度（2026-09-12 新增到管理端）
  steerEnabled: '在途回合注入', slimTools: '工具 schema 精简',
  // 回合保持（social.turnHold）：以前管理端完全没有露出来，主人问"投递与回合那张卡没错吧"时才发现
  turnHold: '回合保持', maxExchanges: '最多来回次数', idleCloseMs: '空闲关闭时长', maxWaitMs: '最长保持时长',
  requestBudgetMs: '每段等待预算', privateOnly: '只对私聊保持', keys: '限定会话',
  /* 【2026-09-18 主人要求「界面上英文键一个别留」】
     这一段的由来：config.json 里**对象型的键**自己也会被当成"小分组标题"渲染
     （Field 遇到 isObj 就 renderLabel()），而平时没人给它写标签 —— 于是界面上出现过
     光秃秃的 collect / docx / slimTools 这类英文分组名。分组名一律在这里登记，
     同时把「管理端目前没单独开卡、但键确实存在于配置里」的那些键也一并登记：
     它们是**按完整路径渲染**的，哪天真开了卡也不会再回落成英文键名。
     规范：标签必须自解释（不许"参数一/参数二"），看不出行为的再配 HELP 里的 ⓘ。 */
  // 分组名（对象型键当小标题时用）
  dsh: '模型与推理', napcat: 'NapCat 连接', social: '社交模块', allow: '允许名单', deny: '拒绝名单',
  guard: 'NapCat 会话守护', slang: '黑话学习', tools: 'QQ 工具开关', collect: '自动收藏',
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
  // 会话守护（guard：NapCat 假死时自动重启容器自愈）
  'guard.enabled': '会话守护总开关', probeIntervalMs: '探活间隔（毫秒）',
  failThreshold: '连续失败几次判定假死', cooldownMs: '自愈冷却（毫秒）',
  maxHealsPerHour: '每小时最多自愈几次', restartGraceSec: '重启宽限（秒）',
  recoverWaitMs: '重启后等待恢复（毫秒）', autoHeal: '自动自愈',
  // 黑话学习（slang）
  'slang.enabled': '黑话学习开关', extractMinMessages: '凑够几条消息才提取',
  extractCooldownMs: '两次提取的最小间隔（毫秒）', inferenceThresholds: '推断阈值（出现次数）',
  injectMax: '最多注入几条黑话', injectIntoPrompt: '把黑话写进提示词',
  learnerPreset: '学习会话的人设预设', 'slang.workspaceTitle': '学习工作区名称',
  autoResearch: '自动联网考究', charactersDir: '角色库目录',
  // 内置表情包（social.meme）：多包 + 角色绑定，详见 README 的「内置表情包（meme-packs）」一节
  'social.meme': '内置表情包（多包）', 'social.meme.enabled': '内置表情包总开关',
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
     免得主人以为还能调。ⓘ 里说明了替代项。 */
  'social.send.linearBaseMs': '（已废弃）首条气泡延迟', 'social.send.linearStepMs': '（已废弃）每条递增间隔',
  'social.send.gapBaseMs': '（已废弃）间隔基数', 'social.send.gapPerCharMs': '（已废弃）每字追加间隔',
  'social.send.gapJitterRatio': '（已废弃）间隔抖动比例',
  'social.burstIntervalMinMs': '（已废弃）连发间隔下限', 'social.burstIntervalMaxMs': '（已废弃）连发间隔上限',
  /* 【2026-09-19】搜图的镜像站地址：主人反馈镜像站会换域名/镜像挂掉，所以要能自己改。
   * 这一项没登记的话 tools/audit-ui-labels.mjs 会报"未翻译键"（界面会裸奔一个英文键名）。 */
  pixiv: '搜/发 Pixiv 插画', 'pixiv.base': 'Pixiv 镜像站地址',
  'pixiv.refreshToken': 'Pixiv 长期登录态（自动续期写入，一般不用手填）',
  /* 【2026-09-21】本次新增的三处设置（[Style] 语感行 / /token 计价 / 工具压缩档）：
   * tools/audit-ui-labels.mjs 只认这张表，登记在这里界面上才不会裸奔英文键名。 */
  prompt: '提示词与语感', 'prompt.styleLine': '每轮语感提醒（[Style] 行）',
  tokenCost: '计价口径（/token 指令）',
  'tokenCost.pHit': '缓存命中单价（¥/百万 tok）', 'tokenCost.pMiss': '未命中输入单价（¥/百万 tok）',
  'tokenCost.pOut': '输出单价（¥/百万 tok）', 'tokenCost.peakMult': '高峰时段倍率',
  'tokenCost.peakHours': '高峰小时（北京时）',
  'social.slimTools.level': '工具描述压缩档位',
  'social.slimTools.schemaLevel': '描述文字压缩档位（不裁功能）',
  'social.toolCompressor': '工具压缩代理', 'social.toolCompressor.enabled': '启用压缩代理',
  'social.toolCompressor.level': '代理压缩档位', 'social.toolCompressor.excludeTools': '代理额外排除的工具',
  'social.toolCompressor.toonify': '工具结果转 TOON',
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
  /* 【2026-09-21 记忆架构升级】新增的写记忆开关（qq_memory_remember）——工具与规则页要能关掉它 */
  memoryRemember: '写长期记忆',
  historyDelete: '删聊天记录', historyClear: '清空记录', sendDocx: '发 Word 文档', sendRich: '发卡片消息',
  musicSearch: '搜歌', videoSearch: '看/搜视频', imageSearch: '联网找图发图', pixiv: '搜/发 Pixiv 插画', globalOverview: '全局总览', scheduleMessage: '定时发消息', withdrawMessage: '撤回消息',
  sendForward: '合并转发', like: '点赞', proactiveSend: '主动私聊',
  adminSet: '管理设置', whitelist: '白名单',
  qzone: '空间互动（看/评/赞/发）', qzoneView: '看空间',
  activityHours: '活跃时段',
  /* 【2026-09-19 删废开关】这里原来还有 blacklist / profileSet / profileQuery / memeSearch /
     sendMeme / sendQzone 六个开关名，以及 getGroupOwner / getGroupMembers / scheduleList /
     scheduleCancel 四个对不上任何开关的标签 —— 桥侧全树 grep 0 命中，勾了不生效，一并删掉
     （群信息由 getGroupInfo 管、定时只有 scheduleMessage、qzone 由 qzone/qzoneView 统管）。 */
  // 【2026-09-18】config.example.json 里已有、但标签表漏登的开关：漏了就会在「工具与规则」页裸奔英文 key
  characterCards: '角色卡（角色库）',
  // 【2026-09-19】同样漏登的四个：桥确实会读这四个开关（console-server 的 ToolEnabled('sendVoice'/
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
  // 【2026-09-21 记忆架构升级】新工具与它的开关（没有这条映射，审计会判定"这个工具在页面上会消失"）
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
  /* 【2026-09-19 删废开关】这里原来还有 blacklist / profileSet / profileQuery / memeSearch /
     sendMeme / sendQzone 六个键 —— 桥侧**从来不读**它们（`git grep` 全树 0 命中，桥只读
     `cfg.social?.tools?.[key] !== false`）：拉黑走 /api/blacklist 的令牌鉴权、qzone 那组由
     `qzone` / `qzoneView` 统管、群信息由 `getGroupInfo` 管。它们对应的工具（qq_blacklist /
     qq_remove_friend / qq_profile_get / qq_profile_set / qq_meme_search / qq_send_meme）
     都是无条件注册 —— 见下面 TOOLS_NO_SWITCH。
     留着这些行 = 页面上摆着一个"勾了不生效"的开关，比缺行更糟。 */
  // 【2026-09-19】角色库四个工具由 social.tools.characterCards 一个开关统管（false = 四个都不注册）。
  characterCards: 'qq_character_list / qq_character_read / qq_character_pack / qq_character_search',
  // 【2026-09-19】语音两个与跨会话/群信息三个：同样要显示英文原名，否则开关行只有中文名、
  // 无法与 config.json 里的 social.tools.* 对照（也便于照抄进 social.slimTools.deny）。
  sendVoice: 'qq_send_voice', transcribeVoice: 'qq_transcribe_voice',
  crosschat: 'qq_crosschat_inbox / qq_crosschat_send',
  getGroupInfo: 'qq_get_group_owner / qq_get_group_members',
  // 【2026-09-19】点赞与主动私聊：桥有开关（mcp-napcat-safe.js 的 tools?.like / tools?.proactiveSend）、
  // 中文名表里也有，但这里漏了工具原名，于是「显示 MCP 工具原名」时这两行看不到映射。
  like: 'qq_like', proactiveSend: 'qq_proactive_send',
};

/**
 * 没有独立开关的工具：桥侧**无条件注册**，在「QQ 工具开关」里既开不了也关不了。
 * 列出来只为一件事 —— 页面上的工具清单要**完整**（主人才知道这套 bot 到底能做什么），
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
  // 【2026-09-19】原来挂在六个废开关下面的工具（开关已删，工具照旧无条件注册）：
  // 表情包两个、档案读写两个、拉黑与删好友两个。
  'qq_meme_search', 'qq_send_meme', 'qq_profile_get', 'qq_profile_set', 'qq_blacklist', 'qq_remove_friend',
];

/**
 * MCP 工具原名的中文名（键 = `mcp__napcat__` 前缀之后的名字）。
 *
 * 【为什么要单独一张表】「工具 schema 精简」卡会把 src/tool-schema-chars.ts 里
 * **每一个** mcp__napcat__ 工具逐行列出来勾选。以前每行显示的就是 `qq_send_message`
 * 这种原始工具名 —— 主人看到的是一屏英文标识符（2026-09-18 主人要求「一个别留」）。
 * 现在行标题一律是这里的中文名，原名默认**不显示**；要跟 config.json 里的
 * social.slimTools.deny 对照时，勾上卡片里的「显示 MCP 工具原名」即可（原名必须逐字一致）。
 *
 * 加工具时请一并补这张表：漏了的话（① 中文名缺失）tools/audit-ui-labels.mjs 会直接报错拦下。
 */
const MCP_LABEL: Record<string, string> = {
  qq_get_prompt: '查看人设与工具', qq_get_unread_messages: '读未读消息', qq_get_recent_messages: '读最近消息',
  qq_social_state: '查看社交状态', qq_send_group_message: '发群消息', qq_send_private_message: '发私聊消息',
  qq_reply: '引用回复', qq_send_burst: '连发多条', qq_send_message: '发送消息',
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
  // 【2026-09-19】漏登的六个（工具加了、中文名没跟着加 → 精简卡里会显示"未登记"占位）：
  // 语音两个（注册是无条件的，但调用期由 console-server 的 ToolEnabled('sendVoice'/'transcribeVoice') 把关）
  // 与角色库四个（social.tools.characterCards 控制注册）。
  qq_send_voice: '发语音（说话）', qq_transcribe_voice: '语音转文字',
  qq_character_list: '列角色库', qq_character_read: '读角色卡文件',
  qq_character_pack: '取整套角色卡', qq_character_search: '搜角色库',
  // 【2026-09-19】没有独立开关的那批（条目名字也要有中文名：见下面 TOOLS_NO_SWITCH 一栏）
  napcat_status: 'NapCat 运行状态', start_napcat: '启动 NapCat', stop_napcat: '停止 NapCat',
  qq_learning_corpus: '读学习语料', qq_learning_submit: '提交学习结果',
  web_search: '联网搜索', web_fetch: '抓取网页',
};

/** 精简名单里某一行该显示的中文名；未登记时回落到「未登记」占位（绝不显示英文原名） */
function mcpLabel(fullName: string) {
  const short = fullName.startsWith(SLIM_PREFIX) ? fullName.slice(SLIM_PREFIX.length) : fullName;
  return MCP_LABEL[short] || UNNAMED_LABEL;
}

/** 进阶项说明（点 ⓘ 展开），只给对新手不友好的项加 */const HELP: Record<string, string> = {
  baseUrl: 'DSH（DeepSeek Harness）Web 服务地址。本地内置隔离实例默认 http://127.0.0.1:10721；也可用环境变量 QQB_DSH_BASE_URL 覆盖。不要填桌面端 3210。',
  provider: '模型服务商标识，由 DSH 端已配置的 provider 决定；不确定时保持默认，改错会导致会话建不起来（日志会提示）。',
  apiKey: '「语言模型密钥」：**专门给语言模型（聊天本体）用的那一把 Key**。它不写进 qq-bridge/config.json，而是在你点「保存」时由管理端写进**隔离 DSH 自己的凭据文件** `.credentials.yaml`（权限 600，只有本机这个用户读得到），变量名按上面「模型服务商」在 DSH settings.yaml 里声明的 `apiKeyEnv` 决定 —— 例如服务商 `xiaomi-token-plan-cn` → 变量名 `XIAOMI_TOKEN_PLAN_CN_API_KEY`，随后自动重启隔离 DSH 让新值生效（必须重启：DSH 只在启动时读凭据文件）。三个要点：① **留空 = 不动已保存的那份**（不会把已有 Key 清掉），要删掉就点下面那行的「清除已保存的密钥」；② 它**只**影响语言模型，与「识图模型密钥」「语音模型密钥」是三把不同的 Key，互不影响；③ DSH 自身的取值优先级是「启动它的进程环境变量 > 凭据文件」—— 若你在系统里另设过同名环境变量，那个会盖过这里填的。',
  model: '主对话模型。留空由 DSH 默认决定。',
  visionModel: '识图（多模态）模型，用于带图片消息的会话。**语言模型和识图模型是分开配的**：上面「主模型」管文字回话，这里管看图。三种情况——① 三个识图字段全留空：图片按老办法当附件发给主模型（要求主模型本身是多模态的，默认已是）；② 只填「识图模型」不填地址：仍走 DSH 那条路，只是这次会话显式指定这个模型来读图；③ 填了「识图模型请求地址」：桥**直接**用 OpenAI 兼容接口（POST /chat/completions，图片走 image_url 的 data: URL）去问识图模型，把返回的文字描述交给语言模型——这样识图可以用完全不同的厂商/额度，也能给主模型省钱（主模型只收文字）。',
  visionBaseUrl: '识图模型的 **OpenAI 兼容**请求地址，例如 https://api.siliconflow.cn/v1 或 http://127.0.0.1:8000/v1（桥会自己在后面接 /chat/completions，所以填到 /v1 为止，别带 /chat/completions）。**留空 = 不用这条独立通路**，图片按老办法走 DSH 当附件。填了它就必须同时填「识图模型」（否则不知道该调哪个模型）；「识图模型密钥」可留空（本机自建服务通常不要密钥）。',
  visionApiKey: '「识图模型密钥」：识图这条独立通路自己的 Key（只在填了「识图模型请求地址」时用）。它跟着配置保存，用于请求上面那个地址；留空则不带头（本机自建/内网服务用）。注意：它和「语言模型密钥」是两个不同的东西，互不影响。',
  reasoningEffort: '推理强度档位，只对支持该参数的服务商生效（如 deepseek-reasoner / 深度思考类）。档位越高越慢但更仔细；实测**这是单次调用耗时与思考 token 最大的一块**（出现过单次 37 秒），嫌慢嫌贵先降它。`xhigh`/`max` 只有部分服务商支持（小米 MiMo 不支持）：选了不支持的档位时，桥会自动退回该服务商的默认档位并在日志里写一行，不会卡住会话。改完会自动重启隔离 DSH 生效。'
    + '下拉里每项都是「英文档位 id · 中文说明」——英文 id 就是真正写进 DSH settings.yaml 的值，保留它是为了配置和文件能对上号：'
    + 'off=关闭思考、none=同「关闭思考」、minimal=最低、low=快但粗略、medium=平衡、high=仔细但慢、xhigh=更高、max=最高。',
  launcherPath: '仅在你手动拉 QQ 网关时使用；本项目 NapCat 已内置并由管理端拉起，一般保持留空。',
  homeDir: '网关侧可写目录（容器映射等），本地 NapCat 一般不需要。',
  allowProcessControl: '是否允许 DSH 内的 agent 自动启停本机 QQ 网关。请仅在完全信任时开启。',
  'napcat.imageFileMode': '发图片/表情时，桥交给 NapCat 的文件该怎么传：path=直接给路径（本机裸机部署）；base64=读成 base64 直接塞过去（跨容器/跨机都能发）；auto=先按「容器路径映射」换成容器内路径（服务器 Docker 用这个），换不了再退 base64。服务器上推荐 auto。',
  'napcat.tmpDir': '桥写临时文件（表情、语音、文档）的目录。服务器上要指到**NapCat 容器挂载出来的那个目录**（例如 /root/napcat/config/moonbot-tmp），否则容器读不到文件、图/语音发不出去。',
  'napcat.dockerPathMap': '宿主目录 → 容器内目录的映射表，配合 imageFileMode=auto 用。服务器 NapCat 跑在 Docker 里时填 [{"host":"/root/napcat/config","container":"/app/napcat/config"}] 这类值。',
  accessToken: '「HTTP 访问令牌」：桥接进程通过 HTTP 接口（http://127.0.0.1:3000，NapCat 的 httpServers）收发消息时使用的令牌，需与 NapCat WebUI 里 HTTP 服务的 token 一致。它和下面的「WS 访问令牌」是两种不同传输各自的令牌——即使值相同也是分开的字段，改一个不影响另一个；填错会导致 HTTP 工具全部 401。',
  wsAccessToken: '「WS 访问令牌」：桥接进程通过 WebSocket 接口（ws://127.0.0.1:3001，NapCat 的 websocketServers）收发消息时使用的令牌，需与 NapCat WebUI 里 WS 服务的 token 一致。与「HTTP 访问令牌」相互独立（哪怕默认值相同）；填错会导致 WS 连接被拒、机器人收不到/发不出消息。',
  consolePort: '桥接内部服务端口（本地管理端会探测它判断是否在运行）。',
  consoleToken: '本机桥接内部接口令牌，一般不用改；改动后管理端会需要同步。',
  sessionCwd: 'DSH 会话工作目录；留空 = 每个会话在 state/agents 下独立建目录。',
  allowAllWhenEmpty: '白名单为空时是否放行所有会话（私聊+群聊两边一起放）。强烈建议先把私聊/群白名单填上再开它。',
  allowAllPrivate: '私聊专属开关（2026-09-19 主人要求）：**私聊名单为空**时放行所有私聊 —— 群里严格只认名单、私聊谁来都能说上话，就用它。注意：① 只在该类名单为空时生效，私聊名单里填了人就以名单为准；② 黑名单永远优先，拉黑的人照样进不来。',
  allowAllGroups: '群聊专属开关，语义与上面那条一样，只是作用于群聊。默认两个都不勾 = 空名单时谁都不放行。',
  security: '安全选项分组。',
  'prompt.styleLine': '唤醒正文里每轮都会带的一行语感提醒（默认 `[Style] 说人话：短、有态度，别讲课别列举`）。'
    + '为什么单独可配：系统提示词里写着"别讲课"也压不住这一轮的语气 —— 小模型对**最近那段上下文**权重最高，'
    + '所以这句话是最后一道闸。它的长度每轮只有几十字符、且每轮完全相同（稳定前缀，按缓存读计价），成本可忽略。'
    + '改文案的几个要求：① 保持**每轮完全相同**（别放时间/随机数，否则会打掉前缀缓存）；'
    + '② 描述的是"怎么说"，不要写具体规则条款（那些属于系统提示词）；③ 留空 = 完全不注入这一行。'
    + '保存后下一条消息生效（配置文件热加载，无需重启桥）。',
  'tokenCost.pHit': '缓存命中的输入单价（¥ / 百万 token）。DeepSeek 谷时的缓存命中价约为未命中价的 1/50，'
    + '所以这个值填大了会把 /token 报出的钱算虚高。默认 0.02。',
  'tokenCost.pMiss': '未命中（新读入）输入的单价（¥ / 百万 token）。默认 1。',
  'tokenCost.pOut': '输出 token 的单价（¥ / 百万 token）。默认 4。',
  'tokenCost.peakMult': '高峰时段整体倍率。默认 2 = 高峰时上述三项单价全部 ×2。填 1 = 不分时段计价。',
  'tokenCost.peakHours': '算作"高峰"的北京时小时（0-23）。默认 [9,10,11,14,15,16,17]，即上午 09:00-11:59 与下午 14:00-17:59。',
  'pixiv.refreshToken': 'Pixiv 的长期登录态（OAuth refresh_token）。**一般不用手填**：'
    + '引导流程会用一次性的 PHPSESSID 换回长期 refresh_token 并自动写在这里，之后按画师名字搜人不再依赖手贴 cookie。'
    + '填错/过期会导致「按名字搜画师」失败，但直接按作品 id 发图不受影响（那条路走公开接口）。',
  prompt: '提示词可调项分组。目前只有一项：唤醒正文每轮带的那句语感提醒。',
  tokenCost: 'QQ 里发 /token 时算钱用的单价分组（¥ / 百万 token）。默认值与管理端「学习」页的实测计量同源；'
    + '改这里只影响 /token 报出来的钱，不影响提供方的实际计费。',
  'social.toolCompressor': '开源 mcp-compressor 代理（2026-09-21 接上）：DSH 不再直连 napcat MCP，'
    + '改连代理；代理只把 2 个包装工具发给模型（napcat_get_tool_schema / napcat_invoke_tool），工具清单压进描述里。'
    + '实测相对完整工具表：低 38.8% / 中 14.0% / 高 6.2% / 极限 3.6%。'
    + '代价是遇到本轮没用过的工具要"先查 schema 再调用"，一步变两步；桥侧已按真实工具名解包，不影响发送判定与幂等账本。'
    + '⚠ 压缩机没装（pip3 install mcp-compressor）时自动回退直连，不会把工具表搞没。改完必须重启隔离 DSH。',
  'social.toolCompressor.enabled': '是否让隔离 DSH 走压缩代理。关掉 = 直连（默认）。'
    + '桥每次启动会做一次廉价探测：找不到 mcp-compressor 可执行文件就自动回退直连并把原因写进日志。',
  'social.toolCompressor.level': '代理压缩档位（对应 mcp-compressor 的 --compression）：'
    + '低 = 保留完整描述；中 = 每条描述只留第一句；高 = 工具清单里不带描述；极限 = 连参数都不带。'
    + '档位越低模型越依赖"先查 schema"，调用步数越多。建议先用中档实测几轮，拿 /token 对一次账再定。',
  'social.toolCompressor.excludeTools': '交给代理之前先从后端排除的工具（后端原名，如 qq_send_pixiv），'
    + '逗号或换行分隔。与「工具 schema 精简」那张卡的名单是叠加关系：两边都会把工具挡在模型视线之外。',
  'social.toolCompressor.toonify': '把工具返回的 JSON 转成 TOON 再交给模型（更省 token，但模型看到的格式变了）。'
    + '默认关闭：格式一变，模型对该工具结果的读法可能跟着变，建议先在低价值工具上试。',
  'social.slimTools.schemaLevel': '描述文字压缩档（与上面的"名单档位"是两个正交的旋钮）：上面决定**注册哪些工具**，'
    + '这里决定**注册了的那份 schema 写多长** —— 压的是描述文字，工具一个不少、参数一个不少（名字/类型/枚举/必填照旧）。'
    + '档位语义照搬开源的 mcp-compressor（atlassian-labs）：medium = 每条描述只留第一句；high = 完全不发描述。'
    + '在我们真实的 JSON Schema 格式上实测：不压 100% / 中度 71.4% / 高度 31.1%（90 个工具）。'
    + '⚠ high 是激进档：描述是模型判断"什么时候用这个工具"的主要依据，去掉后只能靠工具名猜；'
    + '换来的差额是每步约 1.9 万 token（本机口径）。改完必须重启隔离 DSH 才会重新注册工具表。',
  'social.slimTools.level': '工具描述压缩档位（一次点一个档，不用手写几十个工具名）：'
    + 'off = 全部注册（默认，行为与改动之前一致）；low ≈50%（只砍"实测零调用"的大块头：pixiv/富卡片/角色卡/点歌/定时/空间…）；medium ≈39%（再收一圈）；high ≈29%（**实测被调用过的能力一个都不丢**——发米姆、语音、查记忆、看历史图都在，这是"不丢功能"的地板）；extreme ≈7%（只留说话/引用/收尾/看未读八件套，**会真的砍掉在用的能力**，只在必须省钱时用）；'
    + 'custom = 用下面的白名单/黑名单两张表（老行为）。'
    + '百分比是**桥实测**的（注册工具时逐个量出来的，不是写死的），卡片上的「桥实测」一行会显示当前真实占比。'
    + '⚠ 换档后必须重启隔离 DSH 才会生效（工具表只在 DSH 启动时取一次）。'
    + '注意：`social.tools.*` 那些开关**省不了这份描述**（它们只在调用时返回"工具未启用"），只有这里的档位才会让它从请求里消失。',
  trustedCrossSessionUids: '允许 agent 跨会话读取/带话的 QQ 号（数组），一般只放你自己最信任的好友。',
  deepsleep: '总开关：开启后**所有群聊**的消息入库但不唤醒、不回复、不主动冒泡（省 token）；**私聊照常**。拍一拍等群内事件同样被静默。主人发 /start 可随时恢复（这条命令不经过模型，永远有效）。',
  recommendedHint: '喂给模型的“潜水/唤醒行为规则”长文本；一般不建议新手改动。',
  activeProbability: '「活跃模式搭话概率」：把某个群/私聊**转成活跃**时用的随机搭话概率（默认 0.3 = 三成）。以前转活跃会沿用潜水那套 0.05（每 20 条才醒一次），看起来跟潜水没区别 —— 这个值就是用来区分两者的：调大=更活跃，调小=更省额度（配合「群每小时唤醒上限」兜底）。',
  preSleepWaitMs: '想潜水前先“静默观察”的窗口时长：窗口内若没人说话就可以安心睡。',
  wakeThreshold: '「聊多少轮换新会话」：同一个会话累计到这么多轮，下一次唤醒就切到新的一代会话（旧会话归档，记忆文件保留、不丢记忆）。'
    + '计入的只有真实来回：私聊消息 / 被 @ / 被提问 / 被喊名字 / 拍一拍 / 关键词这类**触发唤醒各算 1 轮**，'
    + '`qq_wait_for_messages` 每取回一批新消息也算 1 轮；回复检查、主动冒泡这类内部唤醒**不计入**'
    + '（计进去会导致一两小时内上下文被切十几次、机器人频繁失忆）。桥里最小 5，默认 10。'
    + '这个值**每轮现读**配置，改完对正在跑的老会话立刻生效，不用等它自然轮换、也不用重启桥；而轮次计数落在 state/social-state.json，重启桥不会把它清零。'
    + '它和「轮换后首轮带入条数」是两件事：这条是**换会话的时机**，那条是**换完之后第一轮看多少历史**。',
  prewarmAhead: '「提前几轮预建新会话」：在到「聊多少轮换新会话」之前这么多轮，桥就把下一代会话建好并预热一次，'
    + '到点直接切过去，第一轮不卡、还能命中提示缓存。填 1 = 只在最后一轮才建（最省，但轮换那一下稍慢）；'
    + '填得和轮换阈值一样大 = 第一轮就建（没必要）。默认 3。'
    + '⚠️ 这条以前在**没写进 config.json** 时是失效的（读取处 `Number(x) ?? 3` 在缺键时算出 NaN，预热分支永远不触发），已修。',
  permanent: '「永久会话（不轮换）」：勾上就**不再按轮数换会话** —— 一个会话一直用下去，省掉每次换新会话那一轮的首轮 token'
    + '（新会话的系统提示词、工具清单、历史窗口都是冷的，没有任何前缀缓存可用）。'
    + '配套的是「上下文治理（dshCompaction）」：由隔离 DSH 自己剪掉超大的工具结果、必要时把最老一段摘要，'
    + '所以不换会话也不会把上下文越拖越长。两条要注意：'
    + '① `agentPreset`（人设预设）**只在建会话那一刻绑定** —— 开着永久会话时改预设，老会话不会跟着变'
    + '（改 persona.md 人设文件不受影响，那份是每轮注入的正文）；确实要换预设就先把这里取消勾选、等它轮换一次再打开。'
    + '② 万一压缩配置被写坏，会话会一直长下去，所以「聊多少轮换新会话」那个值仍保留：关掉本项立刻恢复按轮数轮换。'
    + '改这一项**立刻生效**，不用重启桥，正在聊的会话也不会被打断。',
  dshCompaction: '上下文治理：让一个会话能长期用下去又不堆积上下文。'
    + '桥**不直接改** DSH 的历史（DSH 的会话是内存里的事件溯源日志，外部改文件只会撞 `seq gap` 校验），'
    + '而是把策略写进隔离 DSH home 的 `cordis.patch.yml`（home 级 patch 层），交给 DSH 自己的压缩组件执行：'
    + '① 先剪掉超大的工具结果（`tool-result-pruner`）——不发模型请求，聊天记录一个字都不动；'
    + '② 剪完仍超阈值、或提供方报上下文溢出，才把最老一段摘要成 `<compacted-summary>`（`compaction-basic`）。'
    + '阈值一律按「模型窗口的比例」给，换模型自动等比缩放。改这里**立刻生效**（DSH 会热加载那份 patch），不用重启 DSH 或桥。',
  thresholdRatio: '「触发比例」：上下文用到**模型窗口的百分之多少**就开始治理（当前推荐 **0.16** = 16%）。'
    + '窗口 1M 的模型 ≈ 16 万 token 触发；窗口 128k 的模型 ≈ 2 万 token 触发 —— 同一个比例换模型自动缩放，不用手改。'
    + '\n\n**智能推荐（2026-09-22 用线上实测重算，不再写死）**：按上下文区间分桶量下来，'
    + '上下文本身几乎只按缓存命中价计费（实测回归：每次成本 ≈ ¥0.0020 + **0.022 ¥/M × 上下文**），'
    + '真正花钱的是"压缩/换会话/长时间空闲之后要**整段重读**一次"（实测每次 ≈ ¥0.036）。'
    + '所以最省的做法是**少压缩**，而不是把小上下文当目标：阈值越低，压缩越频繁，重建费越亏。'
    + '\n推荐公式：`阈值比例 = clamp((固定开销 + 逐字保留 + 余量) / 模型窗口, 0.10, 0.30)`，'
    + '其中「固定开销」= system 提示词 + 工具 schema 的实测 token（这一项**每步都要重发**，'
    + '所以阈值必须明显大于它，否则会被顶穿成"每一步压缩一次"）；「余量」取 24k token'
    + '（保证压缩后离阈值还有距离，不会"压完立刻又压"）。当前实测固定开销见本卡上方的读数。'
    + '\n实测扫描（模型窗口 1M）：0.08 → ¥3.34/天（重建 15~29 次/天）· 0.12 → ¥2.67 ·'
    + ' **0.16 → ¥2.53** · 0.18 → ¥2.53 · 0.25 → ¥2.66 → 最省 0.16~0.18，稳健区间 **0.14~0.20**。'
    + '复算脚本：`qq-bridge/tools/compaction-threshold.mjs`（参数全部从线上 `state/token-usage.jsonl` 现场量，改价后重跑）。'
    + '\n\n**别低于 0.08（8%）（桥的下限，低于它会被自动夹回并写日志）**：阈值一旦被固定开销顶穿就变成'
    + '**每一步都压缩一次** —— 每次压缩额外发一次"读完整段上下文写摘要"的模型请求、并改写会话历史'
    + '（prompt 前缀缓存随之作废，下一步只能全量重读）。2026-09-20 线上实测：0.06 时 114 个模型步里触发了'
    + '**46 次摘要**，每步之间多花 15~20 秒，一个搜索回合拖成 6 分钟。'
    + 'DSH 的硬要求：这个值必须**大于**「逐字保留比例」，否则插件会拒绝加载（桥会自动夹到合法范围并写日志）。',
  retainRatio: '「逐字保留比例」：最近这一部分上下文**原样保留**，压缩只动比它更老的部分（默认 0.02 = 2%，1M 窗口 ≈ 2.1 万 token）。'
    + '必须小于「触发比例」。压缩后上下文 ≈（这一段 + 固定开销 2.75 万），要明显低于触发阈值才不会"压完立刻又压"。'
    + '调大 = 最近这段记得更牢、更贵；调小 = 更省，但模型更容易忘掉前几轮的细节。',
  toolResultMaxChars: '「工具结果保留字数」：单个工具结果超过这么多字符（Unicode 码点）就被剪成'
    + '「开头 60% + 一行 `[... tool result middle pruned ...]` + 结尾 20%」（默认 1500）。'
    + '这是**最省 token 的一刀**：QQ 机器人的上下文大头几乎都是工具结果（群成员列表、聊天记录、网页正文、图片信息）。'
    + '剪枝不发模型请求、不动聊天记录，被剪掉的原文本仍留在会话日志里（可回放、可 grep）。'
    + '代价：每次剪枝都会改写这段历史，命中它之前的前缀缓存随之失效 —— 所以它是个"省 token ↔ 少改写"的折中，'
    + '工具结果普遍不大（几百字）时可以调大一点（例如 4000），让改写少发生、缓存更容易命中，响应更稳。'
    + 'DSH 的硬要求：保留的头 + 标记 + 尾不能超过这个字数，桥会自动按 60/20 拆并校验。',
  'dshCompaction.enabled': '总开关：关掉 = 不覆盖 DSH 默认（默认要等上下文用到窗口 80% 才压缩，等于不压缩，上下文会一直涨到轮换为止）。',
  contextWindow: '「首轮带入历史条数」：一个新会话的**第一次**唤醒时，往提示里贴最近多少条聊天记录'
    + '（每个会话只贴这一次，之后各轮只发一行哨兵，不再重贴）。下限 6、普通首轮**上限 24**——'
    + '填 30 也只按 24 走；想让轮换后的第一轮看得更长，要同时调「轮换后首轮带入条数」。'
    + '它决定"新会话开局知道多少上下文"，越大越懂但越贵（这段窗口之后每一步都会被重读计价）。桥里默认 12。',
  resetWindow: '「轮换后首轮带入条数」：会话**轮换之后的第一轮**贴多少条历史，只此一次，之后回到上面那个条数。'
    + '桥取 `max(首轮带入历史条数, 这个值)`，所以**填得比「首轮带入历史条数」小是完全没效果的**（不是坏了，是不会生效）；上限 60。'
    + '它和「聊多少轮换新会话」不是同一个东西：这个是**历史窗口的大小**，那个是**轮换的时机**。'
    + '只有轮换后的第一轮会读它（没轮换过的普通首轮不读这个值，填了也不影响）。桥里默认 24。',
  recentLimit: '「每会话内存保留条数」：桥在内存里为每个会话留这么多条最近消息，新的进来就把最旧的挤掉。'
    + '它只决定"桥手头留多少货"——真正贴进提示的条数由上面的「首轮带入历史条数」决定；'
    + '历史消息本来每条都会落 SQLite，内存里挤掉的照样能用 `qq_get_recent_messages` / `qq_memory_search` 查到。'
    + '调大更占内存（每个会话一份），一般不用动。桥里默认 100。',
  unreadLimit: '「未读队列上限」：每个会话内存里最多排这么多条未读，超了丢**最旧**的（不是最新）。'
    + '重启后从 SQLite 恢复未读时也按这个数取。它不改变"已读/未读"的判定，只限制排队长度。桥里默认 30。',
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
  'social.typing.enabled': '「私聊等对方打完字」：开启后，私聊里检测到对方正在输入（QQ 的输入状态）就先等 ta 打完再回，不抢话。等待期间到的消息会全部排队 —— 不管模型是不是正在回复，**都不会半路一条一条塞进去**，等 ta 打完才**合并成一次**（对话里只出现一个 [Mid-turn] 块、机器人只回一次）。关掉 = 不看打字状态，按正常节奏回。',
  'social.typing.holdMaxMs': '「最多等多久」：对方一直不停地打字时，最多等这么久（默认 12000 毫秒）就插话，避免遇到"打字没完"的人永远不回复。',
  'social.typing.breakProbability': '「中途插话概率」（桥侧掷骰）：每次唤醒掷一次骰子，命中就**不等 ta 打完**、按正常节奏接话 —— 这是"智能接话"的来源。0 = 绝不抢话，只等对方停；0.15 = 偶尔接（默认）；0.5 以上 = 多半会接。',
  'social.typing.refreshOnMessageMs': '「收到消息后续多久」：QQ 的输入状态事件并不可靠（有时只在开始/结束各来一次），所以收到对方一条消息就认为"他还在打字"，把状态再续这么久（默认 5000 毫秒）。这就是"对方不停发消息时打字状态一直是连续的"的实现方式。',
  // —— 表情包 ——
  'social.sticker.enabled': '表情包总开关。开着：机器人会用你 QQ 的收藏表情回消息（接梗、赞同、晚安等场合）；关掉：只用文字聊天。',
  'social.sticker.syncTtlMs': '隔多久向 QQ 同步一次收藏表情（毫秒）。同步一次够用很久，不用每条消息都去拉，调小只会更频繁地刷新、多花资源。',
  'social.sticker.maxListCount': '一次最多同步多少个收藏表情。收藏很多时建议保持默认，太多了反而拖慢。',
  'social.sticker.includeInPrompt': '把“你有哪些表情、备注是什么”写进发给 AI 的提示里。开着 AI 才知道该用哪个表情；关掉它会“盲发”。',
  'social.sticker.promptMaxStickers': '提示里最多列出几个表情。列太多会占 token；够 AI 挑就行了。',
  'social.sticker.maxRemarkChars': '「表情备注字数上限」：AI 给**已有收藏表情**写备注（挑表情时看的就是这句描述）时最多写多少个字。备注越准，下次越知道这表情适合什么场合。它和「自动收藏」那一组里的「收藏备注字数上限」不是一回事：那个只管新收藏进来的表情。',
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
  /* ================= 【2026-09-18】为「界面不许出现英文键」补齐的说明 =================
     这些键以前管理端没有卡片、也没写说明，所以只有"标签"没有"解释"；现在逐个补上，
     统一写清三件事：它管什么、默认值、桥里的键名（审计脚本按标签表查，说明是给主人看的）。 */
  // —— 已废弃的旧发送节奏键（老配置里很可能还留着，读了也不生效）——
  'social.send.linearBaseMs': '已废弃（老版的"首条气泡延迟"，桥里的键名 social.send.linearBaseMs）。'
    + '桥现在只剩「按字数」一套打字节拍：第 1 条气泡立即发，第 2 条起按字数等。这个键写了也不生效，留着只为兼容老配置文件；'
    + '要调节奏请改用「按字数打字节拍 / 每个字的打字时间 / 两条气泡最小间隔 / 两条气泡最大间隔 / 打字速度抖动 / 静默后重新秒回」。',
  'social.send.linearStepMs': '已废弃（老版的"每条递增间隔"，桥里的键名 social.send.linearStepMs），桥不读它、写了也不生效；替代项是「每个字的打字时间」。',
  'social.send.gapBaseMs': '已废弃（老版的"间隔基数"，桥里的键名 social.send.gapBaseMs），桥不读它、写了也不生效；替代项是「两条气泡最小间隔」。',
  'social.send.gapPerCharMs': '已废弃（老版的"每字追加间隔"，桥里的键名 social.send.gapPerCharMs），桥不读它、写了也不生效；替代项是「每个字的打字时间」。',
  'social.send.gapJitterRatio': '已废弃（老版的"间隔抖动比例"，桥里的键名 social.send.gapJitterRatio），桥不读它、写了也不生效；替代项是「打字速度抖动」。',
  'social.burstIntervalMinMs': '已废弃（老版的"连发间隔下限"，桥里的键名 social.burstIntervalMinMs），桥不读它；连发间隔现在由「按字数打字节拍」那一组决定。',
  'social.burstIntervalMaxMs': '已废弃（老版的"连发间隔上限"，桥里的键名 social.burstIntervalMaxMs），桥不读它；连发间隔现在由「按字数打字节拍」那一组决定。',
  burstIntervalMinMsLegacy: '更旧的键名（桥里的键名 burstIntervalMinMsLegacy），任何版本都不生效。看到它说明这份配置是从很旧的版本抄过来的，'
    + '可以在「JSON 进阶」页直接删掉。',
  // —— NapCat 会话守护（guard）：定期探活、假死就重启容器自愈 ——
  'guard.enabled': 'NapCat 会话守护总开关（桥里的键名 guard.enabled，默认开）。开着的时候桥会定期探一次活：'
    + '探针优先用 NapCat 的 get_rkey（它每次都真的请求 QQ 服务器、对别人不可见），连续失败达到阈值就判定"会话假死"并重启容器自愈。'
    + '若该平台的 get_rkey 自身有结构性故障（接口直接抛错，与掉线无关），守护会自动固定改用 get_status 判定在线状态 —— '
    + '这时管理端「会话守护」卡里会写一句静态说明，探活照常进行，不需要你处理。',
  probeIntervalMs: '探活间隔（毫秒，桥里的键名 guard.probeIntervalMs，默认 60000 = 1 分钟）：每隔这么久探一次活。'
    + '调密了会频繁打扰 QQ 服务器，一般不用动。',
  failThreshold: '连续失败几次判定假死（桥里的键名 guard.failThreshold，默认 2）：达到这个次数才动手自愈，避免网络抖一下就把容器重启了。',
  cooldownMs: '自愈冷却（毫秒，桥里的键名 guard.cooldownMs，默认 600000 = 10 分钟）：一次自愈之后这么久内不再重复自愈，防止反复重启。',
  maxHealsPerHour: '每小时最多自愈几次（桥里的键名 guard.maxHealsPerHour，默认 3）：超过就只记录告警，不再自动重启。',
  restartGraceSec: '重启宽限（秒，桥里的键名 guard.restartGraceSec，默认 60）：重启容器时留给 QQ 客户端的退出时间，给太短容易掉登录态。',
  recoverWaitMs: '重启后等待恢复（毫秒，桥里的键名 guard.recoverWaitMs，默认 150000 = 2.5 分钟）：重启完先等这么久，再探活确认是不是真的恢复了。',
  autoHeal: '自动重启自愈（桥里的键名 guard.autoHeal，默认 null = 自动判断）：null 表示"容器配了免扫码回退登录（NAPCAT_QUICK_PASSWORD_MD5）才自动重启"，'
    + '没配就只记录告警、不动手（免得把机器人推到必须扫码的状态）；true = 总是自动重启；false = 只告警不重启。',
  // —— 空闲会话自动归档（social.sessionArchive）——
  'social.sessionArchive.enabled': '空闲会话自动归档开关（桥里的键名 social.sessionArchive.enabled，默认开）：把闲置太久的 DSH 会话归档，'
    + '避免常驻会话越堆越多、上下文越滚越大。归档不是删除：会话文件还在桥的 state 目录下，需要时会被重新唤醒。',
  intervalMs: '巡检间隔（毫秒，桥里的键名 social.sessionArchive.intervalMs，默认 600000 = 10 分钟）：桥每隔这么久巡检一次有没有该归档的会话。',
  idleMinutes: '闲置多少分钟算空闲（桥里的键名 social.sessionArchive.idleMinutes，默认 30）：超过这个时长、而且当前没有回合在跑的会话才会被归档。',
  batchMax: '单批最多归档几个（桥里的键名 social.sessionArchive.batchMax，默认 20）：一次巡检最多处理这么多，避免集中归档把桥卡住。',
  pruneDays: '归档保留天数（桥里的键名 social.sessionArchive.pruneDays，默认 0 = 不清理）：大于 0 时，归档超过这么多天的会话文件会被删掉；'
    + '填 0 就是只归档、永不删除。',
  // —— 反馈上报（social.feedback）——
  maxLength: '反馈字数上限（桥里的键名 social.feedback.maxLength，默认 500）：机器人通过「反馈给主人」工具发来的内容最长多少字，超了会被截断。',
  notifyOwnerOnError: '出错时通知主人（桥里的键名 social.feedback.notifyOwnerOnError，默认关）：开着的时候机器人自己遇到错误会主动私聊告诉你。',
  // —— 黑话学习（slang）：目前的管理端没有单独开这张卡，键照样登记，需要时可在「JSON 进阶」里改 ——
  'slang.enabled': '黑话学习开关（桥里的键名 slang.enabled，默认开）：关掉后桥会跳过所有黑话学习任务，聊天里发 /slang learn 也不会跑。',
  extractMinMessages: '凑够几条消息才提取（桥里的键名 slang.extractMinMessages，默认 10）：一小段语料里消息太少就不值得跑一次模型，直接跳过。',
  extractCooldownMs: '两次提取的最小间隔（毫秒，桥里的键名 slang.extractCooldownMs，默认 300000 = 5 分钟）：防止短时间内反复提取把额度烧掉。',
  inferenceThresholds: '推断阈值（桥里的键名 slang.inferenceThresholds，默认 [2,4,8]）：一个词出现到这些次数时，触发不同深度的考究；数字越小的门槛越容易触发。',
  injectMax: '最多注入几条黑话（桥里的键名 slang.injectMax，默认 8）：唤醒提示里最多带上几条学到的黑话，避免把提示词撑大。',
  injectIntoPrompt: '把黑话写进提示词（桥里的键名 slang.injectIntoPrompt）：开着 = 模型每次都能看到学到的黑话；关掉 = 只有主动查询工具能读到。',
  learnerPreset: '学习会话的人设预设（桥里的键名 slang.learnerPreset）：黑话学习是单独起一个 DSH 会话跑的，这里指定它用哪套预设。',
  'slang.workspaceTitle': '学习工作区名称（桥里的键名 slang.workspaceTitle）：给黑话学习的那个会话工作区起的名字，只是显示用，不影响行为。',
  autoResearch: '自动联网考究（桥里的键名 slang.autoResearch，默认开）：提取到新词后自动联网查它的含义，查不到就留成"未确认"等下次。',
  charactersDir: '角色库目录（桥里的键名 social.charactersDir）：一个角色 = 一个子目录 = 一个角色包（SKILL.md / personality.md / manifest.json 等）。'
    + '出厂自带 21 个角色包（另有 1 个散装卡）；留空 = 用默认目录（用户主目录下的 Downloads/characters/characters）。四个角色卡工具都**只读**这个目录，不会写盘。',
  // —— 内置表情包（social.meme）：三处包目录 + 角色绑定 ——
  'social.meme': '内置表情包（桥里的键名 social.meme）：一份表情包 = 一个目录（manifest.json + index.db + memes/<分类>/图片）。'
    + '桥会同时认三个位置：出厂包（运行目录 meme/）、后装与上传的包（运行目录 meme-packs/）、角色专属包（角色库里的 <角色>/meme-packs/）。通常不用手改这一段，'
    + '在「常用设置」的「内置表情包」卡里上传与勾选即可。',
  'social.meme.enabled': '内置表情包总开关（桥里的键名 social.meme.enabled，默认开）：关掉时 qq_meme_search / qq_send_meme **干脆不注册**给模型'
    + '（工具列表里直接消失、描述不再占额度），不是到调用时才拒绝。',
  'social.meme.packs': '只搜这几个表情包（桥里的键名 social.meme.packs）：填包 id 数组（如 ["whale-fanart-001"]）；'
    + '留空 = 出厂包 + 上传的包 + 角色专属包全都搜。非空时除了点名的包，当前角色绑定的包也一定在搜索范围里。',
  'social.meme.personaPacks': '角色专属表情包绑定（桥里的键名 social.meme.personaPacks）：形如 {"atri": ["atri-pack-001"]}。'
    + '两份包里有同名表情时，优先用这里绑定的那一份。一般不用手写，在「内置表情包」卡里按角色勾选。',
  'social.meme.activePersona': '当前角色（桥里的键名 social.meme.activePersona）：记最近一次从角色库导入进 persona.md 的角色，用来决定哪份角色专属表情包排最前。'
    + '由管理端导入角色卡时自动写入，不用手改。',
  // —— 同名键按路径区分说明 ——
  'social.agentPreset': '社交会话用的人设预设（桥里的键名 social.agentPreset，默认 default）：只作用于社交模块建的会话；'
    + '「基础与会话」里那个同名的项是全局预设，两个都在时以社交模块这个为准。',
  'social.slimTools.enabled': '启用精简名单（桥里的键名 social.slimTools.enabled）：打勾 = 名单里的工具干脆不注册给模型，它的 JSON 描述从每一次请求里彻底消失（真省额度）；'
    + '不打勾 = 全部正常注册。工具表只在隔离 DSH 启动时取一次，所以改完必须重启隔离 DSH。',
  'social.slimTools.deny': '不注册给模型的工具名单（桥里的键名 social.slimTools.deny）：里面写的是 MCP 工具原名（形如 mcp__napcat__qq_send_message），'
    + '必须与桥侧注册的名字逐字一致，写错了不报错但也不生效。',

  /* ══════════════════════════════════════════════════════════════════════════════════════
   * 【2026-09-19 主人要求："说明文档里给每一个配置输入框加上详细说明"】
   * 上面那些是历史上逐条加的（只挑了对新手不友好的）。下面这段把**其余全部配置键**补齐，
   * 做到"每一个输入框点 ⓘ 都有话说"；工具与规则里的每一个工具开关也逐条写了"打开后模型就能做什么"。
   * 维护约定：以后新增配置键，必须同时在这里补一条 —— 有 tools/audit-config-help.mjs 可以审计覆盖率
   * （它会拿 config.example.json + 本机 config.json 的键去比对这张表，缺了就退出码 1）。
   * ══════════════════════════════════════════════════════════════════════════════════════ */

  // ── 顶层分组（卡片标题）──
  dsh: '隔离 DSH（模型执行器）这一段：跑什么厂商、什么模型、推理档位、超时，以及隔离实例与 DSH CLI 的位置。改完由管理端同步进隔离 DSH 的 settings.yaml 并重启它才生效。',
  napcat: 'NapCat（QQ 协议端）这一段：OneBot 的 WebSocket / HTTP 地址与令牌、NapCat 安装位置、图片落盘的临时目录与容器路径映射。这里的 accessToken / wsAccessToken 不在这张卡里改，去「NapCat 鉴权令牌」那张卡（它会同时写 NapCat 自己的配置并重启 NapCat）。',
  pixiv: 'Pixiv 相关的两项：镜像站地址（qq_pixiv_search / qq_send_pixiv 兜底用）与可选的登录 cookie（只为了"按画师名字搜人"）。按画师号、按作品链接发原图都不需要 cookie。',
  guard: 'NapCat 会话守护：定期探活，连续失败就判定"会话假死"并尝试重启 NapCat 自愈（默认只在配了免扫码回退登录时才自动重启，否则只告警）。',
  slang: '黑话学习：从聊天里抽取群内黑话/缩写并沉淀成词表，模型写回复时可以自然用上。抽多少条才触发、多久抽一次、注入多少条都在这里。',
  social: '社交行为总段：唤醒、发送节奏、上下文与轮换、表情包、主动闲聊、等待、打字等待、投递与回合、活跃时段、工具开关都在这一段下面。social.enabled 是总开关。',
  'social.tools': '工具开关：里面每一个键对应一个 MCP 工具（名字是桥侧注册的工具名去掉 qq_ 前缀的驼峰形式）。关掉 = 该工具不注册、模型看不到它。',
  'social.wake': '唤醒与潜水：机器人什么时候被叫醒、默认潜水还是活跃、推荐的沉睡时长/概率/关键词、唤醒频率上限。@、叫名字、提问、拍一拍这类"被直接叫到"的永远会唤醒。',
  'social.send': '发送节奏与限额：一次最多几条、单条多少字、条间间隔、每分钟/每小时最多发几条、长间隔概率。这里直接决定"会不会刷屏"。',
  'social.wait': '等待工具（qq_wait_for_messages）的默认与上下限：默认等多久、最短多久、收到新消息后至少再静默多久。等太久容易把一回合拖成几分钟。',
  'social.sticker': '表情包：总开关、收藏表情同步间隔、列表上限、是否把可用表情写进提示词、提示词里最多列几张。',
  'social.sticker.collect': '自动收藏：模型看到语境内合适的表情时自动存进收藏库的节流（每分钟/每小时最多几张）。',
  'social.proactive': '主动闲聊：没人说话时机器人自己找话题的间隔与概率。间隔是随机区间，概率 0 = 永远不主动。',
  'social.feedback': '反馈（qq_report_feedback）：模型把"这次回复效果好不好"上报回桥的通道，以及要不要在出错时通知主人。',
  'social.context': '上下文窗口：唤醒时给模型贴多少条近期消息、未读最多带几条、轮换后第一轮给多长的窗口。这三个直接决定 token 成本。',
  'social.autoReset': '会话轮换（换新会话、避免上下文越拖越长）：聊多少轮之后换、换完第一个回合给多少条历史、提前预热几个会话。',
  'social.sessionArchive': '会话归档：闲置多久把 DSH 会话归档、多久巡检一次、一次最多归档几个、保留多少天。',
  'social.turnHold': '回合保持：一段连续对话里让 DSH 会话保持"在回合中"，省掉每次重新唤醒的整轮开销。私聊专用，有最大来回数与空闲关闭时间。',
  'social.typing': '私聊打字等待：对方还在打字时先等一下再回（最多等多久、多久刷新一次、多大概率打断直接回）。',
  'social.docx': 'Word 文档（qq_send_docx）：每天能生成/发送多少篇、单篇多少字、临时目录。',
  'social.deepsleep': '静默群聊：打勾 = 这些群的消息完全不处理（连唤醒都不排），用来临时闭嘴。',
  // social.steerEnabled 的说明历史上已经有了（上面那条长说明），这里不再重复登记，否则 TS 会报重复键。

  // ── 基础与会话 ──
  ownerQQ: '主人 QQ。填上之后这个人的私聊带 [OWNER] 标记、可以用自然语言改配置、能用主人专属工具；留空 = 没有主人（谁都不是主人）。必须是机器人能看到消息的 QQ 号。',
  adminQQ: '额外的管理员 QQ 列表（可以多人）。这些人能下管理命令（加白名单、静默等），但不能改配置、也不是主人。',
  agentPreset: '默认 agent 预设名（preset）：决定系统提示词的骨架。social.agentPreset 是聊天用的那个，两个都在时以社交模块的为准。',
  workspaceTitle: 'DSH 工作区标题（显示在会话列表里，纯展示用，不影响行为）。',
  ackMessage: '收到消息先回一条的"垫话"（例如"🤔 收到，正在思考…"）。留空 = 不垫，直接等正式回复。',
  sendDelayMs: '每条消息之间的基础延迟（毫秒）。0 = 立即发；调大像打字慢一点。',
  questionTimeoutMs: '需要用户回答的提问（审批/选择）最多等多久，超时就当没答复继续走。',
  'security.interceptNotify': '安全拦截通知：命中敏感词/危险指令被拦下时，要不要在会话里说一声（不打勾就静默拦）。',

  // ── 名单 ──
  allow: '允许名单：**只有**名单里的会话会被处理（发消息、唤醒、回复）。名单为空时看下面三个"放行开关"。黑名单永远优先。',
  'allow.private': '允许的私聊 QQ 号。一行一个/逗号分隔。空 + 没开放行开关 = 任何私聊都不处理。',
  'allow.groups': '允许的群号。空 + 没开放行开关 = 任何群都不处理（机器人等于闭嘴）。',
  deny: '黑名单：命中就一律不处理，即使同时在允许名单里也拦（拉黑优先）。',
  'deny.private': '拉黑的 QQ 号：不处理其私聊，也不会被加好友/拉人。',
  'deny.groups': '拉黑的群号：这些群的消息完全不理。',

  // ── NapCat 连接 ──
  'napcat.httpUrl': 'NapCat 的 OneBot HTTP 接口地址（桥用它发消息、查状态）。本机部署通常是 http://127.0.0.1:3000。',
  'napcat.wsUrl': 'NapCat 的 OneBot 反向/正向 WebSocket 地址（桥用它接收消息事件）。本机部署通常是 ws://127.0.0.1:3001。改错的表现是"连接成功但收不到任何消息"。',

  // ── Pixiv ──
  'pixiv.base': 'Pixiv 第三方镜像站地址（只在"官网直连失败"时兜底，官方的 ajax 接口其实免登录可用；镜像站慢一些：同一张图 2.7~5.7 秒）。留空 = 用内置默认 https://x.pixigraph.xyz。',
  'pixiv.cookie': 'Pixiv 登录 cookie（PHPSESSID）：**只为一件事** —— 按画师**名字**搜人（官网的用户搜索接口对匿名请求一律 400）。免费号即可；填一次就行：每解出一个画师号都会落盘缓存（state/pixiv-artists.json），cookie 以后过期了，查过的名字照样能用；真过期时桥会自检并主动在 QQ 里提醒你。不填也能用 authorId（画师号，如 1554775）或作品链接。安全：只发给 pixiv 自己的域名，绝不发给镜像站；写入请用 tools/set-pixiv-cookie.mjs（从文件读、写完删文件、只回显掩码）。',

  // ── 工具开关（逐个写清"打开后模型能做什么"）──  'social.tools.getPrompt': '读提示词（qq_get_prompt）：模型主动重新读一遍当前生效的人设/发言规则/工具说明。一般不用它，但它能让模型自查"我现在的人设是什么"。',
  'social.tools.getUnread': '读未读（qq_get_unread）：取还没处理的消息。关掉后模型只能靠唤醒正文里带的未读内容。',
  'social.tools.getRecent': '读最近消息（qq_get_recent_messages）：按会话翻最近若干条历史，包括自己发过的。追旧话题时要用。',
  'social.tools.socialState': '查社交状态（qq_social_state）：当前潜水/活跃、下次唤醒时间、限额用了多少。排障时最有用。',
  'social.tools.sendGroup': '发群消息（qq_send_group_message）：向白名单内的群发文本。关掉 = 模型不能在群里说话。',
  'social.tools.sendPrivate': '发私聊消息（qq_send_private_message）：向白名单内的 QQ 发文本。',
  'social.tools.reply': '引用回复（qq_reply）：带引用地回某条消息（QQ 里显示"回复 xxx"）。',
  'social.tools.sendBurst': '连发（qq_send_burst）：一次调用发多条气泡，条间按打字节奏自动延迟——"像人一样分条发"。',
  'social.tools.sendMessage': '统一发送（qq_send_message）：最常用的发送入口，支持 text + images + 引用 + @，也支持多条。',
  'social.tools.waitMessages': '等待新消息（qq_wait_for_messages）：沉睡前先观察一段时间；也可以用 triggers 等特定的人/关键词。',
  'social.tools.feedback': '反馈（qq_report_feedback）：把"这次回得好不好/哪里出了问题"上报回来，供后续学习与排障。',
  'social.tools.getMyRecent': '读自己最近说的话（qq_get_my_recent_messages）：避免重复、保持一致。',
  'social.tools.getMessageDetail': '查单条消息详情（qq_get_message_detail）：引用/转发/图片等结构拆解，排障用。',
  'social.tools.getActiveMembers': '查活跃成员（qq_get_active_members）：群里谁最近在说话，决定 @ 谁。',
  'social.tools.setWakeConfig': '设置唤醒条件（qq_set_wake_config）：潜多久、什么条件唤醒（@/名字/关键词/提问/拍一拍），每轮收尾都要调一次。',
  'social.tools.markRead': '标记已读（qq_mark_read）：推进已读水位，避免同一条消息被反复处理。',
  'social.tools.memory': '记忆（qq_memory_append/search 等）：把长期事实写进记忆库、需要时搜出来。',
  'social.tools.slangQuery': '查黑话（qq_slang_query）：这个词群里是什么意思。',
  'social.tools.slangSubmit': '提交黑话（qq_slang_submit）：学到新词时上报给黑话库。',
  'social.tools.getImages': '读消息里的图（qq_get_message_images）：取回图片内容再交给模型看。关掉后图片消息只剩占位文字。',
  'social.tools.getForwardMsg': '读合并转发（qq_get_forward_msg）：把转发聊天记录展开成可读文本。',
  'social.tools.sendPoke': '拍一拍（qq_send_poke）：戳一下对方。',
  'social.tools.listStickers': '列收藏表情（qq_list_stickers）：看自己收藏了哪些表情（含备注），挑一张来发。',
  'social.tools.getStickerImage': '看表情图（qq_get_sticker_image）：把某张收藏表情取回来给模型看，避免瞎发。',
  'social.tools.sendSticker': '发收藏表情（qq_send_sticker）：把收藏里的某张发出去。',
  'social.tools.setStickerRemark': '给表情写备注（qq_set_sticker_remark）：把"这张适合什么场合"记下来，下次选得更准。默认关（属于整理动作，日常用不上）。',
  'social.tools.stickerNote': '表情学习笔记（qq_sticker_note）：看到新表情时记下自己的理解。',
  'social.tools.collectSticker': '收藏表情（qq_collect_sticker）：把别人发的、语境内好用的表情存进自己的收藏库。',
  'social.tools.getSelfImage': '取自己的形象图（qq_get_self_image）：assets/deepseek娘.png，需要发自拍/头像时用。',
  'social.tools.characterCards': '角色库（qq_character_list/read/pack/search）：读 characters 目录下的角色卡，做角色扮演时用。',
  'social.tools.faceList': 'QQ 原生表情表（qq_face_list）：列出可用的 QQ 大表情/小表情及含义，挑一个发。',
  'social.tools.sendQqFace': '发 QQ 原生表情（qq_send_qq_face）：发内置大表情（比自己写 emoji 自然得多）。',
  'social.tools.musicSearch': '点歌搜索（qq_music_search）：按关键词搜歌，拿到 musicId 后用 qq_send_rich 发音乐卡片。',
  'social.tools.sendRich': '发卡片/音乐（qq_send_rich）：音乐卡（网易云/QQ音乐）、名片、骰子等富消息。音乐卡只传 musicId，标题/封面/音频由桥自己拼，手写 JSON 会导致手机端空白卡。',
  'social.tools.imageSearch': '联网找图（qq_image_search）：按关键词搜图片（Bing/百度），能把结果图直接发出去——不知道用什么图时用它。',
  'social.tools.videoSearch': '视频解析（qq_video_parse）：把 B 站/抖音等分享链接解析成可发的内容（B 站会发小程序卡片）。',
  'social.tools.sendForward': '发合并转发（qq_send_forward）：把多条消息打包成"聊天记录"一次发出。',
  'social.tools.scheduleMessage': '定时消息（qq_schedule_message）：约定"几点提醒你"这类场景。',
  'social.tools.withdrawMessage': '撤回消息（qq_withdraw_message）：发错了可以撤回（需要 messageId）。',
  'social.tools.historyDelete': '删单条历史（qq_history_delete）：把某条消息从桥的会话历史里删掉（只删桥的记录，不删 QQ 上的）。',
  'social.tools.historyClear': '清空历史（qq_history_clear）：清掉整个会话的历史记录，重置上下文。影响面大，默认关。',
  'social.tools.memorySearch': '搜记忆（qq_memory_search）：在长期记忆库里检索相关条目。',
  'social.tools.globalOverview': '全局概览（qq_global_overview）：一次看到所有会话的未读/状态，忙的时候很省 token。',
  'social.tools.qzone': 'QQ 空间（qq_qzone_*）：看/发说说、点赞评论。默认关（对外发布动作，谨慎开）。',
  'social.tools.sendDocx': '发 Word 文档（qq_send_docx）：长文/报告转成 .docx 发文件，不走聊天正文。',
  'social.tools.getFileContent': '读群文件（qq_get_file_content）：下载并读取群文件/收到的文件内容，需要模型看文档时用。',

  // ── 唤醒 ──
  'social.wake.defaultMode': '默认模式：diving = 潜水（按触发条件才醒）/ active = 活跃（群里说什么都接）。单会话可以用 /set active 或 /set diving 覆盖（也能带时段，如 /set diving 00:00-21:00）。',
  'social.wake.preSleepWaitEnabled': '沉睡之前先观察：开启后 qq_wait_for_messages 会先等一个安静窗口，确认没人说话再睡，避免刚睡下就被叫醒。',
  'social.wake.recommendedDefaultInfinite': '给模型的推荐值：是否建议"无限期潜水"（自己判断该醒时再醒）。这只是提示词里的建议，不是强制。',
  'social.wake.sleepMinMs': '允许的最短沉睡时长（毫秒）：模型想睡太短时会被顶到这里的下限。',
  'social.wake.sleepMaxMs': '允许的最长沉睡时长（毫秒）：0 = 不限制（可以睡到无限期）。',
  'social.wake.recommendedSleepMinMs': '推荐沉睡时长下限（毫秒）：写进提示词，引导模型别睡太频繁。',
  'social.wake.recommendedSleepMaxMs': '推荐沉睡时长上限（毫秒）：写进提示词。',
  'social.wake.recommendedProbability': '推荐"随机被唤醒"概率：模型沉睡时，普通消息有多大概率把它叫醒。0.05 = 二十分之一。',
  'social.wake.recommendedAtMention': '推荐开关：被 @ 时唤醒。建议常开。',
  'social.wake.recommendedNameMention': '推荐开关：消息里叫到机器人名字时唤醒。',
  'social.wake.recommendedQuestion': '推荐开关：有人在提问时唤醒。',
  'social.wake.recommendedPoke': '推荐开关：被拍一拍时唤醒。',
  'social.wake.batchWindowMs': '唤醒合批窗口（毫秒）：这段时间内的多条消息合成一批一起交给模型，避免"每来一条就唤醒一次"。',
  'social.wake.maxWakePerMinute': '每分钟最多唤醒几次：超了排队（防抖/防循环）。',
  'social.wake.maxWakePerHour': '每小时最多唤醒几次：成本刹车。',
  'social.wake.noActionLimit': '连续几次唤醒都没做任何动作（既不回也不设置唤醒条件）就强制提醒/收尾，防"空转烧 token"。',
  'social.wake.maxWakeConfigReminders': '同一回合最多提醒几次"你还没设置唤醒条件"。',
  'social.wake.maxWakePerMinutePrivate': '**私聊**每分钟最多唤醒几次（默认 12）：私聊是主人自己找上门，允许比群聊密一些。',
  'social.wake.maxWakePerHourPrivate': '**私聊**每小时最多唤醒几次（默认 0 = 不限）：私聊默认不设小时上限，防止主人半夜说话被挡。',

  // ── 发送节奏 ──
  'social.send.burstEnabled': '允许一次发多条气泡：关掉 = 只能发一条（模型硬要发多条会被拒）。',
  'social.send.burstMaxMessages': '一次最多几条气泡：超过直接拒绝。',
  'social.send.longGapProbability': '出现"长间隔"的概率：模拟"打了一半停一下再发"的真人节奏。',
  'social.send.longGapMinMs': '长间隔的最小毫秒数。',
  'social.send.longGapMaxMs': '长间隔的最大毫秒数。',
  'social.send.maxSendPerMinute': '每分钟最多发几条消息（跨会话合计），0 = 不限。超了直接拒绝并结束回合。',
  'social.send.maxSendPerHour': '每小时最多发几条，0 = 不限。被垃圾回复刷屏时的兜底刹车。',
  'social.send.maxMessageChars': '单条消息最多多少字：超了拒绝（防止一句话糊满整屏）。',
  'social.send.maxGapMs': '条间最大间隔（毫秒）：上限，防止节奏参数配得过大把一回合拖很久。',

  // ── 让"审计"一次过：分组键也给一条（有些卡片会把分组键名显示成标题旁的ⓘ）──
  'social.sticker.collect.maxRemarkChars': '「收藏备注字数上限」：自动收藏一张**新**表情时顺手写的那句备注最多几个字（太长会很啰嗦）。与卡里单列的「表情备注字数上限」分开管：那个管已有收藏的表情，这个只管新收藏进来的。',
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
  // 【2026-09-21】[Style] 语感行 + /token 计价参数（两者都在「Core 设置」的通用页签里可改）
  'prompt.styleLine': '每轮语感提醒（[Style] 行）',
  'tokenCost.pHit': '缓存命中单价（¥/百万 tok）',
  'tokenCost.pMiss': '未命中输入单价（¥/百万 tok）',
  'tokenCost.pOut': '输出单价（¥/百万 tok）',
  'tokenCost.peakMult': '高峰时段倍率',
  'tokenCost.peakHours': '高峰小时（北京时）',
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
  'prompt.styleLine': '留空 = 不注入这一行',
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
  /** 【2026-09-19 修「读失败时整页空白」】以前 load() 没有 try/catch：读配置抛错（config.json 损坏、
   *  服务端没连上、接口 500）时 cfg 一直是 null，而每个页签都是 `cfg && <Tab/>` 写法 ——
   *  于是页面只剩页签栏，一个字都不说，看起来像"配置页坏了"。现在错误有地方落：一条可重试的提示。
   *  注意这跟"桥有没有在跑"无关：这份配置读的是磁盘上的 qq-bridge/config.json。 */
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [persona, setPersona] = useState('');
  const [speechRules, setSpeechRules] = useState('');
  const [personaHasFile, setPersonaHasFile] = useState(false);
  const [speechHasFile, setSpeechHasFile] = useState(false);
  /** 隔离 DSH 里「语言模型密钥」到底配没配（后端只回 {env, from, set, len}，**不含密钥本身**） */
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(null);
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

  /** load() 的序号：晚到的旧响应不许覆盖新响应（详见下面 refresh 的注释） */
  const loadSeq = useRef(0);

  /**
   * 读配置。
   * @param opts.forceRefresh 服务端模式下绕过后端 45 秒预热缓存（保存之后必须用）
   *
   * 【2026-09-19 修"点保存、切出去回来又变回去，第二次点保存才真的生效"】
   * 后端对服务端配置有一份预热缓存；POST 写入后只 delete 缓存、不做代次校验，于是
   * "写入之前发出的那次预热"可能**在写入之后**把旧内容塞回缓存 —— 紧接着的这次重载就读到旧值。
   * 现在两头都堵：保存后的重载带 refresh=1（后端也改成 refresh=1 时不复用正在飞的预热），
   * 且这里给 load 加了序号保护，避免旧请求后到把新值覆盖回去。
   */
  const load = async (opts: { forceRefresh?: boolean } = {}) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadErr('');
    try {
      // 连上服务器 → 读**服务端** /root/qq-bridge/config.json（经已有 SSH 连接，不新建连接）
      const r: any = remote
        ? await getRemoteBridgeConfig(remote.id, { refresh: opts.forceRefresh === true })
        : await getBridgeConfig();
      if (seq !== loadSeq.current) return;   // 已经有更新的读取在路上了，丢弃这份旧结果
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
      if (c.dsh.visionBaseUrl === undefined) c.dsh.visionBaseUrl = '';
      if (c.dsh.visionApiKey === undefined) c.dsh.visionApiKey = '';
      if (!c.dsh.model) c.dsh.model = '';
      if (!c.dsh.provider) c.dsh.provider = '';
      /* 上下文治理：老配置里没有这一段，也要把输入框画出来（缺键时按默认值显示，保存即落盘）。
       * 服务端模式同理 —— 远程 config.json 里没有这些键时不补，卡片就是空的。 */
      if (!c.dshCompaction || typeof c.dshCompaction !== 'object') c.dshCompaction = {};
      const dc = c.dshCompaction;
      if (dc.enabled === undefined) dc.enabled = true;
      /* 【2026-09-21 修】这里原来回填 0.12/0.03，而桥侧默认（qq-bridge/src/core/config.js）是 0.08/0.02 ——
       * 老配置打开这张卡再点保存，就等于把"上下文治理"悄悄放宽回 0.12：上下文长期停在 ~11.7 万 token，
       * 实测"一句话 1 分钱"。回填值必须与服务端默认逐字一致，否则界面本身就是个改错值的陷阱。 */
      if (dc.thresholdRatio === undefined) dc.thresholdRatio = 0.08;
      if (dc.retainRatio === undefined) dc.retainRatio = 0.02;
      if (dc.toolResultMaxChars === undefined) dc.toolResultMaxChars = 8192;
      if (dc.summarizationProvider === undefined) dc.summarizationProvider = '';
      if (dc.summarizationModel === undefined) dc.summarizationModel = '';
      /* 【2026-09-21】提示词可调项：`prompt.styleLine` 是唤醒正文每轮那句语感提醒，
       * 缺键时要把输入框画出来（否则老配置打开这张卡是空的）。 */
      if (!c.prompt || typeof c.prompt !== 'object') c.prompt = {};
      if (c.prompt.styleLine === undefined) c.prompt.styleLine = '[Style] 说人话：短、有态度，别讲课别列举';
      /* 【2026-09-21】/token 计价参数（¥ / 百万 tok），默认值与管理端「学习」页实测区同源。 */
      if (!c.tokenCost || typeof c.tokenCost !== 'object') c.tokenCost = {};
      const tc = c.tokenCost;
      if (tc.pHit === undefined) tc.pHit = 0.02;
      if (tc.pMiss === undefined) tc.pMiss = 1;
      if (tc.pOut === undefined) tc.pOut = 4;
      if (tc.peakMult === undefined) tc.peakMult = 2;
      if (tc.peakHours === undefined) tc.peakHours = [9, 10, 11, 14, 15, 16, 17];
      if (!c.social) c.social = {};
      if (!c.social.autoReset || typeof c.social.autoReset !== 'object') c.social.autoReset = {};
      if (c.social.autoReset.permanent === undefined) c.social.autoReset.permanent = false;
      // 「语言模型密钥」的真实状态（在隔离 DSH 的凭据文件里，不在 config.json 里）
      setApiKeyStatus((r as any).apiKeyStatus || null);
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
    } catch (e: any) {
      // 【2026-09-19】读失败必须说出来。以前这里会直接抛出 promise 未处理，cfg 一直是 null，
      // 每个页签又都是 `cfg && <Tab/>`，于是页面变成"只有页签栏"的空壳 —— 连"读失败了"都不显示。
      setLoadErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
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
      // 「语言模型密钥」的落地结果要单独说清楚：它不在 config.json 里，而是写进隔离 DSH 的凭据文件
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
      // 【2026-09-19】保存后的这次重载**必须**绕过服务端预热缓存，否则会把"写之前的旧值"读回来 ——
      // 主人看到的就是"点了保存、切出去再回来又变回去了，得再点一次保存才真的生效"。
      await load({ forceRefresh: target === 'remote' });
    } catch (e: any) { setMsg('保存失败：' + (e?.message || '')); }
    finally { setSaving(false); }
  };

  /** 清除隔离 DSH 凭据文件里的那条密钥（界面上的输入框是密码框，看不出"到底配没配"，
   *  所以给一个显式清除入口；后端只删这一行，文件里 DSH 自己写的其它块原样保留）。 */
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
        <NoticeBar msg={msg} onClose={() => setMsg(null)} />

        {/* 【2026-09-19 主人要求】"哪个要单独点保存、哪个点顶部保存就行"以前只散落在各卡片的说明里，
            没有一处总览 —— 于是很自然会出现"改了某一项、以为顶部保存会一起存进去"的误会。
            这里给一张总览；卡片自身会用「保存这个 / 保存人设 / 保存发言规则」等按钮明确标出来。 */}
        <details className="notice-bar" style={{ display: 'block' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
            保存规则总览：哪些点顶部「保存」就行，哪些卡片要自己点一次保存
          </summary>
          <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.85 }}>
            <div><b>点顶部「保存」</b>（写整份 <code>config.json</code>）：常用设置里的全部字段 —— 模型/厂商、NapCat 地址与路径、基础与会话、允许/拒绝名单、
              唤醒与潜水、发送节奏、上下文与轮换、主动闲聊、等待、打字等待、表情包参数、静默群聊、投递与回合、好友申请、Word 额度，
              以及「工具与规则」里的工具开关和工具 schema 精简。</div>
            <div style={{ marginTop: 4 }}><b>卡片自己写盘、不用点顶部保存</b>：人设（<code>persona.md</code> · 点「保存人设」）、
              发言规则（<code>speech-rules.md</code> · 点「保存发言规则」）、群聊活跃时段（点「保存这个」，写的是桥的 <code>state/activity-windows.json</code>，不是 config.json）、
              NapCat 鉴权令牌（自己写 NapCat 的配置并重启 NapCat）、表情包上传（写表情库并重启桥）、
              「保存并重启」（它会先替你点一次顶部保存、再重启 DSH/桥）。</div>
            <div style={{ marginTop: 4 }}><b>会顺手写一份 config.json 的两个按钮</b>：「活跃时段 → 添加群」（把群加进允许名单）、
              「活跃时段 → 关闭静默，恢复群聊响应」（关 <code>deepsleep</code>）—— 它们立刻写盘，不必再点顶部保存。</div>
            <div style={{ marginTop: 4 }}>配置方案页签：点「存为新方案」只写方案文件；点「套用」写整份 <code>config.json</code>（等同一次全局保存）。</div>
          </div>
        </details>

        {/* 【2026-09-14 主人要求】明显的横幅标明"当前编辑的是服务端配置"：
            没有这条横幅，用户很容易以为在改本机（两套实例并存时这正是最容易踩的坑）。 */}
        {/* 【2026-09-14 主人要求】横幅配色跟新手文档一致（不再自己写死蓝色），
            里面的路径/命令一律按行内代码渲染：说明文字干净、技术名词一眼可辨。 */}
        {target === 'remote' && remote && (
          <div className="notice-bar server-config-banner" style={{ borderColor: 'var(--nc-primary-400)', display: 'block' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
              <Server size={15} /> 服务端模式 · 正在修改服务器上的桥配置
              <span className="badge badge-info">服务端</span>
            </div>
            {/* 【2026-09-19 主人要求】这里只说明"改的是服务器上那份配置"；原子写/备份/热加载这些原理不再堆在页面上。 */}
            <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>
              {remote.name}（{remote.host}）· 保存后立即生效，不用重启桥。
            </div>
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

        {/* 【2026-09-19】读配置失败不再"什么都不显示"：给一条可重试的提示。
            这份配置读的是磁盘上的 qq-bridge/config.json（本机 / 服务端），**不经过桥进程** ——
            所以桥没在跑时它照常能读能改；读不到是另外的原因（文件损坏 / 服务端没连 / 接口报错），
            这里把原始原因原样显示，别让人以为配置页整个坏了。 */}
        {loadErr && (
          <div className="card">
            <div className="lrn-error">
              <AlertTriangle size={15} />
              <div style={{ flex: 1 }}>
                读取配置失败：{loadErr}
                <div className="lrn-error-detail">
                  这份配置读的是 {remote ? '服务端 /root/qq-bridge/config.json' : '本机 qq-bridge/config.json'} 这个文件本身，
                  <b>不需要桥在运行</b>；读不到通常是文件损坏、目录不对{remote ? '，或 SSH 没连上' : ''}。处理完点「重试」。
                </div>
              </div>
              <button className="btn btn-sm btn-danger" disabled={loading} onClick={() => void load()}>
                <RotateCcw size={13} /> 重试
              </button>
            </div>
          </div>
        )}
        {!cfg && !loadErr && (
          <div className="card"><div className="lrn-inline-note"><Loader2 size={13} className="spin" /> 正在读取配置…</div></div>
        )}

        {tab === 'common' && cfg && <CommonTab cfg={cfg} ch={ch} onHelp={setHelp} uploadStickers={uploadStickers} remote={remote} writeConfig={(next) => writeBridge({ config: next })} onCfgChange={setCfg}
          apiKeyStatus={apiKeyStatus} onClearApiKey={clearApiKey} saving={saving} target={target} />}
        {tab === 'tools' && cfg && <ToolsTab cfg={cfg} ch={ch} onSave={save} target={target} remoteServerId={remote?.id} />}

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
                {/* 【2026-09-20】表情包卡在「常用设置」页（挨着上面那张「表情包」卡）；这里给个入口，
                    省得主人记得"它到底在哪一页"——点它切页并滚到那张卡。 */}
                <button className="btn btn-soft btn-sm" title="内置表情包：传包 / 给角色绑包（在「常用设置」页）"
                  onClick={() => { setTab('common'); setTimeout(() => document.getElementById('meme-packs-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); }}>
                  <Layers size={14} /> 内置表情包
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
                  <li><b>管理类指令只有管理员（也就是配置里的「主人 QQ」）能生效</b>；其他人发会被回「管理命令仅管理员可用」。</li>
                  <li>指令要单独发一条，且以 <code>/</code> 开头；带参数时参数用空格隔开。</li>
                </ul>
              </DocSection>

              <DocSection title="会话管理">
                <ul>
                  <li><code>/reset</code> 或 <code>/new</code>：清空当前会话的 DSH 上下文，下一条消息开新会话（长期记忆、档案、聊天库都保留）。顺手取消该会话还没发出的待发任务。</li>
                  <li><code>/status</code>：回一条状态——当前会话编号、白名单是否通过、角色、模式。</li>
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
                  <li><code>/set active</code>：本会话转全天活跃——群里说啥都接；同时清掉该会话的活跃时段限制。</li>
                  <li><code>/set active 09:00-01:00</code>：只在<b>这段时间</b>活跃，其余时间潜水（只回 @ 与点名）。跨午夜写成 <code>09:00-01:00</code> 就行。</li>
                  <li><code>/set diving</code>：本会话全天潜水——平时不打扰群，被 @、被点名或有人问时才出来。</li>
                  <li><code>/set diving 00:00-21:00</code>：<b>这段时间</b>潜水（只回 @ 与点名），其余时间照常活跃。</li>
                  <li><code>/set mode active</code> / <code>/set mode diving</code>：上面两条不带时段的等价老写法。</li>
                  <li><code>/set sleep 01:00-06:00</code>：设每日作息窗口（北京时间）。窗口内群聊只回 @，其余不读以省 token；私聊不受限。</li>
                  <li><code>/set sleep 30m</code> / <code>/set sleep 2h</code>：定时休息 30 分钟 / 2 小时，到点自动醒。</li>
                  <li><code>/set wake</code> 或 <code>/set cancel</code>：一键取消所有睡眠状态（含作息窗口与定时休息）。</li>
                  <li>斜杠命令<b>一律英文</b>；中文说法（「转活跃」「这个点别理群」）直接说人话就行，模型会自己调工具。</li>
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
                  <li><code>/slang learn</code>：立刻跑一次黑话学习（中英混写的 <code>/slang 学习</code> 已不再识别）。</li>
                  <li><code>/slang stop</code>：停止正在跑的黑话学习 / 研究任务。</li>
                  <li><code>/slang</code>：看黑话模块的用法说明。</li>
                </ul>
              </DocSection>

              <DocSection title="群友画像学习">
                <ul>
                  <li><code>/portrait learn</code>（也认 <code>/portrait start</code>、<code>/群友画像学习</code>、<code>/画像学习</code>）：立刻按当前筛选条件挑人跑一轮画像学习。不带参数时自动从聊天库里选人。</li>
                  <li><code>/portrait stop</code>：停止正在跑的画像学习（已在跑的目标不会落半成品）。</li>
                  <li><code>/portrait status</code>：回一条状态——是否启用、自动触发方式、筛选条件、最近一轮学了哪几个人。</li>
                  <li>只有管理员（配置里的「主人 QQ」）能发；其他人发会被回「画像学习只有主人能指挥」。</li>
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
                  <li><b>上下文与轮换</b>：三组旋钮，各管一件事——①「首轮带入历史条数 / 轮换后首轮带入条数」决定新会话第一轮贴多少条聊天记录（后者只对轮换后的第一轮生效，上限 60，填得比前者小则不生效，默认 24）；②「每会话内存保留条数 / 未读队列上限」只决定桥在内存里留多少（超出的历史仍在 SQLite，可查）；③「聊多少轮换新会话 / 提前几轮预建新会话」决定累计多少真实来回后归档轮换到新会话（默认 12，顺带提前预热下一代避免首轮卡顿），防止上下文膨胀。<b>第①组和第③组不是重复项</b>：前者是历史窗口大小，后者是换会话的时机（细节点每个字段旁的 ⓘ）。</li>
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
                  <li><b>提示「桥没在运行」</b>（学习/语音/NapCat 那几页读桥侧数据时）：桥没在跑，那份数据要从桥上取。
                    先确认 NapCat 已登录（QQ 在线）、DSH 已启动，再启动 QQ-Bridge，或直接用首页「一键启动整套」。
                    本页的配置读的是磁盘上的 config.json，<b>不受影响</b>，桥停着也能看能改。</li>
                  <li><b>提示「桥在运行，但没有这条接口」</b>：<b>这才是版本旧</b>（桥答了 404/非 JSON）。
                    把桥代码更新到最新并重启桥即可 —— 别跟上一句混起来，桥没启动时不需要更新。</li>
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
              <NoticeBar msg={charMsg} onClose={() => setCharMsg(null)} style={{ marginBottom: 10 }} />
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
  // 精简后的基础项：删掉端口/令牌/会话目录等系统自管项，避免无效配置
  const topOnly = ['agentPreset', 'workspaceTitle', 'ownerQQ', 'adminQQ', 'ackMessage', 'sendDelayMs', 'questionTimeoutMs'];
  return (
    <div className="cfg-grid">
      <GroupCard title="模型与推理" path="dsh" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="连到哪个 DSH、用什么模型回话。服务商默认「自动探测」（即用隔离 DSH 里已配置的官方 DeepSeek），也可显式选 DeepSeek 官方；留空模型即用 DSH 默认。改这里会自动重启隔离 DSH 使其生效。「推理档位」是单次调用耗时与思考 token 最大的一块——实测同一次调用出现过 37 秒，嫌慢/嫌贵先从它和「工具与规则」页的精简名单入手。">
        {/* 【2026-09-19 主人说"接上它"】语言模型密钥不再是"保存了但不生效"的空字段：
            保存时写进隔离 DSH 的凭据文件（600），这里显示它到底配没配。 */}
        <div className="cfg-card-desc" style={{ marginTop: 6 }}>
          {apiKeyStatus?.env
            ? <>
              语言模型密钥落在{target === 'remote' ? '服务端' : '本机的隔离'} DSH 凭据文件
              {apiKeyStatus.path ? `（${apiKeyStatus.path}）` : ''}里的 <code>{apiKeyStatus.env}</code>：
              {apiKeyStatus.set
                ? <b> 已配置（{apiKeyStatus.len} 个字符）</b>
                : <b> 尚未配置</b>}
              {apiKeyStatus.from ? `（变量名来源：${{ 'settings.yaml': '服务端/隔离 DSH 的 settings.yaml 声明', 'known-provider': '已知服务商对照表', 'derived': '按服务商 id 推导' }[apiKeyStatus.from] || apiKeyStatus.from}）` : ''}
              。保存时填写即写入 / 覆盖；留空不动它。
              {apiKeyStatus.set && onClearApiKey
                ? <> <button type="button" className="btn btn-sm" disabled={saving} onClick={() => { void onClearApiKey(); }}>清除已保存的密钥</button></>
                : null}
            </>
            : '语言模型密钥会随保存写进隔离 DSH 的凭据文件（systemd 环境变量），不再只存不生效。'}
        </div>
      </GroupCard>
      {/* 【2026-09-15 主人反馈"这个界面不就重复了"】令牌字段**只留下面那张卡**：
          这里改成白名单，只列地址/运行路径等连接项，不再重复显示 accessToken / wsAccessToken。 */}
      <GroupCard title="NapCat 连接（地址与路径）"
        blocks={[{ path: 'napcat', only: ['wsUrl', 'httpUrl', 'launcherPath', 'homeDir', 'imageFileMode', 'tmpDir', 'dockerPathMap', 'allowProcessControl'] }]}
        cfg={cfg} ch={ch} onHelp={onHelp}
        desc="机器人与 NapCat 的通信地址与运行路径，本地一键启动时一般不用改。**令牌不在这张卡里**：WebUI / HTTP / WS 三个令牌统一在下面那张「NapCat 鉴权令牌」卡里配 —— 它会同时写进 NapCat 自己的配置和桥的配置，并重启 NapCat 生效。" />
      {/* 【2026-09-15 主人反馈】令牌要真正写进 NapCat 才生效：见 NapcatTokensCard 的注释 */}
      <NapcatTokensCard />
      <GroupCard title="基础与会话" path="" only={topOnly} cfg={cfg} ch={ch} onHelp={onHelp}
        desc="人设预设、主人 QQ、工作区与发送节奏等基础项。" />

      <div className="card-stack">
        <GroupCard title="允许名单" cfg={cfg} ch={ch} onHelp={onHelp}
          blocks={[{ path: 'allow' }, { path: '', only: ['allowAllPrivate', 'allowAllGroups', 'allowAllWhenEmpty'] }]}
          desc="允许陪聊的私聊/群；留空 + 全部放行 = 谁都能聊。" />
        <GroupCard title="拒绝名单" path="deny" cfg={cfg} ch={ch} onHelp={onHelp}
          desc="永远不搭理的私聊/群，优先于允许名单。" />
      </div>
      <GroupCard title="唤醒 · 潜水 / 活跃" path="social.wake" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="机器人平时爱潜水，遇到这些词/被 @/被提问时才会醒过来。" />

      <GroupCard title="发送节奏与间隔" path="social.send" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="连发/停顿/字数上限——控制发消息像不像真人打字。" />
      {/* 【2026-09-17 主人问「resetWindow 是不是和唤醒轮换阈值一样的、重复了」】
          不是重复项，是以前"看着像重复"：这张卡把 `social.context` 与 `social.autoReset` 的键**平铺成一排**，
          而 `resetWindow` 在 LABEL 里没有中文名 → 界面上直接显示原始键名，紧挨着「上下文窗口」，
          两个值在主人的配置里又都是 24 —— 于是像"同一个旋钮写了两遍"。
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
        desc="三组管三件不同的事，不是重复项：① 决定新会话的第一轮往提示里贴多少条聊天记录（'轮换后首轮带入条数'只对轮换后的第一轮生效，所以它必须填得比'首轮带入历史条数'大才有意义）；② 决定桥在内存里留多少条，省内存用；③ 决定聊多少轮把上下文换成新会话——它是换会话的时机，不是历史条数。勾上「永久会话（不轮换）」就不再换会话，上下文改由下面那张「上下文治理」卡负责。" />
      {/* 【2026-09-19 主人要求】"一个会话永久使用，但别让上下文堆积" —— 策略写进隔离 DSH 的 home 级
          cordis.patch.yml（lib/dsh-compaction.js），由 DSH 自己的 compaction-basic + tool-result-pruner 执行。
          为什么不在桥侧删历史：DSH 的会话是内存事件溯源日志，外部改文件只会撞 seq gap / zstd 校验和。 */}
      <GroupCard title="上下文治理（工具历史剪枝）" path="dshCompaction" cfg={cfg} ch={ch} onHelp={onHelp}
        only={['enabled', 'thresholdRatio', 'retainRatio', 'toolResultMaxChars']}
        desc="让一个会话能长期用下去又不堆积上下文：上下文用到「触发比例」时，隔离 DSH 先剪掉超大的工具结果（不发模型请求、聊天记录一字不动），剪完仍超阈值才把最老一段摘要成 <compacted-summary>。阈值按模型窗口的比例给，换模型自动缩放。改这里立刻生效（DSH 热加载那份 patch），不用重启 DSH 或桥。摘要是用**主模型**（全局语言模型服务商）写的，没有单独的服务商/模型可配。" />
      {/* 【2026-09-22 主人要求】"新增智能推荐上下文压缩参数，根据系统提示词总量 token，默认拟人参数更新"
          —— 推荐值按**实测固定开销**现算（见 CompactionRecommendCard 顶部注释），不写死比例。 */}
      <CompactionRecommendCard cfg={cfg} ch={ch} />
      <GroupCard title="主动闲聊" path="social.proactive" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="冷场/没人说话时机器人会不会主动找话题、主动私聊。" />
      <MemoryCard />
      <ActivityHoursCard cfg={cfg} remote={remote} writeConfig={writeConfig} onCfgChange={onCfgChange} />

      <GroupCard title="等待：回复前的停顿" path="social.wait" cfg={cfg} ch={ch} onHelp={onHelp}        desc="模拟真人“想一想再回”：停顿多久、新消息后静默多久。全调 0 = 秒回机器人。" />
      {/* 【2026-09-15 主人要求】私聊看对方打字状态：等 ta 打完再回、不停发消息时状态连续、
          概率骰子决定要不要插话；等待期间的消息合并成一次注入。见 qq-bridge/src/core/typing-hold.js */}
      <GroupCard title="私聊打字等待（不抢话 / 智能接话）" path="social.typing" cfg={cfg} ch={ch} onHelp={onHelp}
        desc="私聊里先看对方是不是正在打字：正在输入就先等 ta 打完再回（不抢话）；对方不停发消息时打字状态会一直延续；每次唤醒再掷一次骰子，命中就插话接上（智能接话）。等待期间到的消息全部排队、最后合并成一次发给模型，省注入轮数。" />
      <StickerCard cfg={cfg} ch={ch} onHelp={onHelp} uploadStickers={uploadStickers} />
      {/* 【2026-09-20 主人要求】内置表情包（meme pack）：包列表 / 上传（zip 或文件夹）/ 角色绑定 / 删除。
          紧挨上面那张「表情包」卡：同一件事的两半 —— 上面管"用不用表情、多久同步"，这张管"库里有哪些包"。 */}
      <MemePacksCard remote={remote} />
      <GroupCard title="静默群聊" path="social" only={['deepsleep', 'deepsleepGroups']} cfg={cfg} ch={ch} onHelp={onHelp}
        desc="想省钱/想安静：全群静默（总开关），或只让名单里的个别群静默。" />

      {/* 【2026-09-19 主人要求】这张卡只留"模型总开关"：另外两项（回复检查间隔 / 推荐参数）
          一个在「调参」里也有、一个一直没人动过，留在页面上只会让人以为"这些设置还管用"。
          键本身仍在桥里生效（config.json 不动），只是不再从这里编辑。 */}
      <GroupCard title="提示词与语感（[Style] 行）" path="prompt" cfg={cfg} ch={ch} onHelp={onHelp}
        only={['styleLine']}
        desc="唤醒正文每轮都会带的那一句语感提醒。它是离模型最近的一句话，对小模型的语气影响比几十 k 字符的系统提示词更直接 —— 觉得回话「像人机」就改这里。填中文短句；留空 = 不注入这一行。改完保存**下一条消息就生效**，不用重启桥、也不用等会话轮换。" />
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
 *  【2026-09-18】以前它会被通用卡片当成普通设置项渲染成一个输入框 —— 字段名是 `_linearNote`
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

  /* 【2026-09-19 主人要求】这张表**只列白名单内的对象**：
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
        {hiddenCount > 0 && (
          <span style={{ fontSize: 12, color: '#d9822b' }} title="这些会话桥认识、但不在允许名单里（或当前模式不允许），设了时段也不会生效，所以不列出来">
            已隐藏 {hiddenCount} 个不在允许名单里的对象
          </span>
        )}
      </div>

      {!visible.length && !loading ? (
        <div className="cfg-card-desc">
          {hiddenCount > 0
            ? `允许名单里还没有对象（另有 ${hiddenCount} 个不在允许名单里的会话已隐藏）。先在「允许名单」里加群，或点下面的「添加群」——它会顺手把群加进允许名单。`
            : '桥还没认识任何对象 —— 下面填群号加一个，或先在「允许名单」里加群。'}
        </div>
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
                  {/* 过滤之后这里理论上不会再有"不在允许名单"的行（见上面的 allowedTargets）；
                      万一桥那版没给 allowed 字段，仍然把这句提示留着，免得看不出为什么设了没用。 */}
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

/** 包来源的中文说法（出厂的那份只能看不能删，上传的与角色专属的可以删） */
const MEME_SOURCE_LABEL: Record<string, string> = { factory: '出厂', global: '全局', character: '角色专属' };

/* ================= 内置表情包（meme-packs） =================
 * 一张卡管四件事：① 看包（连"坏包"也要看得见）② 传包（zip 或文件夹两条路）③ 给角色绑包 ④ 删包。
 *
 * 磁盘约定（已冻结，别改）：一份 pack = 一个目录，
 *   <包目录>/manifest.json + index.db(SQLite) + memes/<分类>/<文件名>.<ext>（webp/png/jpg/jpeg/gif）
 * 三个位置：① <runtime>/meme/<包名>/ 出厂包（自带那份）② <runtime>/meme-packs/<包名>/ 上传的包落这
 *          ③ <charactersDir>/<角色slug>/meme-packs/<包名>/ 某个角色专属的包
 *
 * 上传不在前端拼目录：原样把文件交给管理端（POST /api/bridge/meme-packs/upload，base64-in-JSON），
 * 由后端校验图片 → 落临时目录 → 用桥里的规整脚本重排目录并重建 index.db → 再整体 rename 就位。
 * 所以"收了几张、入库几张、跳过哪些、有没有备份旧包"全部以后端回的报告为准 —— 界面只如实显示，
 * 不自己猜一个数字（猜出来的"成功"最容易骗人）。 */
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
  /* 【2026-09-21 主人要求】「哪个角色用哪些包」这段能折叠：
     角色库里角色一多，这段的角色卡就把整张卡撑得比上面「表情包」那张高一大截。
     默认**展开**（免得看着像少了一块）；收起只影响这一段，勾选/草稿状态照旧留在 drafts 里。 */
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
        if (!imgs.length) { setMsg('这个文件夹里没有 webp / png / jpg / gif 图片'); return; }
        const total = imgs.reduce((n, f) => n + f.size, 0);
        if (total > 40 * 1024 * 1024) {
          setMsg(`这个文件夹里的图有 ${(total / 1048576).toFixed(1)} MB，一次传不完（上限约 40 MB）：请挑一个只装图片的小文件夹，或先压成 zip 再传`);
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
      if (!r.success) { setMsg(r.message || `没删掉「${p.id}」`); return; }
      const restartNote = r.restart?.ok ? '，桥接已重启' : (r.restart?.message ? `；${r.restart.message}` : '');
      setMsg(`已删除「${p.id}」${r.trash ? `（没删干净，目录留在 ${r.trash}）` : ''}${restartNote}`);
      await load();
    } catch (e: any) { setMsg('删除失败：' + (e?.message || '')); }
    finally { setBusy(false); }
  };

  const saveBind = async (role: string) => {
    const picked = drafts[role] ?? bindings[role] ?? [];
    setBusy(true); setMsg(null);
    try {
      const r = await memePackBind(role, picked);
      if (!r.success) { setMsg(r.message || `「${role}」的绑定没保存成功`); return; }
      setMsg(r.message || `已保存「${role}」的绑定`);
      await load();
    } catch (e: any) { setMsg('保存绑定失败：' + (e?.message || '')); }
    finally { setBusy(false); }
  };

  return (
    <div className="cfg-card" id="meme-packs-card">
      <div className="cfg-card-title">内置表情包（meme-packs）</div>
      <div className="cfg-card-desc">
        包里的一组图按<b>分类</b>取材（开心 / 生气 / 无奈…），机器人按聊天语境挑着发，比 QQ 收藏表情更好搜、也更贴语境。
        磁盘上它就是一个个目录：<code>manifest.json</code> + <code>index.db</code> + <code>memes/&lt;分类&gt;/图</code>。
        出厂那份在 <code>meme/</code> 里（只看不删），你传的包落在 <code>meme-packs/</code>，也能只给某个角色用。
        {remote ? '这张卡读的是本机那份目录；服务端的包要到服务器上放。' : ''}
      </div>

      <NoticeBar msg={msg} onClose={() => setMsg(null)} />

      {/* ---------- ① 包列表 ---------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
        <b style={{ fontSize: 13 }}>现在的包（{packs.length}）</b>
        <button className="btn btn-sm" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} 重新读取
        </button>
      </div>
      {loading && <div className="lrn-inline-note"><Loader2 size={13} className="spin" /> 正在读表情包目录…</div>}
      {!loading && loadErr && (
        <div className="lrn-inline-note" style={{ color: '#b3261e' }}>
          <AlertTriangle size={13} /> 读不到包列表：{loadErr}
          <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => void load()}>重试</button>
        </div>
      )}
      {!loading && !loadErr && packs.length === 0 && (
        <div className="lrn-inline-note">还没有表情包。下面用「选 zip 上传」或「选文件夹上传」传一个上来，机器人就能用了。</div>
      )}
      {!loading && !loadErr && packs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '4px 0 8px' }}>
          {packs.map((p) => (
            <div key={p.dir} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', border: '1px solid var(--nc-content2, #eee)', borderRadius: 8, padding: '7px 10px' }}>
              <b style={{ fontSize: 13.5, color: '#3d2b4f' }}>{p.id}</b>
              <span className={`badge ${p.source === 'factory' ? 'badge-soft' : 'badge-success'}`}>{MEME_SOURCE_LABEL[p.source] ?? p.source}</span>
              {p.character ? <span className="badge badge-soft">角色 {p.character}</span> : null}
              {p.broken
                ? <span style={{ fontSize: 12, color: '#b3261e' }}>
                    <AlertTriangle size={12} style={{ verticalAlign: -2 }} /> 坏包：{p.broken}（磁盘上还有 {p.imageCount} 张图）
                  </span>
                : <span style={{ fontSize: 12, color: '#6b5f80' }}>
                    {p.count} 张 · {p.tags.length} 个分类{p.imageCount !== p.count ? `（磁盘上 ${p.imageCount} 张，跟索引对不上）` : ''}
                  </span>}
              <span style={{ fontSize: 11.5, color: '#a99fc0', marginLeft: 'auto', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.dir}>{p.dir}</span>
              {p.source === 'factory'
                ? <span style={{ fontSize: 12, color: '#a99fc0' }}>出厂包不可删除</span>
                : <button className="btn btn-outline-danger btn-sm" disabled={busy} onClick={() => void del(p)}><Trash2 size={13} /> 删除</button>}
            </div>
          ))}
        </div>
      )}

      {/* ---------- ② 上传 ---------- */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        <input className="input" style={{ maxWidth: 190 }} placeholder="包名（留空自动取名）" value={packIdInput} onChange={(e) => setPackIdInput(e.target.value)} />
        <select className="input" style={{ maxWidth: 190 }} value={toCharacter} onChange={(e) => setToCharacter(e.target.value)}>
          <option value="">谁都能用（公共包）</option>
          {roleRows.map((r) => <option key={r} value={r}>只给 {r} 用</option>)}
        </select>
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
          {busy ? (stage || '正在处理…') : '包名只能有字母数字和 . _ -；zip 里多套一层目录也没关系（会自动认成包根）'}
        </span>
      </div>

      {/* ---------- 逐文件报告 ---------- */}
      {report && (
        <div style={{ fontSize: 12.5, margin: '8px 0', padding: '7px 9px', borderRadius: 8, background: 'var(--nc-content2, #f6f4fb)', color: '#4a3d5c' }}>
          收到 {report.received} 个文件 · 入库 {report.images} 张 · 跳过 {report.skipped} 个
          {report.deduped ? ` · 去掉重复 ${report.deduped} 张` : ''}
          {report.backup ? ` · 旧包备份成 ${report.backup}` : ''}
          {report.skippedNames?.length ? (
            <div style={{ marginTop: 4, color: '#8a7f9e' }}>
              跳过的：{report.skippedNames.join('、')}{report.skippedMore ? `…另外还有 ${report.skippedMore} 个` : ''}
            </div>
          ) : null}
          {report.relayoutOutput ? (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: '#8a7f9e' }}>规整脚本说了什么（排错时看这个）</summary>
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
              勾上就写进桥的 <code>config.json</code>（<code>social.meme.personaPacks</code>），保存后立刻生效；
              一个都不勾 = 这个角色只用出厂那份包。
            </div>
            {roleRows.length === 0 ? (
              <div className="lrn-inline-note">还没有角色可用：先到「人设」页用「角色库导入」放一个角色进来，或上传时把「谁都能用」改成某个角色。</div>
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
                      {packs.length === 0 && <span style={{ fontSize: 12.5, color: '#9a8fb0' }}>还没有包可选</span>}
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
  // 【2026-09-18】MCP 工具原名（qq_send_message 这种英文标识符）默认**不显示**：
  // 界面上一律显示中文名；要跟 config.json 里的 social.tools.* 对照时再勾上这个开关。
  const [showRaw, setShowRaw] = useState(true);
  if (!v || !isObj(v)) return <div className="empty-state">当前配置没有可开关的 MCP 工具</div>;
  /* 【2026-09-19 主人反馈"工具开关里显示的工具不全"】根因：这里原来只列 `cfg.social.tools` 里
     已有的键 —— 而那份 config 是**历史产物**：线上只有 45 个键、出厂示例只有 30 个，桥实际认 57 个
     开关。于是没被写进 config 的开关（如 sendVoice / transcribeVoice / crosschat）在这页上根本不出现，
     主人以为"没有这个工具"。现在行集 = **桥侧全部开关（TOOL_MCP 的键）∪ 本配置已有的键**，
     没有的键按桥的语义（`!== false` 即开）显示为"开"。 */
  const cfgKeys = Object.keys(v);
  /* 行集 = 桥会读的全部开关（TOOL_MCP 的键）∪ 本配置里"有中文名"的键。
     配置里那些既没有映射、又没有中文名的键 = 历史遗留的废开关（桥根本不读），
     渲染出来只会让人以为勾了有用，所以不显示，只在下面一句话里点出来，
     方便主人去 config.json 里删掉。 */
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
            <span>显示 MCP 工具原名（对照 config.json 时用）</span>
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
            配置里还有 {deadKeys.length} 个<b>桥侧不读</b>的旧开关，已不再显示（想清理就打开 config.json，
            在工具开关那一节里把它们删掉）：{deadKeys.join('、')}
          </div>
        ) : null}
        <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginTop: 14 }}>
          关闭某项即停用对应的 QQ 工具（AI 调用时会被拒绝）；开关不影响人设文本里已有的自然语言规则。
          想按 config.json 里的英文键名逐个核对时，勾上右上角「显示 MCP 工具原名」。
          <br />
          <b style={{ color: 'var(--nc-foreground-300, inherit)' }}>注意：这一组开关<b>不省 token</b></b> —— 工具描述无论如何都会随每次请求发给模型，
          关掉只是"拒绝调用"。要真正少花钱，请用下面那张「工具 schema 精简」卡。
        </div>
      </div>
      <div className="card">
        <div className="card-title">没有独立开关的工具（{TOOLS_NO_SWITCH.length} 个）</div>
        <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 10 }}>
          这些工具由桥<b>无条件注册</b>，上面那组开关管不到：进程控制三个默认不注册（只在管理员私聊里可用）、
          联网两个随桥常开。要让模型<b>彻底看不见</b>它们，只能在下面那张「工具 schema 精简」卡里把它们加进名单
          （注册期就不注册 = 这才真的省 token）。
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
/** 「长期记忆」卡（2026-09-21 记忆架构升级）——只看不改。
 *
 * 为什么要有这张卡：记忆以前是**看不见的**（写进 SQLite 就没了下文，"到底记住了什么"没人知道）。
 * 升级之后记忆分了层（永久/长期/短期）、检索走全文索引，那就必须看得见：
 *   · 永久层（★）每一轮都会出现在唤醒正文的 `[Recall]` 里 —— 所以**它写错了会一直错**，要点开核对；
 *   · `chat_fts` / `mem_fts` 是检索用的全文索引，显示 -1 表示这份库没有 FTS5 或索引还没建
 *     （检索会自动退回模糊匹配：能用、只是慢且没有相关性排序）。
 * 数据来自 manager 只读打开的 qq-bridge/state/memory.db，不改任何东西。 */
function MemoryCard() {
  const [s, setS] = useState<MemoryStats | null>(null);
  const [msg, setMsg] = useState('正在读取…');
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
              <b>永久层（★ = 每一轮都会出现在它眼前的几句话，写错了会一直错）</b>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {s.top.map((e) => (
                  <li key={e.id}>[★ {e.category}] {e.content}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>
              还没有永久记忆条目。在 QQ 里对机器人说「记住：……」并让它用 <code>qq_memory_remember</code> 写一条永久层即可。
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--nc-foreground-400)', lineHeight: 1.7 }}>
            记忆写在桥的 <code>state/memory.db</code> 里：聊天记录永久保存（每一条都进全文索引，
            机器人说"看不到更早的消息"时可以直接检索回来）；永久层条目每轮注入，长期/短期按闲置时间淡出。
            这张卡只读，不会改动任何数据。
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)' }}>{msg}</div>
      )}
    </div>
  );
}

/** 「工具压缩代理」卡（2026-09-21 主人要求）：接开源的 mcp-compressor 当代理。
 *
 * 它与下面那张「工具 schema 精简」是**两层不同的压缩**：
 *   · 这里（代理层）：DSH 不再直连 napcat MCP，改连代理；代理只把 2 个包装工具发给模型，
 *     把压缩过的工具清单塞进包装工具的描述里。实测（挂我们真实的 90 个工具跑）：
 *       low 38.8% · medium 14.0% · **high 6.2%** · max 3.6%。
 *   · 下面那张（注册层）：桥自己按名单决定注册哪些工具、按档位压描述文字。
 * 两层可以叠加：代理开着时，桥侧那份 schema 也会被代理再压一次。
 *
 * 代价（要如实说）：模型遇到**本轮没用过**的工具要先 `get_tool_schema` 再 `invoke_tool`，
 * 调用从 1 步变 2 步。桥侧已按真实工具名解包（core/mux.js 的 unwrapCompressedToolName），
 * 所以发送判定、幂等账本、回合收尾这些逻辑不受影响。
 * ⚠ 压缩机没装时自动回退直连（绝不把工具表搞没）；改完必须重启隔离 DSH。 */
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
      /* 【2026-09-21 修「配了 max、服务器上还是 medium」】
       * 现场：config.json 已经是 level:"max"，但 cordis.patch.yml 写着 high、跑着的代理是 -c medium ——
       * 三份东西各说各话。原因有两条，缺一不可：
       *   ① 档位是**桥启动时**写进 cordis.patch.yml 的 → 不重启桥，patch 就是旧的；
       *   ② 代理是**隔离 DSH 启动时**按 patch 里的 args 起的 → 不重启 DSH，进程就是旧的。
       * 而这里原来只调了 instanceAction('dsh-isolated')，那是**本机**实例：目标是服务器时，
       * 服务器上桥和 DSH 一个都没重启，于是"改了没生效"，界面上还显示"已保存并重启"。
       * 现在按 target 走，并且**先桥后 DSH**（顺序反了 DSH 会按旧 patch 起代理）。 */
      if (target === 'remote') {
        if (!remoteServerId) throw new Error('目标选了服务器但没选具体哪台');
        await sshServiceAction(remoteServerId, 'bridge', 'restart');
        await new Promise((r) => setTimeout(r, 3000));
        await sshServiceAction(remoteServerId, 'dsh', 'restart');
        setMsg('已保存并重启**服务器**上的桥 + 隔离 DSH（约 30 秒后工具表才换过来）');
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
      <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 12, lineHeight: 1.7 }}>
        隔离 DSH <b>不再直连 napcat MCP</b>，而是连代理：代理只把 <b>2 个</b> 包装工具
        （<code>napcat_get_tool_schema</code> / <code>napcat_invoke_tool</code>）发给模型，
        把压过的工具清单塞进包装工具的描述里。实测相对完整工具表：
        <b>低档 38.8% · 中档 14.0% · 高档 6.2% · 极限档 3.6%</b>（下拉里每项也标了）。
        <br />
        这一步 <b>恒开</b>——没有开关：直连就等于回到"每一步都把整张工具表重发一遍"的高花费形态，
        没有理由回去。<b>压缩机没装时自动回退直连</b>，绝不会把工具表搞没。
        <br />
        代价：模型遇到<b>本轮没用过</b>的工具要先查 schema 再调用（一步变两步）；
        桥已按真实工具名解包，发送判定 / 幂等账本 / 回合收尾都不受影响。
        <br />
        <b>两处旋钮谁管什么：</b><br />
        · <b>本卡的「代理档位」</b> = 工具表以什么形态发给模型（模型看到的永远是那 2 个包装工具，差别只在清单压多狠）；<br />
        · <b>下面那张卡的「工具名单档位」</b> = <b>后端注册哪些工具</b>——它决定代理那份清单里有多少条；
        那一档砍掉了哪些工具，下面那张卡会**逐个列出来**，不用猜。
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>代理档位</span>
        <select className="input" style={{ maxWidth: 260 }} value={level} onChange={(e) => ch('social.toolCompressor.level')(e.target.value)}>
          {['low', 'medium', 'high', 'max'].map((id) => (
            <option key={id} value={id}>{id}｜约保留 {ratio[id]}</option>
          ))}
        </select>
        <label className="switch-row" style={{ marginBottom: 0, fontWeight: 400, fontSize: 12.5 }}>
          <input type="checkbox" checked={toonify} onChange={(e) => ch('social.toolCompressor.toonify')(e.target.checked)} />
          <span>工具返回的 JSON 转 TOON（更省，但格式变了）</span>
        </label>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12.5, marginBottom: 4 }}>
          额外排除的后端工具名（每行一个，写 <code>qq_xxx</code> 原名；留空 = 不排除）
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

/** 「上下文治理」的**智能推荐**（2026-09-22 主人要求"根据系统提示词总量 token 新增智能推荐，默认拟人参数更新"）。
 *
 * 为什么不能写死一个比例：阈值必须**明显大于固定开销**（system 提示词 + 工具 schema，每一步都要重发），
 * 否则会被顶穿成"每一步压缩一次"（2026-09-20 实测：0.06 时 114 步触发 46 次摘要，每步多花 15~20 秒）。
 * 而固定开销随提示词压缩/工具裁剪而变，所以推荐值要按**实测的固定开销**现算：
 *   阈值比例 = clamp((固定开销 + 逐字保留 + 余量 24k) / 模型窗口, 0.10, 0.30)
 * 实测数据（docs/COMPACTION-MATH.md）：上下文本身几乎只按缓存命中价计费，钱花在"压缩后整段重读"上 ——
 * 所以阈值偏低反而更贵：0.08 → ¥3.34/天、0.12 → ¥2.67、**0.16 → ¥2.53**、0.25 → ¥2.66。
 * 固定开销从隔离 DSH 的会话投影缓存里读（server/index.js 的 GET /api/bridge/context-overhead）。 */
function CompactionRecommendCard({ cfg, ch }: { cfg: any; ch: (p: string) => (v: any) => void }) {
  const [ov, setOv] = useState<ContextOverhead | null>(null);
  const [err, setErr] = useState('');
  const [applied, setApplied] = useState('');
  useEffect(() => {
    let alive = true;
    getContextOverhead()
      .then((r) => { if (alive) { setOv(r); if (!r?.ok) setErr(r?.message || '没读到实测数据'); } })
      .catch((e: any) => { if (alive) setErr(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, []);
  const curRatio = Number(get(cfg, 'dshCompaction.thresholdRatio')) || 0.16;
  const curRetain = Number(get(cfg, 'dshCompaction.retainRatio')) || 0.02;
  const fixed = Number(ov?.fixedTokens) || 0;
  const win = Number(ov?.contextWindow) || 1000000;
  const retain = 0.02 * win;
  const HEADROOM = 24000;
  const recRatio = Math.min(0.30, Math.max(0.10, Math.round(((fixed + retain + HEADROOM) / win) * 100) / 100));
  const recTokens = Math.round(recRatio * win);
  const curTokens = Math.round(curRatio * win);
  const ok = fixed > 0;
  return (
    <div className="card">
      <div className="card-title">上下文治理 · 智能推荐（按实测固定开销算，不写死）</div>
      <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 10, lineHeight: 1.75 }}>
        {ok ? (
          <>
            实测固定开销（<b>每一步都要重发的那部分</b>）：system 提示词 <b>{Number(ov?.systemTokens || 0).toLocaleString()}</b> +
            工具 schema <b>{Number(ov?.toolsTokens || 0).toLocaleString()}</b> = <b>{fixed.toLocaleString()}</b> token
            （模型窗口 {win.toLocaleString()}）· 当前会话正文 {Number(ov?.messageTokens || 0).toLocaleString()} token
            <br />
            推荐公式：<code>(固定开销 {fixed.toLocaleString()} + 逐字保留 {Math.round(retain).toLocaleString()} + 余量 {HEADROOM.toLocaleString()}) ÷ {win.toLocaleString()}</code>
            {' '}= <b>{(recRatio * 100).toFixed(0)}%</b>（≈ {recTokens.toLocaleString()} token 触发）
            {' '}· 当前设置 {(curRatio * 100).toFixed(0)}%（≈ {curTokens.toLocaleString()} token）
            <br />
            <span style={{ color: '#b07d2b' }}>
              余量 24k 是为了"压缩完离阈值还有距离"，不会压完立刻又压；下限 0.10 是防止被固定开销顶穿成"每一步压缩一次"。
              实测扫描（1M 窗口）：0.08 → ¥3.34/天 · 0.12 → ¥2.67 · 0.16 → ¥2.53 · 0.25 → ¥2.66 → 最省区间 0.14~0.20。
            </span>
          </>
        ) : (
          <>还没读到固定开销实测（{err || '读的是隔离 DSH 的会话投影缓存，等它跑过一次请求'}）——先把提示词/工具表跑热，或直接按经验值 0.16。</>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" disabled={!ok}
          onClick={() => {
            ch('dshCompaction.thresholdRatio')(recRatio);
            ch('dshCompaction.retainRatio')(0.02);
            setApplied(`已填入推荐值：触发比例 ${recRatio}，逐字保留 0.02 —— 记得点下面/上面的「保存」`);
          }}>
          <Wand2 size={14} /> 应用推荐（{(recRatio * 100).toFixed(0)}% / 保留 2%）
        </button>
        <button className="btn btn-soft btn-sm"
          onClick={() => {
            ch('social.send.linearEnabled')(true);
            ch('social.send.linearPerCharMs')(150);
            ch('social.send.linearMinMs')(250);
            ch('social.send.linearCapMs')(4000);
            setApplied('已恢复拟人打字节拍默认：150 ms/字（第 2 条气泡起按字数等），下限 250ms、上限 4000ms');
          }}>
          恢复拟人默认（打字节拍 150/250/4000）
        </button>
        {applied && <span style={{ fontSize: 12.5, color: '#2f9e44' }}>{applied}</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--nc-foreground-400)', marginTop: 8, lineHeight: 1.7 }}>
        打字节拍会被桥夹在 perChar ∈ [60, 320] ms、cap ∈ [800, 6000] ms（<code>clampSendPace</code>）——这些键模型自己在私聊里也能改，
        夹住是为了不再出现"一条气泡等十几秒"。复算脚本 <code>qq-bridge/tools/compaction-threshold.mjs</code>。
      </div>
    </div>
  );
}

function SlimToolsCard({ cfg, ch, onSave }: { cfg: any; ch: (p: string) => (v: any) => void; onSave: () => Promise<void> }) {
  const denyRaw = get(cfg, 'social.slimTools.deny');
  const deny: string[] = Array.isArray(denyRaw) ? denyRaw : [];
  const enabled = get(cfg, 'social.slimTools.enabled') === true;
  /* 【2026-09-21 主人要求「MCP 压缩工具调到 high 档、压缩到 8.6%、并支持管理端切换」】
   * 档位（off/low/medium/high/custom）由桥的 lib/tool-tiers.js 定义，这里只负责选 + 显示实测结果。
   * 老配置没有 level 键 → 显示成 custom（＝继续用手写名单），行为不变。 */
  const level: string = String(get(cfg, 'social.slimTools.level') ?? (enabled ? 'custom' : 'off'));
  const [stats, setStats] = useState<ToolSchemaStats | null>(null);
  const [statsMsg, setStatsMsg] = useState('');
  useEffect(() => {
    let alive = true;
    getToolSchemaStats()
      .then((r) => { if (!alive) return; if (r?.ok) setStats(r); else setStatsMsg(r?.message || '还没有实测数据'); })
      .catch((e: any) => { if (alive) setStatsMsg(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, []);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  /* 【2026-09-22 主人要求"不要暴露整个工具描述"】手动勾选清单默认收起：
   * 档位已经决定名单了，把全部工具的勾选表摊在页面上既是长列表、又容易误以为"必须手动挑"。
   * 选了具体档位时手写名单不生效（tool-tiers.js 的 resolveToolTier 只认档位），所以它只在
   * custom 档、或用户主动点开时才有意义。 */
  const [manualOpen, setManualOpen] = useState(false);
  // 【2026-09-19 主人改主意】原来这一屏行标题只有中文名、原始工具名默认收起（当时要求「一个别留」），
  // 现在要求**把原工具名加回来** —— 所以 showRaw 默认勾上：中文名 + `qq_xxx` 原名并排显示。
  // 对照 config.json 的 deny 名单时也终于不用再手动勾一次了。
  const [showRaw, setShowRaw] = useState(true);

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
      <div className="card-title">② 桥侧工具裁剪（不换拓扑的做法）— 决定「后端注册哪些工具」</div>
      <div style={{ fontSize: 13, color: 'var(--nc-foreground-400)', marginBottom: 12, lineHeight: 1.7 }}>
        这一步决定 <b>后端到底注册哪些工具</b>。上面那张卡的代理把关过的清单塞进包装工具的描述里，
        <b>清单有多长就取决于这里</b>：少注册一个用不到的工具，代理那份清单、以及（万一代理没装时的）
        真实工具表都会跟着变短。<b>改完要重启隔离 DSH</b>（工具表只在 DSH 启动时取一次）。
        <br />
        每一档砍掉了哪些工具，下面<b>逐个列出来</b>——名单是桥注册时实测的那一份，不需要你猜。
      </div>

      <label className="switch-row" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => ch('social.slimTools.enabled')(e.target.checked)} />
        <span>启用名单裁剪（关掉 = 所有工具都注册）</span>
      </label>

      {/* ── 档位选择（2026-09-21）─────────────────────────────────────────────
          一次点击就能在"省钱"和"功能"之间挪一格，不用手写几十个工具名。
          每档后面那个百分比是**桥实测**的（state/tool-schema-stats.json，
          由 mcp-napcat-safe.js 注册工具时逐个量出来的），不是界面上写死的数字。 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>工具名单档位</span>
        <select className="input" style={{ maxWidth: 340 }} value={level}
          onChange={(e) => {
            const v = e.target.value;
            ch('social.slimTools.level')(v);
            // 选档位 = 明确要生效：顺手把总开关打开（否则改了档位却因为 enabled=false 一点没变）
            if (v !== 'off') ch('social.slimTools.enabled')(true);
          }}>
          <option value="off">不裁剪（全部工具）</option>
          {(stats?.tiers ? Object.keys(stats.tiers) : ['low', 'medium', 'high', 'extreme', 'custom'])
            .filter((id) => id !== 'off')
            .map((id) => {
              const t = stats?.tiers?.[id];
              const pct = t ? ` · 实测留 ${(t.share * 100).toFixed(1)}%` : '';
              const cut = t?.droppedCount ? ` · 砍 ${t.droppedCount} 个` : '';
              return <option key={id} value={id}>{`${id}${t ? `｜${t.label}` : ''}${pct}${cut}`}</option>;
            })}
        </select>
        {stats?.tiers?.[level]?.note && (
          <span style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>{stats.tiers[level].note}</span>
        )}
      </div>

      {/* 描述文字档位已按主人要求移除（代理恒开时它多余）：见 lib/tool-schema-compress.js */}

      {/* ── 裁剪结果可视化（2026-09-22 主人要求"那个裁剪的也标出来别让别人猜"）──────
          对**当前选中的档位**：列出被砍掉的工具名 + 各自字符数（桥实测），
          以及保留数与省下的字符/ token。数据同源于 state/tool-schema-stats.json。 */}
      {stats?.tiers?.[level] && (
        <div style={{ fontSize: 12.5, marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--nc-background-100, #f6f7f9)', lineHeight: 1.75 }}>
          <b>这一档（{level}）砍掉 {stats.tiers[level].droppedCount ?? 0} 个工具</b>
          {' · '}保留 <b>{stats.tiers[level].keptCount}</b> 个
          {' · '}省 <b>{(stats.tiers[level].droppedChars ?? 0).toLocaleString()}</b> 字符 ≈{' '}
          <b>{charsToTokens(stats.tiers[level].droppedChars ?? 0).toLocaleString()}</b> tokens/步
          {Array.isArray(stats.tiers[level].dropped) && stats.tiers[level].dropped.length > 0 ? (
            <>
              <br />
              <span style={{ color: 'var(--nc-foreground-400)' }}>
                被砍掉的（按体积从大到小，括号里是它占的字符数）：
              </span>{' '}
              {stats.tiers[level].dropped.map((d) => `${d.n}(${d.c.toLocaleString()})`).join('、')}
            </>
          ) : (
            <>
              <br />
              <span style={{ color: 'var(--nc-foreground-400)' }}>这一档不砍任何工具（全部注册）。</span>
            </>
          )}
          <br />
          <span style={{ color: 'var(--nc-foreground-400)' }}>
            名单来自桥注册时的实测账本（{stats.at ? new Date(stats.at).toLocaleString() : '—'}）；换档位后**必须重启隔离 DSH** 才会重新注册并刷新。
          </span>
        </div>
      )}

      {stats ? (
        <div style={{ fontSize: 12.5, marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--nc-background-100, #f6f7f9)', lineHeight: 1.7 }}>
          <b>桥实测（隔离 DSH 真正拿到的那份工具表）</b>：档位 {stats.level}
          {' · '}注册 <b>{stats.registered}</b>/{stats.available} 个
          {' · '}工具描述共 <b>{(stats.keptChars || 0).toLocaleString()}</b>/{ (stats.totalChars || 0).toLocaleString()} 字符
          {' '}（<b>{((stats.share ?? 1) * 100).toFixed(1)}%</b>）≈ <b>{stats.approxTokensPerStep?.toLocaleString()}</b> token/步
          {' · '}省 <b>{(stats.savedChars || 0).toLocaleString()}</b> 字符
          <br />
          各档位若切过去：{Object.entries(stats.tiers || {}).filter(([id]) => id !== 'off' && id !== 'custom').map(([id, t]) =>
            `${id} ${(t.share * 100).toFixed(1)}%`).join(' · ')}
          <br />
          <span style={{ color: 'var(--nc-foreground-400)' }}>
            数据时间 {stats.at ? new Date(stats.at).toLocaleString() : '—'}；换档位后**必须重启隔离 DSH** 才会重新注册工具并刷新这份实测。
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)', marginBottom: 10 }}>
          {statsMsg || '正在读取桥侧实测数据…'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 13 }}>
          后端注册：<b>{effectiveKept}</b> 个工具 · 约 <b>{effectiveChars.toLocaleString()}</b> 字符 ≈{' '}
          <b>{charsToTokens(effectiveChars).toLocaleString()}</b> tokens/步
        </span>
        <span style={{ fontSize: 13, color: 'var(--nc-foreground-400)' }}>
          （已精简 {enabled ? all.length - kept.length : 0} 个 · 省 {enabled ? savedChars.toLocaleString() : 0} 字符 ≈{' '}
          {charsToTokens(enabled ? savedChars : 0).toLocaleString()} tokens/步）
        </span>
      </div>

      {/* ── 手动微调（custom 档专用）──────────────────────────────────────────
          【2026-09-22 主人要求"不要暴露整个工具描述"】原来这一整块（全部工具的勾选清单）
          默认摊在页面上，既是长列表、又容易让人以为"必须手动挑"。
          现在只在 custom 档、或用户主动点开时才出现 —— 档位本身已经决定名单了。 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <button className="btn btn-soft btn-sm" onClick={() => setManualOpen((v) => !v)}>
          {manualOpen ? '收起手动名单' : `手动微调名单（当前 ${deny.length} 个被排除）`}
        </button>
        {level !== 'custom' && (
          <span style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>
            选了具体档位时，手写名单不参与生效（档位说了算）—— 要手动挑就把档位切到 custom。
          </span>
        )}
      </div>

      {manualOpen && (
      <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <button className="btn btn-soft btn-sm" onClick={() => setDeny(SLIM_RECOMMENDED)}>出厂默认名单（21 个，从没用过）</button>
        <button className="btn btn-soft btn-sm" onClick={() => setDeny([])}>全部恢复</button>
        <input className="input" style={{ maxWidth: 220 }} placeholder="筛选工具名…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="switch-row" style={{ marginBottom: 0, fontWeight: 400, fontSize: 12.5 }}>
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          <span>显示 MCP 工具原名（排错 / 手改 config.json 时对照用）</span>
        </label>
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
        只有 <code>mcp__napcat__</code> 系列受这张名单控制；另有两个模型侧工具（<code>todo_write</code> / <code>ask_user_question</code>）
        已经在人设预设里卸载了对应插件，不在这里。<br />
        本页只影响"注册不注册"；能否<b>调用</b>仍由上面那张「QQ 工具开关」决定。
        每行显示的是中文名，勾上方的「显示 MCP 工具原名」可以按原名逐字核对 config.json 里的名单。
        {extraDeny.length > 0 ? (
          showRaw
            ? <><br />名单里还有 {extraDeny.length} 个当前未注册的名字会被原样保留：{extraDeny.slice(0, 6).join(', ')}{extraDeny.length > 6 ? ' …' : ''}</>
            : <><br />名单里还有 {extraDeny.length} 个当前未注册的工具名会被原样保留（勾上「显示 MCP 工具原名」可查看）。</>
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
      </>
      )}
    </div>
  );
}

/** 「推理档位」下拉：**不写死低/中/高**（2026-09-12 主人要求）
 *  · 选项就是各服务商**真实的英文档位 id**（off/none/minimal/low/medium/high/xhigh/max…），
 *    【2026-09-18】但下拉里显示的改成**中文名**（英文 id 写在 ⓘ 说明里，随时可查），
 *    免得界面上又是一串 off/low/xhigh；
 *  · DSH 里已经配好、但不在预设列表里的值（例如某些厂商的 `xhigh`）会直接以**自定义输入框**
 *    回显，不会"显示成空白、一保存就被悄悄改掉"；
 *  · 下面一行显示隔离 DSH 的 settings.yaml 里**现在实际生效**的档位，方便核对。 */
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
/** 档位 id → 显示名。**英文 id 一定保留在前面**（2026-09-18 主人要求："low/high/max/xhigh 那些字带上别删除，这样清晰"）——
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
          <select className="select" value={cur}
            onChange={(e) => { if (e.target.value === '__custom__') setCustom(true); else ch(path)(e.target.value); }}>
            <option value="">自动探测（跟随 DSH / 服务商默认）</option>
            {EFFORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{`${p.id} · ${p.hint}`}</option>)}
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

/** 【2026-09-18】标签表里没登记的键，自动生成一条说明：写清**桥里的键名**、类型、当前值。
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
  return `这一项是 config.json 里存在的设置，但界面还没给它登记中文名，字段名暂时显示成占位文字。\n`
    + `桥里的键名：${path}\n类型：${kind}\n当前值：${shown}\n`
    + `改它之前建议先看「说明文档 · 每一项功能与配置」，或切到「JSON 进阶」页找同名的键。`;
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
