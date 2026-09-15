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
    // 状态机在启动/停止过程中要"看得见地"往前走，所以轮询间隔跟着 phase 变：
    //   有实例处于 starting/stopping → 1.2 秒（秒数在跳，用户知道它在动）
    //   全部稳定 → 4 秒（本地回环，代价可忽略）
    const load = async () => {
      try {
        const s = await getState();
        if (alive) setState(s);
        const transient = (s?.instances ?? []).some((i) => i.phase === 'starting' || i.phase === 'stopping');
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
