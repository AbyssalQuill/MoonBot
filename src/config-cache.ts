/**
 * MoonBot 管理端 · 配置缓存（内存 + 浏览器持久化 两级）
 *
 * 「为什么需要它」：管理端的页面切换是卸载再挂载（见 `src/App.tsx`：每次 `view` 变化即返回另一个页面组件），
 * 每个配置页在挂载瞬间都会重新发起一次配置读取。若挂载时用一组"出厂默认值"占位，页面上就会先闪出
 * 一份与当下配置不同的数值，待回包到达后才跳成真实值 —— 这就是此前反馈的"状态机跳变"。
 *
 * 「本模块的约定」
 *   · 任何一次成功读到配置的地方，都把回包写进这里的缓存（`rememberConfig`）；
 *   · 页面挂载时先读缓存（`getCachedConfig`）：有缓存即以真实值渲染，切换页面时数值不会跳变；
 *   · 没有缓存时不允许用出厂默认值冒充 —— 各页须渲染为空值 + 禁用，待真实回包到达后再启用并填入；
 *   · 按"读取目标"分键：本机桥配置与服务端桥配置各占一个键，二者绝不互相回落，
 *     否则连上服务器时会把本机那份配置显示成服务端那份，比闪一下默认值更危险。
 *
 * ═══════════════ 2026-09-29：内存缓存 → 加一层浏览器持久化 ═══════════════
 *
 * 「为什么持久化」：上面那层只是模块级内存，刷新页面（或重开管理端窗口）即全部失效，
 * 于是每次打开都回到"没有缓存 → 空白 + 禁用 → 等回包"的老路：连服务器时表现为
 * 语音配置/桥配置先出现"正在读取…"、桥不可达的短暂空窗与连接提示跳变。
 * 现加第二级：`localStorage`。
 *
 * 「为什么选 localStorage 而不是 sessionStorage」
 *   · 要消除的是"每次打开都从零开始读"，而管理端每次启动是新的浏览器标签/窗口，
 *     sessionStorage 的生命周期恰好就是"一个标签页"，重开即失效，等于没解决；
 *   · localStorage 按源（origin）隔离：管理端固定跑在 `http://127.0.0.1:1921`，同源同份配置，
 *     既不会串到别的站点，也不会被别的标签页误读；
 *   · 数据量是"几份配置对象"，localStorage 的容量绰绰有余，不需要 IndexedDB 的复杂度。
 *
 * 「键名格式」`moonbot.cfgcache.v1.<scope>::<key>`
 *   · `moonbot.cfgcache` = 本模块专用命名空间，清缓存时可整片删除，不碰别人的键；
 *   · `v1` = 版本前缀：将来缓存结构（或脱敏规则）变了，直接升 v2 即可让旧记录自然失效，
 *     不必写迁移逻辑（旧键永远不会被新版本读到，读取时按 TTL 顺手清掉）；
 *   · `<scope>` = 作用域，`local`（本机）或 `remote`（远端服务器）；
 *   · `<key>` = 本模块的缓存键，远端键自带服务器 id（`bridge-config:remote:<serverId>`），
 *     因此"先连 A、再连 B、再回 A"三条记录各占一个键，互不覆盖、互不回落。
 *   例：`moonbot.cfgcache.v1.local::bridge-config:local`
 *       `moonbot.cfgcache.v1.remote::bridge-config:remote:srv-1a2b`
 *
 * ═══════════════ 2026-09-30：作用域播种（消除首帧"未连接 / 不可用"的跳变） ═══════════════
 *
 * 「问题」：上一版要求"本次页面加载已经知道连的是哪一侧"（`scopeKnown`）才敢用歧义键的缓存，而作用域
 * 只在 `/api/state` 成功回包时才登记 —— 页面挂载往往早于它。于是同一次打开里，首帧必然 miss、
 * 页面先走"空白 + 禁用 + 正在读取 / 学习状态不可用"，几百毫秒后再跳成真实值。这正是此前反馈的
 * 「每次点开都要跳一遍…再回复正常」。
 *
 * 「做法」：把上次真实记录的作用域（`CFG_LAST_CONNECT`，由每次成功的 `/api/state` 落盘）在本次页面
 * 加载的第一次读缓存之前播种为当前作用域。于是同一次加载的首帧就按"上次连的那一侧"命中缓存，
 * 中间态被整段消掉；`/api/state` 一到，再用真实值覆盖当前作用域（`noteActiveScope`）。
 *
 * 「取舍：宁可先用"上次那一侧"的真实值，也不给伪值或空态」
 *   · 播种值是上次真实观测到的作用域，不是"默认值"：据此命中并显示的那份数据，本身也是真实读到
 *     过的配置。最坏情况是"上次连服务器 A、这次其实在本机"，首帧先显示 A 的配置、几百毫秒后被本机
 *     那份替换 —— 一帧偏差，且这一帧里的数值是真的（不是捏造的出厂默认值），页面也不会出现
 *     「正在读取 / 不可用 / 未连接」：这类并无结论的中间态。
 *   · 从未有过任何持久记录（全新安装 / 清过缓存）：按 `local` 播种（管理端默认就是本机形态）；
 *     此后 `noteActiveScope` 一到即按实际值纠正。
 *
 * 「为什么这不等于"拿本机值冒充服务器值"（关键不变量仍然成立）」
 *   · 播种值取自落盘的连接事实，与"猜一个默认值"不同；两侧的落盘记录仍各自带标签、各占一个键，
 *     命中要求"标签 == 当前作用域"，本机那份永远不会被当成服务器那份返回；
 *   · 落盘写入必须先有实测作用域：作用域还只是播种推测时，歧义键（语音 / 学习）只写内存、不写盘
 *     （见 `writePersisted`）。因此猜错时磁盘上不会留下任何"错标一侧"的记录 —— 冒充的源头被堵死；
 *   · 播种猜错而被纠正的那一瞬，把"推测期间只写在内存里"的那几份歧义缓存丢弃（`unverifiedScope`），
 *     相当于"这一侧的初值作废，等实时回包"，即回到最保守的行为，而不是继续用可疑的那一份；
 *   · 作用域被纠正后，取值严格按真实作用域（`scopeOk` 只认 `currentScope`），盘上另一侧的数据不删、
 *     不读、不回落。
 *
 * 「密钥一律不落盘（硬规则）」
 *   · 落盘前递归剔除凭证类字段（清单见 `SECRET_NAME_SUFFIXES`：apiKey / accessToken / wsAccessToken /
 *     webuiToken / refreshToken / visionApiKey / password / passphrase / privateKey / secret /
 *     cookie / credential / authorization / phpsessid …，按"驼峰下划线点号全部拍平后取后缀"匹配，
 *     故 `DEEPSEEK_API_KEY`、`visionApiKey`、`accessToken` 等写法都能命中）；内存里仍保留完整值，
 *     因为内存里的那份只活在本页面会话中，不落盘、不外带 —— 而 localStorage 是明文、可被同源脚本、
 *     开发者工具、目录同步工具与备份带走的。
 *   · 剔除 = 删掉这个键，绝不置成空字符串：后端两条配置写入通路都是深合并
 *     （`server/index.js:5134` 的 deepMerge、`server/index.js:6700` 的 deepMergeObject），
 *     "键不存在"= 保留服务器上的原值；置空串则会把真令牌/真密钥覆盖成空。
 *   · 因此从磁盘恢复出来的记录是脱敏副本：界面在"实时回包尚未到达"的窗口里可能显示空的密钥框，
 *     用户若恰好在此窗口点保存，空值会写回后端。为此本模块记录脱敏路径（`rehydratedSecrets`），
 *     并由 `dropUnknownSecrets()` 在提交前把"我们已知不真实、且刚好是空值"的字段从请求体里删掉
 *     （深合并 → 后端保留原值），使脱敏永不反过来损坏真实配置。任何一次实时回包
 *     （`rememberConfig`）都会清掉该标记，标记消失后该保护自动失效、不再干预用户的显式清空。
 *   · 一句话：缓存里的密钥只活在内存，磁盘上只有"非密钥的那部分配置"。
 *
 * 「降级」localStorage 的每一次读写都包在 try/catch 里：隐私模式 / 存储被禁用 / 配额超限 /
 * JSON 被改坏 / 记录结构不认识 —— 一律静默当作"没有缓存"（页面回到原有的空白 + 禁用行为），
 * 绝不抛错、绝不阻塞页面。
 */

