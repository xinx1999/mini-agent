// 端到端测试：起一个假模型接口，把 index.ts 完整跑一遍，然后断言。
//
// 跑法：  node test/run-test.mjs       （或 npm test）

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeLLM } from './fake-llm.mjs';
import { loadSession, saveSession } from '../src/memory.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const TEST_SESSION = '__run_test__';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

function runAgentCli() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['index.ts', '现在几点？算一下 (17 ** 0.5) * 3，再看看当前目录'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          LLM_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
          LLM_API_KEY: 'test-key',
          LLM_MODEL: 'fake-model',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const fake = createFakeLLM(PORT);

try {
  await fake.listen();
} catch (err) {
  console.error(`\n无法在 ${PORT} 端口启动假模型服务：${err.code ?? err.message}`);
  console.error('这个测试故意用固定端口、不自动换端口，免得"碰巧有别的服务在听"造成假绿。');
  console.error('请先释放该端口再重跑。\n');
  process.exit(1);
}

const result = await runAgentCli();
await fake.close();

console.log('\n--- 断言：agent 循环 ---');
check('CLI 正常退出', result.code === 0, `退出码 ${result.code}\n${result.out}`);
check('循环在正确的步数结束（共 4 次请求）', fake.stats.requests === 4, `实际请求 ${fake.stats.requests} 次`);
check('走完了 4 次工具调用', (result.out.match(/\[第 \d+ 步\]/g) ?? []).length === 4);
check(
  '协议正确：tool_call_id 都能对上',
  fake.stats.badToolCallIds.length === 0,
  `对不上的 id：${fake.stats.badToolCallIds.join(', ')}`,
);
check('不存在的工具被当成错误喂回模型', result.out.includes('不存在名为 fake_tool 的工具'));
check('工具结果确实回灌（最终答案里带出计算结果）', result.out.includes('12.369'));
check('返回了最终答案', result.out.includes('最终答案'));

console.log('\n--- 断言：可观测性 ---');
check('输出了开销统计', result.out.includes('本次开销') && result.out.includes('模型调用 4 次'));
check('失败的工具被计入统计', /工具调用 4 次（失败 1 次）/.test(result.out));
check('token 统计不为 0', /token 合计 [1-9]\d*/.test(result.out), result.out.match(/token 合计 \d+/)?.[0] ?? '没找到');

console.log('\n--- 断言：记忆读写 ---');
const testFile = join(ROOT, '.agent-memory', `${TEST_SESSION}.json`);
saveSession(TEST_SESSION, [
  { role: 'user', content: '第一条' },
  { role: 'system', content: '这条不该落盘' },
  { role: 'assistant', content: '第二条' },
]);
check('存盘后文件存在', existsSync(testFile));
const restored = loadSession(TEST_SESSION);
check('读回来条数正确（system 被剔除）', restored.length === 2, `实际 ${restored.length} 条`);
check('内容没丢', restored[0]?.content === '第一条' && restored[1]?.content === '第二条');
check('不存在的会话返回空数组', loadSession('__never_exists__').length === 0);

// 清理测试产生的文件，别把垃圾留在项目里
try {
  rmSync(testFile, { force: true });
} catch {
  console.warn('（测试存档清理失败，可手动删除 .agent-memory/' + TEST_SESSION + '.json）');
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
