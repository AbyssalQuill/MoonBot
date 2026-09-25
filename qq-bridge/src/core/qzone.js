// M2 空间说说
import { log } from '../lib/log.js';
import { initMemoryDb } from './memory.js';

let cfgRef = null;
export function initQzoneCore(cfg) { cfgRef = cfg; }

export async function postRandomQzone() {
  const napcatBase = String(cfgRef.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  // 兜底说说池（角色无关的短句，情绪/日常向）。角色人设由 persona 决定，这里只保证
  // 「模型没给正文时也发得出一条像人写的说说」，不与任何具体角色绑定。
  const pool = [
    '今天也在好好过。日子这么长，事情这么多，我只是一件一件慢慢做。',
    '有人问我为什么总在这种时候说话。我说，因为安静的时候，人容易想起没说完的事。',
    '灯关了以后，房间比白天更大。有些话就是在这种时候想清楚的。',
    '想念是一种很轻的东西，轻到一阵风就能吹动；又很重，重到一整天都放不下。',
    '愿你每天都有事可做，有人可说，有一件小事值得你晚睡。',
    '时间像一场远游，我在途中学会了告别，也学会了在告别里长出生气。',
    '今天走得很慢，像在等什么。后来想明白了：我只是不想那么快到家。',
    '在意一个人是很轻的事，轻到一句话就能说明；又很重，重到一整年都说不完。',
    '错过不可怕，可怕的是没来得及把想说的话说完。所以我现在就说了：你好呀。',
    '我就是我，没什么特别，但每天都过得还算认真。这大概就是我的全部浪漫。'
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
