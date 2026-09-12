// 会话/回合/队列共享状态
// const Map/Set 仅按内容增删（无整体重赋值），经 export 活绑定共享安全。

export const collectors = new Map(); // sessionId -> turn collector

export const TurnStartAt = new Map(); // sessionId -> timestamp：default turn 开始时间，用于判断是否"无行动"

export const pendingWakeKeys = new Set();

export const sessionPromises = new Map(); // key -> create promise（防并发重复创建）

export const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

// ── P4-19 批量（回合/循环/工具监控 + 唤醒租约状态） ──────────────────────────
export const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
export const turnTimeoutTimers = new Map(); // sessionId -> timeout：活动感知回合看门狗定时器
export const turnTotalTimers = new Map(); // sessionId -> timeout：回合总时长兜底（防无限重复输出卡死）
export const loopRepeatState = new Map();        // key -> { sig, count, firstAt }
export const loopRecoverTimes = new Map();       // key -> number[]：自动重启时间戳
export const activeAiTurns = new Set();          // key：当前处于 AI 回合（本回合工具发送计入复读判定）
export const pendingTurnOutbound = new Map();    // key -> string[]：本回合 AI 实际发出文本
export const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
export const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
export const activeWaits = new Set(); // key：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起
export const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
export const lastWakeRebroadcast = new Map(); // `${key}:${reason}:${seq}` -> ts：补发冷却，防止同一 seq 被反复判定"被吞"导致连环唤醒
export const wakeConfigUpdatedKeys = new Set();
export const markReadCalledKeys = new Set();
export const wakeConfigMissCount = new Map();
export const reverse = new Map(); // sessionId -> conv key
// 【2026-09-11 turn-hold 补完】DSH **权威**运行状态：sessionId 在集合里 = DSH 自己说这个 agent 正在跑。
// 来源是事件流的 `host/session-status` 帧（dsh-host-apiproxy/lib/index.js:3699 由 agent/status 事件发出）。
// 为什么需要它：桥以前只能靠 turn/start、turn/end 事件**推断**"回合在不在跑"，推不准正是当初 steer
// 吞消息的根因（`isConversationBusy()` 为真 ≠ 模型回合在跑）。有了权威信号，"即时 steer"才有安全前提。
export const agentRunningSessions = new Set();

// ── P4-21 批量（投递队列/控制台 RPC/媒体缓存） ───────────────────────────────
export const queued = new Map(); // key -> { promptText }[]
export const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
export const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）
export const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }
export const visionModelAppliedSessions = new Set();
/**
 * 清空"该会话已 selectModel 过"的缓存。
 * ensureVisionModel 对每个会话只设置一次模型，所以模型配置（provider/model/visionModel/档位）一变，
 * 必须清缓存，否则**已存在的会话会继续用旧模型**（表现为"改了模型没生效"，只有新会话才吃新值）。
 */
export function resetVisionModelApplications() { visionModelAppliedSessions.clear(); }

/**
 * 正在被 turn-hold 保持循环托管的会话（key）。
 * 放在这里而不是 turn-hold.js：`wake-send.js` 需要知道"这个回合有人接管后续批次"，
 * 但它与 turn-hold.js 是互相 import 的关系（turn-hold 要 steerIntoRunningTurn），
 * 用一个共享 Set 代替互相 import，避免 ESM 循环依赖里的 TDZ 坑。
 */
export const holdActiveKeys = new Set();
export const messageMediaStore = new Map(); // key -> Map<messageId/seq, media[]>（一代）/default存会话内
export const activityWakeCooldown = new Map(); // key -> ts（55 分钟内每个窗口起点只唤醒一次）
// 静默回合队列（2026-09-06 单模式化后自 social.silentTurns 迁出）：sessionId -> {id,ts}[]。
// 后台提醒/摘要等"只投喂不发言"回合在此登记，turn/end 消费后不把文本发送到 QQ。
export const silentTurnQueue = new Map();

// 单条消息最多内联/返回的图片/表情数（P4-23 迁入共享）
export const MAX_MEDIA_COUNT = 5;
