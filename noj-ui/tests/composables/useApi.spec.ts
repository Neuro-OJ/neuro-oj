import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { error: toastError } }),
}));

import { useApi } from '~/composables/useApi';
import { ref } from 'vue';
import { domainAnswerKey } from '~/utils/domain-problems';

describe('useApi', () => {
  beforeEach(() => {
    localStorage.clear();
    toastError.mockClear();
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { authCookiePrefix: 'noj' } }));
    vi.stubGlobal('useRoute', () => ({ path: '/problems', fullPath: '/problems' }));
  });

  it.each([true, false])('普通 API 的 401 清理账号与旧草稿（user 已恢复：%s）', async (hasUser) => {
    const user = ref(hasUser ? { id: 'student' } : null);
    const session = ref<{ userId: string } | null>({ userId: 'student' });
    const ownKey = `noj:draft:${domainAnswerKey('student', 'school', 'p', 'v1', 'cc')}`;
    const guestKey = `noj:draft:${domainAnswerKey('anonymous', 'school', 'p', 'v1', 'cc')}`;
    for (const key of [ownKey, guestKey, 'noj:draft:old']) localStorage.setItem(key, 'draft');
    vi.stubGlobal('useState', () => user);
    vi.stubGlobal('useCookie', () => session);
    const navigate = vi.fn();
    vi.stubGlobal('navigateTo', navigate);
    vi.stubGlobal(
      '$fetch',
      vi.fn((url: string) => url === '/api/auth/logout' ? Promise.resolve() : Promise.reject({ status: 401 })),
    );
    await expect(useApi().api.get('/api/v1/problems/p', { silent: true })).rejects.toEqual({ status: 401 });
    expect(user.value).toBeNull();
    expect(session.value).toBeNull();
    expect(localStorage.getItem(ownKey)).toBeNull();
    expect(localStorage.getItem('noj:draft:old')).toBeNull();
    expect(localStorage.getItem(guestKey)).toBe('draft');
    expect(navigate).toHaveBeenCalledWith({ path: '/login', query: { redirect: '/problems' } });
  });

  it('成功请求返回数据', async () => {
    vi.stubGlobal('$fetch', vi.fn(() => ({ ok: true })));
    const { api } = useApi();
    const data = await api.get('/api/v1/health');
    expect(data).toEqual({ ok: true });
  });

  it('非 2xx 错误提取 message 并重抛', async () => {
    const err = new Error('fetch error') as Error & { data?: unknown; status?: number };
    err.data = { error: '题目不存在' };
    err.status = 404;
    vi.stubGlobal(
      '$fetch',
      vi.fn(() => {
        throw err;
      }),
    );
    const { api } = useApi();
    await expect(api.get('/api/v1/problems/x')).rejects.toThrow('fetch error');
    expect(toastError).toHaveBeenCalledWith('题目不存在');
  });

  it('silent 模式不弹 toast', async () => {
    const err = new Error('fetch error') as Error & { data?: unknown; status?: number };
    err.data = { error: '内部错误' };
    err.status = 500;
    vi.stubGlobal(
      '$fetch',
      vi.fn(() => {
        throw err;
      }),
    );
    const { api } = useApi();
    await expect(api.get('/api/v1/x', { silent: true })).rejects.toThrow();
    expect(toastError).not.toHaveBeenCalled();
  });
});
