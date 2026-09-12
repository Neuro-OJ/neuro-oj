import type { SubmissionDetail } from "./types";

/** 评测在配置时间内没有结束。 */
export class PollTimeoutError extends Error {
  constructor() {
    super("等待评测结果超时，可稍后在 Neuro OJ 网站查看");
    this.name = "PollTimeoutError";
  }
}

/** 轮询提交详情，直到完成、失败、取消或超时。 */
export async function pollSubmission(
  load: () => Promise<SubmissionDetail>,
  options: {
    intervalMs: number;
    timeoutMs: number;
    isCancelled?: () => boolean;
    sleep?: (milliseconds: number) => Promise<void>;
    onUpdate?: (detail: SubmissionDetail) => void;
  },
): Promise<SubmissionDetail> {
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = Date.now();

  while (Date.now() - startedAt <= options.timeoutMs) {
    if (options.isCancelled?.()) throw new Error("已取消等待评测结果");
    const detail = await load();
    options.onUpdate?.(detail);
    if (detail.status === "finished" || detail.status === "error") {
      return detail;
    }
    await sleep(options.intervalMs);
  }

  throw new PollTimeoutError();
}
