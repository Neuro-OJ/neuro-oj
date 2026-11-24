import { ref } from 'vue';
import { type EvaluationFeedback, normalizeFeedbackPayload } from '~/utils/aiFeedback';

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

  async function fetchFeedback(options: FeedbackFetchOptions): Promise<EvaluationFeedback | null> {
    if (!options.slug || !options.id) return null;
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
      });
      return normalizeFeedbackPayload(res?.data);
    } catch {
      return null;
    }
  }

  async function loadFeedback(options: FeedbackFetchOptions): Promise<EvaluationFeedback | null> {
    loading.value = true;
    try {
      const data = await fetchFeedback(options);
      feedback.value = data;
      return data;
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    feedback.value = null;
    loading.value = false;
  }

  return {
    feedback,
    loading,
    fetchFeedback,
    loadFeedback,
    reset,
  };
}
