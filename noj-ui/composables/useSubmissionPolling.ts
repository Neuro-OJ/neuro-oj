/**
 * 单个提交的实时状态 composable
 *
 * 用于编辑器提交后留在页面时，实时显示评测进度。
 * 优先使用 SSE，不可用时自动降级到轮询 fallback。
 * 提交状态变为 finished / error 时自动停止。
 */
import { computed, onUnmounted, type Ref, ref } from 'vue';
import { useEventSource } from './useEventSource';
import { extractApiError } from '~/utils/apiError';

export type SubmissionStatus =
  | 'pending'
  | 'judging'
  | 'finished'
  | 'error';

export interface PolledSubmission {
  id: string;
  status: SubmissionStatus;
  score: number;
  language: string;
  created_at: string;
  time_ms?: number;
  memory_kb?: number;
  result: {
    status: string;
    score: number;
    time_ms?: number;
    memory_kb?: number;
  } | null;
}

const TERMINAL_STATUSES: SubmissionStatus[] = ['finished', 'error'];
const FALLBACK_INTERVAL_MS = 1500;

export function useSubmissionPolling(submissionIdRef: Ref<string | null>) {
  const { api } = useApi();
  const submission = ref<PolledSubmission | null>(null);
  const isPolling = ref(false);
  const error = ref<string | null>(null);

  function stop() {
    isPolling.value = false;
  }

  async function fetchOnce() {
    const id = submissionIdRef.value;
    if (!id) return;
    try {
      // 轮询为静默请求：失败写入 error ref 由页面展示，不弹 toast
      const res = await api.get<{ data: PolledSubmission }>(
        `/api/v1/submissions/${id}`,
        { silent: true },
      );
      submission.value = res.data;
      error.value = null;
      if (TERMINAL_STATUSES.includes(res.data.status)) {
        stop();
      }
    } catch (e) {
      error.value = extractApiError(e).message;
    }
  }

  const sseUrl = computed(() => submissionIdRef.value ? `/api/v1/submissions/${submissionIdRef.value}/events` : '');

  // SSE 优先 + fallback 轮询
  useEventSource({
    url: sseUrl,
    enabled: isPolling,
    onEvent: {
      'submission:updated': () => fetchOnce(),
    },
    fetchFn: fetchOnce,
    fallbackIntervalMs: FALLBACK_INTERVAL_MS,
  });

  function start(id: string) {
    stop();
    submission.value = null;
    isPolling.value = true;
    submissionIdRef.value = id;
    void fetchOnce();
  }

  onUnmounted(stop);

  return {
    submission,
    isPolling,
    error,
    start,
    stop,
  };
}
