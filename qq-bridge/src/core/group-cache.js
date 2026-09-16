// 群信息/群名缓存
// cfg 静态注入（initGroupCacheCore），bot 运行期注入（setGroupCacheBot）。
import { log } from '../lib/log.js';

// ── 群信息缓存：群主/管理员（OneBot get_group_member_list 的 role 字段） ──
const groupInfoCache = new Map(); // groupId -> { ownerId, ownerName, adminIds, adminNames, ts }
const GROUP_INFO_TTL_MS = 10 * 60 * 1000;
// 群名缓存：groupId -> { name, ts }，用于唤醒提示的【群清单】，避免 AI 记不住群号↔群名对应关系发错群
const groupNameCache = new Map();
// 【2026-09-16 修】get_group_info（NapCat 内部走 NodeIKernelGroupService/getGroupDetailInfo）在部分
// QQ 版本/账号缓存上会稳定失败，实测报 `EventChecker Failed … "errMsg":"inner_error"`：
// 一失败群名就永久缺失，桥日志与唤醒提示里的群名全变成光秃秃的群号（看着像坏了，其实只是名字没拿到）。
// 这里补一条**回退**：改用 get_group_list 拉全量群列表（同环境实测可用），建「群号 → 群名」映射并缓存。
let groupListCache = { ts: 0, map: new Map() };
const GROUP_LIST_TTL_MS = 10 * 60 * 1000;

/** 回退：从 get_group_list 全量列表里找群名（列表整体缓存 10 分钟，逐个群不会重复请求）。 */
async function nameFromGroupList(g) {
  const fresh = Date.now() - groupListCache.ts < GROUP_LIST_TTL_MS && groupListCache.map.size > 0;
  if (!fresh) {
    try {
      const list = await botRef.api('get_group_list', {});
      const arr = Array.isArray(list) ? list : (list?.data ?? []);
      const map = new Map();
      for (const it of arr) {
        const id = it?.group_id != null ? String(it.group_id) : '';
        const nm = String(it?.group_name || it?.name || '').trim();
        if (id && nm) map.set(id, nm);
      }
      if (map.size) groupListCache = { ts: Date.now(), map };
    } catch (error) {
      log(`[memory] 群列表拉取失败（群名回退也失败）：${error?.message ?? error}`);
    }
  }
  return groupListCache.map.get(g) || null;
}

let cfgRef = null;
let botRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initGroupCacheCore(cfg) {
  cfgRef = cfg;
}
/** NapCat 网关就绪后注入 bot（NapCat client） */
export function setGroupCacheBot(bot) {
  botRef = bot;
}

export async function warmGroupName(groupId) {
  const g = String(groupId);
  try {
    const info = await botRef.getGroupInfo(Number(g));
    const name = String(info?.group_name || info?.name || '').trim();
    if (name) {
      groupNameCache.set(g, { name, ts: Date.now() });
      return name;
    }
  } catch (error) {
    // 主路径失败不再直接放弃：先试 get_group_list 回退，拿到名字就照常返回（只留一行说明用了回退）
    const fallback = await nameFromGroupList(g);
    if (fallback) {
      groupNameCache.set(g, { name: fallback, ts: Date.now() });
      log(`[memory] 群名主接口失败(${error?.message ?? error})，已用群列表回退拿到「${fallback}」`);
      return fallback;
    }
    log(`[memory] 群名拉取失败 ${g}: ${error?.message ?? error}`);
    return null;
  }
  return null;
}

export function getGroupDisplayName(groupId) {
  const hit = groupNameCache.get(String(groupId));
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL_MS) return hit.name;
  return null;
}

// 群清单文本：所有白名单群的 群号（群名），供 AI 跨会话发消息时确认目标，避免发错群
export function formatGroupListLine() {
  const gids = Array.isArray(cfgRef?.allow?.groups) ? cfgRef.allow.groups.map(String) : [];
  if (!gids.length) return '';
  const parts = gids.map((g) => {
    const name = getGroupDisplayName(g);
    return name ? `${g}(${name})` : `${g}`;
  });
  return `[Groups] ${parts.join(', ')}`;
}

export async function warmGroupInfo(groupId) {
  const g = String(groupId);
  try {
    const list = await botRef.getGroupMemberList(Number(g));
    const members = Array.isArray(list) ? list : (list?.data ?? []);
    let ownerId = null, ownerName = null;
    const adminIds = [], adminNames = [];
    for (const m of members) {
      const uid = m?.user_id != null ? String(m.user_id) : null;
      if (!uid) continue;
      const nm = m?.card || m?.nickname || String(uid);
      const role = String(m?.role ?? '');
      if (role === 'owner') { ownerId = uid; ownerName = nm; }
      else if (role === 'admin') { adminIds.push(uid); adminNames.push(nm); }
    }
    if (ownerId) {
      groupInfoCache.set(g, { ownerId, ownerName, adminIds, adminNames, ts: Date.now() });
      return groupInfoCache.get(g);
    }
  } catch (error) {
    log(`[memory] 群信息拉取失败 ${g}: ${error?.message ?? error}`);
  }
  return null;
}

export function getCachedGroupInfo(groupId) {
  const hit = groupInfoCache.get(String(groupId));
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL_MS) return hit;
  return null;
}

export function formatGroupInfoLine(groupId) {
  const info = getCachedGroupInfo(groupId);
  if (!info) return '';
  const owner = `${info.ownerName || '?'}(QQ:${info.ownerId})`;
  const admins = info.adminNames && info.adminNames.length ? `; admins: ${info.adminNames.join(', ')}` : '';
  return `[This group] owner: ${owner}${admins}`;
}
