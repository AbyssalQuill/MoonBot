import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Mic, Volume2, Play, Save, Trash2, Plus, RefreshCw, Loader2, AlertTriangle,
  Zap, Upload, Wand2, FlaskConical, Clock3, Sparkles,
} from 'lucide-react';
import { api } from '../api';

/**
 * MoonBot · 语音（MiMo-V2.5 TTS / 音色设计 / 音色复刻 / 语音识别）
 *
 * 【为什么单独开一页】语音用的是**独立的模型商与密钥**（跟聊天模型不是同一个账号/端点也常见），
 * 所以四个模型各自配「请求地址 + API Key + 模型名」，互不影响；配置存在桥侧
 * （state/voice-config.json），保存即生效，不用重启桥，也不进公开仓库。
 *
 * 【安全】API Key 只**单向**写入：界面读回来的永远只有掩码（前 3 位 + 后 4 位），
 * 输入框留空 = 不改动已保存的密钥。
 *
 * 【实测过的接口形态】（2026-09-15 服务器实测，官方文档 api 一致）
 *   · 合成：POST {地址}/chat/completions，assistant 消息放要读的文本、user 消息放风格/音色描述，
 *     音色放 audio.voice；返回 choices[0].message.audio.data（base64 音频）。
 *   · 识别：messages 的 content 里放 input_audio（data URL，mp3/wav），返回 message.content（文本）。
 */

interface RoleCfg { baseUrl: string; model: string; apiKeyMasked: string; apiKeySet: boolean }
interface VoiceCfg {
  ok?: boolean;
  enabled?: boolean;
  defaultVoice?: string;
  style?: string;
  format?: string;
  maxChars?: number;
  dailyChars?: number;
  cacheEnabled?: boolean;
  maxCacheFiles?: number;
  asrLanguage?: string;
  asrAutoTranscribe?: boolean;
  /** 主动发语音的节奏：概率（0~1）+ 同一会话冷却（毫秒） */
  send?: { probability?: number; cooldownMs?: number };
  usage?: { day: string; chars: number; calls: number; cacheHits: number; asrCalls: number };
  roles?: { role: string; label: string; defaultModel: string }[];
  presets?: { tokenPlanCn: string; official: string };
  builtinVoices?: { id: string; label: string; lang: string; gender: string; note: string }[];
  models?: Record<string, RoleCfg>;
}
interface CustomVoice { id: string; name: string; kind: 'design' | 'clone'; description: string; sampleBytes: number; hasSample: boolean; createdAt: string }

interface Props { onBack: () => void }

const SAMPLE_TEXT = '你好呀，我是月亮，这是音色试听。';
const ROLE_ORDER = ['tts', 'design', 'clone', 'asr'] as const;
const ROLE_HINT: Record<string, string> = {
  tts: '用官方内置音色说话（默认走这个）',
  design: '用一段文字描述“变”出一个音色，不用样本',
  clone: '上传一段 mp3/wav 样本，复刻那个人的音色',
  asr: '把别人发来的语音转成文字（机器人“听懂”语音）',
};

/** 桥控制台返回体兼容：管理端代理失败时会回 { success:false, code, message }（**没有 ok 字段**），
 *  所以判成功一律用 `ok === true`，不能只判 `ok === false` —— 否则会把代理失败当成成功数据渲染。 */
function pickErr(e: any): string {
  if (!e) return '未知错误';
  if (e.code === 'bridge-offline') return '目标桥不可达：请确认桥接进程已启动、远端连接与隧道正常';
  if (e.code === 'bridge-stale') return '目标桥版本过旧或未连接（需要更新桥代码）';
  return e.error || e.message || String(e);
}

