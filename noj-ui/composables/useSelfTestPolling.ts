/**
 * 单个自测的实时状态轮询 composable
 *
 * 与 useSubmissionPolling 类似，但走 /api/v1/self-tests/:id，
 * 状态为 pending / judging / finished / error。
 */
import { extractApiError } from '~/utils/apiError';

export type SelfTestStatus = 'pending' | 'judging' | 'finished' | 'error';

export interface PolledSelfTest {
  id: string;
  status: SelfTestStatus;
  result_status: string | null;
  score: number;
  language: string;
  created_at: string;
  time_ms?: number | null;
  memory_kb?: number | null;
  output?: string | null;
  details?: Record<string, unknown> | null;
}

const TERMINAL_STATUSES: SelfTestStatus[] = ['finished', 'error'];
const POLL_INTERVAL_MS = 1500;

export function useSelfTestPolling(selfTestIdRef: Ref<string | null>) {
  const selfTest = ref<PolledSelfTest | null>(null);
  const isPolling = ref(false);
  const error = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isPolling.value = false;
  }

  async function fetchOnce() {
    const id = selfTestIdRef.value;
    if (!id) return;
    try {
      const res = await useApi().api.get<{ data: PolledSelfTest }>(
        `/api/v1/self-tests/${id}`,
        { silent: true },
      );
      selfTest.value = res.data;
      error.value = null;
      if (TERMINAL_STATUSES.includes(res.data.status)) {
        stop();
      }
    } catch (e) {
      error.value = extractApiError(e).message;
      // 避免无限 spinner：轮询出错时停止，错误信息由页面展示
      stop();
    }
  }

  function start(id: string) {
    stop();
    selfTest.value = null;
    error.value = null;
    isPolling.value = true;
    selfTestIdRef.value = id;
    void fetchOnce();
    timer = setInterval(fetchOnce, POLL_INTERVAL_MS);
  }

  onUnmounted(stop);

  return {
    selfTest,
    isPolling,
    error,
    start,
    stop,
  };
}
