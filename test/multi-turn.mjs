// 多轮对话测试：验证第二轮的请求里，确实带上了第一轮的上下文。
//
// 这个测试比它看起来重要：记忆功能最容易出的 bug 就是
// 「存了但没传回去」——文件里明明有历史，模型却不知道，
// 用户看到的表现是「它怎么忘了刚才说的话」。
//
// 跑法：  node test/multi-turn.mjs

import { createServer } from 'node:http';

const PORT = 8798;
const seenRequests = [];

// 注意：llm.ts 里的配置是在模块加载时读取环境变量的，
// 所以必须先设好变量，再动态 import——静态 import 会被提升到最前面执行。
process.env.LLM_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'fake-model';

const { runAgent } = await import('../src/agent.ts');
const { tools } = await import('../src/tools.ts');
const { saveSession, loadSession } = await import('../src/memory.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

// 这个假模型不做工具调用，只回一句话——把测试聚焦在"上下文传递"上
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  seenRequests.push(payload.messages);

  const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
  const text = `收到：${lastUser?.content ?? ''}`;
  const mid = Math.floor(text.length / 2);

  // agent 现在总是用流式，所以这里也得按 SSE 发
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (text.slice(0, mid)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, mid) } }] })}\n\n`);
  if (text.slice(mid)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(mid) } }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
} catch (err) {
  console.error(`\n无法在 ${PORT} 端口启动假模型服务：${err.code ?? err.message}`);
  console.error('固定端口、不降级，请先释放该端口。\n');
  process.exit(1);
}

const first = await runAgent('我叫老板', tools, { verbose: false });
const second = await runAgent('我叫什么？', tools, { history: first.messages, verbose: false });

server.close();

console.log('--- 断言：多轮上下文 ---');
check('第一轮返回了答案', first.answer === '收到：我叫老板', first.answer);
check(
  '第一轮历史是 3 条（system + user + assistant）',
  first.messages.length === 3,
  `实际 ${first.messages.length} 条`,
);
check(
  '第二轮历史累积到 5 条',
  second.messages.length === 5,
  `实际 ${second.messages.length} 条：${second.messages.map((m) => m.role).join(',')}`,
);

const secondRequest = seenRequests[1] ?? [];
check(
  '第二轮请求里带上了第一轮的提问',
  secondRequest.some((m) => m.content === '我叫老板'),
  `实际内容：${secondRequest.map((m) => `${m.role}:${m.content}`).join(' | ')}`,
);
check(
  '第二轮请求里带上了第一轮的回答',
  secondRequest.some((m) => m.content === '收到：我叫老板'),
);
check(
  'system 提示只有一条（没被历史重复注入）',
  secondRequest.filter((m) => m.role === 'system').length === 1,
);

console.log('\n--- 断言：记忆落盘再读回 ---');
const SESSION = '__multi_turn_test__';
saveSession(SESSION, second.messages);
const restored = loadSession(SESSION);
const expectedCount = second.messages.filter((m) => m.role !== 'system').length;
check(
  '落盘再读回，条数一致（system 按设计不落盘）',
  restored.length === expectedCount,
  `${restored.length} vs ${expectedCount}`,
);
check('读回后第一条用户消息还在', restored[0]?.content === '我叫老板');

const { rmSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.agent-memory', `${SESSION}.json`), { force: true });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
