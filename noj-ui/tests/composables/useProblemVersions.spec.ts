import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.fn();

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { error: toastError } }),
}));

import { isJobTerminal, newIdempotencyKey, useProblemVersions } from '~/composables/useProblemVersions';

/**
 * 版本/草稿/批任务 API 层测试（Handbook §4.1/§4.3/§4.5）。
 *
 * 重点验证**协议细节**：草稿与发布必须带 `If-Match` 乐观锁、批任务受理必须带
 * `Idempotency-Key`、终态判定与轮询只依赖持久化任务状态。
 */
describe('useProblemVersions', () => {
  beforeEach(() => {
    toastError.mockClear();
    vi.stubGlobal('useI18n', () => ({ locale: { value: 'zh-CN' } }));
    vi.stubGlobal('useRoute', () => ({ path: '/problems', fullPath: '/problems' }));
  });

  it('isJobTerminal 只认两种完成态', () => {
    expect(isJobTerminal('completed')).toBe(true);
    expect(isJobTerminal('completed_with_errors')).toBe(true);
    expect(isJobTerminal('queued')).toBe(false);
    expect(isJobTerminal('running')).toBe(false);
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

  it('批任务受理必须携带 Idempotency-Key，并原样透传范围与目标', async () => {
    const fetchMock = vi.fn(() => ({ data: { job_id: 'j1', status: 'queued', total_items: 2 } }));
    vi.stubGlobal('$fetch', fetchMock);
    const versions = useProblemVersions();

    const accepted = await versions.acceptRejudgeJob(
      {
        kind: 'rejudge',
        scope: {
          type: 'selected',
          submissions: [{ kind: 'submission', id: 's1' }],
        },
        target: { mode: 'latest' },
      },
      'key-1',
    );
    expect(accepted.job_id).toBe('j1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/submission-jobs',
      expect.objectContaining({
        method: 'post',
        headers: { 'Idempotency-Key': 'key-1' },
        body: expect.objectContaining({
          kind: 'rejudge',
          target: { mode: 'latest' },
        }),
      }),
    );
  });

  it('升级任务受理带 context 与幂等键', async () => {
    const fetchMock = vi.fn(() => ({ data: { job_id: 'j2', status: 'queued', total_items: 1 } }));
    vi.stubGlobal('$fetch', fetchMock);
    const versions = useProblemVersions();

    await versions.acceptUpgradeJob(
      [{ kind: 'objective', id: 'o1' }],
      'practice',
      'key-2',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/submission-upgrade-jobs',
      expect.objectContaining({
        method: 'post',
        headers: { 'Idempotency-Key': 'key-2' },
        body: {
          submissions: [{ kind: 'objective', id: 'o1' }],
          context: 'practice',
        },
      }),
    );
  });

  it('waitForJobTerminal 轮询到终态即返回（不依赖进程内计数）', async () => {
    const statuses = ['queued', 'running', 'completed'];
    let index = 0;
    vi.stubGlobal(
      '$fetch',
      vi.fn(() => ({ data: { id: 'j3', status: statuses[Math.min(index++, statuses.length - 1)] } })),
    );
    const versions = useProblemVersions();
    const job = await versions.waitForJobTerminal('j3', { intervalMs: 0 });
    expect(job.status).toBe('completed');
    expect(index).toBe(3);
  });

  it('超时后返回最后一次观测到的任务状态（不抛错，交页面展示）', async () => {
    vi.stubGlobal('$fetch', vi.fn(() => ({ data: { id: 'j4', status: 'running' } })));
    const versions = useProblemVersions();
    const job = await versions.waitForJobTerminal('j4', {
      intervalMs: 0,
      timeoutMs: 1,
    });
    expect(job.status).toBe('running');
  });

  it('竞赛固定版本单独升级可同时提交策略与预期 revision', async () => {
    const fetchMock = vi.fn(() => ({ data: { pinned_version_id: 'v2' } }));
    vi.stubGlobal('$fetch', fetchMock);
    const versions = useProblemVersions();

    await versions.setContestProblemVersion('c1', 'p1', 'v2', {
      policy: { mode: 'exact', version_id: 'v2' },
      expectedRevision: 4,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/contests/c1/problems/p1/version',
      expect.objectContaining({
        method: 'put',
        body: {
          version_id: 'v2',
          policy: { mode: 'exact', version_id: 'v2' },
          expected_revision: 4,
        },
      }),
    );
  });
});