/** 缓存键：管理端实例配置（`GET /api/config`） */
export const CFG_MANAGER = 'manager-config';
/** 缓存键：本机桥配置（`GET /api/bridge/config`） */
export const CFG_BRIDGE_LOCAL = 'bridge-config:local';
/** 缓存键前缀：服务端桥配置（`GET /api/ssh/bridge-config`），须拼 serverId */
export const CFG_BRIDGE_REMOTE_PREFIX = 'bridge-config:remote:';
/** 缓存键：语音配置（`GET /api/voice/config`） */
export const CFG_VOICE = 'voice-config';
/** 缓存键：学习配置（`GET /api/learning/config`） */
export const CFG_LEARNING = 'learning-config';
/** 缓存键：上次成功取到的连接事实（`GET /api/state` 的 `connected` / `activeServer`）。
 *  只存"上次连的是哪台、连没连上"这几项，不存任何进程/端口状态 —— 它只用来在
 *  「本次页面刚打开、`/api/state` 还没回来」的那几秒里给出一句可显示的话
 *  （「正在连接 X…」），而不是武断地写「未连接远程」。 */
export const CFG_LAST_CONNECT = 'last-connect';

/** localStorage 命名空间（带版本前缀；升版本即旧记录自然失效） */
const STORAGE_NS = 'moonbot.cfgcache.v1';
/** 落盘记录的存活时间：超期即视为过期并删除（页面挂载时本来就会重新读一次，这里只是兜底，
 *  防止早已不存在的服务器/已改过的配置在很久以后仍被当作初值渲染）。 */
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 单条记录落盘上限（字符数）：正常的配置对象只有几十 KB；超限说明抓到了不该缓存的大对象
 *  （例如把某张图/某段 base64 当配置存了），此时宁可不落盘。 */
