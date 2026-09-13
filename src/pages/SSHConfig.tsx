import { useEffect, useRef, useState } from 'react';
import { api, postConfig, deployStart, deployStatus, syncBridge, removeServerStack } from '../api';
import type { SSHServer, ManagerState } from '../stores/types';
import { ArrowLeft, Plus, Trash2, Loader2, PlugZap, Plug, TestTube2, Server, Settings, Save, Rocket, X, RefreshCw } from 'lucide-react';
import NumInput from '../components/NumInput';

/* 远程端口默认值（与 server/index.js tunnelMapFor 一致） */
const RP_DEFAULTS = { napcatWebui: 6099, napcatHttp: 3000, dshWeb: 3080, bridge: 3100 };
type RPKey = keyof typeof RP_DEFAULTS;
const RP_LABELS: [RPKey, string][] = [
  ['napcatWebui', 'NapCat WebUI 端口'],
  ['napcatHttp', 'NapCat HTTP 端口'],
  ['dshWeb', 'DSH Web 端口'],
  ['bridge', 'Bridge 控制台端口'],
];

interface EditDraft {
  name: string; host: string; port: number; username: string;
  authType: 'password' | 'key';
  password: string; privateKey: string; passphrase: string;
  remotePorts: Record<RPKey, number>;
}

interface Props {
  state: ManagerState | null;
  onBack: () => void;
  onRefresh: () => void;
}

