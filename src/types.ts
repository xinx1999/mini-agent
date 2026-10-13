// 词汇表：只放类型定义，不放任何逻辑。
//
// 这些结构不是随便定的——它们就是 OpenAI 的接口格式，
// 目前几乎所有模型厂商都兼容它。看懂这几个类型，
// 你就看懂了所有 agent 框架在传什么。

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 对话里的一条消息 */
export interface Message {
  role: Role;
  content: string | null;
  /** 只有 assistant 消息可能有：模型说"我要调这几个工具" */
  tool_calls?: ToolCall[];
  /** 只有 tool 消息有：这条结果是在回哪个调用，靠它和上面的 tool_calls 对上号 */
  tool_call_id?: string;
}

/** 模型发起的一次工具调用请求 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /**
     * 注意：这是 JSON 字符串，不是对象。
     * 模型是逐字"写"出这段 JSON 的，所以它可能是坏的、可能少括号——
     * 所以后面一定要 try/catch 包住 JSON.parse。
     */
    arguments: string;
  };
}

/** 工具的说明书，这份是给模型看的 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** 一个工具 = 给模型看的说明书 + 我们自己执行的函数 */
export interface Tool {
  schema: ToolSchema;
  run: (args: Record<string, any>) => Promise<string> | string;
}

/** 模型返回的 token 用量，用来算成本 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 模型一次回复的解析结果 */
export interface LLMResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
}