const MAX_RECORD_CHARS = 512 * 1024;
/** 脱敏递归深度上限与环保护：配置是浅层 JSON，这里只是防止异常结构把页面卡死 */
const REDACT_MAX_DEPTH = 12;

/* ================= 作用域鉴别（歧义键绝不跨侧回落） =================
 * 「问题」`CFG_VOICE`（`/api/voice/config`）与 `CFG_LEARNING`（`/api/learning/config`）这两个接口
 * 都是"当前活动目标"上的配置：本机运行时读本机桥那份，连上服务器后读服务器桥那份
 * （见 `server/index.js` 的 voiceRoute / learningConfigRoute 与 `callBridgeConsole`）。
 * 而这两页用的缓存键是固定的、不含作用域的 —— 于是"先连服务器 A 看一眼语音配置，再切回本机"时，
 * 缓存会把 A 那份当成本机的显示出来。拿服务端值冒充本机值（或反过来）比闪一下默认值危险得多，
 * 故本模块自行按作用域鉴别这两个键：
 *   · 落盘记录里带上写它时的作用域标签（`moonbot.cfgcache.v1.<scope>::<key>` 的键名是"键的作用域"，
 *     而这里的标签是"数据来自哪一侧"，二者不是一回事：键名对歧义键恒为 local）；
 *   · 读缓存时要求"标签 == 当前作用域"。当前作用域在本次页面加载的首帧之前即由
 *     "上次的连接事实"播种（见文件头「作用域播种」段），`/api/state` 到达后再由
 *     `noteActiveScope`（`src/api.ts` 每次成功取状态时调用）纠正为实测值；
 *   · 不匹配就返回"没有缓存"（页面按"尚未读到"渲染，等实时回包），绝不回落到另一侧的值；
 *     磁盘上那份不删 —— 切回原来那一侧时它仍可用（标签匹配即可命中）。
 * 页面（VoiceConfig.tsx / Learning.tsx）无需改动；它们的 `rememberConfig` 写入会被自动打上标签。 */
const AMBIGUOUS_KEYS: readonly string[] = [CFG_VOICE, CFG_LEARNING];
function isAmbiguous(key: string): boolean { return AMBIGUOUS_KEYS.includes(key); }

/** 「当前作用域」：是否已确定。播种即置真（见 `seedScopeFromPersisted`），故它现在只是一个兜底判据：
 *  歧义键不再有"作用域未知 → 整档不命中"的窗口。 */
let scopeKnown = false;
/** 当前活动作用域：'local'（未连服务器）/ `remote:<serverId>`；
 *  SSH 已连上但服务端身份尚未解析出来时记 `remote:?` —— 此时本机那份与服务端那份都不敢用。 */
let currentScope = '';
/** 本次页面加载是否已把"上次的作用域"播种下来（只播一次） */
let scopeSeeded = false;
/** 当前作用域是否已被 `/api/state` 实测过（false = 还只是播种的推测值）。
 *  落盘写入要求它为真：推测值只影响"首帧先显示什么"，绝不能变成写盘时打的标签。 */
let scopeObserved = false;
/** 播种来源：'last-connect' = 沿用上次落盘的真实连接记录；'default-local' = 从未有过任何持久记录 */
let scopeSeedSource: 'last-connect' | 'default-local' = 'default-local';
/** 内存里每份歧义缓存值来自哪一侧（与它一起被写入） */
const ambiguousTag = new Map<string, string>();
/** 作用域尚未实测期间写入内存的歧义键（其标签只是播种的推测）：作用域被真实值纠正时丢弃 */
const unverifiedScope = new Set<string>();

/**
 * 「首帧播种」：把"上次的作用域"当作本次页面加载首帧的作用域，使第一次渲染就能命中缓存。
 *  见文件头「作用域播种」段：这是"消灭中间态"与"本机/服务端绝不互相冒充"之间的取舍。
 *
 * 取值来源唯一：已落盘的连接事实 `CFG_LAST_CONNECT`（`rememberLastConnect` 于每次成功取到
 * `/api/state` 时写入）——上次 `connected=true` 按 `remote:<serverId>` 播种，否则按 `local`。
 * 从未有过任何持久记录（全新安装 / 清过缓存 / localStorage 不可用）→ 按 `local` 播种。
 * 直接读 localStorage 而不经 `getCachedConfig`：避免与缓存读写路径互相调用。
 */
