// 动态 sitemap：从 noj-core 拉取公开资源，短 TTL 内存缓存后输出 XML。
// 避免引入额外依赖，适配 Deno 单二进制部署。
//
// ── 2026-09-12 架构评审 §4.2 修复 ────────────────────────────────
// 原实现把**请求 Host 头**拼出的 origin 写入**进程级**缓存（TTL 1h）：
// 伪造一次 `Host: evil.com` 即可把 `<loc>https://evil.com/...</loc>` 钉住一小时，
// 影响所有访客与搜索引擎（缓存投毒）。
// 现在的做法：
//   1. 优先使用配置的权威地址 `runtimeConfig.siteUrl`（来自 NUXT_SITE_URL）；
//   2. 未配置时退化为"按 origin 分键缓存 + 形状校验"，投毒只能污染伪造者自己那个键；
//   3. 上游不可达的降级结果**不写缓存**（避免把"只有首页"的残缺 sitemap 固化一小时）；
//   4. 显式声明 `cache-control`，让 CDN/爬虫有明确语义。

import { resolveOrigin } from '../utils/sitemap-origin';

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PAGES = 10;
const PER_PAGE = 100;

/** origin → 缓存条目。按 origin 分键，避免 Host 头互相污染。 */
const cache = new Map<string, { at: number; body: string }>();

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
  const config = useRuntimeConfig();
  const apiBase = config.apiBase as string;
  const origin = resolveOrigin(
    config.siteUrl as string | undefined,
    event.headers.get('x-forwarded-proto'),
    event.headers.get('host'),
  );

  if (!origin) {
    // 既无权威配置、Host 头又不可用：宁可报错也不要产出被投毒的 URL
    setResponseStatus(event, 400);
    return 'invalid host';
  }

  const cached = cache.get(origin);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    setHeader(event, 'content-type', 'application/xml');
    setHeader(event, 'cache-control', 'public, max-age=3600');
    return cached.body;
  }

  const entries: SitemapEntry[] = [{ loc: `${origin}/` }];
  let degraded = false;

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
    // core 不可达：降级为仅首页，且**不写缓存**（见文件头第 3 点）
    degraded = true;
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    entries
      .map((e) => `<url><loc>${escapeXml(e.loc)}</loc></url>`)
      .join('')
  }</urlset>`;

  if (degraded) {
    setHeader(event, 'content-type', 'application/xml');
    setHeader(event, 'cache-control', 'no-store');
    if (cached) {
      // 有完整旧缓存时优先返回旧内容，避免"只有首页"的残缺 sitemap 被收录
      setHeader(event, 'cache-control', 'public, max-age=60');
      return cached.body;
    }
    return body;
  }

  cache.set(origin, { at: now, body });
  setHeader(event, 'content-type', 'application/xml');
  setHeader(event, 'cache-control', 'public, max-age=3600');
  return body;
});
