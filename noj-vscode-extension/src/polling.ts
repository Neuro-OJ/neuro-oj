import type { SelfTestDetail, SubmissionDetail } from "./types";

/** 评测在配置时间内没有结束。 */
export class PollTimeoutError extends Error {
  constructor() {
    super("等待评测结果超时，可稍后在 Neuro OJ 网站查看");
    this.name = "PollTimeoutError";
  }
}

export interface PollOptions<T> {
  intervalMs: number;
  timeoutMs: number;
  isCancelled?: () => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  onUpdate?: (detail: T) => void;
}

async function pollUntil<T>(
  load: () => Promise<T>,
  isDone: (detail: T) => boolean,
  options: PollOptions<T>,
): Promise<T> {
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = Date.now();

  while (Date.now() - startedAt <= options.timeoutMs) {
    if (options.isCancelled?.()) throw new Error("已取消等待评测结果");
    const detail = await load();
    options.onUpdate?.(detail);
    if (isDone(detail)) {
      return detail;
    }
    await sleep(options.intervalMs);
  }

  throw new PollTimeoutError();
}

/** 轮询提交详情，直到完成、失败、取消或超时。 */
export function pollSubmission(
  load: () => Promise<SubmissionDetail>,
  options: PollOptions<SubmissionDetail>,
): Promise<SubmissionDetail> {
  return pollUntil(
    load,
    (detail) =>
      detail.result_visibility === "hidden" ||
      detail.status === "finished" ||
      detail.status === "error",
    options,
  );
}

/** 轮询云端自测详情，直到完成、失败、取消或超时。 */
export function pollSelfTest(
  load: () => Promise<SelfTestDetail>,
  options: PollOptions<SelfTestDetail>,
): Promise<SelfTestDetail> {
  return pollUntil(
    load,
    (detail) =>
      detail.status === "finished" ||
      detail.status === "error" ||
      detail.status === "cancelled",
    options,
  );
}