function seedScopeFromPersisted(): void {
  if (scopeSeeded) return;
  scopeSeeded = true;
  let v: any = null;
  const ls = storage();
  if (ls) {
    try {
      const raw = ls.getItem(storageKeyOf(CFG_LAST_CONNECT));
      const rec = raw ? JSON.parse(raw) : null;
      v = rec && typeof rec === 'object' ? rec.value : null;
    } catch { v = null; }                                 // 坏 JSON / 读不了：按"没有记录"处理
  }
  if (v && typeof v === 'object' && v.connected === true) {
    currentScope = `remote:${v.serverId ? String(v.serverId) : '?'}`;
    scopeSeedSource = 'last-connect';
  } else {
    currentScope = 'local';
    scopeSeedSource = 'default-local';
  }
  scopeKnown = true;
}

/** 由 `src/api.ts` 的 `getState()` 在每次成功取到状态后调用：登记"当前活动作用域是哪一个"。
 *  `connected=true` 但没有 serverId（刚连上、服务端尚未解析）时记为 `remote:?`：
 *  这与两侧的标签都不相同 → 歧义键一律不命中（宁可短暂空白，也不拿本机值冒充服务端值）。
 *
 *  「纠正时序」：真实作用域与播种值不同时，只改当前作用域，不动盘上任何数据；此后读取严格按
 *  真实作用域命中（另一侧那份留在盘上，切回去仍可用）。此刻若某页已按猜错的那一侧渲染过，它会在
 *  下一次渲染（通常就是紧随其后的实时回包）被真实值替换 —— 这一帧不可避免，但界面上不会出现
 *  「正在读取 / 不可用 / 未连接」：这类还没有结论的中间态。 */
export function noteActiveScope(connected: boolean, serverId?: string | null): void {
  seedScopeFromPersisted();
  const next = connected ? `remote:${serverId ? String(serverId) : '?'}` : 'local';
  const corrected = next !== currentScope;
  scopeObserved = true;
  currentScope = next;
  scopeKnown = true;
  if (corrected) {
    /* 播种猜错了：把"尚未实测期间只写在内存里"的那几份歧义缓存丢弃（它们的标签只是推测）。
       磁盘上没有写过它们（见 `writePersisted` 的同名判据），故不存在需要清理的落盘数据。 */
    for (const k of unverifiedScope) { store.delete(k); ambiguousTag.delete(k); persistedSig.delete(k); }
  }
  unverifiedScope.clear();
}

/** 诊断用：当前作用域及其来源（播种 / 实测）。供报告与临时校验脚本读取，页面无需使用。 */
export function activeScopeInfo(): { scope: string; known: boolean; observed: boolean; seedSource: 'last-connect' | 'default-local' } {
  seedScopeFromPersisted();
  return { scope: currentScope, known: scopeKnown, observed: scopeObserved, seedSource: scopeSeedSource };
}

/** 歧义键是否允许返回"这次读到的这一份"；非歧义键一律放行。 */
function scopeOk(key: string, tag?: string | null): boolean {
  if (!isAmbiguous(key)) return true;
  seedScopeFromPersisted();           // 首帧：作用域取"上次那一侧"，不再是"未知 → 一律不命中"
  if (!scopeKnown) return false;      // 兜底（播种之后不会走到这里）
  return (tag ?? ambiguousTag.get(key)) === currentScope;
}

/* ================= 一级：内存 ================= */

const store = new Map<string, unknown>();
/** 已落盘内容的指纹：与上次完全相同则不再写 localStorage（`/api/state` 轮询每秒一次，
 *  连接事实没变就不该反复写盘）。 */
const persistedSig = new Map<string, string>();
/** 本次页面加载中，哪些键是从磁盘脱敏副本恢复的（值 = 被剔除的字段路径）。
 *  它们一旦被实时回包覆盖（`rememberConfig`）即删除 —— 标记存续期间，提交配置时会把
 *  "已知不真实且为空值"的凭证字段从请求体里剔除（见文件头 注释）。 */
const rehydratedSecrets = new Map<string, string[]>();

/* ================= 二级：localStorage ================= */

/** 取得可用的 localStorage；不可用（隐私模式 / 被禁用 / 非浏览器环境）一律返回 null */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const ls = window.localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch { return null; }
}

/** 缓存键 → 作用域（本机 / 远端）。远端键自带服务器 id，故"先连 A 再连 B 再回 A"记录各自独立。 */
function scopeOf(key: string): 'remote' | 'local' {
  return key.startsWith(CFG_BRIDGE_REMOTE_PREFIX) ? 'remote' : 'local';
}

