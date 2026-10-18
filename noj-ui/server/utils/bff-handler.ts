import type { H3Event } from 'h3';
import { getCookie, getQuery, getRouterParam, setHeader, setResponseStatus } from 'h3';
import type { BffViewKind } from '../../utils/bff-view.ts';
import type { BffCacheStore } from './bff-cache.ts';
import { cachedSiteMeta } from './bff-cache.ts';
import { aggregateView } from './bff-aggregate.ts';
import { BffError, createCoreReader } from './bff-request.ts';
import { getClientNetworkHeaders } from './client-network.ts';
import { authCookieNames } from '../../utils/auth-cookies.ts';

/** 所有 BFF GET 使用同一身份、总预算和诊断计数。 */
export async function handleBffView(event: H3Event, kind: BffViewKind) {
  setHeader(event, 'cache-control', 'private, no-store');
  const config = useRuntimeConfig(event);
  const token = getCookie(event, authCookieNames(config.public.authCookiePrefix).token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const disconnected = () => controller.abort();
  event.node.res.once('close', disconnected);
  let requests = 0;
  let cacheState = 'bypass';
  const started = performance.now();
  const reader = createCoreReader({
    base: config.apiBase as string,
    token,
    headers: getClientNetworkHeaders(event),
    signal: controller.signal,
    onRequest: () => {
      requests++;
    },
  });
  try {
    const query = getQuery(event);
    const slug = getRouterParam(event, 'slug');
    const id = getRouterParam(event, kind === 'classroom' ? 'classroomId' : 'assignmentId');
    if (!slug || /[/.\\]/.test(slug) || (id && /[/.\\]/.test(id))) {
      throw new BffError(400, { error: '无效的资源标识', code: 'BFF_INVALID_PATH' });
    }
    const store = event.context.bffCacheStore as BffCacheStore | undefined;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(config.apiBase)));
    const upstream = Array.from(new Uint8Array(digest)).map((v) => v.toString(16).padStart(2, '0')).join('');
    const key = `${config.bffCachePrefix}:${upstream}:site-meta`;
    const result = await aggregateView(
      reader,
      {
        kind,
        slug,
        id,
        authenticated: !!token,
        help: typeof query.help === 'string' ? query.help : undefined,
        feedback: typeof query.feedback === 'string' ? query.feedback : undefined,
        history: query.history === '1',
      },
      () =>
        cachedSiteMeta(
          store ?? null,
          key,
          () => reader.get('/api/v1/site/meta', { anonymous: true, timeout: 2000 }),
          (state) => {
            cacheState = state;
          },
        ),
    );
    const degraded = Object.values(result.sections).filter((section) => section?.error).length;
    setHeader(
      event,
      'server-timing',
      `bff;dur=${
        (performance.now() - started).toFixed(1)
      }, core;desc="${requests} requests", cache;desc="${cacheState}", degraded;desc="${degraded} sections"`,
    );
    return result;
  } catch (error) {
    if (!(error instanceof BffError)) throw error;
    setResponseStatus(event, error.statusCode);
    for (const [name, value] of Object.entries(error.headers)) setHeader(event, name, value);
    return error.data;
  } finally {
    clearTimeout(timer);
    event.node.res.removeListener('close', disconnected);
    controller.abort();
  }
}
