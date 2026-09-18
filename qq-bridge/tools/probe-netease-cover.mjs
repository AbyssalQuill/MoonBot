/* 实测网易云封面的**各种 URL 形态**到底返回什么（字节级）。
 * 判定只看头 3 字节魔数：ffd8ff=JPEG / 89504e=PNG —— 扩展名和 content-type 都不可信
 * （网易云写着 .jpg、报 image/jpg，字节却是 PNG）。
 */
const P = 'https://p1.music.126.net/fQOLZwjHwUqLAQs3b_yzUg==/109951173276565105.jpg';
const Q = 'https://p2.music.126.net/qGLgEziAdCXsk9SbhiYjbw==/109951173214324887.jpg';

const forms = [
  ['原图（无参数）', `${P}`],
  ['?param=300y300', `${P}?param=300y300`],
  ['?imageView=1&thumbnail=300x300', `${P}?imageView=1&thumbnail=300x300`],
  ['?imageView=1&thumbnail=300x300&type=jpg', `${P}?imageView=1&thumbnail=300x300&type=jpg`],
  ['只加 ?type=jpg', `${P}?type=jpg`],
  ['?type=jpg&imageView=1&thumbnail=300x300', `${P}?type=jpg&imageView=1&thumbnail=300x300`],
  ['== 转义 %3D%3D + type=jpg', `${P.replace('==', '%3D%3D')}?imageView=1&thumbnail=300x300&type=jpg`],
  ['第二首 ?param=300y300', `${Q}?param=300y300`],
  ['第二首 ?type=jpg', `${Q}?type=jpg`],
];

const NAME = { ffd8ff: 'JPEG ✅', '89504e': 'PNG  ❌', '474946': 'GIF', '52494646': 'WEBP' };

for (const [label, url] of forms) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const magic = buf.subarray(0, 3).toString('hex');
    console.log(
      String(label).padEnd(40),
      String(res.status).padStart(4),
      (NAME[magic] || `magic=${magic}`).padEnd(10),
      String(buf.length).padStart(10),
      String(res.headers.get('content-type') || '').slice(0, 24)
    );
  } catch (error) {
    console.log(String(label).padEnd(40), '  ERR', String(error?.message ?? error).slice(0, 60));
  }
}
