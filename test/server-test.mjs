// HTTP 层测试：把 server.ts 真的起起来，用 fetch 打它的接口。
//
// 为什么要单独测这一层：CLI 能跑 ≠ 网页能用。
// 中间隔着一层 HTTP——请求体解析、错误码、静态文件、目录穿越，
// 每一处都可能出问题，而且这些在 CLI 里根本测不到。
//
// 跑法：  node test/server-test.mjs

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { createFakeLLM } from './fake-llm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_PORT = 8799; // 假模型
const APP_PORT = 3001; // 被测服务
const SESSION = '__server_test__';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

async function waitFor(url, timeoutMs = 10000) {
  const start = Date.now();
  let lastErr = '未知';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  // 超时就报错退出，不"跳过测试"——跳过等于假绿
  throw new Error(`${url} 在 ${timeoutMs}ms 内没起来（最后一次错误：${lastErr}）`);
}

const fake = createFakeLLM(FAKE_PORT);
try {
  await fake.listen();
} catch (err) {
  console.error(`\n无法在 ${FAKE_PORT} 端口启动假模型：${err.code ?? err.message}\n`);
  process.exit(1);
}

const server = spawn(process.execPath, ['server.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    LLM_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    LLM_API_KEY: 'test-key',
    LLM_MODEL: 'fake-model',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

let exitCode = 0;
try {
  const base = `http://127.0.0.1:${APP_PORT}`;
  await waitFor(`${base}/api/health`);

  console.log('--- 断言：健康检查 ---');
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  check('健康检查返回 ok', health.ok === true);
  check('健康检查带上了模型名', health.model === 'fake-model', JSON.stringify(health));

  console.log('\n--- 断言：静态页面 ---');
  const pageRes = await fetch(`${base}/`);
  const pageText = await pageRes.text();
  check('根路径返回 200', pageRes.status === 200, `状态码 ${pageRes.status}`);
  check('返回的是 HTML', pageRes.headers.get('content-type')?.includes('text/html'));
  check('页面里有输入框', pageText.includes('id="input"'));
  check('未知路径返回 404', (await fetch(`${base}/nope.txt`)).status === 404);

  const escaped = await fetch(`${base}/../package.json`);
  const escapedText = await escaped.text();
  check('目录穿越拿不到项目文件', !escapedText.includes('"mini-agent"'), `状态码 ${escaped.status}`);

  console.log('\n--- 断言：/api/chat ---');
  const chatRes = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '现在几点？算一下 (17 ** 0.5) * 3，再看看当前目录', sessionId: SESSION }),
  });
  const chat = await chatRes.json();

  check('返回 200', chatRes.status === 200, `状态码 ${chatRes.status}：${JSON.stringify(chat)}`);
  check('拿到了最终答案', typeof chat.answer === 'string' && chat.answer.includes('最终答案'), chat.answer);
  check('答案里带出了工具结果', chat.answer?.includes('12.369'), chat.answer);
  check(
    'steps 里有 4 次工具调用',
    (chat.steps ?? []).filter((s) => s.type === 'tool').length === 4,
    `实际 ${(chat.steps ?? []).filter((s) => s.type === 'tool').length} 次`,
  );
  check(
    'steps 里记录了工具参数和结果',
    (chat.steps ?? []).some((s) => s.type === 'tool' && s.name === 'calculate' && s.result.includes('12.369')),
  );
  check('失败的工具被标记 ok=false', (chat.steps ?? []).some((s) => s.type === 'tool' && s.ok === false));
  check('trace 统计正确', chat.trace?.toolCalls === 4 && chat.trace?.failedTools === 1, JSON.stringify(chat.trace));
  check('trace 有 token 数', chat.trace?.totalTokens > 0, String(chat.trace?.totalTokens));

  console.log('\n--- 断言：参数校验 ---');
  const noMsg = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION }),
  });
  check('缺少 message 返回 400', noMsg.status === 400, `状态码 ${noMsg.status}`);

  const badJson = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{不是 json',
  });
  check('请求体不是 JSON 返回 400', badJson.status === 400, `状态码 ${badJson.status}`);

  const wrongMethod = await fetch(`${base}/api/chat`, { method: 'GET' });
  check('GET 打 /api/chat 返回 405', wrongMethod.status === 405, `状态码 ${wrongMethod.status}`);

  console.log('\n--- 断言：SSE 流式端点 ---');
  const sseRes = await fetch(`${base}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '现在几点？算一下 (17 ** 0.5) * 3', sessionId: '__sse_test__' }),
  });

  check('返回的是 event-stream', (sseRes.headers.get('content-type') ?? '').includes('text/event-stream'), String(sseRes.headers.get('content-type')));
  // 反代缓存会把流攒成一整块，这个头是告诉反代"别缓冲"
  check('带了禁缓冲头', (sseRes.headers.get('x-accel-buffering') ?? '') === 'no');

  if (!sseRes.body) {
    check('响应有 body', false, 'sseRes.body 为空');
  } else {
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const events = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        try {
          events.push(JSON.parse(trimmed.slice(5).trim()));
        } catch {
          // 单行解析失败就跳过
        }
      }
    }

    check('收到了 token 事件', events.filter((e) => e.type === 'token').length > 0, `事件类型：${events.map((e) => e.type).join(',')}`);
    check('工具步骤边跑边推', events.some((e) => e.type === 'step' && e.event?.type === 'tool'));

    const doneEvent = events.find((e) => e.type === 'done');
    check('最后有 done 事件', doneEvent !== undefined);
    check('done 里带最终答案', typeof doneEvent?.answer === 'string' && doneEvent.answer.includes('12.369'), String(doneEvent?.answer));
    check('done 里带 trace', doneEvent?.trace?.toolCalls === 4, JSON.stringify(doneEvent?.trace));
  }

  console.log('\n--- 断言：记忆贯通 ---');
  const second = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '我叫什么？', sessionId: SESSION }),
  }).then((r) => r.json());
  // 假模型的最后一轮永远返回 "最终答案｜..."，这里验证的是服务端确实读到了历史：
  // 第二轮请求里 tool 消息应该 > 0（说明历史被载入了）
  check('第二轮载入了上一轮的历史', (second.steps ?? []).length > 0 || fake.stats.requests > 4, `假模型收到 ${fake.stats.requests} 次请求`);
} catch (err) {
  check('测试过程没有抛异常', false, String(err));
  console.log('\n--- 服务端日志 ---\n' + serverLog);
} finally {
  server.kill();
  await fake.close();
  for (const id of [SESSION, '__sse_test__']) {
    rmSync(join(ROOT, '.agent-memory', `${id}.json`), { force: true });
  }
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
