import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { NotFoundError } from "../../shared/base/errors.ts";
import { unwrapRows } from "../../shared/base/sql-rows.ts";
import { getDb } from "../../shared/db/connection.ts";
import { evaluationAttempts, selfTests } from "../../shared/db/schema.ts";
import {
  loadWorkspace,
  userActorFromAuthenticatedId,
} from "../../modules/access/index.ts";
import { currentTeacherSubmissionAccessWhere } from "../../modules/education/contracts/cross-module/services_submission-access-sql.ts";
import {
  getDomainSelfTest,
  getDomainSubmission,
} from "../../modules/evaluations/index.ts";
import {
  getSubmissionLlmSummary,
  type LlmSubmissionSummaryQuery,
  type LlmSubmissionSummaryResult,
  type LlmSubmissionSummaryStats,
} from "../../modules/platform/index.ts";
import type {
  EvaluationFeedback,
  FeedbackBadcase,
  FeedbackMetric,
  FeedbackVisibility,
} from "./types.ts";

/** 归一化后的可见测试点（内部计算指标与抽取 badcases 共用）。 */
export interface NormalizedFeedbackCase extends FeedbackBadcase {
  passed: boolean;
}

/** 可注入的外部依赖，便于服务层与路由层单测隔离。 */
export interface FeedbackServiceDeps {
  loadWorkspace: typeof loadWorkspace;
  getDomainSubmission: typeof getDomainSubmission;
  getDomainSelfTest: typeof getDomainSelfTest;
  getSubmissionLlmSummary: (
    query: LlmSubmissionSummaryQuery,
    domainId?: string,
  ) => Promise<LlmSubmissionSummaryResult>;
  isTeacherForStudent: (
    studentUserId: string,
    domainId: string,
    actorId: string,
  ) => Promise<boolean>;
  submissionHasAttempt: (
    submissionId: string,
    attemptId: string,
  ) => Promise<boolean>;
  getSelfTestRunId: (
    selfTestId: string,
    domainId: string,
  ) => Promise<string | null>;
}

