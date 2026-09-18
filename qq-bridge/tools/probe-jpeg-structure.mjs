/* 逐字节看两张封面的 **JPEG 结构**，找出"手机不渲染"的真实差别。
 * 只看魔数是不够的：JPEG 里还有 基线/渐进（SOF0 vs SOF2）、分量数（3=YCbCr / 4=CMYK）、
 * 是否带 EXIF、尺寸 —— 手机端的解码器对这些比 PC 挑剔得多。
 *
 * 用法：node probe-jpeg-structure.mjs
 */
const TARGETS = [
  ['✅ QQ音乐（真机确认能显示）', 'https://y.qq.com/music/photo_new/T002R300x300M000004fXSyj3bWTMN.jpg'],
  ['❌ 网易云 type=jpg（手机没图）', 'https://p1.music.126.net/fQOLZwjHwUqLAQs3b_yzUg==/109951173276565105.jpg?imageView=1&thumbnail=300x300&type=jpg'],
  ['❌ 网易云 param=300y300（手机没图）', 'https://p1.music.126.net/fQOLZwjHwUqLAQs3b_yzUg==/109951173276565105.jpg?param=300y300'],
];

const MARKERS = {
  0xc0: 'SOF0 基线 DCT', 0xc1: 'SOF1 扩展顺序', 0xc2: 'SOF2 **渐进式**', 0xc3: 'SOF3 无损',
  0xc4: 'DHT', 0xc8: 'JPG', 0xc9: 'SOF9', 0xca: 'SOF10 **渐进式算术**', 0xdb: 'DQT',
  0xda: 'SOS', 0xd9: 'EOI', 0xe0: 'APP0 (JFIF)', 0xe1: 'APP1 (EXIF)', 0xe2: 'APP2',
  0xed: 'APP13 (Photoshop/IPTC)', 0xee: 'APP14 (Adobe)', 0xfe: 'COM 注释'
};

function parseJpeg(buf) {
  const out = { markers: [], sof: null, components: null, size: buf.length, adobe: null, exif: false, icc: false, comment: false };
  if (buf.subarray(0, 2).toString('hex') !== 'ffd8') return { ...out, error: '不是 JPEG' };
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xda) { out.markers.push('SOS'); break; }
    const len = buf.readUInt16BE(i + 2);
    const name = MARKERS[m] || `0x${m.toString(16)}`;
    if (!out.markers.includes(name)) out.markers.push(name);
    if (m === 0xe1) out.exif = true;
    if (m === 0xe2) out.icc = true;
    if (m === 0xfe) out.comment = true;
    if (m === 0xee) out.adobe = buf.subarray(i + 4, i + 4 + Math.min(len - 2, 12)).toString('hex');
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      out.sof = name;
      out.height = buf.readUInt16BE(i + 5);
      out.width = buf.readUInt16BE(i + 7);
      out.components = buf[i + 9];
    }
    i += 2 + len;
  }
  return out;
}

for (const [label, url] of TARGETS) {
  console.log('='.repeat(96));
  console.log(label);
  console.log(url);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const r = parseJpeg(buf);
    console.log(`  HTTP ${res.status}  ${buf.length} 字节  magic=${buf.subarray(0, 3).toString('hex')}`);
    console.log(`  帧类型    : ${r.sof ?? '?'}   ${r.width ?? '?'}x${r.height ?? '?'}   分量数=${r.components ?? '?'}` +
      (r.components === 4 ? '  ← **CMYK**，很多手机解码器不认' : ''));
    console.log(`  APP 段    : EXIF=${r.exif} ICC=${r.icc} COM=${r.comment} Adobe=${r.adobe ?? '无'}`);
    console.log(`  段顺序    : ${r.markers.join(' → ')}`);
  } catch (error) {
    console.log('  ERR', error?.message ?? error);
  }
}
