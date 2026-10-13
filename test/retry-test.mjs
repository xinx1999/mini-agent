// 失败处理测试：重试策略、退避算法、上下文超长识别。
//
// 跑法：  node test/retry-test.mjs

const { isRetryableStatus, computeBackoff, fetchWithRetry } = await import('../src/llm.ts');
const { isContextLengthError } = await import('../src/compress.ts');

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

console.log('--- 断言：哪些错误值得重试 ---');
check('429 限流可重试', isRetryableStatus(429) === true);
check('408 超时可重试', isRetryableStatus(408) === true);
check('500/502/503 服务端错误可重试', isRetryableStatus(500) && isRetryableStatus(502) && isRetryableStatus(503));
// 4xx（除 408/429）是"请求本身有问题"，重试多少次都一样
check('400 不重试', isRetryableStatus(400) === false);
check('401 不重试', isRetryableStatus(401) === false);
check('404 不重试', isRetryableStatus(404) === false);
check('200 不重试', isRetryableStatus(200) === false);

console.log('\n--- 断言：退避策略 ---');
const back1 = computeBackoff(1, 800);
const back2 = computeBackoff(2, 800);
const back3 = computeBackoff(3, 800);
check('退避随次数指数增长', back2 > back1 && back3 > back2, `${back1} / ${back2} / ${back3}`);
check('退避有上限', computeBackoff(20, 800) <= 30000, String(computeBackoff(20, 800)));
const samples = new Set([computeBackoff(3, 200), computeBackoff(3, 200), computeBackoff(3, 200), computeBackoff(3, 200), computeBackoff(3, 200)]);
check('退避带抖动（不会每次相同）', samples.size > 1, [...samples].join(','));

console.log('\n--- 断言：上下文超长识别 ---');
check('识别 context length', isContextLengthError(new Error('maximum context length is 4096')) === true);
check('识别 too many tokens', isContextLengthError(new Error('too many tokens in prompt')) === true);
check('识别中文文案', isContextLengthError(new Error('上下文长度超出限制')) === true);
check('普通错误不误判', isContextLengthError(new Error('HTTP 500 服务端错误')) === false);
check('非 Error 也能处理', isContextLengthError('context length exceeded') === true);

console.log('\n--- 断言：fetchWithRetry ---');
const realFetch = globalThis.fetch;
let callCount = 0;

try {
  // 场景 1：第一次 429，第二次成功
  callCount = 0;
  globalThis.fetch = async () =>
    callCount++ === 0 ? new Response('限流', { status: 429 }) : new Response('ok', { status: 200 });

  const ok = await fetchWithRetry('http://x/', {}, { baseDelayMs: 1 });
  check('429 后重试成功', ok.status === 200);
  check('共请求 2 次', callCount === 2, `实际 ${callCount} 次`);

  // 场景 2：一直 429，最终抛错
  callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response('请求过于频繁', { status: 429 });
  };

  let caught;
  try {
    await fetchWithRetry('http://x/', {}, { maxAttempts: 3, baseDelayMs: 1 });
  } catch (err) {
    caught = err;
  }
  check('持续失败最终抛错', caught !== undefined);
  check('尝试满 3 次', callCount === 3, `实际 ${callCount} 次`);
  check('错误信息带状态码', String(caught?.message).includes('429'), String(caught?.message));
  check('错误信息带上一次原文', String(caught?.message).includes('请求过于频繁'), String(caught?.message));

  // 场景 3：400 属于请求本身有问题，一次都不重试
  callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response('参数错误', { status: 400 });
  };
  const badRequest = await fetchWithRetry('http://x/', {}, { baseDelayMs: 1 });
  check('400 直接返回不重试', badRequest.status === 400);
  check('400 只请求 1 次', callCount === 1, `实际 ${callCount} 次`);

  // 场景 4：网络层错误（抛异常）也重试
  callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error('connect ECONNREFUSED');
    return new Response('ok', { status: 200 });
  };
  const netOk = await fetchWithRetry('http://x/', {}, { baseDelayMs: 1 });
  check('网络错误后重试成功', netOk.status === 200 && callCount === 2, `实际 ${callCount} 次`);

  // 场景 5：持续网络错误，抛原始错误（不吞）
  callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    throw new Error('boom');
  };
  let netErr;
  try {
    await fetchWithRetry('http://x/', {}, { maxAttempts: 2, baseDelayMs: 1 });
  } catch (err) {
    netErr = err;
  }
  // 持续网络错误：不再把 "boom" 这种裸错误抛出去，而是带上尝试的地址。
  // 因为裸的 fetch failed / ECONNREFUSED 说明不了问题，最常见真因是 base_url 写错
  check('持续网络错误时错误带上了请求地址', String(netErr?.message).includes('http://x/'), String(netErr?.message));
  check('持续网络错误时保留了原始错误', String(netErr?.message).includes('boom'), String(netErr?.message));

  // 场景 6：onRetry 回调
  callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return new Response('限流', { status: 429 });
  };
  const retries = [];
  await fetchWithRetry('http://x/', {}, {
    maxAttempts: 3,
    baseDelayMs: 1,
    onRetry: (info) => retries.push(info),
  }).catch(() => {});
  check('onRetry 触发 2 次（最后一次不再重试）', retries.length === 2, `实际 ${retries.length} 次`);
  check('onRetry 带上了状态码', retries[0]?.status === 429, JSON.stringify(retries[0]));
  check('onRetry 带上了退避时长', typeof retries[0]?.delayMs === 'number');
} finally {
  // 无论测试结果如何，真实 fetch 必须还原
  globalThis.fetch = realFetch;
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
