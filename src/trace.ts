// 可观测性：把 agent 每一步的开销记下来。
//
// 这一层是「能跑」和「能交付」之间的分水岭。
// 线上出问题时，没有这些数据你只能靠猜：
// 是模型慢？工具慢？还是循环转太多圈？
// 面试里被问「你这个东西跑了多少成本」，答不上来就露馅了。

export interface StepRecord {
  kind: 'llm' | 'tool';
  name: string;
  ms: number;
  ok: boolean;
  tokens?: number;
}

export class Trace {
  readonly steps: StepRecord[] = [];

  recordLLM(ms: number, tokens?: number): void {
    this.steps.push({ kind: 'llm', name: 'chat', ms, ok: true, tokens });
  }

  recordTool(name: string, ms: number, ok: boolean): void {
    this.steps.push({ kind: 'tool', name, ms, ok });
  }

  get llmCalls(): number {
    return this.steps.filter((s) => s.kind === 'llm').length;
  }

  get toolCalls(): number {
    return this.steps.filter((s) => s.kind === 'tool').length;
  }

  get failedTools(): number {
    return this.steps.filter((s) => s.kind === 'tool' && !s.ok).length;
  }

  get totalTokens(): number {
    return this.steps.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
  }

  get totalMs(): number {
    return this.steps.reduce((sum, s) => sum + s.ms, 0);
  }

  /** 最慢的那一步——优化时先看它 */
  get slowest(): StepRecord | undefined {
    return this.steps.reduce<StepRecord | undefined>(
      (max, s) => (max === undefined || s.ms > max.ms ? s : max),
      undefined,
    );
  }

  summary(): string {
    const slow = this.slowest;
    const slowText = slow ? `最慢一步 ${slow.name} ${slow.ms}ms` : '没有记录到步骤';
    return [
      `模型调用 ${this.llmCalls} 次，工具调用 ${this.toolCalls} 次（失败 ${this.failedTools} 次）`,
      `token 合计 ${this.totalTokens}，总耗时 ${this.totalMs}ms，${slowText}`,
    ].join('\n');
  }
}
