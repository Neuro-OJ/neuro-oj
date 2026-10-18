import { readProblemSummaries } from './bff-problem-summaries.ts';
import { BffError, createCoreReader } from './bff-request.ts';
import { authCookieNames } from '../../utils/auth-cookies.ts';
import { getClientNetworkHeaders } from './client-network.ts';
import { getCookie, getQuery, getRouterParam, type H3Event, setHeader, setResponseStatus } from 'h3';
/** 编辑与翻页的摘要请求同样不缓存私有数据，不接受客户端指定上游地址。 */
export async function handleProblemSummaries(event: H3Event) {
  setHeader(event, 'cache-control', 'private, no-store');
  const config = useRuntimeConfig(event), slug = getRouterParam(event, 'slug');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  const cancel = () => controller.abort();
  event.node.res.once('close', cancel);
  try {
    if (!slug || /[/.\\]/.test(slug)) throw new BffError(400, { error: '无效的空间', code: 'BFF_INVALID_PATH' });
    const input = getQuery(event).reference;
    const references = typeof input === 'string'
      ? [input]
      : Array.isArray(input) && input.every((value) => typeof value === 'string')
      ? input as string[]
      : [];
    const reader = createCoreReader({
      base: String(config.apiBase),
      token: getCookie(event, authCookieNames(config.public.authCookiePrefix).token),
      signal: controller.signal,
      headers: getClientNetworkHeaders(event),
    });
    return await readProblemSummaries(reader, slug, references);
  } catch (error) {
    if (!(error instanceof BffError)) throw error;
    setResponseStatus(event, error.statusCode);
    return error.data;
  } finally {
    clearTimeout(timer);
    event.node.res.removeListener('close', cancel);
    controller.abort();
  }
}
