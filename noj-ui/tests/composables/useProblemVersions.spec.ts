import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { error: toastError } }),
}));

import { useApi } from '~/composables/useApi';
import { newIdempotencyKey, useProblemVersions } from '~/composables/useProblemVersions';

/**
 * 版本/草稿 API 层测试（Handbook §4.1/§4.3）。
 *
 * 重点验证**协议细节**：草稿与发布必须带 `If-Match` 乐观锁。
 * 批任务（重测/升级）相关用例随旧 `/admin/submission-jobs` 页面一并移除。
 */
describe('useProblemVersions', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { authCookiePrefix: 'noj' } }));
    toastError.mockClear();
    vi.stubGlobal('useApi', useApi);
    vi.stubGlobal('useRoute', () => ({ path: '/problems', fullPath: '/problems' }));
  });

  it('newIdempotencyKey 每次生成不同 UUID', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('保存草稿带 If-Match，发布同理', async () => {
    const fetchMock = vi.fn(() => ({ data: { revision: 3 } }));
    vi.stubGlobal('$fetch', fetchMock);
    const versions = useProblemVersions();

    await versions.saveDraft('p1', { kind: 'ai' }, 2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/problems/p1/draft',
      expect.objectContaining({
        method: 'put',
        body: { content: { kind: 'ai' } },
        headers: { 'If-Match': '2' },
      }),
    );

    await versions.publish('p1', 3, '补充边界数据');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/problems/p1/versions',
      expect.objectContaining({
        method: 'post',
        body: { change_note: '补充边界数据' },
        headers: { 'If-Match': '3' },
      }),
    );
  });
});
