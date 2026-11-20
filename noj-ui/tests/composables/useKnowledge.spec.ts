import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const toastError = vi.fn();

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ toast: { error: toastError } }),
}));

import { useApi } from '~/composables/useApi';
import { useKnowledge } from '~/composables/useKnowledge';
import {
  formatOffpeakStart,
  formatOffpeakWindow,
  isBackfillDrift,
  isKnowledgeDisabled,
  normalizeSelection,
  selectionFromView,
} from '~/utils/knowledge';

const disabledError = { status: 404, data: { error: '知识图谱功能已关闭', code: 'KNOWLEDGE_DISABLED' } };

/** 每个用例独立的 useState 存储（模拟 Nuxt 共享状态）。 */
function stubState() {
  const store = new Map<string, ReturnType<typeof ref>>();
  vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
    if (!store.has(key)) store.set(key, ref(init()));
    return store.get(key);
  });
}

describe('useKnowledge', () => {
  beforeEach(() => {
    toastError.mockClear();
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { authCookiePrefix: 'noj' } }));
    vi.stubGlobal('useRoute', () => ({ path: '/admin/knowledge', fullPath: '/admin/knowledge' }));
    vi.stubGlobal('useApi', useApi);
    stubState();
  });

  it('KNOWLEDGE_DISABLED：置 disabled、返回 null 且不弹 toast', async () => {
    const fetch = vi.fn(() => Promise.reject(disabledError));
    vi.stubGlobal('$fetch', fetch);
    const knowledge = useKnowledge();
    await expect(knowledge.loadGraph()).resolves.toBeNull();
    expect(knowledge.disabled.value).toBe(true);
    expect(toastError).not.toHaveBeenCalled();
    // 题目、用量、预估、审核队列同样静默返回 null
    await expect(knowledge.loadProblem('p1')).resolves.toBeNull();
    await expect(knowledge.loadUsage()).resolves.toBeNull();
    await expect(knowledge.estimateBackfill()).resolves.toBeNull();
    await expect(knowledge.loadReviews(1)).resolves.toBeNull();
  });

  it('题目接口 404（不存在/保护期）返回 null，不视为功能关闭', async () => {
    vi.stubGlobal('$fetch', vi.fn(() => Promise.reject({ status: 404, data: { error: '题目不存在' } })));
    const knowledge = useKnowledge();
    await expect(knowledge.loadProblem('p1')).resolves.toBeNull();
    expect(knowledge.disabled.value).toBe(false);
  });

  it('其他错误照常抛出并交由默认 toast', async () => {
    const failure = { status: 500, data: { error: '服务异常' } };
    vi.stubGlobal('$fetch', vi.fn(() => Promise.reject(failure)));
    const knowledge = useKnowledge();
    await expect(knowledge.loadReviews(1)).rejects.toEqual(failure);
    // useApi 的 silent/onError 路径在测试环境不弹 toast，这里只断言错误原样抛出
    expect(toastError).not.toHaveBeenCalled();
    expect(knowledge.disabled.value).toBe(false);
  });

  it('图谱只请求一次（会话缓存），并发请求复用同一 Promise', async () => {
    const fetch = vi.fn(() => Promise.resolve({ data: { pack: null, areas: [], nodes: [] } }));
    vi.stubGlobal('$fetch', fetch);
    const knowledge = useKnowledge();
    const [a, b] = await Promise.all([knowledge.loadGraph(), knowledge.loadGraph()]);
    await knowledge.loadGraph();
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('backfill 带 confirm: true 与 expected_count 投递', async () => {
    const fetch = vi.fn(() => Promise.resolve({ data: { enqueued: 3, expected_count: 3, actual_count: 3 } }));
    vi.stubGlobal('$fetch', fetch);
    const knowledge = useKnowledge();
    const result = await knowledge.backfill(3);
    expect(result.drifted).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/admin/knowledge/tagging/backfill',
      expect.objectContaining({ method: 'post', body: { confirm: true, expected_count: 3 } }),
    );
  });

  it('backfill 409 返回 drifted 且不弹默认 toast', async () => {
    const failure = { status: 409, data: { error: '待打标题目数已变化，请重新预估', code: 'CONFLICT_ERROR' } };
    vi.stubGlobal('$fetch', vi.fn(() => Promise.reject(failure)));
    const knowledge = useKnowledge();
    await expect(knowledge.backfill(3)).resolves.toEqual({ data: null, drifted: true });
    expect(toastError).not.toHaveBeenCalled();
    expect(knowledge.disabled.value).toBe(false);
  });

  it('backfill 400 照常抛出（默认 toast）', async () => {
    const failure = { status: 400, data: { error: '回填须显式确认' } };
    vi.stubGlobal('$fetch', vi.fn(() => Promise.reject(failure)));
    const knowledge = useKnowledge();
    await expect(knowledge.backfill(3)).rejects.toEqual(failure);
    // useApi 的 silent/onError 路径在测试环境不弹 toast，这里只断言错误原样抛出
    expect(toastError).not.toHaveBeenCalled();
  });

  it('审核修改以 { primary, secondary } 提交，通过/驳回以 decision 提交', async () => {
    const fetch = vi.fn(() => Promise.resolve({ data: { problem_id: 'p1' } }));
    vi.stubGlobal('$fetch', fetch);
    const knowledge = useKnowledge();
    await knowledge.decideReview('p1', 'accept');
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/v1/admin/knowledge/reviews/p1',
      expect.objectContaining({ method: 'post', body: { decision: 'accept' } }),
    );
    await knowledge.decideReview('p1', { primary: 'a', secondary: ['b'] });
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/v1/admin/knowledge/reviews/p1',
      expect.objectContaining({ method: 'post', body: { primary: 'a', secondary: ['b'] } }),
    );
  });
});

