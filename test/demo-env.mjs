// 本地演示环境：假模型 + 指向它的 server。
//
// 用途：不花 token、不配 key，就能打开浏览器看界面、调样式。
// 跑法：  node test/demo-env.mjs      然后打开 http://localhost:3000
//
// 注意它用的是假模型，回答内容是写死的脚本，只用来验证"界面能不能用"，
// 不能用来判断 agent 的真实表现。

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeLLM } from './fake-llm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_PORT = 8799;
const APP_PORT = Number(process.env.PORT ?? 3000);

const fake = createFakeLLM(FAKE_PORT);
try {
  await fake.listen();
} catch (err) {
  console.error(`无法在 ${FAKE_PORT} 端口启动假模型：${err.code ?? err.message}`);
  console.error('固定端口、不自动换端口。请先释放该端口。');
  process.exit(1);
}
console.log(`假模型已启动：http://127.0.0.1:${FAKE_PORT}/v1`);

const server = spawn(process.execPath, ['server.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    LLM_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    LLM_API_KEY: 'demo-key',
    LLM_MODEL: 'fake-model',
  },
  stdio: 'inherit',
});

async function stop() {
  server.kill();
  await fake.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`演示环境就绪 → 打开 http://localhost:${APP_PORT}\n`);
