// 独立识图模型（2026-09-19 需求："把语言模型和识图模型分开，识图模型不配置就用语言模型"）
//
// 为什么单独一条：
//   · 以前的识图只有一条路 —— 把图片当附件发给 DSH 主模型，并且要求主模型自己多模态；
//     等于"看图"和"回话"必须是同一个厂商、同一份额度、同一种计价。
//   · 需求是：语言模型照旧（文字回话），识图另外指一个地址 + 一把 key + 一个模型
//     （OpenAI 兼容的 /chat/completions），图片在这个通路上被转成文字描述再交给语言模型。
//     好处：识图可以用便宜的/专门的模型，主模型只收文字，省额度也少踩"主模型不支持图片"的坑。
//
// 三种配置形态（与界面帮助文案一一对应，不要各写一套）：
//   ① dsh.visionBaseUrl 为空            → 本模块整个不启用，图片按老路走 DSH 附件（默认行为，一字不变）。
//   ② visionBaseUrl 空、visionModel 有值 → 也是老路，只是 DSH 那边显式用 visionModel 读图（见 dsh-session.js）。
//   ③ visionBaseUrl 有值（且 visionModel 有值）→ 启用独立通路：桥自己 POST /chat/completions，
//      把图片以 `image_url` 的 data URL 递过去，取回文字描述，用描述替换附件。
//
// 失败降级：独立通路任何一步失败（超时/非 2xx/解析不出文字）都退回附件，绝不因为识图挂了就丢图。
import http from 'node:http';
import https from 'node:https';
import { log } from '../lib/log.js';

/** 请求超时：识图是"消息进来 → 回话"链路上的同步等待，不能拖太久 */
const VISION_TIMEOUT_MS = 45000;
/** 响应体上限（只看文字，64KB 足够；防止对端不守规矩地灌数据） */
const VISION_MAX_RESPONSE_BYTES = 64 * 1024;
/** 交给识图模型的指令（要求它产出"能直接塞进聊天上下文"的中文描述） */
const VISION_PROMPT = '请用中文详细描述这张图片：画面主体、场景、人物及其动作表情、可见的文字、明显的风格或梗。'
  + '直接输出描述本身，不要客套话、不要"这张图片展示了"这类开场白。';

let cfgRef = null;
/** cfg 注入（bridge.js 启动时调用，与其它 core 一致） */
export function initVisionCore(cfg) { cfgRef = cfg; }

/** base 可以是 `https://host/v1` 也可以是已带 `/chat/completions` 的完整地址 */
function chatCompletionsUrl(base) {
  const s = String(base || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(s)) return s;
  return `${s}/chat/completions`;
}

/**
 * 当前配置下独立识图通路是否启用。
 * 返回 null = 没启用（走老路）；否则返回 { url, model, key }。
 */
export function visionEndpoint() {
  const base = String(cfgRef?.dsh?.visionBaseUrl ?? '').trim();
  if (!base) return null;
  const model = String(cfgRef?.dsh?.visionModel ?? '').trim();
  if (!model) {
    // 指了地址却没指模型 = 不知道该调谁。宁可退回附件，也不瞎猜一个模型名去撞 404。
    log('[vision] 配了「识图模型请求地址」但没配「识图模型」，已退回"图片当附件发主模型"的老路');
    return null;
  }
  return { url: chatCompletionsUrl(base), model, key: String(cfgRef?.dsh?.visionApiKey ?? '').trim() };
}

/** 独立识图通路是否启用（界面/日志用） */
export function visionSplitEnabled() { return !!visionEndpoint(); }

function requestJsonPost(urlString, body, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch { reject(new Error(`识图模型请求地址无效：${urlString}`)); return; }
    if (!['http:', 'https:'].includes(url.protocol)) { reject(new Error('识图模型请求地址只支持 http/https')); return; }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const mod = url.protocol === 'https:' ? https : http;
    /* 注意：这里不走 safe-fetch 的 SSRF 白名单 —— 识图服务常常就架在本机/内网
     * （llama.cpp、ollama、公司内部网关），挡掉内网等于这个功能没法用。
     * 地址是用户在管理端亲手填的运维级配置，与 dsh.baseUrl 同级信任。 */
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...headers,
      },
      timeout: VISION_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      res.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > VISION_MAX_RESPONSE_BYTES) {
          settled = true;
          try { res.destroy(); } catch { /* 已断开就算了 */ }
          reject(new Error('识图模型响应过大，已中断'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    });
    req.on('timeout', () => req.destroy(new Error(`识图模型请求超时（${VISION_TIMEOUT_MS}ms）`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** 从各家略有差异的响应里把文字抠出来（OpenAI 兼容：choices[0].message.content 可能是字符串或分段数组） */
function extractText(body) {
  const choice = body?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('').trim();
  }
  return '';
}

/**
 * 用独立识图模型描述一张图。
 * @returns {Promise<{ok:true, text:string, model:string, ms:number}|{ok:false, error:string}>}
 *   失败不抛：调用方按"退回附件"处理（识图是增强，不该成为丢图的理由）。
 */
export async function describeImageWithVisionModel(buffer, mimeType, opts = {}) {
  const ep = visionEndpoint();
  if (!ep) return { ok: false, error: '未配置独立识图模型' };
  const started = Date.now();
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${Buffer.from(buffer).toString('base64')}`;
  const body = {
    model: ep.model,
    max_tokens: Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: opts.prompt || VISION_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  };
  const headers = { accept: 'application/json' };
  if (ep.key) headers.authorization = `Bearer ${ep.key}`;
  try {
    const res = await requestJsonPost(ep.url, body, headers);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // 只截前 200 字：错误体可能很长，但不会含我们自己的 key
      return { ok: false, error: `HTTP ${res.statusCode}：${res.text.slice(0, 200)}` };
    }
    let parsed;
    try { parsed = JSON.parse(res.text); }
    catch { return { ok: false, error: '响应不是合法 JSON' }; }
    const text = extractText(parsed);
    if (!text) return { ok: false, error: '响应里没有可用的文字描述' };
    return { ok: true, text, model: ep.model, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
