/**
 * 提交详情查询与结果投影（getSubmission）。
 */

import {
  attemptDisplayStatus,
  normalizeAttemptDetails,
  normalizeResultStatus,
} from "./submission-result-format.ts";
import { oiVerdict, projectMeteringDetails } from "./oi-details.ts";
import { projectContestSubmissionReads } from "./contest-read-projection.ts";
import { eq } from "drizzle-orm";
import {
  domainProblemBindings,
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  type CurrentVersionResult,
  type EffectiveVersionPolicy,
  policyFromColumns,
} from "../../../../shared/versioning/types.ts";
import { selectEffectiveResults } from "../../../../shared/versioning/effective-results.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { checkPermission } from "../../../access/contracts/cross-module/identity_services_security_permissions.ts";
import { evaluateProblemAccess } from "../../../problems/contracts/cross-module/services_problem-access-check.ts";
import { verifyContestAccess } from "../../../contests/contracts/cross-module/services_contest-access.ts";
import { getSubmissionQueueStatus } from "../queue.ts";
import type { Context } from "hono";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  SubmissionAttemptSummary,
  SubmissionAttemptView,
  SubmissionDetail,
  SubmissionVersionResultView,
} from "./submissions-types.ts";

/**
 * 详情接口返回的 result.output 最大长度（字节近似）。
 *
 * 评测脚本 stdout 可能包含大量测试点详情，单次响应过大影响
 * 移动端加载与序列化性能。原始 output 仍完整保存在 DB 中，
 * 本截断仅作用于 API 响应层。
 *
 * 修复 issue 64 评论 §5.1。
 */
const MAX_OUTPUT_LENGTH = 8 * 1024;

/**
 * 根据 ID 查询提交记录。
 *
 * 权限模型（issue: 评测详情公开访问分级）：
 * - 基础数据（题号、状态、时间、内存、得分等）：所有访问者可见
 * - 详细内容（源代码、评测输出、用例级详情）：仅 owner 或 admin 可见
 *
 * @param id 提交 ID
 * @param viewerId 当前查看者的 userId；undefined/null 表示匿名访问
 * @param viewerRole 当前查看者的角色；'admin' 时跳过所有权校验
 *
 * @throws {NotFoundError} 提交不存在
 */
