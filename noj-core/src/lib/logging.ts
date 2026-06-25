/**
 * 日志脱敏工具。
 *
 * 集中处理提交 ID、用户代码等敏感字段的脱敏，避免散落实现导致部分日志泄露。
 * 所有 console 输出涉及 submission_id / score / code 时均应通过本模块。
 */

/**
 * 截断 ID 用于日志展示，保留前缀可识别性但避免完整泄露。
 *
 * @example
 * redactId("550e8400-e29b-41d4-a716-446655440000") // "550e8400..."
 */
export function redactId(id: string, visiblePrefix = 8): string {
  if (!id || id.length <= visiblePrefix) return "[redacted]";
  return `${id.slice(0, visiblePrefix)}...`;
}

/**
 * 判断当前是否为生产环境。
 * 通过 NOJ_ENV 环境变量识别；非 production 视为开发/测试环境。
 */
export function isProduction(): boolean {
  return Deno.env.get("NOJ_ENV") === "production";
}

/**
 * 输出评测任务入队日志（生产环境脱敏 submission_id）。
 */
export function logJudgeTaskEnqueued(
  submissionId: string,
  queueLength: number,
  messageBytes: number,
): void {
  const id = isProduction() ? redactId(submissionId) : submissionId;
  console.log(
    `[judge] task enqueued: submission_id=${id}, queue_length=${queueLength}, size=${messageBytes}B`,
  );
}

/**
 * 输出评测结果接收日志（生产环境脱敏 submission_id 和 score）。
 */
export function logJudgeResultReceived(
  submissionId: string,
  status: string,
  score: number,
): void {
  if (isProduction()) {
    console.log(
      `[judge] result received: submission_id=${
        redactId(submissionId)
      }, status=${status}`,
    );
  } else {
    console.log(
      `收到评测结果: submission_id=${submissionId}, status=${status}, score=${score}`,
    );
  }
}