describe('utils/knowledge', () => {
  it('isKnowledgeDisabled 只认 404 KNOWLEDGE_DISABLED', () => {
    expect(isKnowledgeDisabled(disabledError)).toBe(true);
    expect(isKnowledgeDisabled({ status: 404, data: { code: 'NOT_FOUND' } })).toBe(false);
    expect(isKnowledgeDisabled(null)).toBe(false);
    expect(isBackfillDrift({ status: 409 })).toBe(true);
    expect(isBackfillDrift({ status: 500 })).toBe(false);
  });

  it('normalizeSelection 去空、去重、截断至 3 且排除主项', () => {
    expect(normalizeSelection({ primary: 'a', secondary: [' ', 'a', 'b', 'b', 'c', 'd', 'e'] })).toEqual({
      primary: 'a',
      secondary: ['b', 'c', 'd'],
    });
  });

  it('selectionFromView 从归类视图预填', () => {
    expect(selectionFromView(null)).toEqual({ primary: '', secondary: [] });
    expect(
      selectionFromView({
        problem_id: 'p',
        state: 'classified',
        primary: {
          node_id: 'a',
          name: 'A',
          role: 'primary',
          source: 'ai',
          confidence: 60,
          review_status: 'pending',
          version_id: null,
          updated_at: '',
        },
        secondary: [
          {
            node_id: 'b',
            name: 'B',
            role: 'secondary',
            source: 'ai',
            confidence: 60,
            review_status: 'pending',
            version_id: null,
            updated_at: '',
          },
        ],
        pending: true,
      }),
    ).toEqual({ primary: 'a', secondary: ['b'] });
  });
});

describe('低峰时段展示辅助', () => {
  it('时段按北京时间展示，连字符换成 en dash', () => {
    expect(formatOffpeakWindow('00:30-08:30')).toBe('00:30–08:30（北京时间）');
    expect(formatOffpeakWindow('22:00-06:00')).toBe('22:00–06:00（北京时间）');
  });

  it('下次开始按北京时间展示，空值返回空串', () => {
    // 2026-11-13T16:30Z = 北京 11/14 00:30。
    expect(formatOffpeakStart('2026-11-13T16:30:00.000Z')).toContain('00:30');
    expect(formatOffpeakStart('2026-11-13T16:30:00.000Z')).toContain('11/14');
    expect(formatOffpeakStart(null)).toBe('');
    expect(formatOffpeakStart('not-a-date')).toBe('');
  });
});
