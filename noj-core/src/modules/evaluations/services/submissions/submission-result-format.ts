import type { SubmissionEvaluationDetails } from "./submissions-types.ts";

/**
 * 解析 details 字段。
 * 数据库中以 JSON 字符串存储，解析为对象返回。
 */
export function parseDetails(
  raw: string | null,
): SubmissionEvaluationDetails | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as SubmissionEvaluationDetails;
  } catch {
    return null;
  }
}

/**
 * 归一化尝试 details：`evaluation_attempts.details` 是 jsonb 对象，
 * 迁移导入的历史行可能存 JSON 文本；两种形态都收敛为对象或 null。
 */
export function normalizeAttemptDetails(
  raw: unknown,
): SubmissionEvaluationDetails | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return parseDetails(raw);
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as SubmissionEvaluationDetails;
  }
  return null;
}

/**
 * 将评测结果状态归一化为提交状态：只保留 finished / error。
 * 旧数据中的 Accepted / WrongAnswer 等按分数制语义映射（兼容历史数据）。
 */
export function normalizeResultStatus(status: string | null): string | null {
  if (!status) return null;
  if (
    status === "error" || status === "SystemError" ||
    status === "TimeLimitExceeded" || status === "MemoryLimitExceeded" ||
    status === "RuntimeError"
  ) {
    return "error";
  }
  return "finished";
}

/**
 * 尝试历史条目的展示状态：与 `result.status` 同口径（finished / error），
 * 未终结的排队/执行中分别回落到 pending / judging。
 */
export function attemptDisplayStatus(
  state: string,
  resultStatus: string | null,
): string {
  const normalized = normalizeResultStatus(resultStatus);
  if (normalized) return normalized;
  if (state === "queued") return "pending";
  if (state === "judging") return "judging";
  return "error";
}