/** 缓存键 → localStorage 键：`moonbot.cfgcache.v1.<scope>::<key>` */
function storageKeyOf(key: string): string {
  return `${STORAGE_NS}.${scopeOf(key)}::${key}`;
}

function removePersisted(key: string): void {
  const ls = storage();
  if (!ls) return;
  try { ls.removeItem(storageKeyOf(key)); } catch { /* 忽略 */ }
  persistedSig.delete(key);
}

/** 读一条落盘记录。任何异常（无 localStorage / JSON 损坏 / 结构不认识 / 已过期）都返回 null，
 *  并把坏记录顺手删掉 —— 调用方据此走"无缓存"路径。 */
function readPersisted(key: string): any | null {
  const ls = storage();
  if (!ls) return null;
  let raw: string | null = null;
  try { raw = ls.getItem(storageKeyOf(key)); } catch { return null; }
  if (!raw) return null;
  let rec: any = null;
  try { rec = JSON.parse(raw); } catch { removePersisted(key); return null; }
  if (!rec || typeof rec !== 'object' || !rec.value || typeof rec.value !== 'object') { removePersisted(key); return null; }
  if (typeof rec.at === 'number' && Date.now() - rec.at > STORAGE_TTL_MS) { removePersisted(key); return null; }
  /* 歧义键（语音 / 学习）：落盘记录里必须带着"写入时它属于哪一侧"的标签，且与当前作用域一致。
     不一致就当作"没有缓存"（记录留在盘上，切回那一侧时还能用），绝不跨侧回落。 */
  if (isAmbiguous(key)) {
    if (!scopeOk(key, typeof rec.scope === 'string' ? rec.scope : null)) return null;
    ambiguousTag.set(key, String(rec.scope));
  }
  const paths: string[] = Array.isArray(rec.redacted) ? rec.redacted.filter((p: unknown) => typeof p === 'string') : [];
  if (paths.length) rehydratedSecrets.set(key, paths);
  return rec.value;
}

/** 写一条落盘记录（脱敏后的副本）。任何异常都静默吞掉。 */
function writePersisted(key: string, value: unknown): void {
  const ls = storage();
  if (!ls) return;
  /* 歧义键（语音 / 学习）的作用域标签必须是实测到的：还停留在播种推测期间一律不落盘 ——
     标签只是猜测时，猜错就等于让磁盘上出现"用服务端那份冒充本机那份"的记录，比闪一下更危险。
     内存里那份仍然可用（`persist` 已同步打上标签），只是不写磁盘。 */
  let scopeTag: string | undefined;
  if (isAmbiguous(key)) {
    if (!scopeObserved) return;
    scopeTag = currentScope || 'local';
  }
  const { value: safe, redacted } = redactSecrets(value);
  let text: string;
  try { text = JSON.stringify({ v: 1, at: Date.now(), redacted, scope: scopeTag, value: safe }); } catch { return; }
  if (!text || text.length > MAX_RECORD_CHARS) return;
  if (persistedSig.get(key) === text) return;      // 内容未变：不重复写盘
  try { ls.setItem(storageKeyOf(key), text); persistedSig.set(key, text); } catch { /* 配额 / 隐私模式 */ }
}

/* ================= 脱敏（落盘前剔除密钥） ================= */

/** 凭证字段名后缀清单（键名先小写化并去掉所有非字母数字字符再比对，故各种写法都能命中）：
 *  apiKey / visionApiKey / DEEPSEEK_API_KEY → apikey；accessToken / wsAccessToken / webuiToken →
 *  token；refreshToken、password、passphrase、privateKey、secret、cookie、credential、
 *  authorization、sessionKey、phpsessid。
 *  「为什么用后缀而不是全等」：配置里的凭证字段名有十几种写法（有的带前缀、有的是 snake_case、
 *  有的在 env 映射里是常量名），用后缀匹配一次覆盖。
 *  「为什么不误伤」：配置里以这些后缀结尾的非凭证键只有 `tokenCost`（/token 计价，结尾是 cost）、
 *  `maxTokens` / `tokens`（结尾是 tokens，不是 token），两者都不在清单内，不会被剔掉。 */
const SECRET_NAME_SUFFIXES = [
  'password', 'passwd', 'passphrase', 'privatekey', 'secret', 'apikey',
  'token', 'cookie', 'cookies', 'credential', 'credentials',
  'authorization', 'sessionkey', 'phpsessid', 'accesskey', 'secretkey',
];

function isSecretName(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return false;
  return SECRET_NAME_SUFFIXES.some((s) => n.endsWith(s));
}

