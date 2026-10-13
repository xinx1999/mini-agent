// HTTP 服务：把 agent 包成一个网页能调的接口。
//
// 这里刻意不引入任何 web 框架——Node 内置的 http 模块够用。
// 目的是让"agent 怎么变成产品"这件事保持透明：
// 说到底无非是把 runAgent 的输入输出接到 HTTP 上。
//
// 启动：  node --env-file=.env server.ts
// 端口：  PORT 环境变量，默认 3000

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './src/agent.ts';
import type { StepEvent } from './src/agent.ts';
import { tools } from './src/tools.ts';
import { loadSession, saveSession } from './src/memory.ts';

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface ChatHooks {
  onStep?: (event: StepEvent) => void;
  onToken?: (text: string) => void;
}

/** 跑一轮对话。JSON 端点和 SSE 端点共用它，免得两套逻辑慢慢走偏 */
async function runChat(message: string, sessionId: string, hooks: ChatHooks) {
  const steps: StepEvent[] = [];
  const history = loadSession(sessionId);

  const result = await runAgent(message, tools, {
    history,
    verbose: false, // 网页端不需要往服务端控制台刷轨迹
    onStep: (event) => {
      steps.push(event);
      hooks.onStep?.(event);
    },
    onToken: hooks.onToken,
  });

  saveSession(sessionId, result.messages);

  return {
    answer: result.answer,
    steps,
    trace: {
      llmCalls: result.trace.llmCalls,
      toolCalls: result.trace.toolCalls,
      failedTools: result.trace.failedTools,
      totalTokens: result.trace.totalTokens,
      totalMs: result.trace.totalMs,
    },
  };
}

/** 解析并校验请求体。出错时错误响应已经写回去了，返回 null 让调用方直接收手 */
async function parseChatRequest(req: IncomingMessage, res: ServerResponse) {
  let payload: any;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' });
    return null;
  }

  const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    sendJson(res, 400, { error: 'message 不能为空' });
    return null;
  }

  const sessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId ? payload.sessionId : 'web';

  return { message, sessionId };
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await parseChatRequest(req, res);
  if (!parsed) return;

  try {
    const result = await runChat(parsed.message, parsed.sessionId, {});
    sendJson(res, 200, result);
  } catch (err) {
    // 把「收到的原文」原样交给前端，不替用户猜原因
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** 流式端点：SSE。文本边生成边推给前端，不用等整段答完 */
async function handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await parseChatRequest(req, res);
  if (!parsed) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // 关掉反代的响应缓冲，否则流会被攒成一整块才吐出来
    'X-Accel-Buffering': 'no',
  });

  const send = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runChat(parsed.message, parsed.sessionId, {
      onStep: (event) => send({ type: 'step', event }),
      onToken: (text) => send({ type: 'token', text }),
    });
    send({ type: 'done', ...result });
  } catch (err) {
    send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    res.end();
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = join(WEB_DIR, normalize(rel));

  // 防目录穿越：拼出来的路径必须还在 web/ 里面
  if (!full.startsWith(WEB_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }

  try {
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到这个文件');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/chat' || url.pathname === '/api/chat/stream') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '这个接口只接受 POST' });
      return;
    }
    if (url.pathname === '/api/chat/stream') {
      void handleChatStream(req, res);
    } else {
      void handleChat(req, res);
    }
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, model: process.env.LLM_MODEL ?? '(未配置)' });
    return;
  }

  void serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`\nagent 网页版已启动：http://localhost:${PORT}`);
  console.log(`当前模型：${process.env.LLM_MODEL ?? '(未配置，请检查 .env)'}\n`);
});
