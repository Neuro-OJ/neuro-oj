/**
 * 单个提交的实时状态轮询 composable
 *
 * 用于编辑器提交后留在页面时，实时显示评测进度。
 * 提交状态变为 finished / error 时自动停止轮询。
 */

export type SubmissionStatus =
  | "pending"
  | "judging"
  | "finished"
  | "error";

export interface PolledSubmission {
  id: string;
  status: SubmissionStatus;
  score: number;
  language: string;
  created_at: string;
  result: { status: string; score: number } | null;
}

const TERMINAL_STATUSES: SubmissionStatus[] = ["finished", "error"];
const POLL_INTERVAL_MS = 1500;

export function useSubmissionPolling(submissionIdRef: Ref<string | null>) {
  const submission = ref<PolledSubmission | null>(null);
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
    const id = submissionIdRef.value;
    if (!id) return;
    try {
      const res = await $fetch<{ data: PolledSubmission }>(
        `/api/v1/submissions/${id}`,
      );
      submission.value = res.data;
      error.value = null;
      if (TERMINAL_STATUSES.includes(res.data.status)) {
        stop();
      }
    } catch (e) {
      const err = e as { data?: { error?: string }; message?: string };
      error.value = err.data?.error || err.message || "轮询失败";
    }
  }

  function start(id: string) {
    stop();
    submission.value = null;
    isPolling.value = true;
    submissionIdRef.value = id;
    void fetchOnce();
    timer = setInterval(fetchOnce, POLL_INTERVAL_MS);
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