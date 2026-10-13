// 上下文压缩测试。
//
// 跑法：  node test/compress-test.mjs

const {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompress,
  compressHistory,
} = await import('../src/compress.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

console.log('--- 断言：token 估算 ---');
check('空字符串 0', estimateTokens('') === 0);
check('纯中文按字数估', estimateTokens('你好世界') === 4, String(estimateTokens('你好世界')));
check('纯英文按 4 字符一词', estimateTokens('abcdefgh') === 2, String(estimateTokens('abcdefgh')));
check('混合内容合理', estimateTokens('你好 abc') > 0 && estimateTokens('你好 abc') < 10);
check('消息数组累加', estimateMessagesTokens([{ role: 'user', content: '你好' }, { role: 'assistant', content: '世界' }]) === 2 + 4 + 2 + 4, String(estimateMessagesTokens([{ role: 'user', content: '你好' }, { role: 'assistant', content: '世界' }])));

console.log('\n--- 断言：触发判断 ---');
// 注意：要测"超阈值"就得同时满足两个条件——消息数多于 keepRecent，且估算了阈值。
// 只用两三条短消息是测不出触发的（我第一版就这么写，两条 FAIL）
const enoughHistory = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '第一条' },
  { role: 'user', content: '第二条' },
  { role: 'user', content: '第三条' },
  { role: 'user', content: '第四条' },
  { role: 'user', content: '第五条' },
];

const shortHistory = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '你好' },
];
check('消息少时不压缩', shouldCompress(shortHistory, { maxTokens: 10 }) === false);
check('消息多且超阈值时压缩', shouldCompress(enoughHistory, { maxTokens: 10, keepRecent: 2 }) === true);

const manyMessages = [
  { role: 'system', content: '你是助手' },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ role: 'user', content: `第 ${i} 条消息，内容不算短`.repeat(5) })),
];
check('消息多且超阈值时压缩', shouldCompress(manyMessages, { maxTokens: 300, keepRecent: 4 }) === true);
check('消息多但没超阈值时不压缩', shouldCompress(manyMessages, { maxTokens: 99999 }) === false);
// 关键边界：只剩 keepRecent 条时不能压，否则就没有"当前话题"了
check('剩余条数等于 keepRecent 时不压', shouldCompress([
  { role: 'system', content: 's' },
  { role: 'user', content: 'a' },
  { role: 'user', content: 'b' },
  { role: 'user', content: 'c' },
  { role: 'user', content: 'd' },
], { maxTokens: 1, keepRecent: 4 }) === false);

console.log('\n--- 断言：压缩行为（注入假摘要器）---');
const summarizer = async (msgs) => `【假摘要】压缩了 ${msgs.length} 条`;

const original = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '第一条' },
  { role: 'assistant', content: '第二条' },
  { role: 'user', content: '第三条' },
  { role: 'assistant', content: '第四条' },
  { role: 'user', content: '第五条' },
  { role: 'assistant', content: '第六条' },
];

const before = JSON.stringify(original);
const compressed = await compressHistory(original, { keepRecent: 4, summarizer });

check('没有修改入参', JSON.stringify(original) === before);
check('返回的条数正确（system + 摘要 + 4）', compressed.length === 6, `实际 ${compressed.length} 条`);
check('system 还在最前面', compressed[0]?.role === 'system' && compressed[0]?.content === '系统提示');
check('第二条是摘要消息', compressed[1]?.content?.includes('【假摘要】压缩了 2 条') ?? false, String(compressed[1]?.content));
check('摘要被标记为"不是新指令"', compressed[1]?.content?.includes('不是新的指令') ?? false);
check('最近 4 条原样保留', compressed[2]?.content === '第三条' && compressed[5]?.content === '第六条');

console.log('\n--- 断言：边界 ---');
const nothingToCompress = await compressHistory(original, { keepRecent: 10, summarizer });
check('没有可压缩内容时原样返回', nothingToCompress.length === original.length);
check('keepRecent 很大时不丢消息', nothingToCompress[1]?.content === '第一条');

check('空数组不炸', (await compressHistory([], { summarizer })).length === 0);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