/** 深拷贝一份"去掉凭证字段"的值，同时记下被剔除的字段路径（`a.b` / `a[0].b` 形式） */
function redactSecrets(value: unknown): { value: any; redacted: string[] } {
  const redacted: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: any, path: string, depth: number): any => {
    if (v === null || typeof v !== 'object') return v;
    if (depth > REDACT_MAX_DEPTH) return undefined;      // 超过深度：丢掉（不能落盘的东西宁可不落）
    if (seen.has(v)) return undefined;                   // 环：丢掉
    seen.add(v);
    if (Array.isArray(v)) {
      return v.map((it, i) => {
        const r = walk(it, `${path}[${i}]`, depth + 1);
        return r === undefined ? null : r;
      });
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const p = path ? `${path}.${k}` : k;
      if (isSecretName(k)) { redacted.push(p); continue; }   // 密钥不落盘：删键（不是置空串）
      const r = walk(v[k], p, depth + 1);
      if (r !== undefined) out[k] = r;
    }
    return out;
  };
  return { value: walk(value, '', 0), redacted };
}

/** 路径字符串 → 访问令牌序列：`servers[0].password` → ['servers', 0, 'password'] */
function tokensOf(path: string): Array<string | number> {
  const toks: Array<string | number> = [];
  const re = /[^.[\]]+|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) toks.push(m[1] !== undefined ? Number(m[1]) : m[0]);
  return toks;
}

/* ================= 对外：读 / 写 / 丢 ================= */

/** 服务端桥配置的缓存键：同一台服务器的配置只认这一条，不同服务器互不混淆 */
export function bridgeRemoteKey(serverId: string): string {
  return CFG_BRIDGE_REMOTE_PREFIX + String(serverId);
}

/** 取缓存。顺序：内存 → localStorage（命中即回填内存）。
 *  没有缓存（含存过 `null`/`undefined`）一律返回 `null`，调用方据此判断"尚未读到"。
 *  「歧义键（语音 / 学习）」：还要满足"这一份确实属于当前作用域"才会返回，见上方作用域鉴别段。 */
export function getCachedConfig<T = any>(key: string): T | null {
  if (isAmbiguous(key) && !scopeOk(key)) {
    /* 内存里那份可能是另一侧的（本机 ⇄ 服务端切换过）：不返回它，
       转而看看磁盘上有没有"属于当前作用域"的那一份；都没有就当作无缓存。 */
    const disk = readPersisted(key);
    if (disk !== null) { store.set(key, disk); return disk as T; }
    return null;
  }
  const mem = store.get(key);
  if (mem !== undefined) return mem as T;
  const disk = readPersisted(key);
  if (disk !== null) { store.set(key, disk); return disk as T; }
  return null;
}

/** 只写内存 + 落盘（不改变"这是脱敏副本"的标记）。 */
function persist(key: string, value: unknown): void {
  seedScopeFromPersisted();
  store.set(key, value);
  if (isAmbiguous(key)) {
    /* 内存标签同样取当前作用域；尚未实测时记一笔，作用域被真实值纠正时这份内存值即被丢弃 */
    ambiguousTag.set(key, currentScope || 'local');
    if (scopeObserved) unverifiedScope.delete(key); else unverifiedScope.add(key);
  }
  writePersisted(key, value);
}

/** 记缓存。只接受对象（配置本体）；传入空值视为"本次没有可用的配置"，不改动已有缓存。
 *
 *  「注意」：调用它表示"这是实时拿到的完整值"：会清掉该键的脱敏标记（`rehydratedSecrets`），
 *  此后 `dropUnknownSecrets` 不再干预该键的提交。 */
export function rememberConfig<T>(key: string, value: T | null | undefined): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  rehydratedSecrets.delete(key);
  persist(key, value);
}

/** 丢弃某个键的缓存（内存 + 磁盘；读取目标不存在或已失效时使用） */
export function forgetConfig(key: string): void {
  store.delete(key);
  rehydratedSecrets.delete(key);
  removePersisted(key);
}

/** 清空全部缓存（仅测试或彻底重置时使用；页面流程中不要调用）。
 *  只删本命名空间下的键，不动 localStorage 里其它任何东西。 */
export function clearConfigCache(): void {
  store.clear();
  rehydratedSecrets.clear();
  persistedSig.clear();
  const ls = storage();
  if (!ls) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(`${STORAGE_NS}.`)) doomed.push(k);
    }
    for (const k of doomed) ls.removeItem(k);
  } catch { /* 忽略 */ }
}

/* ================= 读取目标（本机 / 远端）互不回落 ================= */

/** 该键当前是否是"从磁盘脱敏副本恢复、尚未被实时回包覆盖"的值。
 *  为 true 时：界面上的密钥框可能是空的（原值没落盘），提交配置须先过 `dropUnknownSecrets`。 */
export function hasRedactedSecrets(key: string): boolean {
  const p = rehydratedSecrets.get(key);
  return !!p && p.length > 0;
}

/** 本次页面加载中，该键被剔除的字段路径（供诊断/报告用；正常情况下界面无需关心）。 */
export function redactedSecretPaths(key: string): string[] {
  return [...(rehydratedSecrets.get(key) ?? [])];
}

