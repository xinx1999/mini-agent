// 一个假的模型接口，用来在「不花 token、不联网」的情况下把 agent 完整跑一遍。
//
// 它按「对话历史里已经有几条 tool 消息」来决定下一步返回什么，
// 相当于把一段真实的工具调用过程写死在这里。
//
// 为什么值得这么测：真接口有延迟、有费用、结果每次都不同；
// 假接口每次结果一样，才能稳定地卡在边界上。

import { createServer } from 'node:http';

/** 按已有的 tool 消息条数，给出"模型这一步会说什么" */
function nextStep(toolCount) {
  if (toolCount === 0) {
    // 第一轮：同时要求调两个工具（验证一条 assistant 消息可以带多个 tool_call）
    return {
      content: null,
      tool_calls: [
        {
          id: 'call_time',
          type: 'function',
          function: { name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' },
        },
        {
          id: 'call_calc',
          type: 'function',
          function: { name: 'calculate', arguments: '{"expression":"(17 ** 0.5) * 3"}' },
        },
      ],
    };
  }
  if (toolCount === 2) {
    return {
      content: null,
      tool_calls: [
        { id: 'call_list', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
      ],
    };
  }
  if (toolCount === 3) {
    // 故意编一个不存在的工具名，验证「错误被喂回去之后循环还能继续」
    return {
      content: null,
      tool_calls: [{ id: 'call_fake', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }],
    };
  }
  // 最后一轮：不再要求调工具，给出答案
  return { done: true };
}

export function createFakeLLM(port) {
  // 记录协议层面的问题，供测试断言
  const stats = { requests: 0, badToolCallIds: [] };

  const server = createServer(async (req, res) => {
    if (!req.url || !req.url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这个假服务只处理 /chat/completions' }));
      return;
    }

    // 必须把请求体读完再响应，否则连接里会残留数据影响下一个请求
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    stats.requests += 1;
    const toolMessages = payload.messages.filter((m) => m.role === 'tool');

    // 校验协议：每条 tool 消息的 tool_call_id，都必须能在前面的 assistant 消息里找到。
    // 这正是 agent.ts 里「必须先把 assistant 消息存进历史」那一步存在的理由。
    const sentIds = new Set();
    for (const m of payload.messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) sentIds.add(c.id);
      }
      if (m.role === 'tool' && !sentIds.has(m.tool_call_id)) {
        stats.badToolCallIds.push(m.tool_call_id);
      }
    }

    const step = nextStep(toolMessages.length);
    // 真实的 OpenAI 兼容接口都会返回 usage，这里模拟一份，
    // 好让 agent 的 token 统计有东西可算。
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

    if (payload.stream) {
      // 按 SSE 发。故意把 tool_calls 的 arguments 拆成两片发——
      // 真实接口就是这么干的，客户端必须自己按 index 拼回去。
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      if (!step.done) {
        step.tool_calls.forEach((call, i) => {
          send({
            choices: [
              { delta: { tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] } },
            ],
          });
          const args = call.function.arguments;
          const mid = Math.floor(args.length / 2);
          send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, mid) } }] } }] });
          send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(mid) } }] } }] });
        });
      } else {
        // 从工具结果里取出计算结果，用来证明结果确实回灌给了模型
        const calc = toolMessages.find((m) => typeof m.content === 'string' && m.content.includes('='));
        const text = `最终答案｜计算结果：${calc ? calc.content : '未取到'}`;
        // 分三段发，验证客户端的流式累积
        const size = Math.ceil(text.length / 3);
        for (let i = 0; i < text.length; i += size) {
          send({ choices: [{ delta: { content: text.slice(i, i + size) } }] });
        }
      }

      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let message;
    if (step.done) {
      const calc = toolMessages.find((m) => typeof m.content === 'string' && m.content.includes('='));
      message = { role: 'assistant', content: `最终答案｜计算结果：${calc ? calc.content : '未取到'}` };
    } else {
      message = { role: 'assistant', content: step.content, tool_calls: step.tool_calls };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage }));
  });

  return {
    stats,
    listen: () =>
      new Promise((resolve, reject) => {
        // 端口被占用就直接失败。故意不做"换一个端口"的降级——
        // 那会让测试在"碰巧有别的服务在听"时也变绿。
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
