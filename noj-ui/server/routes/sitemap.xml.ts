// 动态 sitemap：从 noj-core 拉取公开资源，短 TTL 内存缓存后输出 XML。
// 避免引入额外依赖，适配 Deno 单二进制部署。

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 10;
const PER_PAGE = 100;

let cache: { at: number; body: string } | null = null;

interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

async function fetchAll<T extends { id: string }>(
  apiBase: string,
  path: string,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const res = await $fetch<{ data: T[]; total?: number }>(
      `${apiBase}${path}?page=${page}&per_page=${PER_PAGE}`,
    );
    const batch = res.data ?? [];
    items.push(...batch);
    const total = res.total ?? items.length;
    if (batch.length === 0 || items.length >= total || page * PER_PAGE >= total) break;
    page++;
  }
  return items;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default defineEventHandler(async (event) => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    setHeader(event, 'content-type', 'application/xml');
    return cache.body;
  }

  const config = useRuntimeConfig();
  const apiBase = config.apiBase as string;
  const protocol = event.headers.get('x-forwarded-proto') ?? 'http';
  const host = event.headers.get('host') ?? 'localhost:3000';
  const origin = `${protocol}://${host}`;

  const entries: SitemapEntry[] = [{ loc: `${origin}/` }];

  try {
    const [problems, contests, announcements] = await Promise.all([
      fetchAll<{ id: string; display_id?: string }>(apiBase, '/api/v1/problems'),
      fetchAll<{ id: string; public_id?: string }>(apiBase, '/api/v1/contests'),
      fetchAll<{ id: string; public_id?: string }>(apiBase, '/api/v1/announcements'),
    ]);

    for (const p of problems) {
      entries.push({ loc: `${origin}/problems/${p.display_id || p.id}` });
    }
    for (const c of contests) {
      entries.push({ loc: `${origin}/contests/${c.public_id || c.id}` });
    }
    for (const a of announcements) {
      entries.push({ loc: `${origin}/announcements/${a.public_id || a.id}` });
    }
  } catch {
    // core 不可达时返回已有缓存或仅首页，避免 sitemap 请求失败
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    entries
      .map((e) => `<url><loc>${escapeXml(e.loc)}</loc></url>`)
      .join('')
  }</urlset>`;

  cache = { at: now, body };
  setHeader(event, 'content-type', 'application/xml');
  return body;
});
