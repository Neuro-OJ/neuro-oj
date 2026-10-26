/**
 * 正式提交平台错误自动重试。
 *
 * 评测以 `result_kind = platform_error` 结束（LLM 网关断连、评测器未输出
 * `---RESULT---`、容器异常等）时，结果写入事务内直接创建一次新的评测尝试
 * （sequence 递增，失败尝试保留 `error` 终态作为历史），而不是把提交定为 `error`。
 *
 * 设计约束：
 * - **次数持久化在 DB**：新尝试的 `task_snapshot.auto_retry.count` 记录这是第几次
 *   自动重试；判定只读失败尝试自身的快照，不依赖任何进程内状态（多副本安全）。
 *   人工重测 / 升级创建的新尝试快照不带该标记，因此天然拥有独立的重试预算。
 * - **幂等**：重试与失败尝试的终态写入处于同一事务、同一提交行锁内；
 *   `finishAttempt` 只成功一次，重复回调在此之前就被判为过时/重复而忽略，
 *   不会重复创建尝试，也不会重复派发。
 * - **只处理正式提交**：客观题与自测不经过此路径；派发阶段的失败（消息过大、
 *   版本缺失、预检失败等）也不重试——它们不调用本模块。
 * - **只重试偶发错误**：`classifyPlatformErrorRetry` 对输出尾部做保守白名单匹配，
 *   选手代码缺函数、LLM 额度/计费/鉴权错误与未知错误一律不重试。
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  submissionJobItems,
} from "../../../../shared/db/schema.ts";
import type { AttemptSource } from "../../../../shared/versioning/types.ts";
import { getSetting } from "../../../system/index.ts";
import { createAttempt } from "./attempts.ts";
import type { ProjectionSource } from "./projection.ts";
import { refreshJobStatus } from "./rejudge-jobs.ts";

/** 默认自动重试次数上限（初次评测之外）。 */
export const DEFAULT_PLATFORM_ERROR_MAX_RETRIES = 3;
/** 自动重试次数配置的硬上限，防止误配置导致无限消耗评测资源。 */
export const MAX_PLATFORM_ERROR_MAX_RETRIES = 10;

/** 写入新尝试 `task_snapshot.auto_retry` 的持久化标记。 */
export interface AutoRetryMarker {
  /** 本尝试是第几次自动重试（1 起）。 */
  count: number;
  /** 触发本次重试的平台错误尝试。 */
  retry_of: string;
  /** 重试链起点尝试的来源：`initial` 链沿用初次提交的派发优先级。 */
  origin_source: AttemptSource;
}

/** 自动重试调度结果。 */
export interface ScheduledAutoRetry {
  /** 新创建的评测尝试 ID（= 新的 run_id）。 */
  attempt_id: string;
  /** 新尝试的 sequence。 */
  sequence: number;
  /** 第几次自动重试（1 起）。 */
  retry_count: number;
  /**
   * 是否交由批任务 worker 派发（重测/升级任务产生的尝试）。
   * `false` 时由结果消费者在事务提交后立即派发，失败则由 sweeper 兜底恢复。
   */
  via_job: boolean;
}

/** 读取当前配置的自动重试上限（runtime 设置，DB → env → 默认值）。 */
export function resolvePlatformErrorMaxRetries(): number {
  const value = getSetting("judge_platform_error_max_retries")?.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return DEFAULT_PLATFORM_ERROR_MAX_RETRIES;
  }
  return Math.min(value, MAX_PLATFORM_ERROR_MAX_RETRIES);
}

/** 从尝试快照解析自动重试标记；不存在或格式非法返回 null。 */
export function readAutoRetryMarker(snapshot: unknown): AutoRetryMarker | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const raw = (snapshot as Record<string, unknown>).auto_retry;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (
    typeof marker.count !== "number" || !Number.isInteger(marker.count) ||
    marker.count < 1
  ) {
    return null;
  }
  return {
    count: marker.count,
    retry_of: typeof marker.retry_of === "string" ? marker.retry_of : "",
    origin_source: typeof marker.origin_source === "string"
      ? marker.origin_source as AttemptSource
      : "initial",
  };
}

/** 平台错误可重试判定结论。 */
export interface PlatformErrorRetryDecision {
  retryable: boolean;
  /** 命中的特征（日志与测试用的稳定标识）。 */
  reason: string;
}

/** 只检查输出尾部：异常回溯与 judge 公开文案都在末尾，避免扫描 evaluator 的大段日志。 */
const RETRY_CLASSIFY_TAIL_CHARS = 8 * 1024;

/**
 * 确定性/计费类失败特征（**优先于**可重试特征）：再跑结果相同，或只会继续消耗额度。
 *
 * - 选手代码缺函数：SDK `NotFoundError: function 'solve' not registered`；
 * - LLM gateway 4xx：额度耗尽（`out_of_usage`）、上游计费 402、鉴权 401/403 等；
 * - 额度/计费/鉴权关键字（含网关透传的上游 `upstream_error` + 402）。
 */
const NON_RETRYABLE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["function_not_registered", /\bnot registered\b/],
  ["llm_gateway_4xx", /LLM gateway 返回 4\d\d\b/],
  ["llm_out_of_usage", /\bout_of_usage\b/],
  ["llm_quota", /\binsufficient_quota\b|\bquota\b/i],
  ["llm_payment_required", /\b402\b|payment required|billing/i],
  [
    "llm_auth",
    /\b(?:401|403)\b|unauthorized|forbidden|invalid_token|invalid_api_key/i,
  ],
];

