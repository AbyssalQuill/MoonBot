// html-text.js 实机自测：抓几个真页面，看抽出来的标题/正文是不是人话。
// 用法: node tools/test-html-text.mjs [url...]
import { extractReadableHtml } from '../src/lib/html-text.js';

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://zh.wikipedia.org/wiki/%E9%B2%B8%E9%B1%BC',
      'https://www.bilibili.com/video/BV1GJ411x7h7',
      'https://news.ycombinator.com/',
    ];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

for (const u of urls) {
  console.log('\n' + '='.repeat(70));
  console.log(u);
  try {
    const res = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    const doc = extractReadableHtml(html, { url: u });
    console.log('http       :', res.status, `html=${html.length} 字节`);
    console.log('title      :', doc.title);
    console.log('description:', (doc.description || '(空)').slice(0, 160));
    console.log('image      :', doc.image || '(空)');
    console.log('extracted  :', doc.extracted || '(body)');
    console.log('textChars  :', doc.textChars, 'truncated=', doc.truncated);
    console.log('links      :', doc.links ? doc.links.length : 0);
    console.log('--- 正文前 700 字 ---');
    console.log(doc.text.slice(0, 700));
  } catch (e) {
    console.log('  ERROR', e.message);
  }
}
