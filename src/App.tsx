import { useEffect, useState } from 'react';
import Home from './pages/Home';
import SSHConfig from './pages/SSHConfig';
import InstanceConfig from './pages/InstanceConfig';
import BridgeConfig from './pages/BridgeConfig';
import WebView from './pages/WebView';
import Learning from './pages/Learning';
import GroupPortrait from './pages/GroupPortrait';
import VoiceConfig from './pages/VoiceConfig';
import { getState } from './api';
import type { ManagerState } from './stores/types';

type View =
  | { name: 'launch' }
  | { name: 'ssh' }
  | { name: 'bridge' }
  | { name: 'learning' }
  | { name: 'portrait' }
  | { name: 'voice' }
  | { name: 'web'; url: string; title: string }
  | { name: 'cfg'; id: 'dsh-isolated' | 'napcat-local' | 'bridge-local' };

export default function App() {
  const [view, setView] = useState<View>({ name: 'launch' });
  const [state, setState] = useState<ManagerState | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    let iv: ReturnType<typeof setTimeout> | null = null;
    /* 【2026-09-23 启动预热窗】从挂载起 20 秒内一律 1.2 秒一拍。
     * 为什么必须要有它：自启动连接服务器时，**首轮 getState() 拿到的 phase 还是 'idle'**
     * （后端此刻才刚开始连，bridge.log 实测：窗口 46.3s 加载页面、46.94s 才开始 connecting），
     * 于是 transient 判为 false → 轮询间隔被定成 4000ms → 下一次采样要等到 50.3s，
     * 而 46.9~50.3 这 3.4 秒里 connecting 和半个 tunnels 已经走完了。
     * 结果就是主人看到的"中间态根本没出现"——不是没渲染，是**前 4 秒压根没采样**。
     * 预热窗保证连接从第一刻起就在被采样。 */
    const mountedAt = Date.now();
    // 状态机在启动/停止过程中要"看得见地"往前走，所以轮询间隔跟着 phase 变：
    //   有实例处于 starting/stopping → 1.2 秒（秒数在跳，用户知道它在动）
    //   全部稳定 → 4 秒（本地回环，代价可忽略）
    /* 【2026-09-23 修「卡片小字还是从未启动直接跳到运行中」】
     * 原来这个 transient 判据**只看本机实例**（instances[].phase），没看服务器的连接状态机。
     * 于是连接服务器期间仍按 4 秒轮询，把中间那几个瞬时阶段整个跳过去：
     * 上一拍"未启动"，下一拍"运行中"，卡片小字里那个中间态等于白写。
     * 现在把连接状态机与预热窗一并纳入判据。 */
    const load = async () => {
      try {
        const s = await getState();
        if (alive) setState(s);
        const instanceTransient = (s?.instances ?? []).some((i) => i.phase === 'starting' || i.phase === 'stopping');
        const connectTransient = !!s?.connect && s.connect.phase !== 'idle' && s.connect.phase !== 'ready';
        const warmingUp = Date.now() - mountedAt < 20000;
        const transient = instanceTransient || connectTransient || warmingUp;
        if (alive) iv = setTimeout(load, transient ? 1200 : 4000);
      } catch {
        if (alive) iv = setTimeout(load, 4000);   // 后端没起时退避，别把浏览器打满
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

  const back = () => setView({ name: 'launch' });
  const refresh = () => setTick((t) => t + 1);

  if (view.name === 'web') return <WebView url={view.url} title={view.title} onBack={back} />;
  if (view.name === 'ssh') return <SSHConfig state={state} onBack={back} onRefresh={refresh} />;
  if (view.name === 'learning') return <Learning onBack={() => setView({ name: 'bridge' })} />;
  if (view.name === 'portrait') return <GroupPortrait onBack={() => setView({ name: 'bridge' })} />;
  if (view.name === 'voice') return <VoiceConfig onBack={() => setView({ name: 'bridge' })} />;
  if (view.name === 'bridge') return (
    <BridgeConfig
      onBack={back}
      onRefresh={refresh}
      onOpenLearning={() => setView({ name: 'learning' })}
      onOpenPortrait={() => setView({ name: 'portrait' })}
      onOpenVoice={() => setView({ name: 'voice' })}
      /* 【2026-09-14】连上服务器时，功能配置页读写**服务端** /root/qq-bridge/config.json（页面会显示明显横幅） */
      remote={state?.connected && state.activeServer ? { id: state.activeServer.id, name: state.activeServer.name, host: state.activeServer.host } : null}
    />
  );
  if (view.name === 'cfg') return <InstanceConfig state={state} instanceId={view.id} onBack={back} onRefresh={refresh} />;
  return (
    <Home
      state={state}
      onOpenSSH={() => setView({ name: 'ssh' })}
      onOpenConfig={(id) => setView(id === 'bridge-local' ? { name: 'bridge' } : { name: 'cfg', id })}
      onOpenWeb={(url, title) => setView({ name: 'web', url, title })}
      onRefresh={refresh}
    />
  );
}
