import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { instanceAction, startAllInstances } from '../api';
import type { ManagerState, LocalInstance } from '../stores/types';
import { Settings, Loader2, Rocket, BookOpen, X, RotateCw, Square } from 'lucide-react';

interface HomeProps {
  state: ManagerState | null;
  onOpenSSH: () => void;
  onOpenConfig: (id: 'dsh-isolated' | 'napcat-local' | 'bridge-local') => void;
  onOpenWeb: (url: string, title: string) => void;  // 应用内打开官方界面（同一页面内）
  onRefresh: () => void;
}

type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'failed';

/** 按钮/状态完全由服务端的 phase 驱动（服务端用真实探活推进，不再靠"我们 spawn 过"来推断）。
 *  这里只做一步兜底：服务端说是 running、但进程和端口都没了（例如被任务管理器杀了），
 *  就别再显示"运行中"骗用户点「打开」。 */
function phaseOf(inst?: LocalInstance): Phase {
  if (!inst) return 'idle';
  const p = (inst.phase as Phase) || 'idle';
  if (p === 'running' && !inst.reachable && !inst.proc.running) return 'idle';
  return p;
}

const PHASE_TEXT: Record<Phase, string> = {
  idle: '未启动',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  failed: '启动失败',
};

/** 状态小字：尽量说清"现在在等什么"（等扫码 / 等就绪 / 失败原因） */
function footText(inst: LocalInstance | undefined, phase: Phase): string {
  if (!inst) return PHASE_TEXT[phase];
  if (phase === 'starting') {
    const s = Math.max(0, Math.round((inst.elapsedMs || 0) / 1000));
    return `启动中 ${s}s${inst.note ? ' · ' + inst.note : ' · 等待就绪'}`;
  }
  if (phase === 'stopping') return '停止中…';
  if (phase === 'failed') return `启动失败：${(inst.error || '见日志').slice(0, 60)}`;
  if (phase === 'running') {
    if (inst.kind === 'napcat' && !inst.loggedIn) return '已启动 · 等待 QQ 扫码登录';
    return inst.kind === 'bridge' ? '运行中' : '运行中 · 点击打开';
  }
  return '未启动';
}

function dotClass(phase: Phase): string {
  if (phase === 'running') return 'online';
  if (phase === 'starting' || phase === 'stopping') return 'loading';
  return 'offline';
}

const SLOGAN = 'One Chat, One Soul Companion';

/** 打字机循环：逐字蹦出 → 完整句停留 hold → 快速回到 0 重新蹦出（空屏不停留） */
function useTypewriterLoop(text: string, speed = 110, holdMs = 3200) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = (i: number) => {
      if (cancelled) return;
      setN(i);
      if (i >= text.length) {
        // 全句显示：停顿后再从头（先归零再立即开始，不在空屏停留）
        timer = setTimeout(() => { if (!cancelled) { setN(0); tick(1); } }, holdMs);
      } else {
        timer = setTimeout(() => tick(i + 1), speed);
      }
    };
    timer = setTimeout(() => tick(1), 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text, speed, holdMs]);
  return text.slice(0, n);
}

type SvcId = 'dsh-isolated' | 'napcat-local' | 'bridge-local';

