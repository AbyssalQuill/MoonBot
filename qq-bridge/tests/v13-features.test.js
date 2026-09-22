// 1.3.0 新增能力的回归用例（纯函数为主，不碰生产 state 文件）。
// 覆盖三件事：
//   ① /token 的金额口径 —— 必须与管理端「学习」页实测区逐字一致（算错钱是主人一眼能看出来的错）；
//   ② 工具 schema 压缩档 —— 档位解析、白名单/黑名单优先级、实测占比；
//   ③ 记忆检索的查询串构造 —— 短词不能喂给 trigram 的 FTS5（会直接返回空，表现为"查不到"）。
// 跑法：cd qq-bridge && node tests/v13-features.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const { initTokenMeter, getTokenReport } = await import(new URL('../src/core/token-meter.js', import.meta.url));
const { initTokenReportCore, buildTokenReportText, summarizeMeasuredCost, DEFAULT_TOKEN_COST, fmtTok } =
  await import(new URL('../src/core/token-report.js', import.meta.url));
const { resolveToolTier, toolAllowedByTier, measureSchemaShare, normalizeToolTier, TOOL_TIERS } =
  await import(new URL('../src/lib/tool-tiers.js', import.meta.url));

// ── ① /token 金额口径 ─────────────────────────────────────────────────────────
await check('① 金额口径：命中/未命中/输出分别按单价相加，且只统计带缓存字段的请求', () => {
  const price = { pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2, peakHours: new Set([9, 10, 11, 14, 15, 16, 17]) };
  const hours = [
    { hour: 3, prompt: 5000, completion: 200, cacheRead: 195000, cacheWrite: 0, cachePrompt: 5000, cacheCompletion: 200, cacheSamples: 1 },
    { hour: 4, prompt: 9999, completion: 999, cacheRead: 0, cacheWrite: 0, cachePrompt: 0, cacheCompletion: 0, cacheSamples: 0 },
  ];
  const s = summarizeMeasuredCost(hours, price);
  // 只有第 1 个小时带缓存字段：0.02×195000/1e6 + 1×5000/1e6 + 4×200/1e6 = 0.0039 + 0.005 + 0.0008
  assert.equal(Number(s.cost.toFixed(6)), 0.0097, `金额 ${s.cost}`);
  assert.equal(s.peakHours, 0);
  assert.equal(s.measuredRate, 195000 / 200000);
});

await check('① 高峰时段按北京小时整体乘倍率，并且谷时/高峰分开记账', () => {
  const price = { pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2, peakHours: new Set([9, 10, 11, 14, 15, 16, 17]) };
  const mk = (hour) => ({ hour, prompt: 1e6, completion: 0, cacheRead: 0, cacheWrite: 0, cachePrompt: 1e6, cacheCompletion: 0, cacheSamples: 1 });
  const s = summarizeMeasuredCost([mk(3), mk(10)], price);
  assert.equal(Number(s.offCost.toFixed(6)), 1);       // 谷时 1e6 × ¥1/M
  assert.equal(Number(s.peakCost.toFixed(6)), 2);      // 高峰同样量 ×2
  assert.equal(s.peakHours, 1);
  assert.equal(Number(s.cost.toFixed(6)), 3);
});