export default function SSHConfig({ state, onBack, onRefresh }: Props) {
  const [servers, setServers] = useState<SSHServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testOut, setTestOut] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testedServer, setTestedServer] = useState<SSHServer | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<string[] | null>(null);
  // 同步面板：direction = to-server|to-local|merge; opts 勾选哪些内容
  const [syncFor, setSyncFor] = useState<SSHServer | null>(null);
  const [syncDir, setSyncDir] = useState<'to-server' | 'to-local' | 'merge'>('to-server');
  const [syncCode, setSyncCode] = useState(true);
  const [syncState, setSyncState] = useState(false);
  const [syncStickers, setSyncStickers] = useState(false);
  const [syncConfig, setSyncConfig] = useState(false);   // 只同步桥的 config.json
  const [form, setForm] = useState({ name: '', host: '', port: 22, username: 'root', authType: 'password' as 'password' | 'key', password: '', privateKey: '', passphrase: '' });

  // ===== 克隆部署面板 =====
  const [deployFor, setDeployFor] = useState<SSHServer | null>(null); // 目标服务器(这台要装整套)
  const [deploySrc, setDeploySrc] = useState<string>('');              // 模板源 id
  const [deployQQ, setDeployQQ] = useState(true);                      // 是否带 QQ 登录态
  const [deployTask, setDeployTask] = useState<string | null>(null);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deployBusy, setDeployBusy] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<number | null>(null);

  const closeDeploy = () => {
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    setDeployFor(null); setDeploySrc(''); setDeployTask(null); setDeployLog([]); setDeployBusy(false);
  };

  const openDeploy = (target: SSHServer) => {
    setSelectedId(target.id);
    // 默认源 = 本机（2026-09-12 主人要求"改成从本机复刻"）：不需要第二台服务器，
    // 也不要求目标机旁边有一台"模板机"。想用别的服务器做模板再在下拉里换。
    setDeployFor(target);
    setDeploySrc('local');
    setDeployQQ(true);
    setDeployTask(null);
    setDeployLog([]);
  };

  // 轮询部署任务日志
  useEffect(() => {
    if (!deployTask) return;
    pollRef.current = window.setInterval(async () => {
      try {
        const r = await deployStatus(deployTask);
        if (Array.isArray(r.lines)) setDeployLog(r.lines);
        if (r.status === 'done' || r.status === 'error') {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setDeployBusy(false);
        }
      } catch { /* 网络闪断, 下轮再试 */ }
    }, 1200);
    return () => { if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; } };
  }, [deployTask]);

  // 日志自动滚到底
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [deployLog]);

  const startDeploy = async () => {
    if (!deployFor || !deploySrc) { setMsg('请先选择复刻源（本机或某台已装好的服务器）'); return; }
    setDeployBusy(true);
    setDeployLog([]);
    try {
      const plain = (x: SSHServer) => ({ ...x } as Record<string, unknown>);
      // 源 = 本机：不再需要"两台服务器"，直接拿本机磁盘上的整套（桥 + 隔离 DSH + NapCat 登录令牌 + 数据）复刻过去
      const useLocal = deploySrc === 'local';
      if (!useLocal) {
        const source = servers.find((x) => x.id === deploySrc);
        if (!source) { setMsg('复刻源不存在, 请重新选择'); setDeployBusy(false); return; }
        if (source.host === deployFor.host && (source.port || 22) === (deployFor.port || 22)) { setMsg('源与目标是同一台机器'); setDeployBusy(false); return; }
      }
      const r = await deployStart(useLocal ? { local: true, name: '本机（这台电脑）' } : plain(servers.find((x) => x.id === deploySrc)!), plain(deployFor), deployQQ);
      if (!r.success || !r.taskId) { setMsg(r.message || '发起失败'); setDeployBusy(false); return; }
      setDeployTask(r.taskId);
      setMsg(useLocal ? '已开始从本机复刻（本机不会被停机, 详见下方日志）' : '部署已开始, 详见下方日志(此过程源服务器会短暂停机打包)');
    } catch (e) { setMsg(`发起失败: ${(e as Error).message}`); setDeployBusy(false); }
  };

  const srcServer = deploySrc === 'local' ? null : (servers.find((x) => x.id === deploySrc) ?? null);
  const srcLabel = deploySrc === 'local' ? '本机（这台电脑）' : (srcServer?.name ?? '—');
  const deployDone = deployLog.some((l) => l.includes('克隆部署完成'));
  const deployFailed = deployLog.some((l) => l.includes('!!!!!'));

  useEffect(() => {
    api<any>('/config').then((c) => {
      if (Array.isArray(c.servers)) setServers(c.servers);
      if (c.activeServerId) setSelectedId(c.activeServerId);
    }).catch(() => {});
    // 刷新后恢复进行中的克隆部署日志(任务在后台跑, 不丢)
    import('../api').then((m) => m.deployTasks()).then((r) => {
      const run = (r.tasks ?? []).find((t) => t.status === 'running');
      if (run) { setDeployTask(run.id); setDeployLog([]); }
    }).catch(() => {});
  }, []);

  const persist = async (next: SSHServer[]) => {
    await postConfig({ servers: next });
    setServers(next);
  };

  /** 逐字段校验服务器表单, 返回每一项“缺什么/哪里不对”的独立说明(不合并成一句笼统提示) */
  const validateServerForm = (f: { name?: string; host?: string; port?: number; username?: string; authType?: string; password?: string; privateKey?: string }) => {
    const bad: string[] = [];
    if (!String(f.name ?? '').trim()) bad.push('名称未填');
    if (!String(f.host ?? '').trim()) bad.push('主机地址未填');
    const port = Number(f.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) bad.push('端口需为 1~65535 的整数');
    if (!String(f.username ?? '').trim()) bad.push('用户名未填');
    if (f.authType === 'password' && !String(f.password ?? '')) bad.push('密码未填');
    if (f.authType === 'key' && !String(f.privateKey ?? '').trim()) bad.push('私钥文件路径未填');
    return bad;
  };

  const addServer = async () => {
    const missing = validateServerForm(form);
    if (missing.length) { setMsg(`无法保存，请先修正：${missing.join('；')}`); return; }
    const s: SSHServer = {
      id: Date.now().toString(36),
      ...form,
      name: String(form.name).trim(),
      host: String(form.host).trim(),
      username: String(form.username).trim(),
      remotePorts: { ...RP_DEFAULTS },
    } as SSHServer;
    try { await persist([...servers, s]); }
    catch (e) { setMsg(`保存失败：${(e as Error).message}`); return; }
    setSelectedId(s.id);
    setAdding(false);
    setForm({ name: '', host: '', port: 22, username: 'root', authType: 'password', password: '', privateKey: '', passphrase: '' });
    setMsg('已添加');
  };

  const del = async (s: SSHServer) => {
    if (!confirm(`删除服务器「${s.name}」？`)) return;
    await persist(servers.filter((x) => x.id !== s.id));
    if (selectedId === s.id) setSelectedId(null);
  };

  const connect = async (s: SSHServer) => {
    try {
      const r = await api<any>('/ssh/connect', { method: 'POST', body: JSON.stringify(s) });
      setMsg(r.success ? `已连接 ${s.name}` : `连接失败：${r.message}`);
    } catch { setMsg('连接失败'); }
    setSelectedId(s.id);
    onRefresh();
  };

  const disconnect = async () => {
    await api('/ssh/disconnect', { method: 'POST', body: JSON.stringify({}) });
    setMsg('已断开');
    onRefresh();
  };

  const test = async (s: SSHServer) => {
    setTesting(s.id);
    setTestOk(null);
    setTestedServer(s);
    try {
      const r = await api<any>('/ssh/test', { method: 'POST', body: JSON.stringify(s) });
      // 认证失败时后端会带 detail（服务器允许哪些方式 / 本次发了哪些），这里如实展示：
      // 原来只有 ssh2 那句 "All configured authentication methods failed"，用户完全不知道该改什么。
      const d = r?.detail;
      const extra = d
        ? `\n\n诊断：本次发送 ${(d.sentMethods?.length ? d.sentMethods.join(' + ') : '无凭据')}；服务器允许 ${(d.serverMethods?.length ? d.serverMethods.join(', ') : '未取到')}。`
        : '';
      setTestOut(`${s.name}：${r.message}${extra}`);
      setTestOk(!!r.success);
    } catch (e: any) {
      setTestOut(`${s.name}：测试请求失败（${e?.message ?? '无法连接后端'}）`);
      setTestOk(false);
    } finally {
      setTesting(null);
    }
  };

  // ===== 桥代码同步(to-server / to-local / merge) =====
  const openSync = (s: SSHServer) => {
    setSelectedId(s.id);
    setSyncFor(s);
    setSyncDir('to-server');
    setSyncCode(true); setSyncState(false); setSyncStickers(false);
    setMsg(null); setSyncLog(null);
  };
  const closeSync = () => { setSyncFor(null); setSyncLog(null); };

  const runSync = async (s: SSHServer) => {
    setSyncingId(s.id);
    setSyncLog(null);
    try {
      // 内容勾选经 flags 显式传递(与后端 wantCode/wantState/wantStickers 一一对应);
      // direction 只带方向不带后缀。merge 强制 state、禁代码(与 UI 禁用/提示一致)。
      const flags = syncDir === 'merge'
        ? { code: false, state: true, stickers: syncStickers, config: false }
        : { code: syncCode, state: syncState, stickers: syncStickers, config: syncConfig };
      const r = await syncBridge({ ...s }, syncDir, false, flags);
      if (r.steps?.length) setSyncLog(r.steps.map((x) => `${x.ok ? '✓' : '✗'} ${x.step}${x.msg ? ' — ' + x.msg : ''}`));
      setMsg(r.success ? '同步完成' : (r.message || '同步失败，详见下方步骤'));
    } catch (e) { setMsg(`同步失败：${(e as Error).message}`); }
    finally { setSyncingId(null); }
  };

  // ===== 删除整套(移动备份, 不可撤回) =====
  const removeStack = async (s: SSHServer) => {
    if (!confirm(`确认删除服务器「${s.name}」上的整套(桥 /root/qq-bridge、DSH /root/.dsh、NapCat /root/napcat、代理 /root/dsh-polyfill)？将停服务并移动到 /root/qq-bridge-removed-<时间戳>/ 备份, 不会删除 QQ 登录卷。此操作不可撤回, 确定继续?`)) return;
    setRemovingId(s.id);
    setSyncLog(null);
    try {
      const r = await removeServerStack({ ...s });
      if (r.steps?.length) setSyncLog(r.steps.map((x) => `${x.ok ? '✓' : '✗'} ${x.step}${x.msg ? ' — ' + x.msg : ''}`));
      setMsg(r.success ? '已移除整套' : (r.message || '移除失败，详见下方步骤'));
    } catch (e) { setMsg(`移除失败：${(e as Error).message}`); }
    finally { setRemovingId(null); }
  };

  const startEdit = (s: SSHServer) => {
    setSelectedId(s.id);
    setAdding(false);
    // 默认值兜底：未配置的字段给合理默认，避免空值
    setEditId(s.id);
    setEditDraft({
      name: s.name ?? '',
      host: s.host ?? '',
      port: s.port || 22,
      username: s.username || 'root',
      authType: s.authType || 'password',
      password: s.password ?? '',
      privateKey: s.privateKey ?? '',
      passphrase: s.passphrase ?? '',
      remotePorts: { ...RP_DEFAULTS, ...(s.remotePorts ?? {}) },
    });
  };

  const saveEdit = async () => {
    if (!editId || !editDraft) return;
    const missing = validateServerForm(editDraft);
    if (missing.length) { setMsg(`无法保存，请先修正：${missing.join('；')}`); return; }
    const next = servers.map((x) => (x.id === editId
      ? {
          ...x,
          ...editDraft,
          name: String(editDraft.name).trim(),
          host: String(editDraft.host).trim(),
          username: String(editDraft.username).trim(),
          remotePorts: { ...editDraft.remotePorts },
        }
      : x));
    try { await persist(next as SSHServer[]); }
    catch (e) { setMsg(`保存失败：${(e as Error).message}`); return; }
    setEditId(null);
    setEditDraft(null);
    setMsg('配置已保存');
  };

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={14} /> 返回</button>
          <div className="page-title" style={{ fontSize: 18 }}>服务器</div>
        </div>
      </div>
      <div className="page-body">
        {msg && <div className="notice-bar" onClick={() => setMsg(null)}>{msg}</div>}

        {/* 服务器列表；空 -> 只显示添加 */}
        {servers.length === 0 && !adding ? (
          <div className="empty-state" style={{ padding: 70 }}>
            <Server size={40} style={{ color: 'var(--nc-foreground-300)', marginBottom: 14 }} />
            <div style={{ marginBottom: 18, color: 'var(--nc-foreground-500)' }}>还没有服务器</div>
            <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16} /> 添加服务器</button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              {!adding && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus size={14} /> 添加服务器</button>}
            </div>

            {adding && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-title">添加服务器</div>
                <div className="form-row">
                  <div className="form-group"><label className="label">名称</label><input className="input" placeholder="我的 VPS" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                  <div className="form-group"><label className="label">主机地址</label><input className="input" placeholder="服务器 IP 或域名" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="label">端口</label><NumInput className="input" value={form.port} onCommit={(n) => setForm({ ...form, port: Math.round(n) || 22 })} /></div>
                  <div className="form-group"><label className="label">用户名</label><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
                </div>
                <div className="form-group">
                  <label className="label">认证</label>
                  <select className="select" value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as any })}>
                    <option value="password">密码</option>
                    <option value="key">私钥</option>
                  </select>
                </div>
                {form.authType === 'password' ? (
                  <div className="form-group"><label className="label">密码</label><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
                ) : (
                  <div className="form-group"><label className="label">私钥路径</label><input className="input" value={form.privateKey} placeholder="如 C:\Users\你\.ssh\id_rsa" onChange={(e) => setForm({ ...form, privateKey: e.target.value })} /></div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={addServer}>保存</button>
                  <button className="btn" onClick={() => setAdding(false)}>取消</button>
                </div>
              </div>
            )}

            {editId && editDraft && (
              <div className="card" style={{ marginBottom: 14, borderColor: 'var(--nc-primary-400)' }}>
                <div className="card-title">配置服务器</div>
                <div className="form-row">
                  <div className="form-group"><label className="label">名称</label><input className="input" value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} /></div>
                  <div className="form-group"><label className="label">主机地址</label><input className="input" value={editDraft.host} onChange={(e) => setEditDraft({ ...editDraft, host: e.target.value })} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="label">端口</label><NumInput className="input" value={editDraft.port} onCommit={(n) => setEditDraft({ ...editDraft, port: Math.round(n) || 22 })} /></div>
                  <div className="form-group"><label className="label">用户名</label><input className="input" value={editDraft.username} onChange={(e) => setEditDraft({ ...editDraft, username: e.target.value })} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="label">认证方式</label>
                    <select className="select" value={editDraft.authType} onChange={(e) => setEditDraft({ ...editDraft, authType: e.target.value as any })}>
                      <option value="password">密码</option>
                      <option value="key">私钥</option>
                    </select>
                  </div>
                  {editDraft.authType === 'password' ? (
                    <div className="form-group"><label className="label">密码</label><input className="input" type="password" value={editDraft.password} onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })} /></div>
                  ) : (
                    <div className="form-group"><label className="label">私钥路径</label><input className="input" value={editDraft.privateKey} placeholder="如 C:\Users\你\.ssh\id_rsa" onChange={(e) => setEditDraft({ ...editDraft, privateKey: e.target.value })} /></div>
                  )}
                </div>
                {editDraft.authType === 'key' && (
                  <div className="form-group"><label className="label">私钥口令（可选）</label><input className="input" type="password" value={editDraft.passphrase} onChange={(e) => setEditDraft({ ...editDraft, passphrase: e.target.value })} /></div>
                )}
                <div className="card-title" style={{ fontSize: 13, marginTop: 10 }}>远程端口（默认 6099 / 3000 / 3080 / 3100）</div>
                <div className="form-row">
                  {RP_LABELS.map(([key, label]) => (
                    <div className="form-group" key={key}>
                      <label className="label">{label}</label>
                      <NumInput className="input" value={editDraft.remotePorts[key]}
                        onCommit={(n) => setEditDraft({ ...editDraft, remotePorts: { ...editDraft.remotePorts, [key]: Math.round(n) || RP_DEFAULTS[key] } })} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={saveEdit}><Save size={14} /> 保存</button>
                  <button className="btn" onClick={() => { setEditId(null); setEditDraft(null); }}>取消</button>
                </div>
              </div>
            )}

            {(deployFor || deployTask) && (
              <div className="card" style={{ marginBottom: 14, borderColor: 'var(--nc-primary-400)', boxShadow: 'var(--nc-shadow-s)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="card-title" style={{ marginBottom: 0 }}>
                    <Rocket size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                    一键克隆整套{deployFor ? ` → ${deployFor.name}` : '（进行中）'}
                  </div>
                  <button className="icon-btn" onClick={closeDeploy} title="关闭"><X size={15} /></button>
                </div>
                {deployFor && (
                <>
                <div className="notice-bar" style={{ background: 'transparent', border: 'none', padding: '10px 0', color: 'var(--nc-foreground-500)', fontSize: 13 }}>
                  {deploySrc === 'local' ? (
                    <>把<b>本机当前运行中的整套</b>（隔离 DSH + 桥 + NapCat 登录令牌 + 全部数据）复刻到「{deployFor.name}」
                    ({deployFor.host})。目标机应为全新 Ubuntu；<b>本机不会被停机</b>，直接读磁盘上的副本打包。</>
                  ) : (
                    <>把模板服务器上的整套(DSH + 桥 + NapCat 登录态 + 全部数据)克隆部署到「{deployFor.name}」
                    ({deployFor.host})。目标机应为全新 Ubuntu;过程中模板机会短暂停机打包后自动恢复。</>
                  )}
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="label">复刻源</label>
                    <select className="select" value={deploySrc} onChange={(e) => setDeploySrc(e.target.value)} disabled={deployBusy || !!deployTask}>
                      <option value="local">本机（这台电脑 · 当前运行中的整套）</option>
                      {servers.filter((x) => x.id !== deployFor.id).map((x) => (
                        <option key={x.id} value={x.id}>{x.name}（{x.host}）</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                    <label className="checkbox-label" style={{ marginBottom: 10 }}>
                      <input type="checkbox" checked={deployQQ} onChange={(e) => setDeployQQ(e.target.checked)} disabled={deployBusy || !!deployTask} />
                      连同 QQ 登录令牌一起克隆（免重新扫码）
                    </label>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <button className="btn btn-primary" onClick={startDeploy} disabled={deployBusy || !deploySrc || !!deployTask}>
                    {deployBusy ? <Loader2 size={14} className="spin" /> : <Rocket size={14} />}
                    {deployTask ? '部署中…' : '开始复刻'}
                  </button>
                  {deployDone && <span className="badge badge-success">部署完成</span>}
                  {deployFailed && <span className="badge" style={{ background: 'var(--nc-danger-100)', color: 'var(--nc-danger-500)' }}>部署失败</span>}
                  <span style={{ color: 'var(--nc-foreground-400)', fontSize: 12 }}>源 {srcLabel} → 目标 {deployFor.name}</span>
                </div>
                </>
                )}
                {deployTask && (
                  <div className="notice-bar" style={{ background: 'transparent', border: 'none', padding: '10px 0 0', color: 'var(--nc-foreground-400)', fontSize: 12 }}>
                    {deployDone ? '任务已结束。' : deployFailed ? '任务失败, 见下方日志; 模板机已尽力恢复。' : '部署进行中… 请勿关闭页面(刷新可恢复日志)。'}
                  </div>
                )}
                {(deployTask || deployLog.length > 0) && (
                  <div
                    ref={logRef}
                    className="log-box"
                    style={{
                      // 【2026-09-12】主人要求：部署日志字体改黑色 —— 所以底色一并换成浅底，
                      // 否则黑字压在原来的深色底（#0f1115）上根本看不见。
                      marginTop: 12, maxHeight: 320, overflow: 'auto', background: '#fff',
                      color: '#000', border: '1px solid var(--nc-primary-200, #e4e7ec)',
                      fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12,
                      padding: '10px 12px', borderRadius: 8, whiteSpace: 'pre-wrap',
                    }}
                  >
                    {deployLog.length ? deployLog.map((l, i) => <div key={i}>{l}</div>) : <div>等待日志…</div>}
                  </div>
                )}
                {deployFor && (
                <div className="notice-bar" style={{ background: 'transparent', border: 'none', padding: '10px 0 0', color: 'var(--nc-foreground-500)', fontSize: 12 }}>
                  源可以是<b>本机</b>（默认，不需要第二台服务器），也可以是另一台已装好的服务器。
                  开始后可在下方日志查看每一步进度; 部署完成后回列表点「连接」建隧道即可使用。
                </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {servers.map((s) => {
                const active = s.id === selectedId;
                const connected = state?.connected && state.activeServer?.id === s.id;
                return (
                  <div
                    key={s.id}
                    className="card server-row"
                    onClick={() => setSelectedId(s.id)}
                    style={active ? { borderColor: 'var(--nc-primary-400)', boxShadow: 'var(--nc-shadow-s)' } : undefined}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`status-dot ${connected ? 'online' : active ? 'loading' : 'offline'}`} />
                        <b>{s.name}</b>
                        {connected && <span className="badge badge-success">已连接</span>}
                      </div>
                      <div style={{ color: 'var(--nc-foreground-500)', fontSize: 12, marginTop: 2 }}>
                        {s.username}@{s.host}:{s.port}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm" disabled={testing === s.id} onClick={() => test(s)}>
                        {testing === s.id ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />} 测试
                      </button>
                      <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}><Settings size={12} /> 配置</button>
                      <button className="btn btn-sm" title="克隆整套(DSH+桥+NapCat 登录态)到这台新服务器" onClick={() => openDeploy(s)}><Rocket size={12} /> 部署</button>
                      <button className="btn btn-sm" title="同步代码/记忆/表情包到这台服务器(或拉回本地)" onClick={() => openSync(s)} disabled={syncingId === s.id}>
                        {syncingId === s.id ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 同步
                      </button>
                      <button className="btn btn-sm btn-danger" title="删除这台服务器上的整套(桥+DSH+NapCat, 移动备份)" onClick={() => removeStack(s)} disabled={removingId === s.id}>
                        {removingId === s.id ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />} 清整套
                      </button>
                      {connected ? (
                        <button className="btn btn-sm btn-danger" onClick={disconnect}><Plug size={12} /> 断开</button>
                      ) : (
                        <button className="btn btn-sm btn-primary" onClick={() => connect(s)}><PlugZap size={12} /> 连接</button>
                      )}
                      <button className="btn btn-sm btn-danger" onClick={() => del(s)}><Trash2 size={12} /></button>
                    </div>
                  </div>
                );
              })}
            </div>

            {testOut && (
              <div className="card" style={{ marginTop: 14, borderColor: testOk === false ? '#e5484d' : undefined }}>
                <div className="card-title">
                  测试结果 {testOk === true ? '· 连接成功' : testOk === false ? '· 连接失败' : ''}
                </div>
                <code style={{ whiteSpace: 'pre-wrap', display: 'block' }}>{testOut}</code>
                {testOk === false && testedServer && testedServer.lastGoodPort && testedServer.lastGoodPort !== testedServer.port && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#b54708' }}>
                    端口提示：这台服务器**上次成功用的是 {testedServer.lastGoodPort}**，这次填的是 {testedServer.port}。
                    同一个 IP 上可能挂着不止一个 sshd，填错端口的表现就是"所有认证方式都失败"，很容易被误当成密码坏了。
                  </div>
                )}
                {testOk === false && (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                    常见处理：① 密码认证被拒 → 确认密码（可用系统 ssh 客户端复核）或改用密钥；② 服务器只允许密钥 →
                    把公钥写进服务器 <code>~/.ssh/authorized_keys</code>；③ 私钥有口令 → 在「编辑」里补私钥口令。
                    <br />
                    <b>别连着点测试</b>：服务器上的 fail2ban 常会因多次失败把本机 IP 一并封禁，之后表现会从"认证失败"变成"连接超时"
                    （解封：<code>fail2ban-client set sshd unbanip &lt;你的IP&gt;</code>）。
                  </div>
                )}
              </div>
            )}
            {syncFor && (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="card-title">同步 · {syncFor.name} ({syncFor.host})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(['to-server', 'to-local', 'merge'] as const).map((d) => (
                      <button key={d} className={`btn btn-sm ${syncDir === d ? 'btn-primary' : ''}`} onClick={() => setSyncDir(d)}>
                        {d === 'to-server' ? '本地 → 服务器' : d === 'to-local' ? '服务器 → 本地' : 'merge 双向合并'}
                      </button>
                    ))}
                  </div>
                  <div style={{ color: 'var(--nc-foreground-500)', fontSize: 12 }}>
                    {syncDir === 'merge'
                      ? 'merge：只合并 state 数据 + 表情包到一套写回两端，代码与 config.json 不动，两端先备份。'
                      : syncDir === 'to-server'
                        ? 'to-server：本地内容推到服务器覆盖（先备份远端 config.json）。'
                        : 'to-local：服务器内容拉回本地覆盖（先备份本地 config.json）。'}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: syncDir === 'merge' ? 0.45 : 1 }}>
                      <input type="checkbox" checked={syncCode} onChange={(e) => setSyncCode(e.target.checked)} disabled={syncDir === 'merge'} />
                      桥代码（src/配置，不含数据）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: syncDir === 'merge' ? 0.45 : 1 }}>
                      <input type="checkbox" checked={syncState} onChange={(e) => setSyncState(e.target.checked)} disabled={syncDir === 'merge'} />
                      记忆/会话数据（state/：SQLite 记忆库、社交状态、用量日志等）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: syncDir === 'merge' ? 0.45 : 1 }}>
                      <input type="checkbox" checked={syncConfig} onChange={(e) => setSyncConfig(e.target.checked)} disabled={syncDir === 'merge'} />
                      只同步 config.json（桥的配置：模型/名单/社交参数；不含代码与数据）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={syncStickers} onChange={(e) => setSyncStickers(e.target.checked)} />
                      表情包文件夹（stickers-upload/ 图库文件 + stickers.json 索引）
                    </label>
                    {syncDir === 'merge' && <div style={{ color: 'var(--nc-foreground-500)', fontSize: 12 }}>merge 总是合并记忆/会话数据（不推代码），表情包按上方勾选一并合并。</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary" disabled={syncingId === syncFor.id} onClick={() => runSync(syncFor)}>
                      {syncingId === syncFor.id ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      {syncingId === syncFor.id ? '同步中…' : '开始同步'}
                    </button>
                    <button className="btn btn-sm" onClick={closeSync}><X size={13} /> 关闭</button>
                  </div>
                </div>
              </div>
            )}
            {syncLog && (
              <div className="card" style={{ marginTop: 14 }}>
                <div className="card-title">同步 / 清理步骤</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {syncLog.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
