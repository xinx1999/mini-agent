// 入口。两种用法：
//
//   node --env-file=.env index.ts                     → 交互模式：多轮对话，历史落盘
//   node --env-file=.env index.ts "帮我看下 src 目录"  → 单次模式：跑完就退出，不碰磁盘
//
// 交互模式下的命令：
//   /reset   清空这个会话的记忆
//   /exit    退出

import { createInterface } from 'node:readline/promises';
import { runAgent } from './src/agent.ts';
import { tools } from './src/tools.ts';
import { loadSession, saveSession } from './src/memory.ts';

const task = process.argv.slice(2).join(' ').trim();

if (task) {
  await runOnce(task);
} else {
  await repl();
}

/** 单次模式：跑一个任务就退出，不读写记忆文件 */
async function runOnce(input: string): Promise<void> {
  console.log(`\n任务：${input}\n`);
  console.log('--- 执行轨迹 ---');

    try {
    // 回答走 stdout 且逐字流出；过程轨迹走 stderr。
    // 分开是为了让 stdout 只保留"agent 的回答"——方便重定向和管道。
    const { trace } = await runAgent(input, tools, {
      verbose: false,
      onStep: (e) => {
        if (e.type !== 'tool') return;
        const oneLine = e.result.replace(/\s+/g, ' ').trim();
        const shown = oneLine.length <= 120 ? oneLine : oneLine.slice(0, 120) + '…';
        process.stderr.write(`  [第 ${e.step} 步] ${e.name}(${e.args})\n`);
        process.stderr.write(`           → ${shown}\n`);
      },
      onToken: (text) => process.stdout.write(text),
    });
    console.log('\n\n--- 本次开销 ---');
    console.log(trace.summary());
  } catch (err) {
    // 配置类错误（比如没填 key）不需要堆栈，直接说清楚怎么修。
    console.log('--- 轨迹结束 ---\n');
    console.error(`出错了：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/** 交互模式：多轮对话，历史存到 .agent-memory/ */
async function repl(): Promise<void> {
  const sessionId = process.env.AGENT_SESSION ?? 'default';
  let history = loadSession(sessionId);

  console.log(`\n交互模式 · 会话「${sessionId}」`);
  console.log(history.length > 0 ? `已载入 ${history.length} 条历史消息` : '这是一个新会话');
  console.log('输入任务后回车。可用命令：/reset 清空记忆，/exit 退出\n');

  const interactive = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  try {
    // 用 for await 逐行读，而不是 rl.question()。
    // question 在管道输入下有个坑：stdin 一关闭它就立刻 reject，
    // 管道里剩下的行会被整段丢掉——刚才实测 6 行只处理了 1 行。
    // for await 会先把输入缓冲起来逐行 yield，没有这个问题。
    if (interactive) process.stdout.write('\n你 > ');

    for await (const line of rl) {
      const input = line.trim();
      if (!input) {
        if (interactive) process.stdout.write('你 > ');
        continue;
      }

      if (input === '/exit') break;
      if (input === '/reset') {
        history = [];
        saveSession(sessionId, []);
        console.log('（记忆已清空）\n');
        if (interactive) process.stdout.write('你 > ');
        continue;
      }

      try {
        const result = await runAgent(input, tools, { history });
        history = result.messages;
        // 存盘这一步失败不能静默跳过——否则用户以为记住了，其实没有
        saveSession(sessionId, history);
        console.log(`\n${result.answer}\n`);
        console.log(`[${result.trace.summary().split('\n').join(' | ')}]\n`);
      } catch (err) {
        console.error(`出错了：${err instanceof Error ? err.message : String(err)}\n`);
      }

      if (interactive) process.stdout.write('你 > ');
    }
  } finally {
    rl.close();
  }

  console.log('再见。');
}
