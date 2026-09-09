import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { error: toastError } }),
}));

import { useApi } from '~/composables/useApi';

describe('useApi', () => {
  beforeEach(() => {
    toastError.mockClear();
    vi.stubGlobal('useI18n', () => ({ locale: { value: 'zh-CN' } }));
    vi.stubGlobal('useRoute', () => ({ path: '/problems', fullPath: '/problems' }));
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
