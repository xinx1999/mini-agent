// 记忆：把对话历史存到磁盘，下次启动还能接着聊。
//
// 这里有个容易写错的地方：存的是**完整的 messages 数组**，
// 包括每一次工具调用的往返记录。
// 如果只存「用户说了什么、助手答了什么」，把工具调用那段丢掉，
// 恢复之后模型会不记得自己查过什么，可能重复调同一个工具。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './types.ts';

const DIR = '.agent-memory';

function fileOf(sessionId: string): string {
  // 会话名来自命令行/环境变量，挡住路径穿越
  const safe = sessionId.replace(/[^\w\-]/g, '_');
  return join(DIR, `${safe}.json`);
}

export function saveSession(sessionId: string, messages: Message[]): void {
  mkdirSync(DIR, { recursive: true });
  // system 提示每次运行时都会重新注入，没必要落盘
  const persistable = messages.filter((m) => m.role !== 'system');
  writeFileSync(fileOf(sessionId), JSON.stringify(persistable, null, 2), 'utf8');
}

export function loadSession(sessionId: string): Message[] {
  const file = fileOf(sessionId);
  if (!existsSync(file)) return [];

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // 存档损坏不该让程序起不来，但也别静默吞掉——
    // 悄悄返回空历史，用户会以为「我的记忆丢了」，却不知道为什么。
    console.warn(`[memory] ${file} 解析失败，已忽略旧记录：${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function listSessions(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}