export async function getSubmission(
  id: string,
  viewerId?: string | null,
  viewerRole?: string | null,
  c?: Context,
  domainAccess?: {
    domainId: string;
    canReadDetails: boolean;
    platformAdmin: boolean;
  },
): Promise<SubmissionDetail> {
  const db = getDb();

  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  const row = rows[0];
  if (
    domainAccess
      ? row.domain_id !== domainAccess.domainId
      : row.domain_id !== null && row.domain_id !== DEFAULT_DOMAIN_ID
  ) {
    throw new NotFoundError("默认域不存在此提交");
  }

  // 权限判断：仅 owner 或 admin 可看 code/output/details
  // 注意：基础数据（题号/状态/时间等）对所有访问者公开，不在这里做"非所有者 404"的拦截
  const isOwner = !!(c?.var.userId ?? viewerId) &&
    row.user_id === (c?.var.userId ?? viewerId);
  // 实时权限查询（submission:read_all，admin:full_access 通配）
  const isAdmin = domainAccess
    ? domainAccess.canReadDetails
    : c
    ? await checkPermission(c, "submission:read_all")
    : viewerRole === "admin";
  const canSeeDetails = isOwner || isAdmin;
  if (canSeeDetails && !domainAccess) {
    const [problem] = await db.select().from(problems).where(
      eq(problems.id, row.problem_id),
    );
    if (!problem) throw new NotFoundError("题目不存在");
    const actorId = c?.var.userId ?? viewerId ?? null;
    const contestAccess = row.contest_id
      ? await verifyContestAccess(actorId, row.contest_id, row.problem_id)
      : null;
    const { result } = await evaluateProblemAccess(problem, {
      viewerId: actorId,
      isAdmin,
      contestAccess,
    });
    if (!result.allowed) throw new NotFoundError("题目不存在");
  }

  // 类 Kaggle 赛制不隐藏进行中的评测结果（实时榜按排名接口权限控制）
  const hideResult = false;

  // 查询最近一次运行的判定：优先最近终态尝试，存量行回退有效成绩指针。
  // 不再读 evaluation_results（该表只保留最近一次结果且即将随存量收尾删除）。
  const latestAttemptId = row.latest_attempt_id ?? row.effective_attempt_id ??
    null;
  const attemptRows = latestAttemptId
    ? await db
      .select()
      .from(evaluationAttempts)
      .where(eq(evaluationAttempts.id, latestAttemptId))
      .limit(1)
    : [];
  const resultRows = attemptRows;

  const result = !hideResult && resultRows.length > 0
    ? (() => {
      const rawOutput = resultRows[0].output ?? "";
      // API 层截断：原始 output 完整保留在 DB，仅响应层控制大小
      const output_truncated = rawOutput.length > MAX_OUTPUT_LENGTH;
      // 仅 owner/admin 返回 output（截断），其他访问者得到 null
      const output = canSeeDetails
        ? (output_truncated ? rawOutput.slice(0, MAX_OUTPUT_LENGTH) : rawOutput)
        : null;
      // 仅 owner/admin 解析 details JSON，其他访问者得到 null
      const rawDetails = normalizeAttemptDetails(resultRows[0].details);
      const details = canSeeDetails ? rawDetails : null;
      const metering = oiVerdict(rawDetails) &&
          (rawDetails?.oi as Record<string, unknown>)?.backend !== "native"
        ? projectMeteringDetails(
          (rawDetails as Record<string, unknown>).metering,
        )
        : undefined;
      return {
        status: normalizeResultStatus(resultRows[0].result_status) ??
          "finished",
        score: resultRows[0].score ?? 0,
        output,
        output_truncated: canSeeDetails ? output_truncated : null,
        time_ms: resultRows[0].time_ms,
        memory_kb: resultRows[0].memory_kb,
        details,
        metering,
      };
    })()
    : null;

  // 提交时版本号（展示用）：`submitted_version_id` 已由 DB 复合外键保证属于本题。
  let submittedVersion: number | null = null;
  if (row.submitted_version_id) {
    const [versionRow] = await db
      .select({ version: problemVersions.version })
      .from(problemVersions)
      .where(eq(problemVersions.id, row.submitted_version_id))
      .limit(1);
    submittedVersion = versionRow?.version ?? null;
  }

  // 题目作用域的有效版本策略：各版本判定的选择依据（竞赛作用域策略在竞赛读路径）。
  const [policyRow] = await db
    .select({
      effective_version_mode: problems.effective_version_mode,
      required_version_id: problems.required_version_id,
      latest_version_id: problems.latest_version_id,
      binding_mode: problems.effective_version_mode,
      binding_required: problems.required_version_id,
    })
    .from(problems)
    .leftJoin(
      domainProblemBindings,
      eq(domainProblemBindings.id, row.domain_problem_binding_id ?? ""),
    )
    .where(eq(problems.id, row.problem_id))
    .limit(1);
  const effectiveVersionPolicy: EffectiveVersionPolicy = policyFromColumns(
    row.domain_problem_binding_id
      ? policyRow?.binding_mode
      : policyRow?.effective_version_mode,
    row.domain_problem_binding_id
      ? policyRow?.binding_required
      : policyRow?.required_version_id,
  ) ?? { mode: "any" };
  const isSubmittedVersionLatest = !!row.submitted_version_id &&
    row.submitted_version_id ===
      (row.domain_problem_binding_id && effectiveVersionPolicy.mode === "exact"
        ? effectiveVersionPolicy.version_id
        : policyRow?.latest_version_id);

  // 全部执行历史（含 queued/judging/superseded 与平台错误，tracking #53）。
  // 只投影非敏感字段：output/details 仍只经 `result` 返回并按权限裁剪，
  // 因此本数组在竞赛视角下被 `applySubmissionProjection` 统一处理（非参赛者整条剥离）。
  const attemptHistoryRows = await db
    .select({
      attempt_id: evaluationAttempts.id,
      sequence: evaluationAttempts.sequence,
      problem_version_id: evaluationAttempts.problem_version_id,
      version: problemVersions.version,
      source: evaluationAttempts.source,
      state: evaluationAttempts.state,
      result_kind: evaluationAttempts.result_kind,
      result_status: evaluationAttempts.result_status,
      score: evaluationAttempts.score,
      time_ms: evaluationAttempts.time_ms,
      memory_kb: evaluationAttempts.memory_kb,
      created_at: evaluationAttempts.created_at,
      finished_at: evaluationAttempts.finished_at,
    })
    .from(evaluationAttempts)
    .leftJoin(
      problemVersions,
      eq(problemVersions.id, evaluationAttempts.problem_version_id),
    )
    .where(eq(evaluationAttempts.submission_id, id));

  const effectiveAttemptId = row.effective_attempt_id ?? null;
  const acceptedAttemptId = row.accepted_attempt_id ?? null;
  const latestPointerId = row.latest_attempt_id ?? null;
  const attempts: SubmissionAttemptView[] = attemptHistoryRows
    .map((item) => ({
      attempt_id: item.attempt_id,
      sequence: item.sequence,
      problem_version_id: item.problem_version_id,
      version: item.version ?? null,
      source: item.source as SubmissionAttemptView["source"],
      state: item.state as SubmissionAttemptView["state"],
      result_kind: item.result_kind ?? null,
      status: attemptDisplayStatus(item.state, item.result_status),
      score: item.score ?? 0,
      time_ms: item.time_ms ?? null,
      memory_kb: item.memory_kb ?? null,
      is_effective: effectiveAttemptId === item.attempt_id,
      is_accepted: acceptedAttemptId === item.attempt_id,
      is_latest: latestPointerId === item.attempt_id,
      created_at: item.created_at,
      finished_at: item.finished_at ?? null,
    }))
    .sort((a, b) =>
      a.sequence - b.sequence || a.attempt_id.localeCompare(b.attempt_id)
    );

  const summarizeAttempt = (
    attemptId: string | null,
  ): SubmissionAttemptSummary | null => {
    if (!attemptId) return null;
    const found = attempts.find((item) => item.attempt_id === attemptId);
    if (!found) return null;
    return {
      attempt_id: found.attempt_id,
      sequence: found.sequence,
      problem_version_id: found.problem_version_id,
      version: found.version,
      state: found.state,
      result_kind: found.result_kind,
      status: found.status,
      score: found.score,
      time_ms: found.time_ms,
      memory_kb: found.memory_kb,
      created_at: found.created_at,
      finished_at: found.finished_at,
    };
  };

  // 跨版本判定（Handbook 核心不变量 3）：每（提交，版本）一条当前正式判定。
  const versionRows = await db
    .select({
      problem_version_id: submissionVersionResults.problem_version_id,
      version: problemVersions.version,
      attempt_id: evaluationAttempts.id,
      sequence: evaluationAttempts.sequence,
      result_kind: evaluationAttempts.result_kind,
      state: evaluationAttempts.state,
      result_status: evaluationAttempts.result_status,
      score: evaluationAttempts.score,
      accepted: evaluationAttempts.accepted,
      time_ms: evaluationAttempts.time_ms,
      memory_kb: evaluationAttempts.memory_kb,
    })
    .from(submissionVersionResults)
    .innerJoin(
      evaluationAttempts,
      eq(evaluationAttempts.id, submissionVersionResults.current_attempt_id),
    )
    .leftJoin(
      problemVersions,
      eq(problemVersions.id, submissionVersionResults.problem_version_id),
    )
    .where(eq(submissionVersionResults.submission_id, id));

  const currentVersionResults: CurrentVersionResult[] = versionRows.map((
    versionRow,
  ) => ({
    attempt_id: versionRow.attempt_id,
    problem_version_id: versionRow.problem_version_id,
    score: versionRow.score ?? 0,
    accepted: versionRow.accepted === true,
    sequence: versionRow.sequence,
    result_kind: versionRow.result_kind,
    state: versionRow.state,
  }));
  const effectiveSelection = selectEffectiveResults(
    currentVersionResults,
    effectiveVersionPolicy,
  );
  const versionResults: SubmissionVersionResultView[] = versionRows
    .map((versionRow) => ({
      problem_version_id: versionRow.problem_version_id,
      version: versionRow.version ?? null,
      attempt_id: versionRow.attempt_id,
      sequence: versionRow.sequence,
      status: normalizeResultStatus(versionRow.result_status) ??
        (versionRow.state === "queued" ? "pending" : "error"),
      score: versionRow.score ?? 0,
      time_ms: versionRow.time_ms ?? null,
      memory_kb: versionRow.memory_kb ?? null,
      is_effective: effectiveSelection.effective_attempt_id ===
        versionRow.attempt_id,
      is_accepted: effectiveSelection.accepted_attempt_id ===
        versionRow.attempt_id,
    }))
    .sort((a, b) =>
      a.sequence - b.sequence || a.attempt_id.localeCompare(b.attempt_id)
    );

  // 查询队列状态信息（排队位置、时间戳）
  // getSubmissionQueueStatus 已实现三态权限：未登录 + owner + admin 可见，登录非 owner 不可见
  // Redis 不可用时内部静默失败，返回 null 时间戳回退至 DB 值
  const queueStatus = await getSubmissionQueueStatus(
    id,
    viewerId ?? undefined,
    isAdmin ? "admin" : viewerRole ?? undefined,
    domainAccess?.domainId,
  );
  const platformAdmin = domainAccess
    ? domainAccess.platformAdmin
    : c
    ? await checkPermission(c, "admin:full_access")
    : viewerRole === "admin";

  const response: SubmissionDetail = {
    id: row.id,
    public_id: row.public_id,
    ...(canSeeDetails
      ? {
        progress: row.judge_progress as
          | import("../oi-progress.ts").OiProgress
          | null,
      }
      : {}),
    user_id: row.user_id,
    problem_id: row.problem_id,
    contest_id: row.contest_id,
    language: row.language,
    code: canSeeDetails ? row.code : null,
    file_name: row.file_name,
    status: row.status,
    created_at: row.created_at,
    result,
    queue_position: platformAdmin ? queueStatus?.queue_position ?? null : null,
    queue_length: platformAdmin ? queueStatus?.queue_length ?? null : null,
    judge_started_at: queueStatus?.judge_started_at ?? row.judge_started_at ??
      null,
    judge_finished_at: queueStatus?.judge_finished_at ??
      row.judge_finished_at ?? null,
    submitted_version_id: row.submitted_version_id ?? null,
    version_origin: row.version_origin ?? "legacy_unknown",
    submitted_version: submittedVersion,
    is_latest: isSubmittedVersionLatest,
    upgraded_from_id: row.upgraded_from_id ?? null,
    effective_version_policy: effectiveVersionPolicy,
    version_results: versionResults,
    attempts,
    latest_attempt: summarizeAttempt(latestPointerId),
    effective_attempt: summarizeAttempt(effectiveAttemptId),
    latest_attempt_id: latestPointerId,
    effective_attempt_id: effectiveAttemptId,
    accepted_attempt_id: acceptedAttemptId,
  };
  return (await projectContestSubmissionReads(
    [response],
    viewerId ?? null,
    platformAdmin,
  ))[0];
}