export default function Home({ state, onOpenSSH, onOpenConfig, onOpenWeb, onRefresh }: HomeProps) {
  const [busy, setBusy] = useState<SvcId | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [allBusy, setAllBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const typed = useTypewriterLoop(SLOGAN);

  const inst = (id: SvcId) => state?.instances.find((i) => i.id === id);

  /** 统一动作入口：启动/停止/重启都走它，按钮 busy 只覆盖请求本身，
   *  之后的状态由服务端 phase（App 每 1.2~3 秒轮询）接管 —— 这样"启动中"会一直显示到真正就绪。 */
  const doAction = async (id: SvcId, action: 'start' | 'stop' | 'restart') => {
    setBusy(id); setActing(`${id}:${action}`); setMsg(null);
    try {
      const r = await instanceAction(id, action);
      const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
      setMsg(r.message ? `${label}：${r.message}` : `${label}已下发`);
    } catch { setMsg('操作失败：无法连接后端'); }
    finally { setBusy(null); setActing(null); onRefresh(); }
  };

  const act = (id: SvcId) => doAction(id, 'start');
  const actStop = (id: SvcId) => doAction(id, 'stop');
  const actRestart = (id: SvcId) => doAction(id, 'restart');

  /** 一键启动整套：NapCat → DSH → 桥（NapCat 首次需扫码 QQ）；后端会**逐步等到真正就绪**再走下一步 */
  const actAll = async () => {
    setAllBusy(true); setMsg(null);
    try {
      const r = await startAllInstances();
      const lines = (r.steps ?? []).map((s) => {
        const secs = s.elapsedMs ? `${(s.elapsedMs / 1000).toFixed(1)}s` : '';
        return `${s.success ? '✓' : '✗'} ${s.id}：${s.message}${secs ? '（' + secs + '）' : ''}`;
      }).join('\n');
      setMsg(`${r.success ? '整套启动成功' : '整套启动未完成'}\n${lines}`);
    } catch { setMsg('一键启动失败：无法连接后端'); }
    finally { setAllBusy(false); onRefresh(); }
  };

  const svcs: Array<{ id: SvcId; label: string; sub: string; openTitle: string }> = [
    { id: 'napcat-local', label: 'NapCat', sub: 'QQ 网关', openTitle: 'NapCat 官方界面' },
    { id: 'dsh-isolated', label: 'DeepSeek Harness', sub: '内置大脑 · 独立端口', openTitle: 'DeepSeek Harness' },
    { id: 'bridge-local', label: 'Core', sub: '内置核心层', openTitle: '功能配置' },
  ];

  const sshConn = state?.connected;

  return (
    <div className="launcher">
      {msg && <div className="toast" onClick={() => setMsg(null)}>{msg}</div>}

      {/* 【2026-09-12】主人要求：Home 页标题悬停不要弹说明（去掉原生 title 提示框） */}
      <div className="launcher-title">
        <div className="typewriter">{typed}</div>
        <div className="launcher-tag">MoonBot · 一键配置本地和服务器的拟人 QQ Bot</div>
      </div>

      {/* 新手教程：副标题下方、一键启动上方，居中窄按钮 */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <button className="btn btn-primary tutorial-btn" onClick={() => setTutorialOpen(true)} title="第一次使用？先看这里">
          <BookOpen size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> 新手教程
        </button>
      </div>

      {/* 【2026-09-12】安装位置体检：装在 Program Files / 同步盘时提前提醒（记忆库写在安装目录里，
          这类位置会写不进去或同步冲突）——"拿给别人安装"最容易踩的两个坑。 */}
      {(state?.warnings?.length ?? 0) > 0 && (
        <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left' }}>
          {(state?.warnings ?? []).map((w, i) => <div key={i}>⚠️ {w}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <button className="btn btn-primary" style={{ padding: '8px 26px', fontSize: 15, borderRadius: 12 }} disabled={allBusy} onClick={actAll} data-genui-primary-action>
          {allBusy ? <Loader2 size={16} className="spin" style={{ verticalAlign: -2, marginRight: 8 }} /> : <Rocket size={16} style={{ verticalAlign: -2, marginRight: 8 }} />}
          {allBusy ? '正在一键启动整套…' : '一键启动整套（NapCat → DSH → 桥）'}
        </button>
      </div>

      <div className="tiles grid2x2">
        {svcs.map((t) => {
          const i = inst(t.id);
          const phase = phaseOf(i);
          // QQ-Bridge「打开」直接进配置页（管理端已并入主界面 BridgeConfig，不再打开旧控制台）
          const handleOpen = () => {
            if (t.id === 'bridge-local') onOpenConfig('bridge-local');
            else if (i?.url) onOpenWeb(i.url, t.openTitle);
          };
          return (
            <div className="big-tile" key={t.id}>
              <div className="big-tile-head">
                <span className="big-name">{t.label}</span>
                <span className="big-sub">{t.sub}</span>
              </div>
              <div className="big-actions">
                {phase === 'starting' ? (
                  <button className="btn btn-primary btn-block" disabled>
                    <Loader2 size={16} className="spin" /> 启动中…
                  </button>
                ) : phase === 'stopping' ? (
                  <button className="btn btn-primary btn-block" disabled>
                    <Loader2 size={16} className="spin" /> 停止中…
                  </button>
                ) : phase === 'running' ? (
                  <>
                    <button className="btn btn-primary btn-block" onClick={handleOpen}>打开</button>
                    <button
                      className="icon-btn"
                      title="重启"
                      disabled={busy === t.id}
                      onClick={() => actRestart(t.id)}
                    >{acting === `${t.id}:restart` ? <Loader2 size={16} className="spin" /> : <RotateCw size={16} />}</button>
                    <button
                      className="icon-btn"
                      title={t.id === 'bridge-local' ? '终止' : '停止'}
                      disabled={busy === t.id}
                      onClick={() => actStop(t.id)}
                    >{acting === `${t.id}:stop` ? <Loader2 size={16} className="spin" /> : <Square size={15} />}</button>
                  </>
                ) : (
                  <button className="btn btn-primary btn-block" disabled={busy === t.id} onClick={() => act(t.id)}>
                    {busy === t.id ? <><Loader2 size={16} className="spin" /> 启动中…</> : phase === 'failed' ? '重试启动' : '启动'}
                  </button>
                )}
                <button className="icon-btn" title="配置" onClick={() => onOpenConfig(t.id)}><Settings size={17} /></button>
              </div>
              <div className="big-foot" title={phase === 'failed' ? (i?.error || '') : (i?.note || '')}>
                <span className={`status-dot ${dotClass(phase)}`} />
                <span>{footText(i, phase)}</span>
              </div>
            </div>
          );
        })}

        <div className="big-tile ssh-tile">
          <div className="big-tile-head">
            <span className="big-name">SSH 配置</span>
            <span className="big-sub">远程服务器 · 隧道</span>
          </div>
          <div className="big-actions">
            <button className="btn btn-soft btn-block" onClick={onOpenSSH}>进入</button>
          </div>
          <div className="big-foot">
            <span className={`status-dot ${sshConn ? 'online' : 'offline'}`} />
            <span>{sshConn ? '远程已连接' : '未连接远程'}</span>
          </div>
        </div>
      </div>

      <div className="launcher-footer">© 2026 AbyssalQuill · MoonBot · 一键配置本地与服务器的拟人 QQ Bot</div>

      {tutorialOpen && (
        <div className="help-overlay" style={{ zIndex: 120 }} onClick={() => setTutorialOpen(false)}>
          <div className="help-panel tutorial-panel" onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><BookOpen size={16} /> 新手教程 · 第一次启动前</span>
              <button className="icon-btn" onClick={() => setTutorialOpen(false)}><X size={16} /></button>
            </div>
            <div className="tutorial-body">
              <TutorialSection title="① 启动前需要准备的两件事">
                <ol>
                  <li><b>机器人 QQ 扫码登录</b>：装好 MoonBot 后点首页 NapCat 卡「启动」，会弹出二维码/登录窗口，用机器人 QQ 扫一下（登录态只存在本机，不随安装包分发）。</li>
                  <li><b>给隔离 DSH 填模型密钥</b>：DeepSeek Harness 卡 → 配置 → 把「隔离 home」下的 <code>.credentials.yaml</code> 里写上你的 <code>DEEPSEEK_API_KEY: xxx</code>（也可在功能配置页选「自动探测/官方 DeepSeek」并在 DSH 里配好）。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="② 正确的启动顺序">
                <ol>
                  <li>先 <b>NapCat</b>：登录后它自己会写 OneBot 配置（HTTP 3000 / WS 3001，token=truefriend）。</li>
                  <li>再 <b>DeepSeek Harness</b>：等它变「运行中」。</li>
                  <li>最后 <b>QQ-Bridge</b>（桥）：它把 QQ 消息转给 DSH 的 AI 处理。</li>
                  <li>也可以直接点上方 <b>「一键启动整套」</b>，程序会按 NapCat → DSH → 桥 的顺序自动拉起（NapCat 首次仍需扫码）。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="③ SSH 远程服务器怎么配">
                <ol>
                  <li>首页点 <b>SSH 配置</b> 卡 → 「添加服务器」填：名称、主机 IP、端口、用户名（如 <code>root</code>）、密码或密钥。</li>
                  <li>连接成功后会自动开隧道：NapCat 6099→13000、DSH 3080→13080、Bridge 3100→13100，学习与用量页会自动切到远端那套。</li>
                  <li>想用服务器跑整套而本机只当控制台：在 SSH 配置里连上服务器后，把本机三个实例停掉即可，学习/画像页会走远端。</li>
                  <li>每台服务器行还有「同步」（把本地桥代码推上去/拉下来）和「清整套」（删除远端整套并备份）按钮，详见 SSH 页说明。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="④ 常用设置入口">
                <ul>
                  <li><b>NapCat / DSH / Bridge</b> 三张卡右下角齿轮 = 各自的启动配置；<b>QQ-Bridge 卡</b>点开直接进「功能配置」页。</li>
                  <li>功能配置页：<b>常用设置</b>（模型/连接/白名单/主动闲聊）、<b>工具与规则</b>（MCP 工具开关）、<b>人设与发言规则</b>（可上传 .md 或从角色库导入）、<b>JSON 进阶</b>。</li>
                  <li>桥跑起来后，右上角「群友画像 / 学习与用量」需要聊一阵子才会慢慢有数据。</li>
                </ul>
              </TutorialSection>
              <TutorialSection title="⑤ 忘了在哪？">
                <p style={{ margin: 0 }}>
                  所有端口：管理端 1921 · NapCat 6099/3000/3001 · 隔离 DSH {instPortOf(state, 'dsh-isolated')} · 桥 {instPortOf(state, 'bridge-local')}。任一页按 <b>Esc</b> 返回首页。
                </p>
              </TutorialSection>
            </div>
            <div className="help-foot">
              <button className="btn btn-sm" onClick={() => setTutorialOpen(false)}>知道了，开始配置</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TutorialSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="tutorial-sec">
      <div className="tutorial-sec-title">{title}</div>
      <div className="tutorial-sec-body">{children}</div>
    </div>
  );
}

function instPortOf(state: ManagerState | null, id: string): string {
  const i = state?.instances?.find((x) => x.id === id);
  if (!i) return '—';
  try { return new URL(i.url || '').port || '—'; } catch { return '—'; }
}