await check('① 空数据说人话，不吐 NaN/¥0.0000', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok-'));
  try {
    initTokenMeter({ stateDir: dir });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const r = buildTokenReportText({ days: 1 });
    assert.ok(r.ok);
    assert.match(r.text, /还没有用量记录/);
    assert.ok(!/NaN|undefined/.test(r.text), r.text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await check('① 有数据时正文包含总量与钱数，且估算行不并进钱里', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok-'));
  try {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push({ tsMs: now - i * 60_000, sessionId: 's', convKey: 'group:1', prompt: 1000, completion: 50, total: 201050, est: false, cacheRead: 200000, cacheWrite: 0 });
    rows.push({ tsMs: now - 30_000, sessionId: 's2', convKey: null, prompt: 800, completion: 80, total: 880, est: true, promptChars: 1440, completionChars: 176 });
    fs.writeFileSync(path.join(dir, 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    initTokenMeter({ stateDir: dir });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const rep = getTokenReport(1);
    const r = buildTokenReportText({ days: 1 });
    const billed = Number(rep.today.billedTotal);
    assert.ok(billed > 0, `billedTotal=${billed}`);
    // 【2026-09-22】第一行是"平台计费日"口径，数字带千分位（跟面板顶部「今日已用」逐位对得上）
    assert.ok(r.text.includes(Number(billed).toLocaleString('en-US')), r.text);
    assert.match(r.text, /平台计费日/);
    assert.match(r.text, /¥\d/);
    assert.match(r.text, /另有估算/);
    // 估算行绝不进 billedTotal
    assert.equal(billed, 4 * (1000 + 50 + 200000));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await check('① 两个日界口径必须分行标注（计费日 vs 北京自然日），不许混在一行里', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok2-'));
  try {
    // 造"跨换日"的数据：今天（计费日，北京 08:00 起）只有一点点，而北京自然日 00:00 起有一大堆
    // —— 线上现场就是 592,685（计费日）vs 12,182,789（自然日），旧版把两者挨着印，看着像算错。
    // ⚠ 时刻必须**钉死**（opts.nowMs）：这个断言跟挂钟有关 —— 北京时间 11:00 以后"now−3h"也落在
    //   计费日里，两边数字就会相等，测试会假失败（2026-09-22 实际踩到）。所以固定成北京 11:00。
    const NOW = Date.parse('2026-09-22T11:00:00+08:00');
    const rows = [
      // 北京 10:00 —— 在计费日里（08:00 换日之后）
      { tsMs: NOW - 3600_000, sessionId: 's', convKey: 'private:1', prompt: 2000, completion: 600, total: 592685, est: false, cacheRead: 589824, cacheWrite: 0 },
      // 北京 03:00 —— 同一自然日、但属于上一个计费日（平台算在昨天）
      { tsMs: NOW - 8 * 3600_000, sessionId: 's', convKey: 'private:1', prompt: 300000, completion: 20000, total: 11800000, est: false, cacheRead: 11500000, cacheWrite: 0 },
    ];
    fs.writeFileSync(path.join(dir, 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    initTokenMeter({ stateDir: dir });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const r = buildTokenReportText({ days: 1, nowMs: NOW });
    const rep = getTokenReport(1, { nowMs: NOW });
    const natural = (rep.todayHourly || []).reduce((a, h) => a + h.prompt + h.completion + h.cacheRead, 0);
    assert.ok(natural > Number(rep.today.billedTotal), `自然日 ${natural} 应大于计费日 ${rep.today.billedTotal}`);
    assert.ok(r.text.includes(Number(rep.today.billedTotal).toLocaleString('en-US')), `缺计费日数字: ${r.text}`);
    assert.ok(r.text.includes(Number(natural).toLocaleString('en-US')), `缺自然日数字: ${r.text}`);
    assert.match(r.text, /自然日 00:00 起/);
    assert.match(r.text, /平台算在昨天/);
    assert.ok(!/NaN|undefined/.test(r.text), r.text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await check('① 近 N 天报的是"整段窗口"的总量，不是只算今天（旧版这里错取 today.billedTotal）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok3-'));
  try {
    const DAY = 86400_000;
    const now = Date.now();
    const rows = [];
    for (let d = 0; d < 4; d++) {
      rows.push({ tsMs: now - d * DAY, sessionId: 's', convKey: 'private:1', prompt: 1000, completion: 100, total: 1_000_000, est: false, cacheRead: 998900, cacheWrite: 0 });
    }
    fs.writeFileSync(path.join(dir, 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    initTokenMeter({ stateDir: dir });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const r = buildTokenReportText({ days: 7 });
    assert.match(r.text, /近 7 天/);
    const shown = Number((r.text.match(/近 7 天 ([\d,]+) tok/) || [])[1]?.replace(/,/g, '') || 0);
    assert.ok(shown >= 1_000_000, `近 7 天总量应含窗口内每一天，实际=${shown}`);
    assert.ok(shown <= 4_000_000, `不应超过窗口内实际用量，实际=${shown}`);
    assert.ok(!/NaN|undefined/.test(r.text), r.text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── ② 工具 schema 压缩档 ──────────────────────────────────────────────────────
await check('② 档位解析：非法值一律当 off（错字不能把工具砍没）', () => {
  assert.equal(normalizeToolTier('HIGH'), 'high');
  assert.equal(normalizeToolTier('highh'), 'off');
  assert.equal(normalizeToolTier(undefined), 'off');
  assert.equal(resolveToolTier({}).level, 'off');
});

await check('② 档位未开总开关时不裁剪', () => {
  const r = resolveToolTier({ level: 'high', enabled: false });
  assert.equal(r.level, 'off');
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), true);
});

await check('② high 档：实测被调用过的能力一个都不丢，零调用的庞然大物砍掉', () => {
  const r = resolveToolTier({ enabled: true, level: 'high' });
  assert.equal(r.level, 'high');
  // 协议闭环 + 服务器调用日志里出现过的工具，切 high 后必须还在
  for (const keep of ['qq_send_message', 'qq_reply', 'qq_mark_read', 'qq_get_unread_messages',
    'qq_meme_search', 'qq_send_meme', 'qq_send_voice', 'qq_profile_set', 'qq_memory_search',
    'qq_get_message_images', 'qq_get_recent_messages']) {
    assert.equal(toolAllowedByTier(keep, r), true, `应保留 ${keep}`);
  }
  // 实测 0 次调用、体积最大的那批：high 档砍掉
  for (const drop of ['qq_send_pixiv', 'qq_send_rich', 'qq_character_read', 'qq_music_search']) {
    assert.equal(toolAllowedByTier(drop, r), false, `应砍掉 ${drop}`);
  }
  assert.equal(toolAllowedByTier('qq_status', r), true);
});

await check('② extreme 档：只留八件套，且明确是"会丢功能"的极限档（与 high 不同）', () => {
  const high = resolveToolTier({ enabled: true, level: 'high' });
  const extreme = resolveToolTier({ enabled: true, level: 'extreme' });
  assert.equal(toolAllowedByTier('qq_send_meme', high), true, 'high 不该丢发米姆');
  assert.equal(toolAllowedByTier('qq_send_meme', extreme), false, 'extreme 会丢发米姆（已在 note 里警告）');
  assert.equal(toolAllowedByTier('qq_send_message', extreme), true);
  assert.equal(toolAllowedByTier('qq_status', extreme), true);
});

await check('② low 档走"不要"名单：名单外一律保留（新增工具默认可见）', () => {
  const r = resolveToolTier({ enabled: true, level: 'low' });
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), false);
  assert.equal(toolAllowedByTier('qq_send_message', r), true);
  assert.equal(toolAllowedByTier('qq_某个将来才会有的工具', r), true, '黑名单语义：不在名单里就该保留');
});

await check('② 老配置（只有 enabled+deny、没有 level）走 custom 黑名单，行为不变', () => {
  const r = resolveToolTier({ enabled: true, deny: ['mcp__napcat__qq_send_pixiv', 'qq_send_rich'] });
  assert.equal(r.level, 'custom');
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), false);
  assert.equal(toolAllowedByTier('mcp__napcat__qq_send_rich', r), false);
  assert.equal(toolAllowedByTier('qq_send_message', r), true);
});

await check('② 选了具体档位时，手写 allow/deny 一律忽略（避免"档位说要留、老 deny 说要砍"的自相矛盾）', () => {
  const r = resolveToolTier({ enabled: true, level: 'high', allow: ['qq_send_voice'], deny: ['qq_send_message'] });
  assert.equal(toolAllowedByTier('qq_send_message', r), true, '档位说留就得留，老 deny 不该生效');
  assert.equal(toolAllowedByTier('qq_send_voice', r), true);
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), false);
  assert.equal(r.allow, null);
  assert.equal(r.deny, null);
  // 手写名单只在 custom 档生效
  const c = resolveToolTier({ enabled: true, level: 'custom', allow: ['qq_send_voice'], deny: [] });
  assert.equal(toolAllowedByTier('qq_send_voice', c), true);
  assert.equal(toolAllowedByTier('qq_send_message', c), false);
});

await check('② 实测占比：按字符加权算（不是按工具个数），档位严格递减', () => {
  const tools = [
    { name: 'qq_send_message', cost: 2744 }, { name: 'qq_send_pixiv', cost: 6277 },
    { name: 'qq_reply', cost: 1387 }, { name: 'qq_send_rich', cost: 4866 },
    { name: 'qq_mark_read', cost: 643 }, { name: 'qq_get_prompt', cost: 407 },
    { name: 'qq_social_state', cost: 420 }, { name: 'qq_get_unread_messages', cost: 451 },
    { name: 'qq_list_groups', cost: 208 }, { name: 'qq_status', cost: 198 },
  ];
  const total = tools.reduce((s, t) => s + t.cost, 0);
  const m = measureSchemaShare(tools, new Set(TOOL_TIERS.extreme.keep));
  assert.equal(m.totalChars, total);
  // extreme 名单里这 8 个都在：2744+1387+643+407+420+451+208+198
  assert.equal(m.keptChars, 6458);
  assert.equal(m.keptCount, 8);
  assert.ok(m.share < 1);
  // 不带名单 = 全量（off 档）
  const all = measureSchemaShare(tools, null);
  assert.equal(all.keptChars, total);
  assert.equal(all.share, 1);
  // low 用 drop 名单：砍掉两个大块头、其余保留
  const low = measureSchemaShare(tools, null, new Set(TOOL_TIERS.low.drop));
  assert.equal(low.totalChars - low.keptChars, 6277 + 4866);
});

// ── ③ 记忆检索的查询串 ────────────────────────────────────────────────────────
await check('③ FTS5 查询串：够长的词才进索引，2 字中文词交给 LIKE（trigram 最少要 3 个字）', async () => {
  const { ftsQueryOf } = await import(new URL('../src/core/memory.js', import.meta.url));
  assert.equal(ftsQueryOf(''), '');
  assert.equal(ftsQueryOf('ab'), '');                       // 只有 2 字 → 交给 LIKE
  assert.equal(ftsQueryOf('考试'), '');                     // 中文两字词：trigram 索引里没有 2 字词条
  assert.equal(ftsQueryOf('期末考试'), '"期末考试"');         // 4 字 → 正常进 FTS
  // 长短混写：短词被丢掉，长词照样进索引（比整条退回 LIKE 强）
  assert.equal(ftsQueryOf('考试 关于期末考试的事'), '"关于期末考试的事"');
  assert.equal(ftsQueryOf('hello world'), '"hello" OR "world"');
  assert.equal(ftsQueryOf('a"b"c 期末考试'), '"期末考试"');    // 引号一律剥掉，免得拼出非法 FTS 语法
  assert.ok(ftsQueryOf(Array.from({ length: 20 }, (_, i) => `word${i}xx`).join(' ')).split(' OR ').length <= 8);
});

// ── ④ 分层记忆的层级归一（纯函数，不落库）─────────────────────────────────────
await check('④ 记忆层级：rule/owner/identity 天然是永久层；显式 tier 说了算', async () => {
  const { PERMANENT_CATEGORIES, MEMORY_TIERS } = await import(new URL('../src/core/memory.js', import.meta.url));
  assert.equal(MEMORY_TIERS.permanent, 0);
  assert.ok(PERMANENT_CATEGORIES.has('rule') && PERMANENT_CATEGORIES.has('owner'));
  assert.ok(MEMORY_TIERS.working > 0 && MEMORY_TIERS.durable > MEMORY_TIERS.working);
});

console.log('');
if (failures.length) {
  console.log(`${failures.length} 项失败：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('1.3.0 新增能力：全部通过 ✓');
void ROOT;
