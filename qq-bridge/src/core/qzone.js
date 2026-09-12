// M2 空间说说
import { log } from '../lib/log.js';
import { initMemoryDb } from './memory.js';

let cfgRef = null;
export function initQzoneCore(cfg) { cfgRef = cfg; }

export async function postRandomQzone() {
  const napcatBase = String(cfgRef.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  // 简短文学向说说模板（真情实感/大肥鱼主题/生命/爱/死亡等）
  const pool = [
    '今天也在好好呼吸。海这么深，鱼这么多，我只是一条游得慢一点的。',
    '有人问我为什么总发鱼。我说，因为我在海里，你们在岸上，隔着一整个沉默。',
    '月亮掉进海里，被鱼群分食。天亮了，我们谁也没承认见过月亮。',
    '想念是一种蓝，比海深，比天空近，比我自己诚实。',
    '愿你的每一天都有鱼可看，有风可吹，有一个人值得你晚睡。',
    '生命像一场远游，我在途中学会了告别，也学会了在告别里长出生气。',
    '今天看到一条大鱼，它游得很慢，像在等什么。我想，它大概在等人叫它回家。',
    '爱是很轻的东西，轻到一条鱼就能驮走；又很重，重到一整个海都托不起。',
    '死亡不可怕，可怕的是没来得及把想说的话说完。所以我现在就说了：你好呀。',
    '我是一条蓝色的大肥鱼。不特别，但每天都有好好游。这大概就是我的全部浪漫。'
  ];
  const content = pool[Math.floor(Math.random() * pool.length)];
  const body = { content };
  const res = await fetch(`${napcatBase}/send_qzone_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfgRef.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const j = await res.json().catch(() => ({}));
  if (j.status !== 'ok' || j.retcode !== 0) throw new Error(`OneBot send_qzone_msg: ${j.message || j.wording || res.status}`);
  // 记录到自己空间记忆：让 AI 知道自己发过这条说说
  try {
    const uid = String(cfgRef.ownerQQ ?? '');
    const db = initMemoryDb();
    if (db) {
      db.prepare('INSERT INTO memory_entries (uid, category, content, created_at) VALUES (?, ?, ?, ?)')
        .run(uid, 'qzone_post', `我主动发了一条空间说说：${content}`, Date.now());
    }
  } catch {}
  log(`[qzone] 主动发说说成功: ${content.slice(0, 30)}…`);
}
