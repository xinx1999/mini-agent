// 文档加载：把 docs/ 目录里的 .md 和 .txt 读成检索分块。
//
// 每次检索都重新读一遍。文档不多时这点开销可以忽略，换来的是
// "改完文档立刻生效"——省掉一层缓存失效的麻烦。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { splitIntoChunks, type Chunk } from './rag.ts';

const EXTS = new Set(['.md', '.txt', '.markdown']);

export function loadDocs(dir: string = resolve(process.cwd(), 'docs')): Chunk[] {
  if (!existsSync(dir)) return [];

  const out: Chunk[] = [];

  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);

      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue; // 读不到的条目跳过，别让整个检索挂掉
      }

      if (isDirectory) {
        walk(full);
        continue;
      }

      if (!EXTS.has(extname(name).toLowerCase())) continue;

      try {
        const text = readFileSync(full, 'utf8');
        out.push(...splitIntoChunks(text, name));
      } catch (err) {
        console.warn(`[docs] ${name} 读取失败，已跳过：${err instanceof Error ? err.message : err}`);
      }
    }
  };

  walk(dir);
  return out;
}
