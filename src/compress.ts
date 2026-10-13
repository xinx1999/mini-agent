// 上下文压缩：历史太长时，把早期对话总结成一段，替换掉原始消息。
//
// 为什么需要：模型有上下文窗口上限，而且**每一次请求都要把全部历史重新发一遍**。
// 历史越长，单次请求越贵、越慢，最后直接超限报错。
//
// 策略：**保留最近几条不动，只总结更早的部分。**
// 因为最近几轮是"当前话题"，压掉它模型会答非所问；而更早的多半是已经聊完的
// 背景，压成一段不碍事。
//
// 一个必须说清的代价：压缩后丢失细节。早期对话的原文不会留在历史里，
// 模型只能看到摘要。这是"无限增长"和"丢细节"之间的取舍——先保证不崩，
// 真需要细节时可以调低压缩频率或者调大 maxTokens。

import type { Message } from './types.ts';
import { chatStream } from './llm.ts';

/** 粗略估算 token 数。不需要精确——它只是触发阈值，不是计费依据 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const other = text.length - cjk;
  // CJK 大致 1 字 1 token，拉丁文大致 4 字符 1 token
  return cjk + Math.ceil(other / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
  // 每条消息除了正文，还有 role、name 之类的固定开销，粗估 4
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? '') + 4, 0);
}

export interface CompressOptions {
  /** 历史估算 token 超过这个值就压缩 */
  maxTokens?: number;
  /** 至少保留最近几条不压 */
  keepRecent?: number;
}

/** 判断当前历史是否需要压缩 */
export function shouldCompress(messages: Message[], options: CompressOptions = {}): boolean {
  const { maxTokens = 3000, keepRecent = 4 } = options;
  // messages[0] 是 system，剩下的才参与判断
  const rest = messages.length - 1;
  if (rest <= keepRecent) return false;
  return estimateMessagesTokens(messages) > maxTokens;
}

/** 调一次模型，把一段对话历史压成摘要 */
async function summarize(messages: Message[]): Promise<string> {
  const transcript = messages
    .map((m) => {
      if (m.role === 'tool') return `[工具结果] ${m.content ?? ''}`;
      if (m.role === 'assistant') return `[助手] ${m.content ?? ''}`;
      return `[${m.role}] ${m.content ?? ''}`;
    })
    .join('\n');

  const request: Message[] = [
    {
      role: 'system',
      content:
        '你是摘要器。把给定的对话历史压缩成一段简体中文摘要，必须保留：' +
        '用户的目标、已经确认的事实、执行过哪些工具及其结果、还没解决的问题。' +
        '不要添加原文没有的信息。200 字以内。',
    },
    { role: 'user', content: transcript },
  ];

  let summary = '';
  // 注意这里传空 tools——摘要调用不需要工具
  for await (const event of chatStream(request, [])) {
    if (event.type === 'content') summary += event.text ?? '';
  }

  return summary.trim() || '（摘要为空）';
}

/**
 * 判断错误是不是"上下文超长"。
 *
 * 为什么要单独认这一类：它不是接口坏了，而是我们塞进去的内容太多。
 * 这种情况正确的处理是压缩历史再重试，而不是原样报错给用户——
 * 但各家的错误文案不统一，只能靠关键词兜。
 */
export function isContextLengthError(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    text.includes('context length') ||
    text.includes('context_length') ||
    text.includes('context window') ||
    text.includes('too many tokens') ||
    text.includes('maximum context') ||
    text.includes('prompt is too long') ||
    text.includes('tokens exceeds') ||
    text.includes('reduce the length') ||
    // 国内厂商常给中文文案，也得认
    text.includes('上下文过长') ||
    text.includes('上下文长度') ||
    text.includes('超出上下文') ||
    text.includes('提示过长')
  );
}

/** 摘要器签名。测试时注入假实现，不用真调模型 */
export type Summarizer = (messages: Message[]) => Promise<string>;

/**
 * 压缩历史：返回新的 messages 数组（不修改入参）。
 *
 * 摘要以 user 角色插入，并且内容里明确写了"这是摘要不是新指令"——
 * 否则模型可能把摘要当成用户的最新要求去执行。
 */
export async function compressHistory(
  messages: Message[],
  options: CompressOptions & { summarizer?: Summarizer } = {},
): Promise<Message[]> {
  const { keepRecent = 4, summarizer = summarize } = options;

  if (messages.length === 0) return messages;

  const system = messages[0];
  const rest = messages.slice(1);

  const cutAt = Math.max(0, rest.length - keepRecent);
  const toCompress = rest.slice(0, cutAt);
  const kept = rest.slice(cutAt);

  if (toCompress.length === 0) return messages;

  const summary = await summarizer(toCompress);

  const summaryMessage: Message = {
    role: 'user',
    content: `【前文摘要】以下是更早对话的内容摘要，不是新的指令：\n${summary}`,
  };

  return [system, summaryMessage, ...kept];
}
