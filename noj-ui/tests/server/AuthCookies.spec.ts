import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const fetchApi = vi.fn(), remove = vi.fn();
let handler: typeof import('~/server/api/auth/logout.post').default;
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (operation: unknown) => operation);
  handler = (await import('~/server/api/auth/logout.post')).default;
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBase: 'http://core', public: { authCookiePrefix: 'school' } }));
  vi.stubGlobal('parseCookies', () => ({ 'school:token': 'own-test-token', 'noj:token': 'other-test-token' }));
  vi.stubGlobal('deleteCookie', remove);
  vi.stubGlobal('$fetch', fetchApi);
});
describe('独立套件退出登录', () => {
  it('只撤销与清除本套件身份，保留同主机其他套件', async () => {
    await handler({} as Parameters<typeof handler>[0]);
    expect(fetchApi).toHaveBeenCalledWith('http://core/api/v1/auth/logout', {
      method: 'POST',
      headers: { authorization: 'Bearer own-test-token' },
    });
    expect(remove.mock.calls.map((call) => call[1])).toEqual(['school:token', 'school:session']);
  });
  it('没有本套件令牌时不撤销其他套件令牌', async () => {
    vi.stubGlobal('parseCookies', () => ({ 'noj:token': 'other-test-token' }));
    await handler({} as Parameters<typeof handler>[0]);
    expect(fetchApi).not.toHaveBeenCalled();
    expect(remove.mock.calls.map((call) => call[1])).toEqual(['school:token', 'school:session']);
  });
});
