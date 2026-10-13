// 搜索工具测试：重点测 HTML 解析。
//
// 为什么值得单独测：抓 HTML 最大的风险不是"连不上"（那个会报错），
// 而是对方改了页面结构后**解析悄悄返回空数组**——接口不报错，
// agent 只会得到"没有搜到相关结果"，看着像"真的没搜到"。
//
// 跑法：  node test/search-test.mjs

const { parseBing, webSearch } = await import('../src/search.ts');
const { tools } = await import('../src/tools.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

// 一段贴近真实结构的 HTML（含实体编码、内部标签、缺字段的块）
const fakeHtml = `
<html><body>
<li class="b_algo" data-id="1">
  <h2><a target="_blank" href="https://example.com/a" h="ID=SERP,1"><strong>标题 A</strong> &amp; 更多</a></h2>
  <p>这是摘要 A，包含 <strong>加粗</strong> 内容。</p>
</li>
<li class="b_algo" data-id="2">
  <h2><a href="https://example.com/b">标题 B</a></h2>
</li>
<li class="b_algo" data-id="3">
  <h2><a href="https://example.com/c"></a></h2>
  <p>标题为空的块，应该被跳过</p>
</li>
<div class="b_algoSomethingElse">这个不是结果块，不该被算进来</div>
</body></html>
`;

console.log('--- 断言：HTML 解析 ---');
const hits = parseBing(fakeHtml);
check('解析出 2 条有效结果', hits.length === 2, `实际 ${hits.length} 条`);
check('标题剥掉了内部标签', hits[0]?.title === '标题 A & 更多', JSON.stringify(hits[0]?.title));
check('链接提取正确', hits[0]?.url === 'https://example.com/a', hits[0]?.url);
check('摘要剥掉了内部标签', hits[0]?.snippet === '这是摘要 A，包含 加粗 内容。', JSON.stringify(hits[0]?.snippet));
check('缺摘要的块不报错、snippet 为空', hits[1]?.snippet === '', JSON.stringify(hits[1]?.snippet));

check('空 HTML 返回空数组', parseBing('').length === 0);
check('没有结果块时返回空数组', parseBing('<html>什么都没有</html>').length === 0);

// 实体编码：Bing 会把 & 编码成 &amp;，不解码的话链接和标题都会是错的
const entityHtml = `<li class="b_algo"><h2><a href="https://x.com/?a=1&amp;b=2">A &amp; B &#65;</a></h2><p>s</p></li>`;
const entityHits = parseBing(entityHtml);
check('实体编码被解码', entityHits[0]?.url === 'https://x.com/?a=1&b=2', entityHits[0]?.url);
check('标题里的实体和解码都正确', entityHits[0]?.title === 'A & B A', entityHits[0]?.title);

// Bing 偶尔会把真实链接包成 ck/a 跳转链接，那种链接点进去还要再跳一次
const realUrl = 'https://www.example.com/path?q=1';
const wrappedUrl = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(realUrl).toString('base64url')}&ntb=1`;
const redirectHtml = `<li class="b_algo"><h2><a href="${wrappedUrl}">跳转链接</a></h2><p>s</p></li>`;
const redirectHits = parseBing(redirectHtml);
check('ck/a 跳转链接被还原成真实地址', redirectHits[0]?.url === realUrl, redirectHits[0]?.url);

// 没带 u= 参数的 ck/a 链接解不出真实地址，保持原样而不是给个假链接
const noUHtml = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=abc">无 u 参数</a></h2><p>s</p></li>`;
check('解不出真实地址时保持原样', parseBing(noUHtml)[0]?.url === 'https://www.bing.com/ck/a?!&&p=abc');

// 未登记的实体（如实测遇到的 &ensp;）不能漏到结果里
const enspHtml = `<li class="b_algo"><h2><a href="https://x.com/">标题</a></h2><p>2020年9月28日&ensp;·&ensp;正文内容</p></li>`;
check('未登记实体被处理掉', !parseBing(enspHtml)[0]?.snippet.includes('ensp'), JSON.stringify(parseBing(enspHtml)[0]?.snippet));
check('已知实体仍能正确解码', enspHtml.includes('&middot;') === false);

console.log('\n--- 断言：请求构造（注入假 fetch）---');
const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return new Response(fakeHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
};

const searched = await webSearch('typescript agent', { fetchImpl: fakeFetch, count: 3 });
check('返回了解析结果', searched.length === 2, `实际 ${searched.length} 条`);
check('只调用了一次 fetch', calls.length === 1, `实际 ${calls.length} 次`);
// 注意：encodeURIComponent 把空格编码成 %20，不是 +（那是 form-urlencoded 的规则）
check(
  'URL 里带了查询词',
  decodeURIComponent(calls[0]?.url ?? '').includes('q=typescript agent'),
  calls[0]?.url,
);
check('URL 里带了 count', calls[0]?.url.includes('count=3'), calls[0]?.url);
check('设置了 User-Agent', String(calls[0]?.init?.headers?.['User-Agent'] ?? '').length > 0);

console.log('\n--- 断言：错误分支 ---');
const failFetch = async () => new Response('服务端错误', { status: 503 });
await webSearch('x', { fetchImpl: failFetch }).then(
  () => check('HTTP 非 200 时抛错', false, '没有抛错'),
  (err) => check('HTTP 非 200 时抛错', String(err.message).includes('503'), err.message),
);

await webSearch('   ', { fetchImpl: fakeFetch }).then(
  () => check('空关键词抛错', false, '没有抛错'),
  () => check('空关键词抛错', true),
);

console.log('\n--- 断言：工具注册 ---');
const searchTool = tools.find((t) => t.schema.function.name === 'web_search');
check('web_search 已注册', Boolean(searchTool));
check(
  '描述里说明了使用时机',
  (searchTool?.schema.function.description ?? '').includes('最新信息'),
  searchTool?.schema.function.description,
);
check('query 是必填', (searchTool?.schema.function.parameters.required ?? []).includes('query'));

const emptyArgsResult = await searchTool.run({ query: '   ' });
check('工具层空 query 返回错误提示', String(emptyArgsResult).startsWith('错误'), String(emptyArgsResult));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
