import { useEffect, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import type { ReactNode } from 'react';
import { api, postConfig, deployStart, deployStatus, syncBridge, removeServerStack, remoteStackById } from '../api';
import type { SSHServer, ManagerState } from '../stores/types';
import { ArrowLeft, Plus, Trash2, Loader2, PlugZap, Plug, TestTube2, Server, Settings, Save, Rocket, X, Check, RefreshCw, Play, Square } from 'lucide-react';
import NumInput from '../components/NumInput';
import Dropdown from '../components/Dropdown';

/* 远程端口默认值（与 server/index.js 的 tunnelMapFor 保持一致） */
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
/** 2026-09-14保留刚被冷却机制拦下的那台服务器，供「仍然重试一次」使用；冷却时长由后端按失败性质计算，前端不写死。 */
  const [coolServer, setCoolServer] = useState<SSHServer | null>(null);
/** 2026-09-14 修改要求：确认弹窗改为应用内主题弹窗，不再调用系统 confirm()。 */
  const [confirmBox, setConfirmBox] = useState<{ title: string; body: ReactNode; okText?: string; danger?: boolean; onOk: () => void | Promise<void> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const askConfirm = (opts: { title: string; body: ReactNode; okText?: string; danger?: boolean; onOk: () => void | Promise<void> }) => setConfirmBox(opts);
  const runConfirm = async () => {
    if (!confirmBox) return;
    setConfirmBusy(true);
    try { await confirmBox.onOk(); } finally { setConfirmBusy(false); setConfirmBox(null); }
  };
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testedServer, setTestedServer] = useState<SSHServer | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /* 2026-09-23「启动时自动连接服务器」按钮的乐观状态：
   * autoPending 保存刚点击、尚待刷新确认的值；为 null 时跟随服务端下发的 state 字段。
   * 该值的用途：此按钮原为原生 checkbox，直接读取 state.autoConnectServer，而后端当时不返回该字段，
   * 取值恒为 undefined，界面恒显示「开」，点击后无法回退。后端已补上该字段；此处再加一层乐观值，
   * 以免出现「点击后需等待一次刷新才改变显示」的迟滞。 */
  const [autoPending, setAutoPending] = useState<boolean | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
/** 按钮实际显示的状态：优先使用刚点击的乐观值，其次跟随服务端下发值（缺省为开）。 */
  const autoConnectOn = autoPending ?? (state?.autoConnectServer !== false);
/** 服务端值追上乐观值后交回给服务端，避免长期持有陈旧的本地状态。 */
  useEffect(() => {
    if (autoPending !== null && state?.autoConnectServer === autoPending) setAutoPending(null);
  }, [state?.autoConnectServer, autoPending]);
  const toggleAutoConnect = async () => {
    if (autoSaving) return;
    const next = !autoConnectOn;
    setAutoSaving(true);
    setAutoPending(next);
    try {
      await postConfig({ autoConnectServer: next });
      setMsg(next ? '已开启：下次打开应用时将自动连接该服务器' : '已关闭：下次打开应用时不自动连接，仍可手动点击「连接」');
      onRefresh?.();
    } catch (err: any) {
      setAutoPending(null);   // 保存失败即退回服务端值，不显示未生效的状态
      setMsg('保存失败：' + String(err?.message ?? err));
    } finally {
      setAutoSaving(false);
    }
  };
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // 「启动Bot / 终止Bot」：正在执行的动作标识（形如 `<serverId>:start`），用于禁用按钮并显示加载状态
  const [stackBusy, setStackBusy] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<string[] | null>(null);
  // 同步面板：direction 取 to-server | to-local | merge；opts 决定勾选哪些同步内容
  const [syncFor, setSyncFor] = useState<SSHServer | null>(null);
  const [syncDir, setSyncDir] = useState<'to-server' | 'to-local' | 'merge'>('to-server');
  const [syncCode, setSyncCode] = useState(true);
  const [syncState, setSyncState] = useState(false);
  const [syncStickers, setSyncStickers] = useState(false);
  const [syncConfig, setSyncConfig] = useState(false);   // 仅同步桥的 config.json
  const [form, setForm] = useState({ name: '', host: '', port: 22, username: 'root', authType: 'password' as 'password' | 'key', password: '', privateKey: '', passphrase: '' });

  // ===== 克隆部署面板 =====
  const [deployFor, setDeployFor] = useState<SSHServer | null>(null); // 目标服务器（本台将安装整套服务）
  const [deploySrc, setDeploySrc] = useState<string>('');              // 复刻源标识
  const [deployQQ, setDeployQQ] = useState(true);                      // 是否一并复刻 QQ 登录态
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
    // 默认源为本机（2026-09-12 改为从本机复刻）：无需第二台服务器，
    // 也不要求目标机旁另备模板机。如需以其他服务器为模板，可在下拉框中另行选择。
    setDeployFor(target);
    setDeploySrc('local');
    setDeployQQ(true);
    setDeployTask(null);
    setDeployLog([]);
  };

  // 轮询部署任务的日志
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
      } catch { /* 网络闪断时留待下一轮重试 */ }
    }, 1200);
    return () => { if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; } };
  }, [deployTask]);

  // 日志自动滚动到底部
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [deployLog]);

  const startDeploy = async () => {
    if (!deployFor || !deploySrc) { setMsg('请先选择复刻源（本机或某台已部署完成的服务器）'); return; }
    setDeployBusy(true);
    setDeployLog([]);
    try {
      const plain = (x: SSHServer) => ({ ...x } as Record<string, unknown>);
      // 源为本机时不再需要第二台服务器，直接取本机磁盘上的整套内容（桥 + 隔离 DSH + NapCat 登录令牌 + 数据）复刻过去
      const useLocal = deploySrc === 'local';
      if (!useLocal) {
        const source = servers.find((x) => x.id === deploySrc);
        if (!source) { setMsg('复刻源不存在，请重新选择'); setDeployBusy(false); return; }
        if (source.host === deployFor.host && (source.port || 22) === (deployFor.port || 22)) { setMsg('复刻源与目标为同一台机器'); setDeployBusy(false); return; }
      }
      const r = await deployStart(useLocal ? { local: true, name: '本机（这台电脑）' } : plain(servers.find((x) => x.id === deploySrc)!), plain(deployFor), deployQQ);
      if (!r.success || !r.taskId) { setMsg(r.message || '发起失败'); setDeployBusy(false); return; }
      setDeployTask(r.taskId);
      setMsg(useLocal ? '已开始从本机复刻（本机不会停机，详见下方日志）' : '部署已开始，详见下方日志（过程中复刻源服务器会短暂停机以完成打包）');
    } catch (e) { setMsg(`发起失败：${(e as Error).message}`); setDeployBusy(false); }
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
    // 刷新后恢复进行中的克隆部署日志（任务在后台运行，日志不丢失）
    import('../api').then((m) => m.deployTasks()).then((r) => {
      const run = (r.tasks ?? []).find((t) => t.status === 'running');
      if (run) { setDeployTask(run.id); setDeployLog([]); }
    }).catch(() => {});
  }, []);

  const persist = async (next: SSHServer[]) => {
    await postConfig({ servers: next });
    setServers(next);
  };

