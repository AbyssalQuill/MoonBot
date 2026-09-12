// 群信息/群名缓存
// cfg 静态注入（initGroupCacheCore），bot 运行期注入（setGroupCacheBot）。
import { log } from '../lib/log.js';

// ── 群信息缓存：群主/管理员（OneBot get_group_member_list 的 role 字段） ──
const groupInfoCache = new Map(); // groupId -> { ownerId, ownerName, adminIds, adminNames, ts }
const GROUP_INFO_TTL_MS = 10 * 60 * 1000;
// 群名缓存：groupId -> { name, ts }，用于唤醒提示的【群清单】，避免 AI 记不住群号↔群名对应关系发错群
const groupNameCache = new Map();

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
    log(`[memory] 群名拉取失败 ${g}: ${error?.message ?? error}`);
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
