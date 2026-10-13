// 和模型通信的唯一出口。
//
// 拆成单独一个文件，是为了让 agent.ts 里只剩下"循环逻辑"本身——
// 这样你读核心代码时，不会被 HTTP 细节打断。

import type { Message, ToolSchema, LLMResponse, TokenUsage, ToolCall } from './types.ts';

// 配置全部走环境变量，换模型不用改一行代码。
const BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1';
const API_KEY = process.env.LLM_API_KEY ?? '';
const MODEL = process.env.LLM_MODEL ?? 'deepseek-chat';

/** 流式过程中的一个事件 */
export interface StreamEvent {
  type: 'content' | 'done';
  /** content 事件里新到的一段文本 */
  text?: string;
  usage?: TokenUsage;
  /** done 事件带上完整工具调用列表；没有工具调用时为 undefined */
  toolCalls?: ToolCall[];
}

function requireKey(): void {
  if (!API_KEY) {
    throw new Error(
      '缺少 LLM_API_KEY。\n' +
        '  做法：cp .env.example .env 然后填上 key，用 npm start 启动；\n' +
        '  或者直接设环境变量后运行 node index.ts',
    );
  }
}

/**
 * 流式调用模型。
 *
 * 流式下有两个坑，都得认真处理：
 *
 * 1. **SSE 是按行到达的**，一个网络 chunk 的边界可能切在 JSON 中间。
 *    所以必须自己缓冲，只处理完整的行，剩下的留给下一次。
 *
 * 2. **`tool_calls` 的 `arguments` 是分片到达的**，而且多个并发调用靠
 *    `index` 区分。必须按 index 累积拼接——漏掉一片就是坏 JSON。
 *    `name` 同样可能分片，所以也是拼接而不是赋值。
 */
/** 哪些状态码值得重试：429 限流、408 超时、5xx 服务端错误 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/**
 * 指数退避 + 抖动。
 * 指数退避：给上游恢复的时间；抖动：避免多个客户端同一时刻一起重试
 * （否则会把刚恢复的服务再次打挂）。
 */
export function computeBackoff(attempt: number, baseMs = 800): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  const jitter = exponential * 0.25 * Math.random();
  return Math.round(Math.min(exponential + jitter, 30000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; status?: number }) => void;
}

/**
 * 带重试的 fetch。**只在连接阶段重试。**
 *
 * 为什么不再往上一层：一旦开始读响应体，重试就没有意义了——
 * 前面已经 yield 出去的内容收不回来，用户会看到重复的半截回答。
 * 所以读流阶段的错误只能抛出去，交给调用方决定怎么呈现。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const { maxAttempts = 3, baseDelayMs = 800, onRetry } = options;

  let lastStatus: number | undefined;
  let lastBody = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);

      if (res.ok || !isRetryableStatus(res.status)) return res;

      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');
    } catch (err) {
      // 网络层错误（连不上、连接重置、DNS）也值得重试。
      // 但如果已经是最后一次，就抛出一个**指出了地址**的错误：
      // 光说 "fetch failed" 说明不了任何问题，而最常见的真因就是
      // base_url 写错了——必须让人一眼看到连的是哪儿。
      if (attempt === maxAttempts) {
        throw new Error(
          `连不上模型接口：${url}\n` +
            `原始错误：${err instanceof Error ? err.message : String(err)}\n` +
            `请检查 LLM_BASE_URL 是否写错、网络是否可达（当前值：${BASE_URL}）`,
        );
      }
    }

    if (attempt < maxAttempts) {
      const delayMs = computeBackoff(attempt, baseDelayMs);
      onRetry?.({ attempt, delayMs, status: lastStatus });
      await sleep(delayMs);
    }
  }

  throw new Error(
    `请求连续失败 ${maxAttempts} 次${lastStatus ? `（最后一次 HTTP ${lastStatus}）` : ''}` +
      `${lastBody ? `\n收到的原文：${lastBody.slice(0, 400)}` : ''}`,
  );
}

export async function* chatStream(
  messages: Message[],
  tools: ToolSchema[],
  retry: RetryOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  requireKey();

  // tools 为空时不传这两个字段——有些接口在 tools 为空时收到 tool_choice
  // 会直接报错（摘要那次调用就会走到这里）
  const body: Record<string, unknown> = { model: MODEL, messages, stream: true };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto'; // 交给模型自己决定用不用工具
  }

  const res = await fetchWithRetry(
    `${BASE_URL}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    },
    retry,
  );

  if (!res.ok) {
    // 出错时把「收到的原文」摆出来。
    // 不要在这里替用户猜原因——猜错了比不报错更浪费时间。
    const body = await res.text();
    throw new Error(`模型接口返回 HTTP ${res.status}\n收到的原文：${body.slice(0, 600)}`);
  }

  if (!res.body) {
    throw new Error('响应没有 body，没法流式读取');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let sawValidChunk = false;

  // index → 正在累积的调用。多个并发工具调用靠 index 区分
  const acc = new Map<number, ToolCall>();
  let usage: TokenUsage | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      raw += buffer;

      // 只处理完整的行，最后那半行留到下一次
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          // 单行解析失败就跳过。但如果整个响应都不是 SSE（有些网关会用
          // 200 返回一坨 JSON 错误或整页 HTML），每一行都会被跳过，
          // 最后变成一个空回答——所以下面用"一个 chunk 都没收到"来兜底。
          continue;
        }

        sawValidChunk = true;
        if (chunk.usage) usage = chunk.usage;

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'content', text: delta.content };
        }

        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0;
          if (!acc.has(index)) {
            acc.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
          }
          const current = acc.get(index)!;
          if (tc.id) current.id = tc.id;
          if (tc.function?.name) current.function.name += tc.function.name;
          if (tc.function?.arguments) current.function.arguments += tc.function.arguments;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...acc.values()].filter((c) => c.function.name.length > 0);

  // 一个有效 chunk 都没收到 → 大概率不是 SSE。这时报错并附上原文，
  // 否则调用方会把"空的回答"当成模型的合法输出。
  if (!sawValidChunk) {
    throw new Error(`流式响应里没有解析到任何有效内容\n收到的原文：${raw.slice(0, 600)}`);
  }

  yield {
    type: 'done',
    usage,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/** 非流式调用。内部复用流式实现，只是把结果攒起来再返回 */
export async function chat(messages: Message[], tools: ToolSchema[]): Promise<LLMResponse> {
  let content = '';
  let usage: TokenUsage | undefined;
  let toolCalls: ToolCall[] | undefined;

  for await (const event of chatStream(messages, tools)) {
    if (event.type === 'content') content += event.text ?? '';
    if (event.type === 'done') {
      usage = event.usage;
      toolCalls = event.toolCalls;
    }
  }

  return { content: content.length > 0 ? content : null, tool_calls: toolCalls, usage };
}