/** 逐字段校验服务器表单，返回每一项「缺什么／哪里不符」的独立说明，不合并为笼统提示 */
  const validateServerForm = (f: { name?: string; host?: string; port?: number; username?: string; authType?: string; password?: string; privateKey?: string }) => {
    const bad: string[] = [];
    if (!String(f.name ?? '').trim()) bad.push('名称未填');
    if (!String(f.host ?? '').trim()) bad.push('主机地址未填');
    const port = Number(f.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) bad.push('端口需为 1~65535 之间的整数');
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
    /* 2026-09-14 修改要求：不再使用系统 confirm()，改为应用内主题弹窗（同 .help-overlay 一套样式）。 */
    askConfirm({
      title: `删除服务器「${s.name}」`,
      body: <>仅从管理端列表中移除该服务器的配置（<code>{s.username}@{s.host}:{s.port}</code>）。<br />
        服务器上的桥／DSH／NapCat <b>不受影响</b>；如需一并清除服务端，请使用同一行的「清整套」。</>,
      okText: '删除',
      danger: true,
      onOk: async () => {
        await persist(servers.filter((x) => x.id !== s.id));
        if (selectedId === s.id) setSelectedId(null);
      },
    });
  };

  const connect = async (s: SSHServer, force = false) => {
    try {
      const r = await api<any>(`/ssh/connect${force ? '?force=1' : ''}`, { method: 'POST', body: JSON.stringify(s) });
      setCoolServer(r?.cooldown ? s : null);
      setMsg(r.success ? `已连接 ${s.name}` : `连接失败：${r.message}`);
    } catch { setMsg('连接失败：请求未能送达后端'); }
    setSelectedId(s.id);
    onRefresh();
  };

  const disconnect = async () => {
    await api('/ssh/disconnect', { method: 'POST', body: JSON.stringify({}) });
    setMsg('已断开');
    onRefresh();
  };

  const test = async (s: SSHServer, force = false) => {
    setTesting(s.id);
    setTestOk(null);
    setTestedServer(s);
    try {
      const r = await api<any>(`/ssh/test${force ? '?force=1' : ''}`, { method: 'POST', body: JSON.stringify(s) });
      setCoolServer(r?.cooldown ? s : null);
      // 认证失败时后端会附带 detail（服务器允许的认证方式／本次发出的方式），此处如实展示：
      // 原先后端只透出 ssh2 的 “All configured authentication methods failed”，用户无从判断该修改哪一项。
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

  // ===== 桥代码同步（to-server / to-local / merge） =====
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
      // 内容勾选经 flags 显式传递（与后端 wantCode / wantState / wantStickers 一一对应）；
      // direction 仅表示方向，不带后缀。merge 强制包含 state 并禁用代码同步（与界面上的禁用状态和说明一致）。
      const flags = syncDir === 'merge'
        ? { code: false, state: true, stickers: syncStickers, config: false }
        : { code: syncCode, state: syncState, stickers: syncStickers, config: syncConfig };
      const r = await syncBridge({ ...s }, syncDir, false, flags);
      if (r.steps?.length) setSyncLog(r.steps.map((x) => `${x.ok ? '✓' : '✗'} ${x.step}${x.msg ? ' — ' + x.msg : ''}`));
      setMsg(r.success ? '同步完成' : (r.message || '同步失败，详见下方步骤'));
    } catch (e) { setMsg(`同步失败：${(e as Error).message}`); }
    finally { setSyncingId(null); }
  };

  // ===== 删除整套（移动为备份，不可撤回） =====
  const removeStack = async (s: SSHServer) => {
    askConfirm({
      title: `清空服务器「${s.name}」上的整套`,
      body: <>将停止服务，并把 <code>/root/qq-bridge</code>、<code>/root/.dsh</code>、<code>/root/napcat</code> 整体移动至
        <code> /root/qq-bridge-removed-&lt;时间戳&gt;/</code> 作为备份（可自行取回）。<br />
        <b>QQ 登录卷不会被删除</b>，但此操作不可撤回。</>,
      okText: '确认清空',
      danger: true,
      onOk: async () => {
        setRemovingId(s.id);
        setSyncLog(null);
        try {
          const r = await removeServerStack({ ...s });
          if (r.steps?.length) setSyncLog(r.steps.map((x) => `${x.ok ? '✓' : '✗'} ${x.step}${x.msg ? ' — ' + x.msg : ''}`));
          setMsg(r.success ? '已移除整套' : (r.message || '移除失败，详见下方步骤'));
        } catch (e) { setMsg(`移除失败：${(e as Error).message}`); }
        finally { setRemovingId(null); }
      },
    });
  };

  /* 远端整套启停（服务器卡片上的「启动Bot / 终止Bot」）
   * 启动顺序为 DSH → NapCat 容器 → 桥；终止顺序为桥 → NapCat → DSH（逆序执行，避免桥持续连接一个已经消失的 NapCat）。
   * 操作幂等，重复点击不产生副作用；步骤结果复用同步日志卡片显示。
   *
   * 2026-09-15 修「点了启动Bot，回到主页 Core 没起来」两处成因均在此：
   *  ① 原实现走 remoteStack({...s})，把带凭据的整份 server 发回后端；首页那条路径（remoteStackById）只发 id。
   *     现统一走 remoteStackById，与后端「SSH 配置页只管配置、动作按 id 走」的做法一致；
   *  ② 原实现动作完成后不刷新全局状态，也不在本页说明结果，回到首页所见仍是动作前的旧状态。
   *     现改为动作完成后立即 onRefresh()（后端亦已随本次动作返回真实状态并作废状态缓存），
   *     并把每一步（含「桥是否连上 NapCat」）留在本页，不再依赖「回首页看指示灯」判断。
   * 失败原因亦直接拼入提示，不再只显示一句「失败」。 */
  const stackCtl = async (s: SSHServer, action: 'start' | 'stop') => {
    setStackBusy(`${s.id}:${action}`);
    setSyncLog(null);
    const verb = action === 'start' ? '启动' : '终止';
    try {
      const r = await remoteStackById(s.id, action);
      const lines = (r.steps ?? []).map((x) => `${x.ok ? '✓' : '✗'} ${x.step}${x.msg ? ' — ' + String(x.msg).split('\n').filter(Boolean).join(' / ') : ''}`);
      if (lines.length) setSyncLog(lines);
      // 服务端组件状态：后端随本次动作一并返回；取不到则退回下一步轮询
      const st: any = (r as any)?.status;
      if (st?.ok) {
        const bits = [
          `DSH ${st.dsh?.running ? '运行中' : '未运行'}`,
          `NapCat ${st.napcat?.running ? '运行中' : '未运行'}`,
          `桥 ${st.bridge?.running ? '运行中' : '未运行'}`
        ];
        setSyncLog((prev) => [...(prev ?? []), `— 服务端状态：${bits.join(' · ')}`]);
      }
      const bad = (r.steps ?? []).find((x) => !x.ok);
      setMsg(r.success
        ? `已${verb}：${s.name}${action === 'start' ? '（若桥未连上 NapCat，到 NapCat 界面扫码即可，桥会自动重连）' : ''}`
        : `${verb}未完成：${bad ? bad.step + ' — ' + String(bad.msg || '').split('\n')[0] : (r.message || '见下方步骤')}`);
    } catch (e) { setMsg(`${verb}失败：${(e as Error).message}`); }
    finally {
      setStackBusy(null);
      // 使首页卡片立即反映本次动作（后端已作废状态缓存，此处只是催促前端重新拉取一次）
      try { onRefresh(); } catch { /* 忽略 */ }
    }
  };

  const startEdit = (s: SSHServer) => {
    setSelectedId(s.id);
    setAdding(false);
    // 默认值兜底：未配置的字段给出合理默认值，避免空值
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
        <NoticeBar msg={msg} onClose={() => setMsg(null)} />

        {/* 服务器列表；列表为空时仅显示添加入口 */}
        {servers.length === 0 && !adding ? (
          <div className="empty-state" style={{ padding: 70 }}>
            <Server size={40} style={{ color: 'var(--nc-foreground-300)', marginBottom: 14 }} />
            <div style={{ marginBottom: 18, color: 'var(--nc-foreground-500)' }}>尚未添加服务器</div>
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
                  <div className="form-group"><label className="label">名称</label><input className="input" placeholder="用于标识该服务器，例如 VPS-01" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                  <div className="form-group"><label className="label">主机地址</label><input className="input" placeholder="服务器 IP 或域名" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="label">端口</label><NumInput className="input" value={form.port} onCommit={(n) => setForm({ ...form, port: Math.round(n) || 22 })} /></div>
                  <div className="form-group"><label className="label">用户名</label><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
                </div>
                <div className="form-group">
                  <label className="label">认证</label>
                  <Dropdown className="select" value={form.authType} onChange={(v) => setForm({ ...form, authType: v as any })}
                    options={[{ value: 'password', label: '密码' }, { value: 'key', label: '私钥' }]} />
                </div>
                {form.authType === 'password' ? (
                  <div className="form-group"><label className="label">密码</label><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
                ) : (
                  <div className="form-group"><label className="label">私钥路径</label><input className="input" value={form.privateKey} placeholder="例如 C:\Users\你\.ssh\id_rsa" onChange={(e) => setForm({ ...form, privateKey: e.target.value })} /></div>
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
                    <Dropdown className="select" value={editDraft.authType} onChange={(v) => setEditDraft({ ...editDraft, authType: v as any })}
                      options={[{ value: 'password', label: '密码' }, { value: 'key', label: '私钥' }]} />
                  </div>
                  {editDraft.authType === 'password' ? (
                    <div className="form-group"><label className="label">密码</label><input className="input" type="password" value={editDraft.password} onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })} /></div>
                  ) : (
                    <div className="form-group"><label className="label">私钥路径</label><input className="input" value={editDraft.privateKey} placeholder="例如 C:\Users\你\.ssh\id_rsa" onChange={(e) => setEditDraft({ ...editDraft, privateKey: e.target.value })} /></div>
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
                    整套复刻{deployFor ? ` → ${deployFor.name}` : '（进行中）'}
                  </div>
                  <button className="icon-btn" onClick={closeDeploy} title="关闭"><X size={15} /></button>
                </div>
                {deployFor && (
                <>
                <div className="notice-bar" style={{ background: 'transparent', border: 'none', padding: '10px 0', color: 'var(--nc-foreground-500)', fontSize: 13 }}>
                  {deploySrc === 'local' ? (
                    <>将<b>本机当前运行中的整套</b>（隔离 DSH + 桥 + NapCat 登录令牌 + 全部数据）复刻至「{deployFor.name}」
                    ({deployFor.host})。目标机宜为全新 Ubuntu；<b>本机不会停机</b>，复刻源直接读取磁盘上的副本并打包。</>
                  ) : (
                    <>将模板服务器上的整套（DSH + 桥 + NapCat 登录态 + 全部数据）克隆部署至「{deployFor.name}」
                    ({deployFor.host})。目标机宜为全新 Ubuntu；过程中模板机将短暂停机以完成打包，完成后自动恢复。</>
                  )}
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="label">复刻源</label>
                    <Dropdown className="select" value={deploySrc} onChange={setDeploySrc} disabled={deployBusy || !!deployTask}
                      options={[
                        { value: 'local', label: '本机（这台电脑 · 当前运行中的整套）' },
                        ...servers.filter((x) => x.id !== deployFor.id).map((x) => ({ value: x.id, label: `${x.name}（${x.host}）` })),
                      ]} />
                  </div>
                  <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                    <label className="checkbox-label" style={{ marginBottom: 10 }}>
                      <input type="checkbox" checked={deployQQ} onChange={(e) => setDeployQQ(e.target.checked)} disabled={deployBusy || !!deployTask} />
                      连同 QQ 登录令牌一并复刻（免重新扫码）
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
                  <span style={{ color: 'var(--nc-foreground-400)', fontSize: 12 }}>复刻源 {srcLabel} → 目标 {deployFor.name}</span>
                </div>
                </>
                )}
                {deployTask && (
                  <div className="notice-bar" style={{ background: 'transparent', border: 'none', padding: '10px 0 0', color: 'var(--nc-foreground-400)', fontSize: 12 }}>
                    {deployDone ? '任务已结束。' : deployFailed ? '任务失败，详见下方日志；模板机已尽力恢复。' : '部署进行中… 请勿关闭页面（刷新可恢复日志）。'}
                  </div>
                )}
                {(deployTask || deployLog.length > 0) && (
                  <div
                    ref={logRef}
                    className="log-box"
                    style={{
                      // 2026-09-12：部署日志字体改为黑色，故底色一并换为浅色，
                      // 否则黑字叠加在原深色底（#0f1115）上无法辨识。
                      marginTop: 12, maxHeight: 320, overflow: 'auto', background: '#fff',
                      color: '#000', border: '1px solid var(--nc-primary-200, #e4e7ec)',
                      fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12,
                      padding: '10px 12px', borderRadius: 8, whiteSpace: 'pre-wrap',
                    }}
                  >
                    {deployLog.length ? deployLog.map((l, i) => <div key={i}>{l}</div>) : <div>正在等待日志…</div>}
                  </div>
                )}
                {deployFor && (
                <div className="notice-bar" style={{ background: 'transparent', border: 'none', padding: '10px 0 0', color: 'var(--nc-foreground-500)', fontSize: 12 }}>
                  复刻源可以取<b>本机</b>（默认，无需第二台服务器），也可以取另一台已完成部署的服务器。
                  开始后可在下方日志查看每一步进度；部署完成后回到列表点击「连接」建立隧道即可使用。
                </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* 2026-09-22 修改要求："连接上服务器之后直接退出，下次打开自动连接服务器" —— 该开关
                  决定下次打开应用时是否自动连接上次使用的那台（默认开启）。关闭后仅支持手动点击「连接」。 */}
              {/* 2026-09-23 修改要求：原为原生 checkbox：既与本套 nc_pink 主题不符，又因后端
                  不返回该字段而恒显示「开」，既无法勾选也无法取消。现改为内置粉色按钮（开 = .btn-primary
                  实心粉、关 = .btn-outline 描边），状态由 autoConnectOn 统一提供，点击即切换。 */}
              {/* 2026-09-24 修改要求：按钮文案去掉"废话"：只留「自动连接服务器」（原来的
                  "启动时自动连接服务器（上次连接的那台）：开/关" 太长，把按钮横向撑得很宽）；
                  开关状态改由图标与配色表达（对勾 + 实心粉 = 开、叉号 + 描边 = 关），详细说明留在 title 里。 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`btn btn-sm ${autoConnectOn ? 'btn-primary' : 'btn-outline'}`}
                  style={{ paddingLeft: 10, paddingRight: 12 }}
                  disabled={autoSaving}
                  onClick={toggleAutoConnect}
                  title={autoConnectOn
                    ? '已开启：下次打开应用时将自动连接该服务器。点击可关闭。'
                    : '已关闭：下次打开应用时不自动连接，仍可手动点击「连接」。点击可开启。'}
                >
                  {autoSaving
                    ? <Loader2 size={14} className="spin" />
                    : autoConnectOn ? <Check size={14} /> : <X size={14} />}
                  自动连接服务器
                </button>
                {state?.connect && state.connect.phase !== 'idle' && state.connect.phase !== 'ready' && (
                  <span style={{ color: 'var(--nc-foreground-500)', fontSize: 12 }}>
                    当前：{({ connecting: '正在连接', tunnels: '正在建立隧道', 'server-starting': '服务端启动中', warming: '正在完成界面鉴权', failed: '连接失败' } as Record<string, string>)[state.connect.phase] || state.connect.phase}
                  </span>
                )}
              </div>
              {servers.map((s) => {
                const active = s.id === selectedId;
                const connected = state?.connected && state.activeServer?.id === s.id;
                return (
                  <div
                    className="card server-row"
                    key={s.id}
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
                      {/* 【2026-09-22】该服务器正在连接或正在启动服务端时，就地写出状态机所处阶段 */}
                      {connected && state?.connect && state.connect.phase !== 'ready' && state.connect.phase !== 'idle' && (
                        <div style={{ fontSize: 12, marginTop: 2, color: 'var(--nc-foreground-500)' }}>
                          {({ connecting: '正在连接…', tunnels: '正在建立隧道…', 'server-starting': '服务端启动中…', warming: '正在完成界面鉴权…', failed: '连接失败（将自动重试）' } as Record<string, string>)[state.connect.phase] || state.connect.phase}
                          {state.connect.note ? ` · ${state.connect.note}` : ''}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm" disabled={testing === s.id} onClick={() => test(s)}>
                        {testing === s.id ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />} 测试
                      </button>
                      <button className="btn btn-sm btn-primary" onClick={() => startEdit(s)}><Settings size={12} /> 配置</button>
                      <button className="btn btn-sm" title="将整套（DSH + 桥 + NapCat 登录态）克隆部署到该服务器" onClick={() => openDeploy(s)}><Rocket size={12} /> 部署</button>
                      <button className="btn btn-sm" title="将该服务器的代码／记忆／表情包同步到本地，或将本地内容同步至该服务器" onClick={() => openSync(s)} disabled={syncingId === s.id}>
                        {syncingId === s.id ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 同步
                      </button>
                      <button className="btn btn-sm" title="在服务器上启动整套（DSH → NapCat → 桥）；已在运行的服务将跳过，桥若已存在则不改动" disabled={!!stackBusy} onClick={() => stackCtl(s, 'start')}>
                        {stackBusy === `${s.id}:start` ? <Loader2 size={12} className="spin" /> : <Play size={12} />} 启动Bot
                      </button>
                      <button className="btn btn-sm btn-danger" title="在服务器上停止整套（桥 → NapCat → DSH）" disabled={!!stackBusy} onClick={() => stackCtl(s, 'stop')}>
                        {stackBusy === `${s.id}:stop` ? <Loader2 size={12} className="spin" /> : <Square size={12} />} 终止Bot
                      </button>
                      <button className="btn btn-sm btn-danger" title="删除该服务器上的整套（桥 + DSH + NapCat，移动为备份）" onClick={() => removeStack(s)} disabled={removingId === s.id}>
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
                {/* 【2026-09-14】冷却时长不再写死为 10 分钟（见后端 sshCooldownInfo）；此处另提供一个「立即重试」入口，
                    以免用户在修改密码后必须等待冷却结束。 */}
                {coolServer && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="btn btn-sm" disabled={!!testing} onClick={() => test(coolServer, true)}>仍要重试一次</button>
                    <span style={{ fontSize: 12, opacity: 0.7 }}>冷却用于防止本机 IP 因反复尝试而被封禁；确认原因后可以跳过。</span>
                  </div>
                )}
                {testOk === false && testedServer && testedServer.lastGoodPort && testedServer.lastGoodPort !== testedServer.port && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#b54708' }}>
                    端口提示：该服务器上次连接成功使用的是 {testedServer.lastGoodPort}，本次填写的是 {testedServer.port}。
                    同一 IP 上可能运行多个 sshd，端口填写错误时的表现是「所有认证方式均失败」，容易被误判为口令错误。
                  </div>
                )}
                {testOk === false && (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                    常见处理：① 口令认证被拒 → 核对口令（可用系统 ssh 客户端复核）或改用密钥认证；② 服务器仅允许密钥认证 →
                    将公钥写入服务器的 <code>~/.ssh/authorized_keys</code>；③ 私钥设有口令 → 在「配置」中补填私钥口令。
                    <br />
                    <b>切勿连续点击测试</b>：服务器上的 fail2ban 常因多次失败而一并封禁本机 IP，此后表现将由「认证失败」转为「连接超时」
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
                      ? 'merge：仅将 state 数据与表情包合并为一份后写回两端，代码与 config.json 不改动，两端均先备份。'
                      : syncDir === 'to-server'
                        ? 'to-server：以本地内容覆盖服务器（覆盖前先备份远端 config.json）。'
                        : 'to-local：以服务器内容覆盖本地（覆盖前先备份本地 config.json）。'}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: syncDir === 'merge' ? 0.45 : 1 }}>
                      <input type="checkbox" checked={syncCode} onChange={(e) => setSyncCode(e.target.checked)} disabled={syncDir === 'merge'} />
                      桥代码（src/ 目录，不含数据）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: syncDir === 'merge' ? 0.45 : 1 }}>
                      <input type="checkbox" checked={syncState} onChange={(e) => setSyncState(e.target.checked)} disabled={syncDir === 'merge'} />
                      记忆／会话数据（state/：SQLite 记忆库、社交状态、用量日志等）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: syncDir === 'merge' ? 0.45 : 1 }}>
                      <input type="checkbox" checked={syncConfig} onChange={(e) => setSyncConfig(e.target.checked)} disabled={syncDir === 'merge'} />
                      仅同步 config.json（桥的配置：模型、名单、社交参数；不含代码与数据）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={syncStickers} onChange={(e) => setSyncStickers(e.target.checked)} />
                      表情包文件夹（stickers-upload/ 图库文件 + stickers.json 索引）
                    </label>
                    {syncDir === 'merge' && <div style={{ color: 'var(--nc-foreground-500)', fontSize: 12 }}>merge 总是合并记忆／会话数据（不推送代码），表情包按上方勾选一并合并。</div>}
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
                <div className="card-title">同步／清理步骤</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {syncLog.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 【2026-09-14】应用内确认弹窗：配色、圆角与按钮均使用主题样式，不再调用系统 confirm() */}
      {confirmBox && (
        <div className="help-overlay" style={{ zIndex: 140 }} onClick={() => { if (!confirmBusy) setConfirmBox(null); }}>
          <div className="help-panel" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
                {confirmBox.danger ? <Trash2 size={16} /> : <Server size={16} />} {confirmBox.title}
              </span>
              <button className="icon-btn" disabled={confirmBusy} onClick={() => setConfirmBox(null)}><X size={16} /></button>
            </div>
            <div style={{ padding: '12px 16px 4px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--nc-foreground-700)' }}>
              {confirmBox.body}
            </div>
            <div className="help-foot" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-sm" disabled={confirmBusy} onClick={() => setConfirmBox(null)}>取消</button>
              <button className={confirmBox.danger ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-primary'} disabled={confirmBusy} onClick={runConfirm}>
                {confirmBusy ? <><Loader2 size={13} className="spin" /> 处理中…</> : (confirmBox.okText || '确认')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