/**
 * 提交配置前的保护（配合后端深合并生效）：
 * 把"磁盘副本里被剔除、因而我们并不真正知道其值、且在请求体里恰好是空值"的凭证字段，
 * 从请求体里删掉（而不是留一个空串）。后端 `deepMerge`/`deepMergeObject` 对缺失键
 * 会保留服务器上的原值，因此这一步的结果是"不改动那条密钥"，而不是"清空它"。
 *
 * 只在 `hasRedactedSecrets(key)`（本次是脱敏副本起底）时生效；任何一次实时回包之后标记即消失，
 * 用户此后显式清空某条密钥（提交空串）会照常生效 —— 即：该保护只防"我们不知道值"，不防"用户要清空"。
 */
export function dropUnknownSecrets(key: string, body: any): void {
  const paths = rehydratedSecrets.get(key);
  if (!paths || !paths.length) return;
  if (!body || typeof body !== 'object') return;
  /* 请求体的形状各处不同：桥配置是 `{ config: {...}, persona, ... }`（路径相对 config.json 根），
   * 管理端配置补丁是 `{ instances: {...} }`（路径自带 instances 前缀）。故对两条通路都试一次根：
   * 先按传入对象本身解路径，解不开再按 `.config` 解 —— 命中即止，不会重复删。 */
  const roots: any[] = [body];
  if ((body as any).config && typeof (body as any).config === 'object') roots.push((body as any).config);
  for (const p of paths) {
    const toks = tokensOf(p);
    if (!toks.length) continue;
    for (const root of roots) if (dropIfResolved(root, toks)) break;
  }
}

/** 按令牌序列找到容器对象；若该键存在且值为空串/null/undefined 则删掉。
 *  @returns 路径是否在 `root` 上解析成功（成功即不再尝试其它根） */
function dropIfResolved(root: any, toks: Array<string | number>): boolean {
  if (!root || typeof root !== 'object') return false;
  let cur: any = root;
  for (let i = 0; i < toks.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return false;
    cur = cur[toks[i] as any];
  }
  if (!cur || typeof cur !== 'object') return false;
  const leaf = toks[toks.length - 1] as any;
  if (!Object.prototype.hasOwnProperty.call(cur, leaf)) return false;
  const v = cur[leaf];
  if (v === '' || v === null || v === undefined) { try { delete cur[leaf]; } catch { /* 忽略 */ } }
  return true;
}

/* ================= 「/api/config」中的单个实例配置 ================= */

/** 读某个实例（`dshIsolated` / `napcatLocal` / `bridgeLocal`）的缓存配置；没有则返回 `null`。 */
export function cachedInstanceConfig<T = any>(instanceKey: string): T | null {
  const c = getCachedConfig<any>(CFG_MANAGER);
  const v = c && typeof c === 'object' ? (c as any).instances?.[instanceKey] : null;
  return v && typeof v === 'object' ? (v as T) : null;
}

/**
 * 就地更新某个实例的缓存配置（保存成功后调用）。
 * 目的是让"保存 → 切走 → 再切回"看到的是刚保存的值，而不是保存前的那份旧缓存。
 * 「注意」：这里不清除该键的脱敏标记：保存回包不是"实时读到了完整配置"，
 * 若用户是在脱敏副本（密钥框为空）上直接保存的，仍需 `dropUnknownSecrets` 的保护。
 */
export function rememberInstanceConfig(instanceKey: string, value: any): void {
  if (!value || typeof value !== 'object') return;
  const prev = getCachedConfig<any>(CFG_MANAGER) ?? {};
  const instances = { ...(((prev as any).instances ?? {}) as Record<string, unknown>), [instanceKey]: value };
  persist(CFG_MANAGER, { ...(prev as any), instances });
}

/* ================= 连接事实（消除"未连接远程"的空窗） =================
 * 页面刚打开、`/api/state` 尚未回来时，界面此前只能把 `connected` 当作 false，
 * 于是先写一句"未连接远程"、几百毫秒后再变"远程已连接" —— 这正是此前反馈的
 * "桥不可达的短暂状态"。此处记下上一次成功取到的连接事实，让界面在此期间说
 * 「正在连接 X…」（2026-09-24 前的措辞是「正在核实与 X 的连接…」，主人要求去掉"正在核实"这种
 * 状态机口吻）；真正确定失败（状态机 failed / 明确未连接）仍照常显示失败。
 * 只记 connected / serverId / serverName / autoConnectServer，不含任何凭证与进程状态。 */
export interface LastConnect {
/** 最近一次 `/api/state` 报的 connected */
  connected: boolean;
  serverId?: string;
  serverName?: string;
/** 管理器的"启动时自动连接服务器"开关 */
  autoConnectServer?: boolean;
/** 最近一次报 connected=true 的时刻（连接断开后仍保留）：
   *  判据是"上次是连着的"，而不是"现在连着" —— 后端刚起来、状态机还没开始连的那一瞬间，
   *  `/api/state` 会如实报 connected=false，但那不等于"连不上"。 */
  wasConnectedAt: number;
  at: number;
}

