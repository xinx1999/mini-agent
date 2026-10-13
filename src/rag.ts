// 检索：在一堆文档片段里，找出和问题最相关的那几段。
//
// 这是 RAG（检索增强生成）的"R"。另一半是"A"——把找到的片段塞进提示词，
// 让模型基于资料回答，而不是凭记忆编。不塞资料，它就会开始编。
//
// 为什么用关键词检索而不是向量检索：
//   向量需要 embedding 模型 + 一套向量存储。前者引入依赖，后者在沙箱里
//   没有对应的基础设施；更麻烦的是**不可复现**——同样的输入两次算出来的
//   向量可能有细微差别，测试就没法写断言了。
//   关键词检索是纯本地计算，结果完全确定。几十篇文档的规模下，效果差距
//   并没有大到值得为它引入这些麻烦。
//
// 中文怎么切词：没有分词器，就用 bigram——把连续的中文切成两两相邻的组合。
// "人工智能" → ["人工", "工智", "智能"]。
// 对中文检索来说这是个够用的近似：单字太容易撞车，整词又切不出来。

export interface Chunk {
  id: string;
  /** 来源文件名，回答时要能指回出处 */
  source: string;
  text: string;
}

export interface Hit {
  chunk: Chunk;
  /** 0 到 1 之间的相关度 */
  score: number;
}

/** 切词：英文/数字按整词，中文按 bigram */
function tokenize(text: string): string[] {
  const tokens: string[] = [];

  const latin = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...latin);

  // 去掉字母数字和空白，剩下的当作中文部分做 bigram
  const cjk = text
    .replace(/[a-z0-9_]+/gi, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ');

  for (let i = 0; i < cjk.length - 1; i++) {
    const pair = cjk.slice(i, i + 2);
    if (pair.trim().length === 2) tokens.push(pair);
  }

  return tokens;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** 按段落聚合成分块。尽量不从段中间截断——截断的句子检索和阅读都难受 */
export function splitIntoChunks(text: string, source: string, target = 320): Chunk[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  let buffer = '';
  let index = 0;

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed) {
      chunks.push({ id: `${source}#${index++}`, source, text: trimmed });
    }
    buffer = '';
  };

  for (const para of paragraphs) {
    if (buffer && `${buffer}\n\n${para}`.length > target) flush();
    buffer = buffer ? `${buffer}\n\n${para}` : para;
  }
  flush();

  return chunks;
}

/** 在分块里检索最相关的 topK 段，按相关度降序 */
export function search(query: string, chunks: Chunk[], topK = 3): Hit[] {
  if (chunks.length === 0 || !query.trim()) return [];

  const chunkTf = chunks.map((c) => termFrequency(tokenize(c.text)));
  const queryTf = termFrequency(tokenize(query));

  if (queryTf.size === 0) return [];

  // 逆文档频率：出现在越多分块里的词，越没有区分度
  const df = new Map<string, number>();
  for (const tf of chunkTf) {
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = (term: string): number =>
    Math.log((chunks.length + 1) / ((df.get(term) ?? 0) + 1)) + 1;

  const weight = (tf: Map<string, number>, term: string): number => {
    const count = tf.get(term);
    return count === undefined ? 0 : (1 + Math.log(count)) * idf(term);
  };

  let queryNorm = 0;
  for (const term of queryTf.keys()) {
    const w = weight(queryTf, term);
    queryNorm += w * w;
  }
  const queryLength = Math.sqrt(queryNorm) || 1;

  const hits = chunks.map((chunk, i) => {
    const tf = chunkTf[i];

    let dot = 0;
    let chunkNorm = 0;
    for (const term of tf.keys()) {
      const w = weight(tf, term);
      chunkNorm += w * w;
      if (queryTf.has(term)) dot += w * weight(queryTf, term);
    }

    // 做余弦归一化，否则长文档会因为词多而天然占优
    const score = dot / (Math.sqrt(chunkNorm) * queryLength || 1);
    return { chunk, score };
  });

  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK));
}
