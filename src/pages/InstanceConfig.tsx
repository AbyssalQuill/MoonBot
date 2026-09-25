import { useEffect, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import { api, postConfig, instanceAction, instanceLogs } from '../api';
import { CFG_MANAGER, cachedInstanceConfig, rememberConfig, rememberInstanceConfig } from '../config-cache';
import type { ManagerState, DSHIsolatedConfig, NapcatLocalConfig } from '../stores/types';
import { ArrowLeft, Save, Play, Square, FileText, Loader2 } from 'lucide-react';
import NumInput from '../components/NumInput';
import Dropdown from '../components/Dropdown';

interface Props {
  state: ManagerState | null;
  instanceId: 'dsh-isolated' | 'napcat-local' | 'bridge-local';
  onBack: () => void;
  onRefresh: () => void;
}

/** 本页的取值口径（2026-09-23 重订）：
 *  · 有缓存就先用缓存的真实值渲染（缓存模块见 `src/config-cache.ts`），因此在本管理端会话内
 *    反复切换页面时，表单里的数值不会跳变；
 *  · 没有缓存（本次会话首次进入）时表单字段一律留空、开关不选中且不可编辑 ——
 *    绝不以出厂默认值冒充，屏幕上不会出现与桥上配置不同的数值；
 *  · 页面立刻可见，读取中只占一行行内提示，不做整页等待；
 *  · 「保存配置」在真实配置读到之前一律禁用（空值绝不允许写回桥上）。 */
const instanceKeyOf = (id: 'dsh-isolated' | 'napcat-local' | 'bridge-local') =>
  (id === 'dsh-isolated' ? 'dshIsolated' : id === 'napcat-local' ? 'napcatLocal' : 'bridgeLocal');

export default function InstanceConfig({ state, instanceId, onBack, onRefresh }: Props) {
  const isDsh = instanceId === 'dsh-isolated';
  const cmdKey = instanceId === 'napcat-local' ? 'napcatLocal' : 'bridgeLocal';
  /* 初值：本页实例的缓存配置；没有缓存即为 null（字段留空、控件禁用），不使用任何出厂默认值。 */
  const [dsh, setDsh] = useState<DSHIsolatedConfig | null>(() => cachedInstanceConfig<DSHIsolatedConfig>('dshIsolated'));
  const [cmdCfg, setCmdCfg] = useState<NapcatLocalConfig | null>(() => cachedInstanceConfig<NapcatLocalConfig>(instanceKeyOf(instanceId)));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
/** 提示条语气：失败走 `warn`（红字），成功与状态说明走 `notice` */
  const [msgKind, setMsgKind] = useState<'notice' | 'warn'>('notice');
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
/** 配置读取状态。两项都只用于行内提示与「保存配置」的可用性，不阻塞表单渲染。 */
  const [cfgLoading, setCfgLoading] = useState(true);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
/** 读取失败后的自动重试间隔（毫秒，0 = 已读到）。仅用于行内提示里如实说明"现在多久重读一次"。 */
  const [autoRetryMs, setAutoRetryMs] = useState(0);
/** 是否处于失败后的自动退避重读中（2026-09-30 起本页不再有「重试」按钮）。
   *  单独用一个布尔量驱动重读循环，而不是让循环去盯着错误文本 —— 见下方 loadCfg 的说明。 */
  const [retrying, setRetrying] = useState(false);
/** 本次读取期间表单是否已被改动。已改动则不再让迟到的回包覆盖输入。 */
  const touched = useRef(false);

  const inst = state?.instances.find((i) => i.id === instanceId);
  const running = !!inst?.proc?.running || !!inst?.reachable;
/** 本页表单对应的配置是否已读到（缓存或回包）。为 false 时表单空白且不可编辑。 */
  const ready = isDsh ? !!dsh : !!cmdCfg;

  const editDsh = (patch: Partial<DSHIsolatedConfig>) => {
    touched.current = true;
    setDsh((d) => ({ ...(d ?? {}), ...patch } as DSHIsolatedConfig));
  };
  const editCmd = (patch: Partial<NapcatLocalConfig>) => {
    touched.current = true;
    setCmdCfg((c) => ({ ...(c ?? {}), ...patch } as NapcatLocalConfig));
  };

/** 读取本实例配置。成功即写入模块级缓存（供下次进入本页时先按真实值渲染）。 */
/**  返回是否成功 —— 供下面的自动退避重试用（2026-09-30 起失败不再给「重试」按钮）。 */
/**  注意：本函数不在开头清 cfgErr。若清掉，退避重读的每一轮都会先让 cfgErr 变回 null、 */
/**  失败后再置回，驱动循环的 `retrying` 之外多出一条噪音，且提示条会一闪一闪； */
/**  失败原因一直留到下一次成功为止，反而更稳。改由 `retrying` 这个布尔量驱动重读循环。 */
  const loadCfg = async (): Promise<boolean> => {
    setCfgLoading(true);
    try {
      const c = await api<any>('/config');
      rememberConfig(CFG_MANAGER, c);
      const next = isDsh ? c?.instances?.dshIsolated : c?.instances?.[cmdKey];
      if (!next) throw new Error('回包中不含该实例的配置');
      if (!touched.current) { if (isDsh) setDsh(next); else setCmdCfg(next); }
      setCfgErr(null);
      setRetrying(false);
      return true;
    } catch (e: any) {
      setCfgErr(String(e?.message || e || '读取配置失败'));
      setRetrying(true);
      return false;
    } finally {
      setCfgLoading(false);
    }
  };

  useEffect(() => {
    touched.current = false;
    /* 换实例：先把该实例的缓存值铺上（没有缓存则为空），再读一次最新值。
       同时清掉上一个实例留下的失败原因与退避状态，由下面这次读取的结果重新决定。 */
    setCfgErr(null);
    setRetrying(false);
    setDsh(cachedInstanceConfig<DSHIsolatedConfig>('dshIsolated'));
    setCmdCfg(cachedInstanceConfig<NapcatLocalConfig>(instanceKeyOf(instanceId)));
    void loadCfg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  /* 2026-09-30 修改要求：读取失败不再要人"点重试再刷新"，改为自动重试，页面上不出现重试按钮：
     失败后按 5 → 10 → 20 → 40 → 60 秒（封顶 60 秒）逐档拉长重读，读到即停（retrying 置回 false → 本 effect 退出）。
     失败事实照常显示（走下方那行行内提示），表单仍为空且不可编辑，页面不会变成"永远转圈"。
     循环由 `retrying` 布尔量驱动（loadCfg 不会在开头清它），故失败原因文本无论如何变化，
     退避档位都不会被重置回 5 秒。loadCfg 每次渲染都是新函数，用 ref 取最新引用。 */
  const loadCfgRef = useRef(loadCfg);
  useEffect(() => { loadCfgRef.current = loadCfg; });
  useEffect(() => {
    if (!retrying) { setAutoRetryMs(0); return; }
    let alive = true;
    let backoff = 5000;
    let t: number | null = null;
    const step = () => {
      setAutoRetryMs(backoff);
      t = window.setTimeout(() => {
        if (!alive) return;
        backoff = Math.min(60000, backoff * 2);
        void loadCfgRef.current().finally(() => { if (alive) step(); });
      }, backoff);
    };
    step();
    return () => { alive = false; if (t !== null) window.clearTimeout(t); };
  }, [retrying, instanceId]);

  const save = async () => {
    if (!ready) { setMsgKind('warn'); setMsg('配置尚未读取到，暂不可保存；本页会自动重读，读到后即可保存。'); return; }
    const key = isDsh ? 'dshIsolated' : cmdKey;
    const value = isDsh ? dsh : cmdCfg;
    try {
      await postConfig({ instances: { [key]: value } });
      /* 保存成功后同步缓存：切走再回来看到的是刚保存的这份，而不是保存前的旧缓存。 */
      rememberInstanceConfig(key, value);
      setMsgKind('notice');
      setMsg('已保存');
      onRefresh();
    } catch (e: any) {
      setMsgKind('warn');
      setMsg(`保存失败：${String(e?.message || e || '无法连接后端')}；修改后可再次点「保存配置」。`);
    }
  };

  const act = async (a: 'start' | 'stop') => {
    const label = a === 'start' ? '启动' : '停止';
    setBusy(a);
    try {
      const r = await instanceAction(instanceId, a);
      if (r.success === false) { setMsgKind('warn'); setMsg(`${label}未成功：${r.message || '见运行日志'}`); }
      else { setMsgKind('notice'); setMsg(r.message); }
    } catch (e: any) {
      setMsgKind('warn');
      setMsg(`${label}失败：${String(e?.message || e || '无法连接后端')}；可稍后重试。`);
    } finally {
      setBusy(null);
      onRefresh();
    }
  };

  const loadLogs = async () => {
    if (logsOpen) { setLogsOpen(false); return; }
    setLogsOpen(true);            // 立即展开卡片，日志到达后就地填充
    setLogs([]);
    setLogsLoading(true);
    try {
      const r = await instanceLogs(instanceId, 200);
      setLogs(r.lines.length ? r.lines : ['（暂无日志）']);
    } catch (e: any) {
      /* 2026-09-30：原文「收起后再次点「日志」可重试」：措辞与"不要点击重试"的口径不符（此处本是
         展开/收起开关顺带重读，并非重试按钮）。日志为按需读取，不自动轮询，故改为如实说明"再次展开会重读"。 */
      setLogs([`读取日志未成功：${String(e?.message || e || '无法连接后端')}；日志为按需读取，收起后再次展开「日志」会重新读取一次。`]);
    } finally {
      setLogsLoading(false);
    }
  };

  const n = (v: string | null | undefined, def = '') => (v === undefined || v === null ? def : v);
  /* 渲染视图：配置尚未读到时为空对象 —— 各字段随之留空，绝不显示任何"看起来像配置"的数值。 */
  const d: Partial<DSHIsolatedConfig> = dsh ?? {};
  const c: Partial<NapcatLocalConfig> = cmdCfg ?? {};

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={14} /> 返回</button>
          <div>
            <div className="page-title">{isDsh ? 'DeepSeek Harness' : instanceId === 'napcat-local' ? 'NapCat' : 'Bridge'}</div>
            <div className="page-subtitle">本机应用内拉起 · {running ? <b>运行中</b> : state ? '未启动' : '状态读取中'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {running ? (
            <button className="btn btn-outline-danger" disabled={busy === 'stop'} onClick={() => act('stop')}>
              {busy === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 停止
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy === 'start'} onClick={() => act('start')}>
              {busy === 'start' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 启动
            </button>
          )}
          <button className="btn btn-outline" onClick={loadLogs}><FileText size={14} /> 日志</button>
        </div>
      </div>

      <div className="page-body">
        <NoticeBar msg={msg} onClose={() => setMsg(null)} kind={msgKind} />

        <div className="card">
          {isDsh
            ? (
              <>
                <div className="card-title">隔离 DSH 配置</div>
                <div className="field-hint">本页配置本机隔离 DSH 实例（独立端口与独立 <code>DSH_HOME</code>）。修改后点「保存配置」写入；端口与主目录改动需重启该实例方可生效。</div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="label">端口</label>
                    <NumInput className="input" value={d.port} disabled={!ready} placeholder="尚未读取" onCommit={(n) => editDsh({ port: Math.round(n) || 10721 })} />
                    <div className="field-hint">隔离 DSH Web 端口，默认 <code>10721</code>；桥与一键启动均按此端口连接。改动后需重启 DSH 与桥。</div>
                  </div>
                  <div className="form-group">
                    <label className="label">启动配置档（DSH 的 profile）</label>
                    <Dropdown className="input" value={d.profile ?? ''} disabled={!ready} onChange={(v) => editDsh({ profile: v })}
                      options={[
                        { value: '', label: '（配置尚未读取）', disabled: true },
                        { value: 'web', label: 'web（标准：官方 DSH Web 界面 + 插件，默认）' },
                      ]} />
                    <div className="field-hint">固定使用官方 DSH 的 <code>web</code> 档；不依赖、不探测任何桌面端自制安装。</div>
                  </div>
                </div>
                <div className="form-group">
                  <label className="label">DSH 命令行路径</label>
                  <input className="input" value={n(d.dshCli)} disabled={!ready} onChange={(e) => editDsh({ dshCli: e.target.value })} />
                  <div className="field-hint">启动器调用 DSH 时使用的命令行入口路径；留空时按安装位置自动定位。</div>
                </div>
                <div className="form-group">
                  <label className="label">隔离主目录（DSH_HOME）</label>
                  <input className="input" value={n(d.isolatedHome)} disabled={!ready} onChange={(e) => editDsh({ isolatedHome: e.target.value })} />
                  <div className="field-hint">该实例独占的 <code>DSH_HOME</code>，与本机 <code>3210</code> 端口那套互不影响；改动后需重启该实例。</div>
                </div>
              </>
            )
            : (
              <>
                <div className="card-title">
                  {instanceId === 'napcat-local' ? 'NapCat 启动方式' : 'Bridge 启动命令'}
                </div>
                <div className="field-hint">
                  {instanceId === 'napcat-local'
                    ? '本页配置本机 NapCat 的启动方式，供管理器拉起本机 QQ 网关。留空的项由启动器自动探测；修改后点「保存配置」写入。下方开关的取舍见其自身说明。'
                    : '本页配置本机桥实例的启动命令、工作目录与 WebUI 端口。修改后点「保存配置」写入；端口改动需重启该实例方可生效。'}
                </div>
                <div className="form-group">
                  <label className="label">启动命令 / 启动器路径</label>
                  <input className="input" value={n(c.launchCommand)} disabled={!ready} placeholder={instanceId === 'napcat-local' ? '留空 = 自动定位 NapCat.Shell.Windows.OneKey（Windows）/ 官方安装脚本（Linux）' : '如 node server/index.js'} onChange={(e) => editCmd({ launchCommand: e.target.value || '' })} />
                  <div className="field-hint">留空时按平台自动定位启动器；填写后按所填命令直接拉起，填写错误的表现是启动失败并在运行日志末尾给出原因。</div>
                </div>
                {instanceId === 'napcat-local' && (
                  <>
                    <div className="form-group">
                      <label className="label">OneKey / 安装目录（可选）</label>
                      <input className="input" value={n(c.installDir)} disabled={!ready} placeholder="留空自动探测 OneKey 安装目录" onChange={(e) => editCmd({ installDir: e.target.value || undefined })} />
                      <div className="field-hint">OneKey 版 NapCat 的安装目录；留空则自动探测。目录填错时表现为找不到启动器而启动失败。</div>
                    </div>
                    <div className="form-group">
                      <label className="label">快速登录 QQ（留空自动探测 / 二维码登录）</label>
                      <input className="input" value={n(c.quickLogin)} disabled={!ready} placeholder="如 10001（留空自动探测 / 二维码登录）" onChange={(e) => editCmd({ quickLogin: e.target.value || undefined })} />
                      <div className="field-hint">填写后按该号码免扫码登录；留空则自动探测，探测不到时退回二维码登录。</div>
                    </div>
                    <div className="form-group">
                      <label className="label">WebUI 登录令牌（登录 6099 网页用）</label>
                      <input className="input" value={n(c.webuiToken)} disabled={!ready} placeholder={ready ? '留空 = 沿用 truefriend' : '尚未读取'} onChange={(e) => editCmd({ webuiToken: e.target.value || 'truefriend' })} />
                      <div className="field-hint">NapCat WebUI 的登录令牌，默认 <code>truefriend</code>；须与 NapCat 自身配置一致，否则 6099 网页登录失败。</div>
                    </div>
                    {/* 【2026-09-18】本机启动器「关闭界面时结束 NapCat」开关（组件定义见文件末尾） */}
                    <NapcatKillOnExitSwitch value={c.killOnExit} pending={!ready} onChange={(v) => editCmd({ killOnExit: v })} />
                  </>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label className="label">工作目录</label>
                    <input className="input" value={n(c.workDir)} disabled={!ready} placeholder="可选" onChange={(e) => editCmd({ workDir: e.target.value || undefined })} />
                    <div className="field-hint">启动进程的工作目录（可选）；留空时由启动器自行确定。</div>
                  </div>
                  <div className="form-group">
                    <label className="label">WebUI 端口</label>
                    <NumInput className="input" value={c.webuiPort} disabled={!ready} placeholder="尚未读取"
                      onCommit={(n) => editCmd({ webuiPort: Math.round(n) || 1 })} />
                    <div className="field-hint">该实例 WebUI 的监听端口，<code>bridge-local</code> 默认 <code>3100</code>、<code>napcat-local</code> 默认 <code>6099</code>；改动后需重启该实例。</div>
                  </div>
                </div>
              </>
            )}

          {/* 读取状态只占一行，不遮挡表单：读到之前表单为空白且不可编辑。
              {/* 2026-09-30：缓存命中时（`ready`）不再显示这一行：下方本就是上次读到的真实值，
              每次进页面都挂一句「正在读取…」正是此前反馈的中间态跳变；回包到达后原地替换即可。
              2026-09-30 修改要求：失败分支里面那个「重试」按钮已移除，改为按退避间隔自动重读。 */}
          {!ready && (
            <div className="field-hint" style={{ marginTop: 10 }}>
              {cfgErr
                ? '本实例配置尚未读取到；下方字段保持空白且不可编辑，本页会自动重读。'
                : '正在读取本机配置；读到之前下方字段为空白且不可编辑，以免呈现与桥上不一致的数值。'}
            </div>
          )}
          {cfgErr && (
            <div className="field-hint" style={{ marginTop: 6 }}>
              {`读取失败：${cfgErr}；`}
              {ready ? '下方仍为上次读取到的配置。' : '下方字段保持空白且不可编辑。'}
              {autoRetryMs > 0 && ` 正在自动重试：约每 ${Math.max(1, Math.round(autoRetryMs / 1000))} 秒重读一次（失败后按 5／10／20／40／60 秒退避，最长 60 秒一次），无需手动刷新。`}
            </div>
          )}

          <button
            className="btn btn-primary"
            disabled={!ready || cfgLoading || !!cfgErr}
            title={!ready
              ? (cfgErr ? '配置未读取成功，暂不可保存；本页会自动重读' : '配置尚未读取完成，暂不可保存')
              : cfgErr ? '配置未读取成功，暂不可保存；本页会自动重读' : '写入本机配置并立即生效'}
            onClick={save}
          >
            <Save size={14} /> 保存配置
          </button>
        </div>

        {inst?.url && (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-title">实例信息</div>
            <div>地址：<code>{inst.url}</code></div>
            {inst.proc.pid && <div>PID：{inst.proc.pid}</div>}
            {inst.config && 'port' in (inst.config as any) && <div>端口：{(inst.config as any).port ?? inst.port}</div>}
          </div>
        )}

        {logsOpen && (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-title">运行日志</div>
            <div className="log-viewer">
              {logsLoading && !logs.length
                ? <div className="log-line">正在读取日志尾部 200 行…</div>
                : logs.map((l, i) => <div className="log-line" key={i}>{l}</div>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 「关闭界面时结束 NapCat」：开关（NapCat 本地启动器区域）。
 *  · 默认显示为「开」（`value !== false`）：配置中尚无该键的旧配置同样显示为开，与后端 `DEFAULT_CONFIG` 一致
 *    （后端理由见 `server/index.js` 中 `DEFAULT_CONFIG.instances.napcatLocal.killOnExit` 的注释）；
 *  · 配置尚未读到时（`pending`）显示为未选中且不可点击：不显示任何可能与该键真实取值相左的状态；
 *  · 样式沿用本仓库既有的 `.switch-row`（`src/styles/app.css`，与「群友画像学习」等开关同一控件）；
 *  · 对外导出是为了让渲染探针可在两种状态下直接校验中文文案（无需浏览器、无需启动服务）。 */
export function NapcatKillOnExitSwitch({ value, pending, onChange }: { value?: boolean; pending?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="form-group">
      <label className="switch-row" title={pending ? '配置尚未读取到，暂不可修改' : undefined}>
        <input type="checkbox" checked={pending ? false : value !== false} disabled={pending} onChange={(e) => onChange(e.target.checked)} />
        <div>
          <span>关闭界面时结束 NapCat</span>
          <em>开着：关掉管理器窗口或退出管理器进程时，本次由启动器拉起的 NapCat 一并结束（已记进程号者按进程号精确结束；未记到进程号时按 OneKey 安装目录匹配，与「停止」同一口径），不留后台残留进程；QQ 随之退出登录，下次点「启动」重新登录（已配快速登录即免扫码）。关着：退出管理器完全不触碰 NapCat，它继续在后台运行。改动后点下方「保存配置」生效。</em>
        </div>
      </label>
    </div>
  );
}
