import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchApi = vi.fn();
let handler: typeof import('~/server/routes/sitemap.xml').default;
let problems: Array<{ reference: { display_ref: string } }>, contestCount: number;
const headers = new Map<string, string>();
let denied = false;
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (operation: unknown) => operation);
  handler = (await import('~/server/routes/sitemap.xml')).default;
});
beforeEach(() => {
  headers.clear();
  vi.clearAllMocks();
  denied = false;
  problems = [{ reference: { display_ref: '1001' } }];
  contestCount = 1;
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBase: 'http://core', siteUrl: 'https://noj.example.com' }));
  vi.stubGlobal('setHeader', (_event: unknown, key: string, value: string) => headers.set(key, value));
  vi.stubGlobal('setResponseStatus', vi.fn());
  vi.stubGlobal('$fetch', fetchApi);
  fetchApi.mockImplementation((input: string) => {
    const url = new URL(input), page = Number(url.searchParams.get('page'));
    if (denied) throw { statusCode: 403, message: '匿名访问已关闭' };
    if (url.pathname === '/api/v1/domains/main/problems') {
      expect(url.searchParams.get('limit')).toBe('100');
      return { items: problems.slice((page - 1) * 100, page * 100), total: problems.length };
    }
    if (url.pathname === '/api/v1/domains/main/contests') {
      expect(url.searchParams.get('per_page')).toBe('100');
      return {
        data: Array.from(
          { length: Math.min(100, Math.max(0, contestCount - (page - 1) * 100)) },
          (_, i) => ({ id: `contest-${(page - 1) * 100 + i}` }),
        ),
        pagination: { total_pages: Math.ceil(contestCount / 100) },
      };
    }
    if (url.pathname === '/api/v1/announcements') return { data: [], meta: { total_pages: 0 } };
    throw new Error(`未授权的测试路径: ${url.pathname}`);
  });
});
function request() {
  return { headers: new Headers({ host: 'evil.example', cookie: 'noj:session=private-user' }) } as Parameters<
    typeof handler
  >[0];
}
describe('sitemap 的即时公开授权', () => {
  it('只读取匿名main入口，输出显式域URL，不转发访问者Cookie', async () => {
    const xml = await handler(request());
    expect(xml).toContain('https://noj.example.com/d/main/problems/1001');
    expect(xml).toContain('https://noj.example.com/d/main/contests/contest-0');
    expect(xml).not.toContain('evil.example');
    expect(fetchApi.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(headers.get('cache-control')).toBe('no-store');
  });
  it('资源撤销后下次请求不复用旧目录，来源引用仍保留使用域', async () => {
    expect(await handler(request())).toContain('/problems/1001');
    problems = [{ reference: { display_ref: 'source:2001' } }];
    contestCount = 0;
    const xml = await handler(request());
    expect(xml).not.toContain('/problems/1001');
    expect(xml).not.toContain('contest-0');
    expect(xml).toContain('/d/main/problems/source:2001');
    expect(fetchApi).toHaveBeenCalledTimes(6);
  });
  it('main或实例停止匿名访问、以及上游故障时不能返回之前的完整目录', async () => {
    await handler(request());
    denied = true;
    await expect(handler(request())).rejects.toMatchObject({ statusCode: 403 });
    denied = false;
    fetchApi.mockRejectedValue(new Error('上游不可用'));
    await expect(handler(request())).rejects.toThrow('上游不可用');
    expect(headers.get('cache-control')).toBe('no-store');
  });
  it('读取真实分页契约，超过一页的公开资源不会被错误截断', async () => {
    problems = Array.from({ length: 101 }, (_, i) => ({ reference: { display_ref: String(1001 + i) } }));
    contestCount = 101;
    const xml = await handler(request());
    expect(xml).toContain('/d/main/problems/1101');
    expect(xml).toContain('/d/main/contests/contest-100');
    expect(fetchApi.mock.calls.filter((call) => new URL(call[0]).searchParams.get('page') === '2')).toHaveLength(2);
  });
});
