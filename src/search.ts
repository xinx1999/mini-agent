// 联网搜索：抓 Bing 的结果页，解析出标题、链接、摘要。
//
// 为什么选 Bing：免 key、全球可达（部署沙箱在新加坡，访问它没问题）、
// 结果页结构多年稳定。
//
// 但要说清代价：这是"抓 HTML"而不是正规 API——对方改一次页面结构，
// 这里就得跟着改。所以解析部分刻意写得宽松：**拿不到的字段就留空，
// 跳过那一条，而不是让整次搜索失败**。一次搜索里有 8 条能解析出来、
// 2 条失败，远好过整体报错。
//
// `fetchImpl` 可注入：测试里塞假数据，不用真的去打网络。

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
};

function decodeEntities(text: string): string {
  return (
    text
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      // 已登记的实体按表解，没登记的替换成空格——
      // 宁可丢掉，也别让 &ensp; 这种原文漏到结果里
      .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
        const known = NAMED_ENTITIES[name.toLowerCase()];
        return known === undefined ? ' ' : known;
      })
  );
}

/**
 * Bing 有时会把真实链接包装成 bing.com/ck/a?...&u=a1<base64> 的跳转链接。
 * 那种链接对用户没用——点进去还要再跳一次，而且带一堆跟踪参数。
 * u= 参数里 base64url 编码的才是真实地址（前缀 a1 是 Bing 的标记）。
 */
function unwrapBingRedirect(href: string): string {
  if (!href.includes('/ck/a')) return href;

  const match = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (!match) return href;

  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
    return /^https?:\/\//.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** 解析 Bing 结果页。宽松匹配，解析不出来就跳过那一条 */
export function parseBing(html: string): SearchHit[] {
  // 每条结果是一个 <li class="b_algo" ...>，用 split 切开比正则匹配整块更稳
  const blocks = html.split(/<li[^>]*class="[^"]*b_algo[^"]*"/).slice(1);

  const hits: SearchHit[] = [];

  for (const block of blocks) {
    // 标题和链接在块内第一个 <h2><a href="..."> 里
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const url = unwrapBingRedirect(decodeEntities(linkMatch[1])).trim();
    const title = stripTags(decodeEntities(linkMatch[2])).replace(/\s+/g, ' ').trim();

    if (!title || !url) continue;

    // 摘要在 <p> 里，可能跨标签
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = snippetMatch
      ? stripTags(decodeEntities(snippetMatch[1])).replace(/\s+/g, ' ').trim()
      : '';

    hits.push({ title, url, snippet });
  }

  return hits;
}

export interface SearchOptions {
  count?: number;
  /** 测试时注入假 fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function webSearch(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('搜索关键词不能为空');

  const fetchImpl = options.fetchImpl ?? fetch;
  const count = Math.min(Math.max(1, Math.trunc(options.count ?? 5)), 10);

  const res = await fetchImpl(
    `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}&count=${count}`,
    {
      headers: {
        // Bing 对没有 UA 的请求会返回一个空壳页面
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    },
  );

  if (!res.ok) {
    throw new Error(`搜索接口返回 HTTP ${res.status}`);
  }

  const html = await res.text();
  return parseBing(html).slice(0, count);
}
