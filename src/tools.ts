// 工具集。
//
// 写 agent 时最容易被低估的一件事：工具的名字和 description，
// 就是模型判断"要不要用、怎么用"的唯一依据。
// 描述写得含糊，模型就会用错参数，或者该调的时候不调。
// 所以这里的 description 写得比代码本身还长，是有意的。

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.ts';
import { search } from './rag.ts';
import { loadDocs } from './docs.ts';
import { webSearch } from './search.ts';

/** 简单表达式求值。只放行数字和运算符，避免变成任意代码执行。 */
function evaluate(expression: string): number {
  if (!/^[\d\s+\-*/().%]+$/.test(expression)) {
    throw new Error('表达式里只允许数字和 + - * / ( ) . % 这些字符');
  }
  const value = new Function(`return (${expression})`)();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('计算结果不是有效数字');
  }
  return value;
}

export const tools: Tool[] = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'get_current_time',
        description:
          '获取指定时区的当前日期和时间。当用户问“现在几点”“今天几号”“过了多久”这类问题时使用。不要凭训练数据回答时间问题。',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description: 'IANA 时区名，例如 Asia/Shanghai、America/New_York。不传默认为 Asia/Shanghai。',
            },
          },
        },
      },
    },
    run: (args) => {
      const timezone = typeof args.timezone === 'string' ? args.timezone : 'Asia/Shanghai';
      const text = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'medium',
      }).format(new Date());
      return `${timezone}：${text}`;
    },
  },

  {
    schema: {
      type: 'function',
      function: {
        name: 'calculate',
        description:
          '计算一个数学表达式并返回精确结果，支持 + - * / % 和括号、幂运算 **。需要计算时必须调用它，不要自己心算。',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: '要计算的表达式，例如 (17 ** 0.5) * 3',
            },
          },
          required: ['expression'],
        },
      },
    },
    run: (args) => {
      const expression = String(args.expression ?? '');
      return `${expression} = ${evaluate(expression)}`;
    },
  },

  {
    schema: {
      type: 'function',
      function: {
        name: 'list_files',
        description: '列出某个目录下的文件和子目录。需要了解本地文件情况时使用。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '目录路径，可以是相对路径。不传则用当前工作目录。',
            },
          },
        },
      },
    },
    run: (args) => {
      const dir = resolve(process.cwd(), typeof args.path === 'string' ? args.path : '.');
      // 这里故意不 try/catch：目录不存在时抛错，
      // 由 agent 循环统一把错误信息喂回模型，让它自己纠正。
      const entries = readdirSync(dir, { withFileTypes: true });

      // 工具结果最终要发给模型接口，也就是发给第三方服务。
      // 所以 .env 这类文件连名字都不该出现在输出里——
      // 光凭文件名就已经暴露了"这个目录里存着秘密"。
      const listed = entries.filter((e) => !/^\.env/i.test(e.name));

      if (listed.length === 0) return `${dir} 下没有可展示的条目`;

      const lines = listed.map((e) => `  ${e.name}${e.isDirectory() ? '/' : ''}`);
      const hidden = entries.length - listed.length;
      return (
        `${dir} 下共 ${listed.length} 项：\n${lines.join('\n')}` +
        (hidden > 0 ? `\n（另有 ${hidden} 项已按安全规则隐藏）` : '')
      );
    },
  },

  {
    schema: {
      type: 'function',
      function: {
        name: 'search_docs',
        description:
          '在 docs/ 目录的文档里检索与问题最相关的片段。当用户问到项目说明、代码结构、常见问题、使用方法这类应该查文档而不是凭记忆回答的问题时使用。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '要检索的问题或关键词，尽量用文档里可能出现的原词',
            },
            topK: {
              type: 'integer',
              description: '返回几段最相关的内容，默认 3，最多 5',
            },
          },
          required: ['query'],
        },
      },
    },
    run: (args) => {
      const query = String(args.query ?? '');
      if (!query.trim()) return '错误：query 不能为空';

      const requested = Number(args.topK ?? 3);
      const topK = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), 5) : 3;

      const hits = search(query, loadDocs(), topK);
      if (hits.length === 0) return 'docs/ 下没有检索到相关片段';

      return hits
        .map(
          (h, i) =>
            `【片段 ${i + 1}】来源：${h.chunk.source}（相关度 ${h.score.toFixed(3)}）\n${h.chunk.text}`,
        )
        .join('\n\n');
    },
  },

  {
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '联网搜索，返回标题、链接和摘要。当问题需要最新信息、常识之外的内容、或你无法确定的事实时使用。注意返回的是搜索结果摘要，不是网页全文。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词，尽量精准、用文档里可能出现的原词',
            },
            count: {
              type: 'integer',
              description: '返回几条结果，默认 5，最多 10',
            },
          },
          required: ['query'],
        },
      },
    },
    run: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return '错误：query 不能为空';

      const requested = Number(args.count ?? 5);
      const count = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), 10) : 5;

      const hits = await webSearch(query, { count });
      if (hits.length === 0) return '没有搜到相关结果（搜索引擎可能改版了）';

      return hits
        .map((h, i) => `${i + 1}. ${h.title}\n   链接：${h.url}${h.snippet ? `\n   摘要：${h.snippet}` : ''}`)
        .join('\n\n');
    },
  },
];
