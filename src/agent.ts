// ★ 核心文件。整个 agent 就是这一个函数。
//
// 普通聊天：调一次模型，拿回答，结束。
//
// Agent：调一次模型 → 如果它要求调工具，就执行工具 →
//        把结果塞回对话历史 → 再调一次模型 →
//        重复，直到模型不再要求调工具为止。
//
// 后面你会听到的各种名词（ReAct、AgentExecutor、工具编排、
// 多 agent 协作、记忆、可观测性）——都是在回答同一个问题：
// 「怎么让上面这个循环更可靠」。它们不是另一回事。

import type { Message, Tool, ToolCall, TokenUsage } from './types.ts';
import { chatStream } from './llm.ts';
import { Trace } from './trace.ts';
import { compressHistory, shouldCompress, estimateMessagesTokens, isContextLengthError } from './compress.ts';

function preview(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + '…';
}

/** 一步执行的进度事件。网页端靠它显示"agent 正在干什么" */
export type StepEvent =
  | { type: 'llm'; step: number; ms: number; tokens: number }
  | { type: 'tool'; step: number; name: string; args: string; result: string; ok: boolean; ms: number }
  | { type: 'compress'; step: number; before: number; after: number };

export interface RunOptions {
  system?: string;
  /** 最多循环几步。没有这个上限，模型可能一直调工具停不下来。 */
  maxSteps?: number;
  /** 是否打印每一步的执行轨迹 */
  verbose?: boolean;
  /**
   * 之前的对话历史。多轮对话时把上一轮的 messages 传回来。
   * 传进来的历史里如果带旧的 system 提示会被丢掉——system 每次都用当前
   * 最新的那一份，避免旧存档里过时的设定一直生效。
   */
  history?: Message[];
  /** 传一个已有的 Trace 进来，可以把多轮对话的开销累计在一起 */
  trace?: Trace;
  /** 每一步执行后的回调。注意它是"边跑边报"，不是跑完才给 */
  onStep?: (event: StepEvent) => void;
  /** 流式：每收到一段新文本就回调一次，用来做逐字输出 */
  onToken?: (text: string) => void;
  /** 历史超过阈值时自动压缩。默认开 */
  compress?: boolean;
  /** 历史估算 token 超过这个值就压缩 */
  maxContextTokens?: number;
  /** 压缩时至少保留最近几条原始消息 */
  keepRecent?: number;
}

export interface RunResult {
  answer: string;
  /** 更新后的完整对话历史。存盘、或者传给下一轮继续用 */
  messages: Message[];
  trace: Trace;
}

