// 公开目录每次由 core 以匿名身份重新授权，不缓存可被撤销的资源定位。
import { resolveOrigin } from '../utils/sitemap-origin';
import { workspacePath, workspaceProblemPath } from '../../utils/workspace';
import type { DomainProblemReference } from '../../utils/domain-problems';

const MAX_PAGES = 10;
const PER_PAGE = 100;

async function publicProblems(apiBase: string) {
  const items: { reference: DomainProblemReference }[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await $fetch<{ items: typeof items; total: number }>(
      `${apiBase}/api/v1/domains/main/problems?page=${page}&limit=${PER_PAGE}`,
    );
    items.push(...result.items);
    if (!result.items.length || items.length >= result.total) break;
  }
  return items;
}

/** 比赛返回 pagination，公告返回 meta；两者均不携带访问者 Cookie。 */
async function publicPages<T extends { id: string }>(apiBase: string, path: string) {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await $fetch<
      & { data: T[] }
      & (
        { pagination: { total_pages: number } } | { meta: { total_pages: number } }
      )
    >(
      `${apiBase}${path}?page=${page}&per_page=${PER_PAGE}`,
    );
    items.push(...result.data);
    const pagination = 'pagination' in result ? result.pagination : result.meta;
    if (!result.data.length || page >= pagination.total_pages) break;
  }
  return items;
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store');
  const config = useRuntimeConfig();
  const origin = resolveOrigin(
    config.siteUrl as string | undefined,
    event.headers.get('x-forwarded-proto'),
    event.headers.get('host'),
  );
  if (!origin) {
    setResponseStatus(event, 400);
    return 'invalid host';
  }
  const apiBase = config.apiBase as string;
  const [problems, contests, announcements] = await Promise.all([
    publicProblems(apiBase),
    publicPages<{ id: string }>(apiBase, '/api/v1/domains/main/contests'),
    publicPages<{ id: string; public_id?: string }>(apiBase, '/api/v1/announcements'),
  ]);
  const paths = [
    '/',
    ...problems.map((p) => workspaceProblemPath('main', p.reference.display_ref)),
    ...contests.map((c) => workspacePath('main', `contests/${c.id}`)),
    ...announcements.map((a) => `/announcements/${encodeURIComponent(a.public_id ?? a.id)}`),
  ];
  setHeader(event, 'content-type', 'application/xml');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    paths.map((path) => `<url><loc>${escapeXml(`${origin}${path}`)}</loc></url>`).join('')
  }</urlset>`;
});
