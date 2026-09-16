import { useEffect, useState } from 'react';
import { api, postConfig, instanceAction, instanceLogs } from '../api';
import type { ManagerState, DSHIsolatedConfig, NapcatLocalConfig } from '../stores/types';
import { ArrowLeft, Save, Play, Square, FileText, Loader2 } from 'lucide-react';
import NumInput from '../components/NumInput';

interface Props {
  state: ManagerState | null;
  instanceId: 'dsh-isolated' | 'napcat-local' | 'bridge-local';
  onBack: () => void;
  onRefresh: () => void;
}

export default function InstanceConfig({ state, instanceId, onBack, onRefresh }: Props) {
  const [dsh, setDsh] = useState<DSHIsolatedConfig | null>(null);
  const [cmdCfg, setCmdCfg] = useState<NapcatLocalConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const isDsh = instanceId === 'dsh-isolated';
  const inst = state?.instances.find((i) => i.id === instanceId);
  const running = !!inst?.proc?.running || !!inst?.reachable;

  useEffect(() => {
    api<any>('/config').then((c) => {
      if (isDsh) setDsh(c.instances.dshIsolated);
      else setCmdCfg(instanceId === 'napcat-local' ? c.instances.napcatLocal : c.instances.bridgeLocal);
    }).catch(() => {});
  }, [instanceId]);

  const save = async () => {
    const key = isDsh ? 'dshIsolated' : instanceId === 'napcat-local' ? 'napcatLocal' : 'bridgeLocal';
    await postConfig({ instances: { [key]: isDsh ? dsh : cmdCfg } });
    setMsg('已保存');
    onRefresh();
  };

  const act = async (a: 'start' | 'stop') => {
    setBusy(a);
    const r = await instanceAction(instanceId, a);
    setMsg(r.message);
    setBusy(null);
    onRefresh();
  };

  const loadLogs = async () => {
    if (logsOpen) { setLogsOpen(false); return; }
    const r = await instanceLogs(instanceId, 200);
    setLogs(r.lines.length ? r.lines : ['（暂无日志）']);
    setLogsOpen(true);
  };

  const n = (v: string | null | undefined, def = '') => (v === undefined || v === null ? def : v);

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={14} /> 返回</button>
          <div>
            <div className="page-title">{isDsh ? 'DeepSeek Harness' : instanceId === 'napcat-local' ? 'NapCat' : 'Bridge'}</div>
            <div className="page-subtitle">本机应用内拉起 · {running ? <b>运行中</b> : '未启动'}</div>
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
        {msg && <div className="notice-bar" onClick={() => setMsg(null)}>{msg}</div>}

        <div className="card">
          {isDsh && dsh ? (
            <>
              <div className="card-title">隔离 DSH 配置</div>
              <div className="form-row">
                <div className="form-group">
                  <label className="label">端口</label>
                  <NumInput className="input" value={dsh.port} onCommit={(n) => setDsh({ ...dsh, port: Math.round(n) || 10721 })} />
                  <div className="field-hint">隔离 DSH Web 端口，默认 10721（桥与一键启动均按此连接；改完要重启 DSH 与桥）。</div>
                </div>
                <div className="form-group">
                  <label className="label">启动配置档（DSH 的 profile）</label>
                  <select className="input" value={dsh.profile === 'web' ? 'web' : 'web'} onChange={(e) => setDsh({ ...dsh, profile: e.target.value })}>
                    <option value="web">web（标准：官方 DSH Web 界面 + 插件，默认）</option>
                  </select>
                  <div className="field-hint">固定使用官方 DSH 的 web 档；不依赖/不探测任何桌面端自制安装。</div>
                </div>
              </div>
              <div className="form-group">
                <label className="label">DSH 命令行路径</label>
                <input className="input" value={dsh.dshCli} onChange={(e) => setDsh({ ...dsh, dshCli: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="label">隔离主目录（DSH_HOME）</label>
                <input className="input" value={dsh.isolatedHome} onChange={(e) => setDsh({ ...dsh, isolatedHome: e.target.value })} />
              </div>
            </>
          ) : cmdCfg ? (
            <>
              <div className="card-title">
                {instanceId === 'napcat-local' ? 'NapCat 启动方式' : 'Bridge 启动命令'}
              </div>
              <div className="form-group">
                <label className="label">启动命令 / 启动器路径</label>
                <input className="input" value={n(cmdCfg.launchCommand)} placeholder={instanceId === 'napcat-local' ? '留空 = 自动定位 NapCat.Shell.Windows.OneKey（Windows）/ 官方安装脚本（Linux）' : '如 node server/index.js'} onChange={(e) => setCmdCfg({ ...cmdCfg, launchCommand: e.target.value || '' })} />
              </div>
              {instanceId === 'napcat-local' && (
                <>
                  <div className="form-group">
                    <label className="label">OneKey / 安装目录（可选）</label>
                    <input className="input" value={n(cmdCfg.installDir)} placeholder="留空自动探测 OneKey 安装目录" onChange={(e) => setCmdCfg({ ...cmdCfg, installDir: e.target.value || undefined })} />
                  </div>
                  <div className="form-group">
                    <label className="label">快速登录 QQ（留空自动探测 / 二维码登录）</label>
                    <input className="input" value={n(cmdCfg.quickLogin)} placeholder="如 10001（留空自动探测 / 二维码登录）" onChange={(e) => setCmdCfg({ ...cmdCfg, quickLogin: e.target.value || undefined })} />
                  </div>
                  <div className="form-group">
                    <label className="label">WebUI 登录令牌（登录 6099 网页用）</label>
                    <input className="input" value={n(cmdCfg.webuiToken, 'truefriend')} placeholder="默认 truefriend" onChange={(e) => setCmdCfg({ ...cmdCfg, webuiToken: e.target.value || 'truefriend' })} />
                  </div>
                </>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label className="label">工作目录</label>
                  <input className="input" value={n(cmdCfg.workDir)} placeholder="可选" onChange={(e) => setCmdCfg({ ...cmdCfg, workDir: e.target.value || undefined })} />
                </div>
                <div className="form-group">
                  <label className="label">WebUI 端口</label>
                  <NumInput className="input" value={cmdCfg.webuiPort ?? (instanceId === 'bridge-local' ? 3100 : 6099)}
                    onCommit={(n) => setCmdCfg({ ...cmdCfg, webuiPort: Math.round(n) || 1 })} />
                </div>
              </div>
            </>
          ) : <div className="empty-state">加载配置中…</div>}

          <button className="btn btn-primary" onClick={save}><Save size={14} /> 保存配置</button>
        </div>

        {instanceId === 'napcat-local' && <NapcatLauncherInfo quickLogin={(cmdCfg as any)?.quickLogin} webuiToken={(cmdCfg as any)?.webuiToken} />}

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
            <div className="log-viewer">{logs.map((l, i) => <div className="log-line" key={i}>{l}</div>)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** NapCat VBS 隐藏启动器信息（融合进项目：双击/管理器启动均无黑窗） */
function NapcatLauncherInfo({ quickLogin, webuiToken }: { quickLogin?: string; webuiToken?: string }) {
  const [info, setInfo] = useState<any>(null);
  useEffect(() => {
    api<any>('/napcat/launchers').then((r) => setInfo(r.success ? r : { success: false, message: '未定位 NapCat OneKey' })).catch(() => setInfo({ success: false, message: '加载失败' }));
  }, [quickLogin]);
  if (!info || !info.success) return info ? <div className="card" style={{ marginTop: 14 }}><div className="card-title">VBS 隐藏启动器</div><div style={{ color: 'var(--nc-foreground-500)' }}>{info.message}</div></div> : null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-title">VBS 隐藏启动器（双击 = 后台启动，无黑窗）</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div><code>{info.qr}</code></div>
        <div><code>{info.quick}</code></div>
        <div style={{ fontSize: 12, color: 'var(--nc-foreground-400)' }}>
          快速登录账号：{info.quickLogin} ｜ WebUI 登录令牌：{webuiToken || 'truefriend'} ｜ 管理器「启动 NapCat」也会走 VBS 隐藏拉起。
        </div>
      </div>
    </div>
  );
}
