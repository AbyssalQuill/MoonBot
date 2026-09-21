// 文档（docx）生成/上传 + 每日额度
// 本机部署（bridge 与 NapCat 同机，Windows/裸机）：docx 临时文件直接写 qq-bridge/state/doc-tmp，
// upload_*_file 传同一个本机绝对路径，NapCat 即可读取，不再区分 host/container。
// （已迁移：曾用服务器 Docker 挂载对 宿主机 /root/napcat/config/stickers/ ↔ 容器 /app/napcat/config/stickers/，
//   本机不存在 → ENOENT。）返回 { fileId, fileName, size }。
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { atomicWriteJson } from '../lib/json-fs.js';
import { makeDocx } from '../make-docx.js';
// 【2026-09-21】文档上传要和图片走同一套「宿主路径 → NapCat 能认的 file 参数」转换（见 uploadFileToQQ）
import { napcatImageFileArg } from '../lib/napcat-file.js';
import { beijingDateKey } from '../lib/time.js';
import { ROOT } from '../lib/paths.js';
import { getSocialState, saveSocialState } from './social-state.js';
import { sendToQQ } from './qq-send.js';
import { log } from '../lib/log.js';

export const DOC_TMP_DIR = path.join(STATE_DIR, 'doc-tmp');
// 旧导出名兼容（bridge.js / console-server.js / dsh-watch.js / mux.js 仍 import 这两个名字，未直接使用）：
// 本机已不再区分 host/container，二者同为本机绝对路径（已迁移，勿再改回 /root/napcat ↔ /app/napcat）。
export const DOC_TMP_HOST_DIR = DOC_TMP_DIR;
export const DOC_TMP_CONTAINER_DIR = DOC_TMP_DIR;
export const MAX_DOCX_CHARS = 1000000; // 单文档正文上限（100 万字）

// 每日额度持久化：{ 'YYYY-MM-DD': { quotaKey: usedChars } }
const DOCX_QUOTA_FILE = path.join(STATE_DIR, 'docx-quota.json');
export let docxQuota = {};

let cfgRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initDocxCore(cfg) {
  cfgRef = cfg;
}

// 长文每日额度（替代审批）：每个发起会话（private:QQ / group:群号）每天最多生成
// 该字数，北京时间 0 点重置；可配置 social.docx.dailyQuotaChars。
function dailyDocxQuota() {
  return Math.max(0, Number(cfgRef?.social?.docx?.dailyQuotaChars) || 100000);
}

export function loadDocxQuota() {
  try { docxQuota = JSON.parse(fs.readFileSync(DOCX_QUOTA_FILE, 'utf8')) || {}; } catch { docxQuota = {}; }
}

export function saveDocxQuota() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // 只保留最近 7 天，避免文件无限增长
    const keys = Object.keys(docxQuota).sort();
    while (keys.length > 7) delete docxQuota[keys.shift()];
    atomicWriteJson(DOCX_QUOTA_FILE, docxQuota);
  } catch (e) { log('[docx] 额度文件保存失败:', e?.message ?? e); }
}

// 检查额度是否足够（不占用）；发送成功后再 docxQuotaCommit 占用
export function docxQuotaReserve(quotaKey, chars) {
  const day = beijingDateKey();
  const m = docxQuota[day] || (docxQuota[day] = {});
  const used = Number(m[quotaKey]) || 0;
  const quota = dailyDocxQuota();
  const remaining = quota - used;
  if (chars > remaining) return { ok: false, used, quota, remaining: Math.max(0, remaining), quotaKey };
  return { ok: true, used, quota, remaining, quotaKey };
}

export function docxQuotaCommit(quotaKey, chars) {
  const day = beijingDateKey();
  const m = docxQuota[day] || (docxQuota[day] = {});
  m[quotaKey] = (Number(m[quotaKey]) || 0) + chars;
  saveDocxQuota();
}

export function writeDocxToMount(title, content, extraName = '') {
  fs.mkdirSync(DOC_TMP_DIR, { recursive: true });
  // 清理 1 小时前的旧临时文档，避免堆积
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(DOC_TMP_DIR)) {
      const p = path.join(DOC_TMP_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(p); } catch {}
    }
  } catch {}
  const safeTitle = String(title ?? '未命名文档').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || '未命名文档';
  const fileName = `${safeTitle}${extraName ? '-' + extraName : ''}-${Date.now()}.docx`;
  const buf = makeDocx(String(title ?? '未命名文档'), content);
  const hostPath = path.join(DOC_TMP_DIR, fileName);
  fs.writeFileSync(hostPath, buf);
  return { fileName, hostPath, napcatPath: hostPath, size: buf.length };
}

export async function uploadFileToQQ(key, napcatPath, fileName, options = {}) {
  const [kind, id] = key.split(':');
  const action = kind === 'private' ? 'upload_private_file' : 'upload_group_file';
  /* 【2026-09-21 修「发文档失败：识别URL失败, uri= /root/qq-bridge/state/doc-tmp/xxx.docx」】
   * 现场：NapCat 跑在 Docker 里，桥把**宿主路径**原样交给 upload_private_file，
   * 容器里根本没有这个路径，于是它按 URL 解析、报「识别URL失败」。
   * 图片/表情那条路早就修过这件事（lib/napcat-file.js 的 napcatImageFileArg：按 dockerPathMap 换容器路径，
   * 换不了再退 base64），**文档这条支线当时漏了** —— 于是「图片发得出去、文档一张都发不出去」。
   * 现在两处走同一个 helper，语义完全一致（mode=path 时行为不变，等于零风险）。 */
  const fileArg = (() => {
    try { return napcatImageFileArg(napcatPath, cfgRef, { log }); }
    catch (e) { log(`[docx] 文件参数转换失败（按原路径发）: ${e?.message ?? e}`); return napcatPath; }
  })();
  const params = kind === 'private'
    ? { user_id: Number(id), file: fileArg, name: String(fileName) }
    : { group_id: Number(id), file: fileArg, name: String(fileName) };
  const httpUrl = String(cfgRef?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfgRef?.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
  }
  return { fileId: body.data?.file_id ?? null, fileName: String(fileName) };
}

// 把「标题+正文」生成 docx 并发送到会话（写小说/长文用）。
export async function sendDocx(key, title, content, options = {}) {
  const clipped = String(content ?? '').slice(0, MAX_DOCX_CHARS);
  const { fileName, napcatPath, size } = writeDocxToMount(title, clipped);
  try {
    const sent = await uploadFileToQQ(key, napcatPath, fileName, options);
    return { ...sent, size };
  } catch (error) {
    try { fs.unlinkSync(path.join(DOC_TMP_DIR, fileName)); } catch {}
    throw error;
  }
}


// 【2026-09-13 主人要求】原来的 /help（发《小鲸鱼能力概览》docx）整条链路已删除：
// 指令、资产引用、24 小时冷却都去掉了。qq_send_docx 工具本身不受影响（模型仍可主动发 Word 文档）。