/**
 * 偶发错误白名单（judge 公开文案与 evaluator SDK 的 LLMError 文案）。
 *
 * - `Evaluator 总超时`：judge 评测总时限到期（多见于 LLM 调用卡住）；
 * - `系统内部错误 (submission: …)`：judge 内部异常的固定公开文案；
 * - `LLM gateway 连接失败`：连接断开、超时（SDK 已把超时归入此类）；
 * - `LLM gateway 返回 5xx`：网关/上游瞬时故障。
 */
const RETRYABLE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["evaluator_total_timeout", /Evaluator 总超时/],
  ["judge_internal_error", /系统内部错误 \(submission: /],
  ["llm_gateway_connection", /LLM gateway 连接失败/],
  ["llm_gateway_5xx", /LLM gateway 返回 5\d\d\b/],
];

/**
 * 判定一次平台错误是否属于可自动重试的偶发错误。
 *
 * judge 结果目前没有结构化错误码（SDK `LLMError` 的 status/error_code 不进入结果
 * 封套），因此在 core 侧对 `output` 尾部做**保守白名单**：拒绝特征优先；只有命中
 * 可重试特征才重试；未知错误与 core 判定的非法评分（`INVALID_SCORE`）默认不重试。
 */
export function classifyPlatformErrorRetry(input: {
  resultStatus?: string | null;
  output?: string | null;
}): PlatformErrorRetryDecision {
  if (input.resultStatus === "INVALID_SCORE") {
    return { retryable: false, reason: "invalid_score" };
  }
  const output = input.output ?? "";
  const tail = output.length > RETRY_CLASSIFY_TAIL_CHARS
    ? output.slice(-RETRY_CLASSIFY_TAIL_CHARS)
    : output;
  for (const [reason, pattern] of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(tail)) return { retryable: false, reason };
  }
  for (const [reason, pattern] of RETRYABLE_PATTERNS) {
    if (pattern.test(tail)) return { retryable: true, reason };
  }
  return { retryable: false, reason: "unknown" };
}

/** 批任务中仍未终结的条目状态：重试期间条目保持未完成。 */
const OPEN_ITEM_STATUSES = ["pending", "preparing", "dispatched"] as const;

/**
 * 在结果写入事务内为平台错误尝试调度一次自动重试。
 *
 * 调用方必须已：锁定题目宿主与提交行、确认该尝试是提交的活动尝试，
 * 并已把失败尝试写为终态（`finishAttempt` 成功）。
 *
 * @returns 已调度的重试；不满足条件（次数用尽、存量无版本等）返回 null
 */
export async function scheduleAutoRetryInTx(
  db: Executor,
  input: {
    failedAttemptId: string;
    source: ProjectionSource;
    maxRetries: number;
  },
): Promise<ScheduledAutoRetry | null> {
  if (input.source.kind !== "submission" || input.maxRetries <= 0) return null;
  const [failed] = await db.select({
    id: evaluationAttempts.id,
    problem_version_id: evaluationAttempts.problem_version_id,
    source: evaluationAttempts.source,
    task_snapshot: evaluationAttempts.task_snapshot,
  }).from(evaluationAttempts).where(
    eq(evaluationAttempts.id, input.failedAttemptId),
  ).limit(1);
  // 存量无版本尝试无法按不可变版本重建任务，不自动重试
  if (!failed?.problem_version_id) return null;

  const previous = readAutoRetryMarker(failed.task_snapshot);
  const usedRetries = previous?.count ?? 0;
  if (usedRetries >= input.maxRetries) return null;

  const snapshot = (failed.task_snapshot ?? {}) as Record<string, unknown>;
  const marker: AutoRetryMarker = {
    count: usedRetries + 1,
    retry_of: failed.id,
    origin_source: previous?.origin_source ?? failed.source as AttemptSource,
  };
  // 新尝试沿用失败尝试的冻结执行快照（版本、运行配置、LLM Provider/模型/预算），
  // 绝不重新解析当前默认配置；LLM 额度按新尝试 ID 独立计算。
  const attempt = await createAttempt({
    executor: db,
    source: input.source,
    problemVersionId: failed.problem_version_id,
    // 约束只允许既有来源字面量：自动重试按"重测"语义记账（不计入首次结果统计）
    source_kind: "rejudge",
    taskSnapshot: { ...snapshot, auto_retry: marker },
    createdBy: null,
  });

  // 批任务产生的尝试：把条目改指向新尝试并退回 `pending`，由 worker 按既有派发
  // 路径（租约、退避、容量等待）重新派发；条目在重试结束前保持未完成。
  const [item] = await db.select({
    id: submissionJobItems.id,
    job_id: submissionJobItems.job_id,
  }).from(submissionJobItems).where(and(
    eq(submissionJobItems.attempt_id, failed.id),
    inArray(submissionJobItems.status, [...OPEN_ITEM_STATUSES]),
  )).limit(1).for("update");
  if (item) {
    await db.update(submissionJobItems).set({
      status: "pending",
      attempt_id: attempt.id,
      next_dispatch_at: null,
      lease_owner: null,
      lease_until: null,
      reason_code: null,
      reason_message: null,
    }).where(eq(submissionJobItems.id, item.id));
    await refreshJobStatus(item.job_id, db);
  }

  return {
    attempt_id: attempt.id,
    sequence: attempt.sequence,
    retry_count: marker.count,
    via_job: Boolean(item),
  };
}
