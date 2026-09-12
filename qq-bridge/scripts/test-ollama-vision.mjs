// 测试 Ollama qwen2.5vl:3b 视觉模型是否能识别图片
// 用法：node test-ollama-vision.mjs <图片路径>
import fs from 'node:fs';

const imgPath = process.argv[2];
if (!imgPath || !fs.existsSync(imgPath)) {
  console.error('用法: node test-ollama-vision.mjs <图片路径>');
  process.exit(1);
}
const base64 = fs.readFileSync(imgPath).toString('base64');

const resp = await fetch('http://127.0.0.1:11434/api/generate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen2.5vl:3b',
    prompt: '请客观描述这张图片的可见内容：画面主体、场景、构图、出现的文字。',
    images: [base64],
    stream: false,
  }),
});
const json = await resp.json();
console.log('=== 识别结果 ===');
console.log(json.response ?? JSON.stringify(json, null, 2));
process.exit(0);