export async function runAgent(
  userInput: string,
  tools: Tool[],
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    system = '你是一个可以调用工具的助手。需要外部信息或计算时必须调用工具，不要凭记忆猜。',
    maxSteps = 10,
    verbose = true,
    history = [],
    trace = new Trace(),
    onStep,
    onToken,
    compress = true,
    maxContextTokens = 3000,
    keepRecent = 4,
  } = options;

  // 对话历史 = agent 的全部"工作记忆"。
  // 模型本身是无状态的：它每一步能看到什么，完全取决于这个数组。
  // 所以"上下文管理"这件事，本质就是"怎么维护这个数组"。
  // 用 let 而不是 const：压缩时会整体替换这个数组
  let messages: Message[] = [
    { role: 'system', content: system },
    ...history.filter((m) => m.role !== 'system'),
    { role: 'user', content: userInput },
  ];

  const schemas = tools.map((t) => t.schema);
  const toolByName = new Map(tools.map((t) => [t.schema.function.name, t]));

  // 用 null 而不是空字符串表示"还没结束"：
  // 模型完全可能合法地返回空答案，用 '' 判断会把它误判成"没跑完"。
  let answer: string | null = null;
  // 上下文超长触发的压缩重试只允许一次，否则可能和循环开头的自动压缩来回打架
  let compressedForRetry = false;

  for (let step = 1; step <= maxSteps; step++) {
    // 历史太长就先压缩。否则这一轮请求可能直接超出上下文窗口，
    // 而且每一次都要把全部历史重发一遍，越到后面越贵。
    if (compress && shouldCompress(messages, { maxTokens: maxContextTokens, keepRecent })) {
      const before = estimateMessagesTokens(messages);
      messages = await compressHistory(messages, { keepRecent });
      const after = estimateMessagesTokens(messages);

      onStep?.({ type: 'compress', step, before, after });
      if (verbose) {
        console.log(`  [第 ${step} 步] 压缩历史：${before} → ${after} token`);
      }
    }

    // 流式调用：content 边到边通过 onToken 抛出去；
    // tool_calls 则在流里按 index 累积，必须等流完才拿得到完整的一份。
    const llmStart = Date.now();
    let content = '';
    let toolCalls: ToolCall[] | undefined;
    let usage: TokenUsage | undefined;

    try {
      for await (const event of chatStream(messages, schemas)) {
        if (event.type === 'content') {
          content += event.text ?? '';
          onToken?.(event.text ?? '');
        } else {
          usage = event.usage;
          toolCalls = event.toolCalls;
        }
      }
    } catch (err) {
      // 上下文超长是特殊的一类失败：不是接口坏了，是我们塞进去的太多。
      // 这种情况正确做法是压缩历史再试一次，而不是把原文错误丢给用户。
      if (isContextLengthError(err) && !compressedForRetry) {
        compressedForRetry = true;
        const beforeRetry = estimateMessagesTokens(messages);
        messages = await compressHistory(messages, { keepRecent: 2 });
        const afterRetry = estimateMessagesTokens(messages);

        onStep?.({ type: 'compress', step, before: beforeRetry, after: afterRetry });
        if (verbose) {
          console.log(`  [第 ${step} 步] 上下文超长，压缩后重试：${beforeRetry} → ${afterRetry} token`);
        }
        continue;
      }
      throw err;
    }

    const llmMs = Date.now() - llmStart;
    trace.recordLLM(llmMs, usage?.total_tokens);
    onStep?.({ type: 'llm', step, ms: llmMs, tokens: usage?.total_tokens ?? 0 });

    // ── 出口：模型这次没有要求调工具，说明它认为可以给答案了 ──
    if (!toolCalls || toolCalls.length === 0) {
      answer = content;
      // 这条 assistant 回复也必须进历史。
      // 少了它，下一轮对话时模型就"不记得自己刚说过什么"——
      // 单次模式下看不出来，多轮对话里就是明显的失忆。
      messages.push({ role: 'assistant', content });
      break;
    }

    // ── 继续：模型要求调工具 ──
    // 先把这条 assistant 消息原样存进历史。这一步不能省：
    // 下一步的 tool 消息要靠 tool_call_id 和它对上号，
    // 少了它，接口会直接报错。
    messages.push({
      role: 'assistant',
      content: content.length > 0 ? content : null,
      tool_calls: toolCalls,
    });

    // 一次可能要求调多个工具（比如同时问时间和算数），所以是 for 循环
    for (const call of toolCalls) {
      const { name, arguments: rawArgs } = call.function;
      const toolStart = Date.now();
      let result: string;
      let ok = true;

      const tool = toolByName.get(name);
      if (!tool) {
        // 模型可能编出一个不存在的工具名。这里不要抛错崩掉整个流程，
        // 而是把它当成"工具返回的错误"喂回去，让模型自己纠正。
        result = `错误：不存在名为 ${name} 的工具`;
        ok = false;
      } else {
        try {
          const args = JSON.parse(rawArgs || '{}');
          result = await tool.run(args);
        } catch (err) {
          // 工具执行失败也一样：喂回错误，而不是中断循环。
          // 这一条是 agent 和普通脚本最大的心态差别——
          // 错误是"给模型的输入"，不是"程序的终点"。
          result = `错误：${err instanceof Error ? err.message : String(err)}`;
          ok = false;
        }
      }

      const toolMs = Date.now() - toolStart;
      trace.recordTool(name, toolMs, ok);
      onStep?.({ type: 'tool', step, name, args: rawArgs, result, ok, ms: toolMs });

      if (verbose) {
        console.log(`  [第 ${step} 步] ${name}(${rawArgs})`);
        console.log(`           → ${preview(result)}`);
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  // 兜底：跑满 maxSteps 还没结束。
  // 注意这里返回的是一句"明确的未完成信号"，不是一个看起来像结论的东西。
  // 真实系统里，把未完成伪装成完成，比直接报错危险得多。
  if (answer === null) {
    answer = `（已达到最大步数 ${maxSteps}，任务未完成，请缩小问题范围后重试）`;
  }

  return { answer, messages, trace };
}
