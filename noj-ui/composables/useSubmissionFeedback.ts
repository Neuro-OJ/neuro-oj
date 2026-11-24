import { ref } from 'vue';
import { type EvaluationFeedback, normalizeFeedbackPayload } from '~/utils/domain/submission/aiFeedback';

export interface FeedbackFetchOptions {
  slug: string;
  id: string;
  kind: 'submission' | 'self-test';
  attemptId?: string | null;
  includeMessages?: boolean;
}

/**
 * 读取正式提交或代码自测的 AI 评测可视化反馈。
 *
 * 非关键反馈数据在 SSR 或 Gateway 不可用时统一降级为空态（`null`），
 * 严禁阻断评测结果页渲染。
 */
export function useSubmissionFeedback() {
  const { api } = useApi();
  const feedback = ref<EvaluationFeedback | null>(null);
  const loading = ref(false);
  const error = ref<unknown>(null);

  // 单调递增请求代际号：确保晚到的旧响应与过期错误绝不覆盖最新状态
  let activeRequestId = 0;
  let activeController: AbortController | null = null;

  function abortActiveRequest() {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  }

  async function fetchFeedbackInternal(
    options: FeedbackFetchOptions,
    signal?: AbortSignal,
  ): Promise<{ data: EvaluationFeedback | null; err: unknown }> {
    if (!options.slug || !options.id) return { data: null, err: null };
    const resource = options.kind === 'self-test' ? 'self-tests' : 'submissions';
    const url = `/api/v1/domains/${encodeURIComponent(options.slug)}/${resource}/${
      encodeURIComponent(options.id)
    }/feedback`;
    const query: Record<string, string> = {};
    if (options.attemptId) query.attempt_id = options.attemptId;
    if (options.includeMessages) query.include_messages = '1';

    try {
      const res = await api.get<{ data: unknown }>(url, {
        query: Object.keys(query).length > 0 ? query : undefined,
        silent: true,
        redirectOnUnauthorized: false,
        signal,
      });
      return { data: normalizeFeedbackPayload(res?.data), err: null };
    } catch (err) {
      return { data: null, err };
    }
  }

  async function fetchFeedback(
    options: FeedbackFetchOptions,
    signal?: AbortSignal,
  ): Promise<EvaluationFeedback | null> {
    const result = await fetchFeedbackInternal(options, signal);
    return result.data;
  }

  async function loadFeedback(options: FeedbackFetchOptions): Promise<EvaluationFeedback | null> {
    const requestId = ++activeRequestId;
    abortActiveRequest();
    const controller = new AbortController();
    activeController = controller;

    loading.value = true;
    error.value = null;

    try {
      const result = await fetchFeedbackInternal(options, controller.signal);
      if (requestId !== activeRequestId) {
        return null;
      }
      if (result.err) {
        error.value = result.err;
        feedback.value = null;
        return null;
      }
      feedback.value = result.data;
      return result.data;
    } finally {
      if (requestId === activeRequestId) {
        activeController = null;
        loading.value = false;
      }
    }
  }

  function reset() {
    activeRequestId++;
    abortActiveRequest();
    feedback.value = null;
    loading.value = false;
    error.value = null;
  }

  return {
    feedback,
    loading,
    error,
    fetchFeedback,
    loadFeedback,
    reset,
  };
}
