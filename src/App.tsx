import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Home from './pages/Home';
import SSHConfig from './pages/SSHConfig';
import InstanceConfig from './pages/InstanceConfig';
import BridgeConfig from './pages/BridgeConfig';
import WebView from './pages/WebView';
import Learning from './pages/Learning';
import GroupPortrait from './pages/GroupPortrait';
import ChatHistory from './pages/ChatHistory';
import VoiceConfig from './pages/VoiceConfig';
import { getState, getOwnerQQ, setOwnerQQ } from './api';
import { lastConnect } from './config-cache';
import type { ManagerState } from './stores/types';

type View =
  | { name: 'launch' }
  | { name: 'ssh' }
  | { name: 'bridge' }
  | { name: 'learning' }
  | { name: 'portrait' }
  | { name: 'chat' }
  | { name: 'voice' }
  | { name: 'web'; url: string; title: string }
  | { name: 'cfg'; id: 'dsh-isolated' | 'napcat-local' | 'bridge-local' };

export default function App() {
  const [view, setView] = useState<View>({ name: 'launch' });
  /* `state` 初值保持为 null：首帧即渲染首页框架，页面切换与启动均无整页等待态。
     此处置零值而非占位对象，原因在于首页的既定约定 —— 首份 `/api/state` 到达之前，首页会禁用
     动作按钮，避免同一 QQ 号在本机与服务端两处登录（单点登录互斥）。 */
  const [state, setState] = useState<ManagerState | null>(null);
  const [tick, setTick] = useState(0);
  /* 状态接口失败原因。有值时在首页上方显示一行提示并附「立即重试」；后台定时重试始终保留。 */
  const [stateErr, setStateErr] = useState<string | null>(null);

  /* ================= 首次启动弹窗：配置管理员本人 QQ =================
   * 用途：首次启动时若 `config.json` 内没有该 QQ，则弹一次应用内弹窗（不使用 `window.prompt`），
   * 该值用于识别您本人的消息与指令。
   *   · 仅在 `ok && ownerQQ` 为空时弹出；已配置过则不再弹出（`source='env'` 亦视为已配置，
   *     后端会把环境变量取值回填）；
   *   · 按 ESC 或点击遮罩关闭后，本次会话不再自动弹出（ownerDismissedRef）；
   *   · 保存成功即关闭弹窗并触发一次状态刷新；保存失败则把后端返回的 error 原样显示于弹窗内；
   *   · 接口不可用（后端未启动或该接口不存在）时静默跳过，不影响启动流程。 */
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerVal, setOwnerVal] = useState('');
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerErr, setOwnerErr] = useState('');
  const ownerDismissed = useRef(false);

  const back = () => setView({ name: 'launch' });
  const refresh = () => setTick((t) => t + 1);
  /* 立即重试：清除提示并触发一次轮询周期（与自动重试同一入口） */
  const retryNow = () => { setStateErr(null); refresh(); };

  useEffect(() => {
    let alive = true;
    let iv: ReturnType<typeof setTimeout> | null = null;
    /* 2026-09-23：启动预热窗 —— 挂载起 20 秒内一律按 1.2 秒轮询。
     * 必要性：自启动连接服务器时，首轮 `getState()` 的 `phase` 仍为 `'idle'`（后端此刻才开始连接；
     * bridge.log 实测：窗口 46.3s 加载页面、46.94s 才开始 connecting）。据此判定 transient 为 false，
     * 轮询间隔被定为 4000ms，下一次采样要到 50.3s，而 46.9~50.3 的 3.4 秒内 connecting 与半数
     * tunnels 已经走完，中间态因此从未被采样到。预热窗保证连接自第一刻起即被采样。 */
    const mountedAt = Date.now();
    // 轮询间隔随 phase 变化，使启动/停止过程可见：
    //   有实例处于 starting/stopping → 1.2 秒；全部稳定 → 4 秒（本地回环，代价可忽略）。
    /* 2026-09-23：修「卡片小字由未启动直接跳到运行中」。原判据只取本机实例（`instances[].phase`），
     * 未包含服务端连接状态机，连接服务器期间仍按 4 秒轮询，中间阶段被整段跳过。现将连接状态机与
     * 预热窗一并纳入判据。 */
    const load = async () => {
      try {
        const s = await getState();
        if (alive) { setState(s); setStateErr(null); }
        const instanceTransient = (s?.instances ?? []).some((i) => i.phase === 'starting' || i.phase === 'stopping');
        const connectTransient = !!s?.connect && s.connect.phase !== 'idle' && s.connect.phase !== 'ready';
        const warmingUp = Date.now() - mountedAt < 20000;
        const transient = instanceTransient || connectTransient || warmingUp;
        if (alive) iv = setTimeout(load, transient ? 1200 : 4000);
      } catch (e: any) {
        /* 失败不停在等待态：保留上一次成功的 state，前台显示一行原因与「立即重试」，
           后台仍按 4 秒退避重试（后端未启动时不至于把浏览器打满）。
           2026-09-29：这条提示是"请求确实失败"后才出现的（确定失败），故照实显示；
           但若本地已有上次成功留下的连接/配置缓存，补一句说明，免得看起来像整页失效。 */
        const cachedHint = lastConnect() ? '（当前显示的是上次缓存的信息，恢复后会自动刷新）' : '';
        if (alive) setStateErr(`状态接口无响应：${String(e?.message || e || '请求失败')}；界面保持可用，后台每 4 秒自动重试。${cachedHint}`);
        if (alive) iv = setTimeout(load, 4000);
      }
    };
    load();
    return () => { alive = false; if (iv) clearTimeout(iv); };
  }, [tick]);

  // 任意子页按 ESC 返回主界面
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setView({ name: 'launch' }); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  /** 首次启动：查询一次该 QQ 是否已配置，未配置则弹窗（只查询一次，不轮询） */
  useEffect(() => {
    let alive = true;
    getOwnerQQ()
      .then((r) => {
        if (!alive || ownerDismissed.current) return;
        if (r?.ok && !String(r.ownerQQ ?? '').trim()) setOwnerOpen(true);
      })
      .catch(() => { /* 后端未启动或该接口不存在：静默跳过，不打断启动流程 */ });
    return () => { alive = false; };
  }, []);

  const closeOwner = () => {
    ownerDismissed.current = true;   // 关闭后本次会话不再自动弹出
    setOwnerOpen(false);
    setOwnerErr('');
  };

  const saveOwner = async () => {
    const qq = ownerVal.trim();
    if (!qq) { setOwnerErr('请填写主人 QQ 号'); return; }
    setOwnerBusy(true);
    setOwnerErr('');
    try {
      const r = await setOwnerQQ(qq);
      if (!r?.ok) { setOwnerErr(r?.error || '保存失败'); return; }   // 后端返回的中文原因原样显示
      ownerDismissed.current = true;
      setOwnerOpen(false);
      refresh();                                                     // 保存成功：刷新一次状态
    } catch (e: any) {
      setOwnerErr(String(e?.message || e || '保存失败'));
    } finally {
      setOwnerBusy(false);
    }
  };

  // 弹窗打开期间按 ESC 关闭（关闭后本次会话不再自动弹出）
  useEffect(() => {
    if (!ownerOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeOwner(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerOpen]);

  /* ================= 页面切换动效（2026-09-24 主人要求重做） =================
   * 主人原话："给进入服务器配置界面和进入桥配置界面弄了切换动画你没弄……其他的也是，
   *          所有界面切换都顺滑有动画"。
   * 上一版把进场动画挂在各页自己的 `.page` 上，只有带这个类的页面才动，而且两页之间
   * 没有任何过渡层，观感仍是硬切。现在改成"入口唯一"：**所有**视图（服务器配置 / 桥配置 /
   * 聊天记录 / 语音 / 人设 / 学习 / 实例配置 / WebView / 启动器）都套进同一个
   * `<div className="view-swap">`，并按其身份换 `key`（cfg 带实例 id、web 带 url，其余用视图名）。
   * key 变化 → React 重建这一层 → 进场动画（淡入+上浮+去模糊）与入场光带必然重放，
   * 页面自身带不带 `.page` 都不影响覆盖面。
   * `view-veil` 是切换那一瞬间的一层近白柔光（260ms 淡出），垫在下一页与上一页之间，
   * 免去"同时挂两份 29 万字节的桥配置页"的代价。
   * 注意：这里只对子层换 key，App 本身不重挂 —— 上方那条 `/api/state` 轮询因此不受影响。 */
  const viewKey = view.name === 'web' ? `web:${view.url}`
    : view.name === 'cfg' ? `cfg:${view.id}`
    : view.name;
  /* 内嵌页面（iframe：官方 DSH 界面 / NapCat 官方界面）不再套换页动效：
   *  iframe 首帧本身是白的，再叠「淡入 + 上浮 + 去模糊」与全屏柔光遮罩，观感是这一页在闪，
   *  而不是顺滑地推过去；这两页也不需要过渡层（目标页面自己铺满）。
   *  其余视图（服务器配置 / 桥配置 / 聊天 / 语音 / 学习 / 实例配置 / 启动器）保持原动效。 */
  const swap = (node: ReactNode, opts?: { instant?: boolean }) => (
    <div className={opts?.instant ? 'view-swap no-anim' : 'view-swap'} key={viewKey}>
      {node}
      {opts?.instant ? null : <div className="view-veil" />}
    </div>
  );

  if (view.name === 'web') return swap(<WebView url={view.url} title={view.title} onBack={back} />, { instant: true });
  if (view.name === 'ssh') return swap(<SSHConfig state={state} onBack={back} onRefresh={refresh} />);
  if (view.name === 'learning') return swap(<Learning onBack={() => setView({ name: 'bridge' })} />);
  if (view.name === 'portrait') return swap(<GroupPortrait onBack={() => setView({ name: 'bridge' })} />);
  /* 聊天记录读哪一侧由连接状态决定（同一台服务器的那份 remote 也传给桥配置页）：
     连上服务器 → 读服务端；否则 → 读本机。页面里没有"本机/服务端"开关。 */
  const scopeRemote = state?.connected && state.activeServer
    ? { id: state.activeServer.id, name: state.activeServer.name, host: state.activeServer.host }
    : null;
  if (view.name === 'chat') return swap(<ChatHistory onBack={() => setView({ name: 'bridge' })} remote={scopeRemote} />);
  if (view.name === 'voice') return swap(<VoiceConfig onBack={() => setView({ name: 'bridge' })} />);
  if (view.name === 'bridge') return swap(
    <BridgeConfig
      onBack={back}
      onRefresh={refresh}
      onOpenLearning={() => setView({ name: 'learning' })}
      onOpenPortrait={() => setView({ name: 'portrait' })}
      onOpenChat={() => setView({ name: 'chat' })}
      onOpenVoice={() => setView({ name: 'voice' })}
      /* 2026-09-14：已连接服务器时，功能配置页读写服务端 `/root/qq-bridge/config.json`（页面显示横幅） */
      remote={scopeRemote}
    />
  );
  if (view.name === 'cfg') return swap(<InstanceConfig state={state} instanceId={view.id} onBack={back} onRefresh={refresh} />);
  return swap(
    <>
      {/* 状态接口失败提示：一行原因 + 立即重试；不遮挡界面，首页照常可用。
          自动重试由上方轮询保证，与本条提示是否显示无关。 */}
      {stateErr && (
        <div
          className="notice-bar"
          style={{ maxWidth: 720, margin: '12px auto 0', textAlign: 'left', cursor: 'default' }}
          title="管理器后端未响应；界面保持可用，后台每 4 秒自动重试"
        >
          {stateErr}
          <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={retryNow}>立即重试</button>
        </div>
      )}

      <Home
        state={state}
        onOpenSSH={() => setView({ name: 'ssh' })}
        onOpenConfig={(id) => setView(id === 'bridge-local' ? { name: 'bridge' } : { name: 'cfg', id })}
        onOpenWeb={(url, title) => setView({ name: 'web', url, title })}
        onRefresh={refresh}
      />

      {/* 首次启动弹窗：配置管理员本人 QQ（应用内弹窗，复用 .help-overlay/.help-panel 样式）。
          点击遮罩或按 ESC 关闭；关闭后本次会话不再自动弹出。 */}
      {ownerOpen && (
        <div className="help-overlay" style={{ zIndex: 160 }} onClick={closeOwner}>
          <div className="help-panel" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="help-head">设置主人 QQ</div>
            <div className="help-body" style={{ whiteSpace: 'normal' }}>
              用于识别您本人的消息与指令。只需填写一次，此后可在功能配置中修改。
              <div style={{ marginTop: 12 }}>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  inputMode="numeric"
                  maxLength={12}
                  placeholder="纯数字 QQ 号"
                  value={ownerVal}
                  autoFocus
                  onChange={(e) => setOwnerVal(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveOwner(); }}
                />
              </div>
              {ownerErr && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--nc-danger-600, #b42318)' }}>{ownerErr}</div>
              )}
            </div>
            <div className="help-foot">
              <button className="btn btn-sm btn-primary" disabled={ownerBusy} onClick={saveOwner}>
                {ownerBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}