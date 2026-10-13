// 检索质量测试：验证 RAG 的"R"真的能检索到东西。
//
// 为什么要单独测：检索不准的表现很隐蔽——接口不报错，agent 也照样回答，
// 只是内容是基于错误片段编的。这种"假绿"比崩溃更难发现。
//
// 跑法：  node test/rag-test.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { splitIntoChunks, search } = await import('../src/rag.ts');
const { loadDocs } = await import('../src/docs.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

// ── 分块 ──────────────────────────────────────────────────
console.log('--- 断言：分块 ---');
const probeText = '第一段内容\n\n第二段内容\n\n' + '长'.repeat(400);
const probeChunks = splitIntoChunks(probeText, 'probe.md');
check('能切出多个分块', probeChunks.length >= 2, `实际 ${probeChunks.length} 块`);
check('每个分块都带来源', probeChunks.every((c) => c.source === 'probe.md'));
check('分块 id 不重复', new Set(probeChunks.map((c) => c.id)).size === probeChunks.length);
check('空文本不产生分块', splitIntoChunks('', 'empty.md').length === 0);

// ── 检索：合成语料，断言稳定 ──────────────────────────────
console.log('\n--- 断言：检索准确性（合成语料）---');

// 先测排序。这里故意构造"多个块同时命中"的局面——
// 如果每次查询只命中一块，排序断言就是空过的：只有一个元素时，
// 排不排序结果都一样，测试抓不到任何东西。（变异测试实测过）
const ordered = [
  { id: 'diluted', source: 'x.md', text: 'agent 工具 调用 循环 模型 记忆 上下文 trace 很长的一段话把相关词稀释掉了' },
  { id: 'focused', source: 'y.md', text: 'agent 工具' },
  { id: 'unrelated', source: 'z.md', text: '今天天气很好，适合出门散步晒太阳' },
];
const orderedHits = search('agent 工具', ordered, 3);
check('能同时命中多个分块', orderedHits.length === 2, `实际命中 ${orderedHits.length} 块：${orderedHits.map((h) => h.chunk.id).join(',')}`);
check('不相关的块被漏掉', !orderedHits.some((h) => h.chunk.id === 'unrelated'));
check(
  '更相关的排在最前面',
  orderedHits[0]?.chunk.id === 'focused',
  `实际顺序：${orderedHits.map((h) => `${h.chunk.id}(${h.score.toFixed(3)})`).join(' > ')}`,
);
const orderedScores = orderedHits.map((h) => h.score);
check(
  '整体按相关度降序',
  orderedScores.every((s, i) => i === 0 || orderedScores[i - 1] >= s - 1e-12),
  orderedScores.map((s) => s.toFixed(4)).join(' > '),
);

const corpus = [
  { id: 'c0', source: '合成.md', text: 'LangChain 抽象层太厚，学不到 agent 的本质' },
  { id: 'c1', source: '合成.md', text: '把 .env 过滤掉，因为工具结果会发给第三方' },
  { id: 'c2', source: '合成.md', text: 'Node 22.18 才开始默认支持 TypeScript 类型擦除' },
  { id: 'c3', source: '合成.md', text: '今天天气很好，适合出门散步晒太阳' },
];

const envHits = search('为什么要过滤 .env', corpus, 3);
check('能检索到相关分块', envHits.length > 0);
check(
  '命中了 .env 那段',
  envHits[0]?.chunk.text.includes('.env') ?? false,
  `实际命中：${envHits[0]?.chunk.text}`,
);

const nodeHits = search('TypeScript 类型擦除从哪个版本开始', corpus, 3);
check(
  '能命中 Node 版本那段',
  nodeHits[0]?.chunk.text.includes('22.18') ?? false,
  `实际命中：${nodeHits[0]?.chunk.text}`,
);

check('完全无关的查询返回空', search('区块链挖矿收益', corpus).length === 0);
check('topK 限制生效', search('.env', corpus, 1).length === 1);
check('空查询返回空', search('   ', corpus).length === 0);
check('空语料返回空', search('任何东西', []).length === 0);
check('相关度在 0 到 1 之间', envHits.every((h) => h.score > 0 && h.score <= 1));

// 公共词不该有区分度：query 里的词在每块都出现时，排序不该由它主导
const uniform = [
  { id: 'u0', source: 'u.md', text: '工具 工具 工具' },
  { id: 'u1', source: 'u.md', text: '工具' },
];
const uniformHits = search('工具', uniform);
check(
  '词频差异不影响相关度（已归一化）',
  Math.abs((uniformHits[0]?.score ?? 0) - (uniformHits[1]?.score ?? 0)) < 1e-9,
  `${uniformHits[0]?.score} vs ${uniformHits[1]?.score}`,
);

// ── 真实文档冒烟 ──────────────────────────────────────────
console.log('\n--- 断言：真实文档（docs/）---');
// 显式传路径，不依赖当前工作目录
const docs = loadDocs(join(ROOT, 'docs'));
check('docs/ 能加载出分块', docs.length > 0, `实际 ${docs.length} 块`);
check('分块都来自 .md 文件', docs.every((c) => c.source.endsWith('.md')));

const langchain = search('为什么不用 LangChain', docs, 3);
check(
  '「为什么不用 LangChain」命中正确段落',
  langchain[0]?.chunk.text.includes('LangChain') ?? false,
  `命中：${langchain[0]?.chunk.text?.slice(0, 50)}`,
);

const maxsteps = search('maxSteps 上限 没完成怎么办', docs, 3);
check(
  '「maxSteps」命中正确段落',
  maxsteps[0]?.chunk.text.includes('maxSteps') ?? false,
  `命中：${maxsteps[0]?.chunk.text?.slice(0, 50)}`,
);

const howToRun = search('怎么跑测试', docs, 3);
check(
  '「怎么跑测试」能命中项目说明',
  howToRun.some((h) => h.chunk.source === '项目说明.md'),
  `命中来源：${howToRun.map((h) => `${h.chunk.source}(${h.score.toFixed(3)})`).join(', ')}`,
);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