const defaultDeps: FeedbackServiceDeps = {
  loadWorkspace,
  getDomainSubmission,
  getDomainSelfTest,
  getSubmissionLlmSummary,
  async isTeacherForStudent(studentUserId, domainId, actorId) {
    const rows = unwrapRows<{ allowed: boolean }>(
      await getDb().execute(
        sql`SELECT ${
          currentTeacherSubmissionAccessWhere(
            studentUserId,
            domainId,
            actorId,
          )
        } AS allowed`,
      ) as never,
    );
    return rows[0]?.allowed === true;
  },
  async submissionHasAttempt(submissionId, attemptId) {
    const rows = await getDb()
      .select({ id: evaluationAttempts.id })
      .from(evaluationAttempts)
      .where(
        and(
          eq(evaluationAttempts.id, attemptId),
          eq(evaluationAttempts.submission_id, submissionId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },
  async getSelfTestRunId(selfTestId, domainId) {
    const rows = await getDb()
      .select({ judge_run_id: selfTests.judge_run_id })
      .from(selfTests)
      .where(
        and(
          eq(selfTests.id, selfTestId),
          eq(selfTests.domain_id, domainId),
        ),
      )
      .limit(1);
    return rows[0]?.judge_run_id ?? null;
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  const num = asFiniteNumber(value);
  return num !== null && num >= 0 ? num : null;
}

const PASSED_STATUSES = new Set([
  "accepted",
  "ac",
  "pass",
  "passed",
  "ok",
  "correct",
]);

/** 判断测试点状态是否属于通过语义。 */
export function isFeedbackCasePassed(status: string): boolean {
  return PASSED_STATUSES.has(status.toLowerCase());
}

function isHiddenCase(raw: Record<string, unknown>): boolean {
  return raw.hidden === true || raw.visibility === "hidden";
}

function normalizeVisibleCase(
  raw: unknown,
  options: {
    requireExplicitVisible?: boolean;
    isSelfTest?: boolean;
  } = {},
): NormalizedFeedbackCase | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  if (isHiddenCase(obj)) return null;
  if (options.requireExplicitVisible && obj.visibility !== "visible") {
    return null;
  }

  const caseId = asString(obj.case_id) ?? asString(obj.id);
  const status = asString(obj.status) ??
    (typeof obj.content_ok === "boolean"
      ? (obj.content_ok ? "Accepted" : "WrongAnswer")
      : null);
  if (!caseId || !status) return null;

  const score = asNonNegativeNumber(obj.score);
  const maxScore = asNonNegativeNumber(obj.max_score);
  const passedByStatus = isFeedbackCasePassed(status);
  const passedByScore = maxScore !== null && maxScore > 0 && score !== null
    ? score >= maxScore
    : true;
  const passed = passedByStatus && passedByScore;

  return {
    case_id: caseId,
    status,
    score,
    max_score: maxScore,
    error_type: asNonEmptyString(obj.error_type) ??
      asNonEmptyString(obj.termination_reason),
    reasoning: asNonEmptyString(obj.reasoning) ??
      asNonEmptyString(obj.reason) ??
      asNonEmptyString(obj.feedback),
    input: asString(obj.input),
    expected_output: asString(obj.expected_output) ?? asString(obj.expected),
    actual_output: asString(obj.actual_output) ??
      asString(obj.actual) ??
      (options.isSelfTest ? asString(obj.stdout) : null),
    time_ms: asNonNegativeNumber(obj.time_ms),
    memory_kb: asNonNegativeNumber(obj.memory_kb),
    passed,
  };
}

/**
 * 从评测详情抽取非隐藏测试点及未通过/未满分 Badcase。
 * 严格禁止将 `visibility === 'hidden'` 或 `hidden === true` 的用例纳入结果。
 */
export function extractVisibleCasesAndBadcases(
  details: unknown,
  options: { isSelfTest: boolean },
): { visibleCases: NormalizedFeedbackCase[]; badcases: FeedbackBadcase[] } {
  const record = asRecord(details);
  if (!record) return { visibleCases: [], badcases: [] };

  const visibleCases: NormalizedFeedbackCase[] = [];
  if (Array.isArray(record.cases)) {
    for (const item of record.cases) {
      const normalized = normalizeVisibleCase(item, {
        isSelfTest: options.isSelfTest,
      });
      if (normalized) visibleCases.push(normalized);
    }
  } else {
    const visibleGroup = asRecord(record.visible);
    if (Array.isArray(visibleGroup?.cases)) {
      for (const item of visibleGroup.cases) {
        const normalized = normalizeVisibleCase(item, {
          isSelfTest: options.isSelfTest,
        });
        if (normalized) visibleCases.push(normalized);
      }
    }
    const oi = asRecord(record.oi);
    if (Array.isArray(oi?.subtasks)) {
      for (const rawSubtask of oi.subtasks) {
        const subtask = asRecord(rawSubtask);
        if (!subtask || !Array.isArray(subtask.cases)) continue;
        for (const item of subtask.cases) {
          const normalized = normalizeVisibleCase(item, {
            // 正式 OI 子任务用例无显式 visibility='visible' 时按隐藏处理
            requireExplicitVisible: !options.isSelfTest,
            isSelfTest: options.isSelfTest,
          });
          if (normalized) visibleCases.push(normalized);
        }
      }
    }
  }

  const badcases: FeedbackBadcase[] = visibleCases
    .filter((item) => !item.passed)
    .map(({ passed: _passed, ...badcase }) => badcase);

  return { visibleCases, badcases };
}

function normalizeExplicitMetric(
  keyHint: string,
  raw: unknown,
): FeedbackMetric | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const score = Math.max(0, raw);
    return {
      key: keyHint,
      label: keyHint,
      score,
      max_score: score <= 1 ? 1 : 100,
    };
  }
  const obj = asRecord(raw);
  if (!obj) return null;
  const key = asNonEmptyString(obj.key) ?? asNonEmptyString(obj.name) ??
    keyHint;
  const label = asNonEmptyString(obj.label) ?? asNonEmptyString(obj.title) ??
    key;
  const score = asFiniteNumber(obj.score) ?? asFiniteNumber(obj.value);
  if (!key || score === null) return null;
  const rawMax = asFiniteNumber(obj.max_score) ?? asFiniteNumber(obj.max);
  const maxScore = rawMax !== null && rawMax > 0
    ? rawMax
    : score <= 1
    ? 1
    : 100;
  return {
    key,
    label,
    score: Math.max(0, Math.min(score, maxScore)),
    max_score: maxScore,
  };
}

/**
 * 解析 `details.metrics`；若未显式提供且存在非隐藏用例，则派生基础能力维度。
 */
export function extractFeedbackMetrics(
  details: unknown,
  visibleCases: readonly NormalizedFeedbackCase[],
  submissionScore?: number | null,
  llmSummary?: LlmSubmissionSummaryStats | null,
): FeedbackMetric[] {
  const record = asRecord(details);
  const rawMetrics = record?.metrics;
  const explicit: FeedbackMetric[] = [];

  if (Array.isArray(rawMetrics)) {
    rawMetrics.forEach((item, index) => {
      const normalized = normalizeExplicitMetric(`metric_${index + 1}`, item);
      if (normalized) explicit.push(normalized);
    });
  } else {
    const objMetrics = asRecord(rawMetrics);
    if (objMetrics) {
      for (const [key, value] of Object.entries(objMetrics)) {
        const normalized = normalizeExplicitMetric(key, value);
        if (normalized) explicit.push(normalized);
      }
    }
  }

  if (explicit.length > 0) return explicit;
  if (visibleCases.length === 0) return [];

  const total = visibleCases.length;
  const passedCount = visibleCases.filter((item) => item.passed).length;
  const passRate = Math.round((passedCount / total) * 1000) / 10;

  const scoredCases = visibleCases.filter(
    (item) =>
      item.score !== null && item.max_score !== null && item.max_score > 0,
  );
  const avgScoreRate = scoredCases.length > 0
    ? Math.round(
      (scoredCases.reduce(
        (acc, item) => acc + item.score! / item.max_score!,
        0,
      ) /
        scoredCases.length) *
        1000,
    ) / 10
    : typeof submissionScore === "number" && Number.isFinite(submissionScore)
    ? Math.max(0, Math.min(100, Math.round(submissionScore / 10) / 10))
    : passRate;

  const timedCases = visibleCases.filter((item) => item.time_ms !== null);
  const metrics: FeedbackMetric[] = [
    { key: "pass_rate", label: "通过率", score: passRate, max_score: 100 },
    {
      key: "avg_score_rate",
      label: "平均得分率",
      score: avgScoreRate,
      max_score: 100,
    },
  ];

  if (timedCases.length > 0) {
    const avgTimeMs = timedCases.reduce((acc, item) =>
      acc + (item.time_ms ?? 0), 0) /
      timedCases.length;
    const timeScore = Math.max(
      10,
      Math.min(100, Math.round((1000 / (900 + avgTimeMs)) * 100)),
    );
    metrics.push({
      key: "time_efficiency",
      label: "耗时表现",
      score: timeScore,
      max_score: 100,
    });
  } else {
    const unstableStatuses = new Set(["RE", "SE", "TLE", "MLE", "OLE", "CE"]);
    const stableCount = visibleCases.filter(
      (item) => !unstableStatuses.has(item.status.toUpperCase()),
    ).length;
    metrics.push({
      key: "execution_stability",
      label: "运行稳定性",
      score: Math.round((stableCount / total) * 1000) / 10,
      max_score: 100,
    });
  }

  if (llmSummary && llmSummary.total_calls > 0) {
    const okCalls = Math.max(
      0,
      llmSummary.total_calls - llmSummary.error_calls,
    );
    metrics.push({
      key: "llm_reliability",
      label: "模型调用成功率",
      score: Math.round((okCalls / llmSummary.total_calls) * 1000) / 10,
      max_score: 100,
    });
  }

  return metrics;
}

/**
 * 决定是否向 Gateway 请求脱敏 `request_messages`：
 * - 自测仅含用户自身输入与公开样例，默认可看（除非显式 `?include_messages=0`）；
 * - 正式提交默认不返回，仅管理员/教师显式请求 `?include_messages=1` 时返回。
 */
export function resolveIncludeMessagesFlag(options: {
  isSelfTest: boolean;
  isPrivileged: boolean;
  rawQuery?: string;
}): boolean {
  if (options.rawQuery === "0") return false;
  if (options.isSelfTest) return true;
  return options.isPrivileged && options.rawQuery === "1";
}

function hiddenFeedbackResponse(
  visibility: FeedbackVisibility,
): EvaluationFeedback {
  return {
    visible: false,
    visibility,
    attempt_id: null,
    gateway_available: false,
    summary: null,
    metrics: [],
    traces: [],
    badcases: [],
  };
}

/** 读取正式提交的 AI 评测反馈（严格受竞赛可见性与隐藏测试点门控）。 */
export async function getSubmissionFeedback(
  slug: string,
  reference: string,
  actorId: string,
  options: { attemptId?: string; includeMessages?: string } = {},
  deps: FeedbackServiceDeps = defaultDeps,
): Promise<EvaluationFeedback> {
  const access = await deps.loadWorkspace(
    slug,
    userActorFromAuthenticatedId(actorId),
  );
  const submission = await deps.getDomainSubmission(slug, reference, actorId);

  const ownerId = asNonEmptyString(submission.user_id);
  const isOwner = ownerId === actorId;
  const isManager = access.platformAdmin ||
    access.context.domainPermissions.has("submission:read_all");
  const isTeacher = !isOwner && !isManager && ownerId !== null
    ? await deps.isTeacherForStudent(ownerId, access.domain.id, actorId)
    : false;

  if (!isOwner && !isManager && !isTeacher) {
    throw new NotFoundError("提交不存在");
  }

  const visibility =
    (submission.result_visibility ?? "cases") as FeedbackVisibility;
  if (visibility === "hidden" || !submission.resource_available) {
    return hiddenFeedbackResponse(visibility);
  }

  const submissionId = asNonEmptyString(submission.id) ?? reference;
  const requestedAttemptId = asNonEmptyString(options.attemptId ?? undefined);
  let targetAttemptId: string | null = null;

  if (requestedAttemptId) {
    const attemptsList = Array.isArray(submission.attempts)
      ? submission.attempts as Array<{ attempt_id?: unknown }>
      : [];
    const inView = attemptsList.some(
      (item) => item?.attempt_id === requestedAttemptId,
    );
    const exists = inView ||
      await deps.submissionHasAttempt(submissionId, requestedAttemptId);
    if (!exists) {
      throw new NotFoundError("指定的评测尝试不存在");
    }
    targetAttemptId = requestedAttemptId;
  } else {
    targetAttemptId = asNonEmptyString(submission.effective_attempt_id) ??
      asNonEmptyString(submission.latest_attempt_id);
  }

  const resultObj = asRecord(submission.result);
  const details = resultObj?.details ?? null;
  const score = asFiniteNumber(resultObj?.score);

  const shouldIncludeMessages = visibility === "cases" &&
    resolveIncludeMessagesFlag({
      isSelfTest: false,
      isPrivileged: isManager || isTeacher,
      rawQuery: options.includeMessages,
    });

  const gatewayResult = await deps.getSubmissionLlmSummary(
    {
      submission_id: submissionId,
      attempt_id: targetAttemptId ?? undefined,
      include_messages: shouldIncludeMessages,
    },
    submission.domain_id,
  );
  const summary = gatewayResult.data?.summary ?? null;

  if (visibility === "summary") {
    const metrics = extractFeedbackMetrics(details, [], score, summary);
    return {
      visible: true,
      visibility: "summary",
      attempt_id: targetAttemptId,
      gateway_available: gatewayResult.available,
      summary,
      metrics,
      traces: [],
      badcases: [],
    };
  }

  const { visibleCases, badcases } = extractVisibleCasesAndBadcases(details, {
    isSelfTest: false,
  });
  const metrics = extractFeedbackMetrics(details, visibleCases, score, summary);

  return {
    visible: true,
    visibility: "cases",
    attempt_id: targetAttemptId,
    gateway_available: gatewayResult.available,
    summary,
    metrics,
    traces: gatewayResult.data?.traces ?? [],
    badcases,
  };
}

/** 读取代码自测的 AI 评测反馈（自测仅含用户用例与公开样例）。 */
export async function getSelfTestFeedback(
  slug: string,
  id: string,
  actorId: string,
  context: Context,
  options: { includeMessages?: string } = {},
  deps: FeedbackServiceDeps = defaultDeps,
): Promise<EvaluationFeedback> {
  const selfTest = await deps.getDomainSelfTest(slug, id, actorId, context);
  if (!selfTest.resource_available) {
    return hiddenFeedbackResponse("hidden");
  }

  const runId = await deps.getSelfTestRunId(id, selfTest.domain_id);
  const shouldIncludeMessages = resolveIncludeMessagesFlag({
    isSelfTest: true,
    isPrivileged: true,
    rawQuery: options.includeMessages,
  });

  const gatewayResult = await deps.getSubmissionLlmSummary(
    {
      submission_id: id,
      attempt_id: runId ?? undefined,
      include_messages: shouldIncludeMessages,
    },
    selfTest.domain_id,
  );
  const summary = gatewayResult.data?.summary ?? null;
  const { visibleCases, badcases } = extractVisibleCasesAndBadcases(
    selfTest.details,
    { isSelfTest: true },
  );
  const metrics = extractFeedbackMetrics(
    selfTest.details,
    visibleCases,
    selfTest.score,
    summary,
  );

  return {
    visible: true,
    visibility: "cases",
    attempt_id: runId,
    gateway_available: gatewayResult.available,
    summary,
    metrics,
    traces: gatewayResult.data?.traces ?? [],
    badcases,
  };
}