/** 记录一次成功的 `/api/state` 结果（由 `src/api.ts` 的 `getState()` 自动调用）。
 *  结论未变时不重写（轮询每秒一次，没必要反复落盘）。 */
export function rememberLastConnect(s: {
  connected?: boolean;
  activeServer?: { id?: string; name?: string } | null;
  autoConnectServer?: boolean;
} | null | undefined): void {
  if (!s || typeof s !== 'object') return;
  const prev = getCachedConfig<LastConnect>(CFG_LAST_CONNECT);
  const connected = !!s.connected;
  /* 状态里没有 activeServer（尚未连上就是这样）时，保留上次记下的服务器名 ——
   * "正在连接 X…"要有 X 可写。 */
  const serverId = s.activeServer?.id ?? prev?.serverId;
  const serverName = s.activeServer?.name ?? prev?.serverName;
  const autoConnectServer = s.autoConnectServer === true;
  if (prev && prev.connected === connected && prev.serverId === serverId
    && prev.serverName === serverName && prev.autoConnectServer === autoConnectServer) return;
  const next: LastConnect = {
    connected, serverId, serverName, autoConnectServer,
    wasConnectedAt: connected ? Date.now() : (prev?.wasConnectedAt ?? 0),
    at: Date.now(),
  };
  persist(CFG_LAST_CONNECT, next);
}

/** 上次已知的连接事实；从未拿到过 `/api/state` 时为 null。 */
export function lastConnect(): LastConnect | null {
  const v = getCachedConfig<LastConnect>(CFG_LAST_CONNECT);
  return v && typeof v === 'object' ? v : null;
}

/** 界面判定用的最小状态形状（避免本模块依赖 stores/types，也便于单测） */
export interface ConnectViewLike {
  connected?: boolean;
  autoConnectServer?: boolean;
  connect?: { phase?: string } | null;
}

/**
 * 「上次是连着的，本次状态还没回来」—— 是则返回一句可直接显示的话，否则返回 null。
 *   （2026-09-24 主人要求："不要有正在核实的状态机" —— 文案由「正在核实与 X 的连接…」
 *    改为「正在连接 X…」：说的是正在发生的事，而不是"我还不确定"。判据与渲染顺序都不变。）
 *
 * 「它解决什么」：反馈原话：连服务器时界面仍会短暂出现"桥不可达 / 未连接"这类结论性文案。
 * 这些结论此刻并不成立：状态还没回来，或后端的状态机才刚起步（首帧 `connect.phase` 仍是 `idle`，
 * 而 `idle` 的语义是"还没开始连"，不是"连不上"）。
 *
 * 「为什么不能只看 connected」：后端状态机的 `idle` 有三种来历：
 *   ① 开机自启动连接还没轮到（本函数要覆盖的就是这一段，通常不到 1 秒）；
 *   ② 明确配置为不自动连接（`autoConnectServer === false`）——这是确定结论，照实显示；
 *   ③ 主动断开：`/api/ssh/disconnect` 不改状态机阶段（仍是 `ready`），故不会落入本分支。
 * 因此这里的判据是「`phase === 'idle'` 且 自动连接开着 且 本次状态里 connected 为 false」。
 *
 * 「调用方约定的渲染顺序」`connectBusy`（连接进行中：connecting/tunnels/… 用 CONNECT_FOOT 那套）
 * → 本函数（返回文案时显示中性一行）→ 已连上/未连上的既有一切文案。
 * @returns 可直接显示的文案（含服务器名，若记得）；没有这种情况下该显示的内容时返回 null
 */
export function pendingConnect(state: ConnectViewLike | null | undefined): string | null {
  const last = lastConnect();
  if (!last) return null;                                       // 从未取到过状态：按"首次连接"照常显示
  const wasConnected = last.connected || last.wasConnectedAt > 0;
  if (!wasConnected) return null;                               // 上次就知道没连上 → 照实说"未连接"
  const text = last.serverName
    ? `正在连接 ${last.serverName}…`
    : '正在连接服务器…';
  if (!state) return text;                                      // 状态还没回来（页面刚打开）
  if (state.connected) return null;                             // 已连上：由既有逻辑渲染
  const phase = state.connect?.phase ?? 'idle';
  if (phase === 'failed') return null;                          // 确定失败：照实显示失败
  if (phase !== 'idle') return null;                            // 连接进行中：由 CONNECT_FOOT 的那套文案承担
  if (state.autoConnectServer !== true) return null;            // 用户关了自动连接 → idle 就是"不连"
  return text;                                                  // idle + 自动连接开着 = 后端还没开始连
}