export default function VoiceConfig({ onBack }: Props) {
  const [cfg, setCfg] = useState<VoiceCfg | null>(null);
  const [custom, setCustom] = useState<CustomVoice[]>([]);
  const [builtin, setBuiltin] = useState<VoiceCfg['builtinVoices']>([]);
  const [loadErr, setLoadErr] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 可编辑字段
  const [enabled, setEnabled] = useState(false);
  const [defaultVoice, setDefaultVoice] = useState('冰糖');
  const [style, setStyle] = useState('');
  const [format, setFormat] = useState('mp3');
  const [maxChars, setMaxChars] = useState(120);
  const [dailyChars, setDailyChars] = useState(20000);
  const [cacheEnabled, setCacheEnabled] = useState(true);
  const [probPct, setProbPct] = useState(20);      // 主动发语音概率（百分数，界面友好；桥上按 0~1 存）
  const [coolMin, setCoolMin] = useState(10);      // 语音冷却（分钟）
  const [asrLanguage, setAsrLanguage] = useState('auto');
  const [models, setModels] = useState<Record<string, { baseUrl: string; model: string; apiKey: string }>>({});

  // 试听
  // 【2026-09-15 修按钮状态机】试听**每个按钮各自一份**忙碌状态（pvBusy[来源]=true）：
  // 以前所有试听按钮共用 busy 一个字符串 + disabled={busy!==null}，点一个全场变灰像"全都在试听"。
  // pvSeq 每次试听 +1，用来当 <audio> 的 key：命中缓存时 URL 一模一样，不换 key 浏览器不会重新
  // 加载/播放，主人看到的就是"点了没反应"（这次也一起修了）。
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [pvBusy, setPvBusy] = useState<Record<string, boolean>>({});
  const [pvSeq, setPvSeq] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 新建音色
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [sample, setSample] = useState<{ name: string; base64: string; bytes: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const applyCfg = useCallback((c: VoiceCfg) => {
    setCfg(c);
    setEnabled(c.enabled === true);
    setDefaultVoice(String(c.defaultVoice ?? '冰糖'));
    setStyle(String(c.style ?? ''));
    setFormat(String(c.format ?? 'mp3'));
    setMaxChars(Number(c.maxChars) || 120);
    setDailyChars(Number(c.dailyChars) || 0);
    setCacheEnabled(c.cacheEnabled !== false);
    setProbPct(Math.round((Number(c.send?.probability ?? 0.2) || 0) * 100));
    setCoolMin(Math.round((Number(c.send?.cooldownMs ?? 600000) || 0) / 60000));
    setAsrLanguage(String(c.asrLanguage ?? 'auto'));
    const m: Record<string, { baseUrl: string; model: string; apiKey: string }> = {};
    for (const r of ROLE_ORDER) {
      const rc = c.models?.[r] ?? ({} as RoleCfg);
      m[r] = { baseUrl: String(rc.baseUrl ?? ''), model: String(rc.model ?? ''), apiKey: '' };
    }
    setModels(m);
    setBuiltin(c.builtinVoices ?? []);
  }, []);

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      const [c, v] = await Promise.all([
        api<VoiceCfg>('/voice/config'),
        api<{ ok?: boolean; builtin?: any[]; custom?: CustomVoice[] }>('/voice/voices'),
      ]);
      if (!c || (c as any).ok !== true) { setLoadErr(pickErr(c)); return; }
      if (((v as any)?.ok) !== true) { setLoadErr(pickErr(v)); return; }
      applyCfg(c);
      setBuiltin(c.builtinVoices ?? v.builtin ?? []);
      setCustom(Array.isArray(v.custom) ? v.custom : []);
    } catch (e: any) {
      setLoadErr(pickErr(e));
    }
  }, [applyCfg]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy('save');
    try {
      const patch: any = {
        enabled, defaultVoice, style: style.trim(), format,
        maxChars: Number(maxChars) || 120, dailyChars: Number(dailyChars) || 0,
        cacheEnabled, asrLanguage,
        // 主动发语音的节奏：界面上是百分数与分钟，桥侧存 0~1 的概率与毫秒冷却
        send: { probability: Math.max(0, Math.min(100, Number(probPct) || 0)) / 100, cooldownMs: Math.max(0, Number(coolMin) || 0) * 60000 },
        models: Object.fromEntries(ROLE_ORDER.map((r) => [r, {
          baseUrl: models[r]?.baseUrl ?? '', model: models[r]?.model ?? '',
          // 只把用户真正输入的密钥传上去，留空 = 保持原密钥
          ...(models[r]?.apiKey ? { apiKey: models[r].apiKey } : {}),
        }])),
      };
      const r = await api<VoiceCfg>('/voice/config', { method: 'PUT', body: JSON.stringify(patch) });
      if ((r as any)?.ok !== true) { setMsg(`保存失败：${pickErr(r)}`); return; }
      applyCfg(r);
      setMsg('语音配置已保存（桥侧立即生效，不需要重启）');
    } catch (e: any) {
      setMsg(`保存失败：${pickErr(e)}`);
    } finally { setBusy(null); }
  };

  const runTest = async (role: string) => {
    setBusy(`test-${role}`);
    try {
      const r = await api<any>('/voice/test', { method: 'POST', body: JSON.stringify({ role }) });
      setMsg(r?.ok !== true ? `测试失败：${pickErr(r)}` : `测试通过：${r.detail ?? 'ok'}`);
    } catch (e: any) { setMsg(`测试失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  /** 试听：只让**被点的那一个**按钮进入忙碌态（pvBusy[自己的 key]），其它按钮照常可点；
   *  命中缓存也照样把播放器重头播一遍（换 <audio> 的 key + 显式 play）。 */
  const doPreview = async (label: string, body: any, key = 'default') => {
    if (pvBusy[key]) return;                       // 同一按钮防重复点击，别的按钮不受影响
    setPvBusy((m) => ({ ...m, [key]: true }));
    try {
      const r = await api<any>('/voice/preview', { method: 'POST', body: JSON.stringify(body) });
      if (r?.ok !== true) { setMsg(`试听失败：${pickErr(r)}`); return; }
      setPreview({ url: `data:${r.mime || 'audio/mpeg'};base64,${r.audioBase64}`, label });
      setPvSeq((n) => n + 1);                      // 换 key → 就算音频和上次完全一样也会重新播放
      setMsg(r.cached ? `试听：${label}（命中缓存，未重复请求）` : `试听：${label}（${r.bytes} 字节，${r.ms}ms）`);
    } catch (e: any) { setMsg(`试听失败：${pickErr(e)}`); }
    finally { setPvBusy((m) => { const n = { ...m }; delete n[key]; return n; }); }
  };

  // 每次试听都显式 load + play：浏览器对 data URL 的重复播放经常"看着没反应"，
  // 显式播一次最稳；被自动播放策略拦下时保留原生 controls，主人手动点也能放。
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !preview) return;
    try { el.load(); void el.play().catch(() => { /* 被拦截就交给 controls */ }); } catch { /* 忽略 */ }
  }, [pvSeq, preview]);

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (f.size > 7 * 1024 * 1024) { setMsg('样本太大（超过 7MB），请换一段更短的 mp3/wav'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      setSample({ name: f.name, base64: data.replace(/^data:[^,]+,/, ''), bytes: f.size });
    };
    reader.readAsDataURL(f);
  };

  const saveVoice = async (kind: 'design' | 'clone') => {
    setBusy('save-voice');
    try {
      const r = await api<any>('/voice/voices', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(), kind,
          description: kind === 'design' ? newDesc.trim() : '',
          sampleBase64: kind === 'clone' ? (sample?.base64 ?? '') : '',
        }),
      });
      if (r?.ok !== true) { setMsg(`保存音色失败：${pickErr(r)}`); return; }
      setMsg(`音色「${newName.trim()}」已保存到音色库，可在「默认音色」里选用`);
      setNewName(''); setNewDesc(''); setSample(null);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e: any) { setMsg(`保存音色失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  const removeVoice = async (v: CustomVoice) => {
    setBusy(`del-${v.id}`);
    try {
      const r = await api<any>(`/voice/voices?id=${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      if (r?.ok !== true) { setMsg(`删除失败：${pickErr(r)}`); return; }
      setMsg(`已删除音色「${v.name}」`);
      await load();
    } catch (e: any) { setMsg(`删除失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  const usage = cfg?.usage;
  const voiceOptions = useMemo(() => {
    const opts = (builtin ?? []).map((b) => ({ id: b.id, label: `${b.label}（内置·${b.lang}${b.gender !== '—' ? '·' + b.gender : ''}）` }));
    for (const v of custom) opts.push({ id: v.id, label: `${v.name}（自建·${v.kind === 'clone' ? '样本复刻' : '文字设计'}）` });
    return opts;
  }, [builtin, custom]);

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title" style={{ color: 'var(--nc-primary-500)' }}>MoonBot · 语音</div>
            <div className="page-subtitle">让机器人能说（合成语音发到群里）也能听（把别人的语音转成文字）</div>
          </div>
        </div>
        <div className="page-actions">
          <span className="connection-bar" title="语音配置与试听由管理端代理到当前活动实例的桥控制台">
            <Zap size={13} /> 目标：当前活动实例
          </span>
        </div>
      </div>

      <div className="page-body">
        {msg && <div className="notice-bar" onClick={() => setMsg(null)}>{msg}</div>}

        {loadErr ? (
          <div className="card">
            <div className="lrn-error">
              <AlertTriangle size={15} />
              <div style={{ flex: 1 }}>
                {loadErr}
                <div className="lrn-error-detail">语音接口来自桥侧新版本：请先把桥代码更新到服务器并重启桥，再回到本页。</div>
              </div>
              <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void load()}>
                <RefreshCw size={13} /> 重试
              </button>
            </div>
          </div>
        ) : !cfg ? (
          <div className="card"><div className="lrn-inline-note"><Loader2 size={13} className="spin" /> 正在读取语音配置…</div></div>
        ) : (
          <>
            {/* ───────── 总开关与发送设置 ───────── */}
            <div className="card">
              <div className="card-title"><Mic size={17} /> 语音能力</div>
              <div className="cfg-fields">
                <label className="switch-row">
                  <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                  <span>启用语音（总开关）</span>
                  <em>关掉后模型调语音工具会被拒绝，机器人只发文字</em>
                </label>
                <label className="field-row">
                  <span className="f-label">默认音色</span>
                  <select className="input" value={defaultVoice} onChange={(e) => setDefaultVoice(e.target.value)}>
                    {voiceOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </label>
                <label className="field-row">
                  <span className="f-label">全局风格指令</span>
                  <input className="input" type="text" placeholder="可选，例如：语气甜甜的，语速稍快，带一点笑意"
                    value={style} onChange={(e) => setStyle(e.target.value)} />
                </label>
                <label className="field-row">
                  <span className="f-label">单条语音最长字数</span>
                  <input className="input" type="number" min={10} max={500} value={maxChars}
                    onChange={(e) => setMaxChars(Number(e.target.value) || 120)} />
                  <em>超过会被拒绝，避免发一条几十秒的长语音</em>
                </label>
                <label className="field-row">
                  <span className="f-label">每日合成字数上限</span>
                  <input className="input" type="number" min={0} value={dailyChars}
                    onChange={(e) => setDailyChars(Number(e.target.value) || 0)} />
                  <em>0 = 不限；命中缓存的重复文本不计数</em>
                </label>
                <label className="field-row">
                  <span className="f-label">音频格式</span>
                  <select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
                    <option value="mp3">mp3（推荐，体积小）</option>
                    <option value="wav">wav（无损，体积大）</option>
                  </select>
                </label>
                <label className="field-row">
                  <span className="f-label">识别语言</span>
                  <select className="input" value={asrLanguage} onChange={(e) => setAsrLanguage(e.target.value)}>
                    <option value="auto">自动判断</option>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label className="switch-row">
                  <input type="checkbox" checked={cacheEnabled} onChange={(e) => setCacheEnabled(e.target.checked)} />
                  <span>相同内容复用缓存</span>
                  <em>同一句话+同一音色只合成一次，省时间省钱</em>
                </label>
                <label className="field-row">
                  <span className="f-label">主动发语音概率</span>
                  <input className="input" type="number" min={0} max={100} step={1} value={probPct}
                    onChange={(e) => setProbPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
                  <em>0~100（%）。每次唤醒桥会掷一次骰子，写进提示词告诉模型本轮能不能掺一条语音；0 = 不主动发，只能被明确要求</em>
                </label>
                <label className="field-row">
                  <span className="f-label">语音冷却（分钟）</span>
                  <input className="input" type="number" min={0} step={1} value={coolMin}
                    onChange={(e) => setCoolMin(Math.max(0, Number(e.target.value) || 0))} />
                  <em>同一个会话刚发过语音后，这段时间内不再抽中（防连发刷屏）</em>
                </label>
              </div>
              <div className="lrn-inline-note">
                <Clock3 size={13} />
                {usage ? <>今日（{usage.day}）已合成 {usage.chars} 字 / {usage.calls} 次，缓存命中 {usage.cacheHits} 次；语音识别 {usage.asrCalls} 次</> : '今日用量读取中…'}
              </div>
              <div className="lrn-actions">
                <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void save()}>
                  {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 应用配置
                </button>
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={() => void runTest('tts')}>
                  {busy === 'test-tts' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} 测试合成
                </button>
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={() => void runTest('asr')}>
                  {busy === 'test-asr' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} 测试识别
                </button>
              </div>
            </div>

            {/* ───────── 四个模型各自的地址与密钥 ───────── */}
            <div className="card">
              <div className="card-title">
                <Sparkles size={17} /> 模型接入（各配各的地址与密钥）
                <span className="lrn-updated">密钥只写入不回显，留空 = 不改动</span>
              </div>
              <div className="card" style={{ boxShadow: 'none', marginBottom: 10 }}>
                <div className="lrn-inline-note">
                  预置地址：
                  <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => {
                    const next = { ...models };
                    for (const r of ROLE_ORDER) next[r] = { ...next[r], baseUrl: cfg?.presets?.tokenPlanCn ?? '' };
                    setModels(next);
                  }}>小米 Token Plan（国内）</button>
                  <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => {
                    const next = { ...models };
                    for (const r of ROLE_ORDER) next[r] = { ...next[r], baseUrl: cfg?.presets?.official ?? '' };
                    setModels(next);
                  }}>小米官方 API</button>
                  <div style={{ marginTop: 6, color: 'var(--nc-foreground-400)' }}>
                    两个地址都是 OpenAI 兼容形态：请求打 <code>{'{地址}'}/chat/completions</code>。语音模型目前免费试用期，识别按量计费。
                  </div>
                </div>
              </div>
              {ROLE_ORDER.map((role) => {
                const rc = models[role] ?? { baseUrl: '', model: '', apiKey: '' };
                const meta = (cfg.roles ?? []).find((x) => x.role === role);
                const saved = cfg.models?.[role];
                // 音色设计 / 音色复刻与语音合成是**同一家服务、同一把密钥**（主人确认：请求地址一样的），
                // 所以这两栏留空就自动跟随「语音合成」，不必重复填。
                const followsTts = role !== 'tts';
                return (
                  <div key={role} className="lrn-block" style={{ marginBottom: 12 }}>
                    <div className="lrn-block-title">{meta?.label ?? role}　<span style={{ fontWeight: 400, color: 'var(--nc-foreground-400)' }}>{ROLE_HINT[role]}</span></div>
                    <div className="cfg-fields">
                      <label className="field-row">
                        <span className="f-label">请求地址</span>
                        <input className="input" type="text"
                          placeholder={followsTts ? '留空即跟随「语音合成」的地址（同一家服务）' : (cfg.presets?.tokenPlanCn ?? '')}
                          value={rc.baseUrl}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, baseUrl: e.target.value } })} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">API Key</span>
                        <input className="input" type="password" autoComplete="new-password"
                          placeholder={saved?.apiKeySet
                            ? `已设置：${saved.apiKeyMasked}（留空=不改）`
                            : (followsTts ? '留空即用「语音合成」的密钥（同一把即可）' : '未设置，粘进来即可')}
                          value={rc.apiKey}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, apiKey: e.target.value } })} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">模型名</span>
                        <input className="input" type="text" placeholder={meta?.defaultModel ?? ''} value={rc.model}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, model: e.target.value } })} />
                      </label>
                    </div>
                    {followsTts && !saved?.apiKeySet && (
                      <div className="lrn-inline-note" style={{ marginTop: -2 }}>
                        这一栏不填也行：请求地址与密钥都会跟随「语音合成」（它们本来就在同一个服务上）。模型名必须保持接口给的那个 id。
                      </div>
                    )}
                    <div className="lrn-actions">
                      <button className="btn btn-sm" disabled={busy !== null} onClick={() => void runTest(role)}>
                        {busy === `test-${role}` ? <Loader2 size={13} className="spin" /> : <FlaskConical size={13} />} 测试这个模型
                      </button>
                      {saved?.apiKeySet && (
                        <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} title="清空已保存的密钥"
                          onClick={async () => {
                            setBusy(`clear-${role}`);
                            try {
                              const r = await api<any>('/voice/config', { method: 'PUT', body: JSON.stringify({ enabled, clearKeys: [role] }) });
                              if (r?.ok !== true) { setMsg(`清空失败：${pickErr(r)}`); return; }
                              applyCfg(r); setMsg(`已清空「${meta?.label ?? role}」的密钥`);
                            } catch (e: any) { setMsg(`清空失败：${pickErr(e)}`); }
                            finally { setBusy(null); }
                          }}>
                          <Trash2 size={13} /> 清空密钥
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ───────── 音色库 ───────── */}
            <div className="card">
              <div className="card-title">
                <Volume2 size={17} /> 音色库
                <span className="lrn-updated">内置音色直接试听；自建音色 = 文字描述生成 或 上传样本复刻</span>
              </div>

              {preview && (
                <div className="lrn-inline-note" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <b>试听：{preview.label}</b>
                  <audio key={pvSeq} ref={audioRef} controls src={preview.url} style={{ height: 32 }} />
                  <button className="btn btn-sm" onClick={() => setPreview(null)}>收起</button>
                </div>
              )}

              <div className="lrn-block">
                <div className="lrn-block-title">内置音色（{builtin?.length ?? 0} 个）</div>
                <div className="lrn-status-list">
                  {(builtin ?? []).map((v) => (
                    <div className="lrn-status-row" key={v.id} style={{ cursor: 'default' }}>
                      <div className="lrn-status-main">
                        <div className="lrn-status-uid">
                          <b>{v.label}</b>
                          <span className="lrn-nick">{v.lang}{v.gender !== '—' ? ` · ${v.gender}` : ''}</span>
                          {defaultVoice === v.id && <span className="badge badge-success">当前默认</span>}
                          <span className="lrn-status-caret">{v.id}</span>
                        </div>
                        {v.note && <div className="lrn-status-preview" style={{ opacity: .75 }}>{v.note}</div>}
                        <div className="lrn-actions">
                          <button className="btn btn-primary btn-sm" disabled={!!pvBusy[`builtin:${v.id}`]}
                            onClick={() => void doPreview(v.label, { mode: 'tts', voice: v.id, text: SAMPLE_TEXT }, `builtin:${v.id}`)}>
                            {pvBusy[`builtin:${v.id}`] ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 试听
                          </button>
                          <button className="btn btn-sm" onClick={() => setDefaultVoice(v.id)}>设为默认</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="lrn-divider" />

              <div className="lrn-block">
                <div className="lrn-block-title"><Wand2 size={14} /> 新建音色（两种方式，选一种填）</div>
                <div className="cfg-fields">
                  <label className="field-row">
                    <span className="f-label">音色名字</span>
                    <input className="input" type="text" placeholder="例如：软软的少女音" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  </label>
                  <label className="field-row">
                    <span className="f-label">① 文字描述（生成音色）</span>
                    <input className="input" type="text" placeholder="例如：十六七岁少女音，清亮软糯，语速稍快，带一点撒娇的笑意"
                      value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
                  </label>
                  <div className="field-row">
                    <span className="f-label">② 音频样本（复刻音色）</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input ref={fileRef} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" style={{ display: 'none' }}
                        onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
                      <button className="btn btn-sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> 选择 mp3 / wav</button>
                      {sample && <span className="lrn-dk">{sample.name}（{(sample.bytes / 1024).toFixed(0)}KB）</span>}
                    </div>
                  </div>
                </div>
                <div className="lrn-actions">
                  <button className="btn btn-primary btn-sm" disabled={!!pvBusy['new-design'] || !newDesc.trim()}
                    onClick={() => void doPreview('文字描述音色（未保存）', { mode: 'design', text: SAMPLE_TEXT, description: newDesc.trim() }, 'new-design')}>
                    {pvBusy['new-design'] ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试听描述音色
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={!!pvBusy['new-clone'] || !sample}
                    onClick={() => void doPreview('样本复刻音色（未保存）', { mode: 'clone', text: SAMPLE_TEXT, sampleBase64: sample?.base64 ?? '' }, 'new-clone')}>
                    {pvBusy['new-clone'] ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试听复刻音色
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={busy !== null || !newName.trim()}
                    onClick={() => void saveVoice(sample ? 'clone' : 'design')}>
                    {busy === 'save-voice' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                    保存音色（{sample ? '按复刻' : '按文字描述'}）
                  </button>
                </div>
                <div className="lrn-inline-note">
                  文字描述音色：每次合成都按描述生成，音色稳定但不带样本；样本复刻：用你上传的那段声音复刻，更像本人。
                  只支持 mp3 / wav，样本压到 7MB 以内。
                </div>
              </div>

              {custom.length > 0 && (
                <div className="lrn-block">
                  <div className="lrn-block-title">我保存的音色（{custom.length} 个）</div>
                  <div className="lrn-status-list">
                    {custom.map((v) => (
                      <div className="lrn-status-row" key={v.id} style={{ cursor: 'default' }}>
                        <div className="lrn-status-main">
                          <div className="lrn-status-uid">
                            <b>{v.name}</b>
                            <span className="badge badge-soft">{v.kind === 'clone' ? '样本复刻' : '文字设计'}</span>
                            {defaultVoice === v.id && <span className="badge badge-success">当前默认</span>}
                          </div>
                          {v.description && <div className="lrn-status-preview">{v.description}</div>}
                          <div className="lrn-actions">
                            <button className="btn btn-primary btn-sm" disabled={!!pvBusy[`saved:${v.id}`]}
                              onClick={() => void doPreview(v.name, { voiceId: v.id, text: SAMPLE_TEXT }, `saved:${v.id}`)}>
                              {pvBusy[`saved:${v.id}`] ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 试听
                            </button>
                            <button className="btn btn-sm" onClick={() => setDefaultVoice(v.id)}>设为默认</button>
                            <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} onClick={() => void removeVoice(v)}>
                              {busy === `del-${v.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ───────── 使用说明 ───────── */}
            <div className="card">
              <div className="card-title"><Mic size={17} /> 机器人什么时候会发语音</div>
              <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.9 }}>
                · 提示词里已经写明：**默认发文字**，只有被要求「说一句 / 唱一个 / 用语音回」或情境确实合适时才发语音 —— 语音条信息密度低，很多人不会点开。<br />
                · 收到别人发来的语音消息时，正文会显示成 <code>[语音]</code>；机器人需要知道内容时会调「语音识别」工具把它转成文字（按需调用，不自动转，省额度）。<br />
                · 语音合成失败时机器人会自动改用文字回复，不会把消息吞掉。<br />
                · 语音文件缓存在桥的 state 目录下（同内容只合成一次），语音记录也会写进会话，撤回/记忆都正常。
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
