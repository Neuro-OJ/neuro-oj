/**
 * evaluations 应用编排边界。
 *
 * HTTP/CLI 适配器只把已认证的 UserActor 和已经组合的执行快照传入这里。
 * 本文件负责最外层事务、结果提交后的外部副作用和任务受理；evaluations
 * 内部的锁、尝试、结果与投影函数只在 `DbTx` 上工作。
 */
import { getDb } from "../../shared/db/connection.ts";
import { AppError } from "../../shared/base/errors.ts";
import type { DbRoot } from "../../shared/db/executor.ts";
import type { SystemActor, UserActor } from "../access/contracts/actor.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../shared/workspace/types.ts";
import { loadWorkspace } from "../access/policy.ts";
import {
  getContestPolicySnapshot,
  resolveContestId,
  verifyContestAccess,
} from "../access/contest-policy.ts";
import { filterUnendedContestIds } from "../contests/services/problem-secrecy.ts";
import { getProblemVersionSnapshot } from "../problems/contracts/read.ts";
import { getPaperOrThrow } from "../problems/services/objective/objective-questions.ts";
import { evaluateProblemAccess } from "../problems/services/problem-access-check.ts";
import type { ProblemAccessInput } from "../problems/services/problem-access.ts";
import { resolveAssignmentSubmissionOrigin } from "../education/services/assignment-submission-origin.ts";
import {
  applyNewResult,
  getCachedTodayStats,
  getCachedTotalStats,
} from "../read-models/queries/services/stats-cache.ts";
import { refreshRankingsView } from "../read-models/queries/services/rankings.ts";
import {
  assertEvaluationAdmission,
  type EvaluationAdmissionContext,
} from "../evaluations/contracts/read.ts";
import type { DomainEvaluationAdmissionPlan } from "../evaluations/contracts/admission.ts";
import {
  createSubmission,
  deleteSubmission,
  listSubmissions,
} from "../evaluations/services/submissions/submissions-crud.ts";
import {
  createDomainArtifactSubmission,
  createDomainSelfTest,
  createDomainSubmission,
} from "../evaluations/services/domain-submissions.ts";
import { createSelfTest } from "../evaluations/services/self-tests.ts";
import {
  type DomainExecutionRequest,
  resolveDomainExecution,
} from "../evaluations/services/workspace-execution.ts";
import {
  createArtifactSubmission,
  type UploadedSubmissionInput,
} from "../evaluations/services/submissions/artifact-submissions.ts";
import { createPredictionSubmission } from "../evaluations/services/submissions/prediction-submissions.ts";
import type {
  SubmissionInput,
  SubmissionResponse,
} from "../evaluations/services/submissions/submissions-types.ts";
import type { SelfTestInput } from "../evaluations/types/self-tests.ts";
import {
  applyAttemptResultTx,
  type EvaluationWriteActor,
} from "../evaluations/services/versioning/tx-contracts.ts";
import {
  type ApplyAttemptOutcome,
  type ApplyAttemptResultInput,
} from "../evaluations/services/versioning/result-write.ts";
import { saveEvaluationResultTx } from "../evaluations/services/submissions/submissions-result.ts";
import type { SaveEvaluationResultOutcome } from "../evaluations/services/submissions/submissions-result.ts";
import type { JudgeResult } from "../evaluations/types/index.ts";
import { runAttemptTerminalRevocationAfterCommit } from "../evaluations/services/versioning/attempts.ts";
import type { AssignmentSubmissionOrigin } from "../../shared/education-types.ts";
import type {
  SubmitObjectiveInput,
  SubmitObjectiveResponse,
} from "../problems/types/objective.ts";
import { submitObjectivePaper } from "../evaluations/services/objective/objective-submissions.ts";
import {
  getObjectiveSubmissionForActor,
  listObjectiveSubmissionsForActor,
} from "../evaluations/services/objective/objective-submissions.ts";
import type {
  ObjectiveRegradeJobInput,
  ObjectiveRegradeJobResult,
} from "../evaluations/services/objective/versioning/objective-regrade-job.ts";
import { rejudgeObjectiveSubmissionForJobTx } from "../evaluations/services/objective/versioning/objective-regrade-job.ts";
import {
  rejudgeProblemSubmissions,
  rejudgeSubmission,
} from "../evaluations/services/submissions/submissions-rejudge.ts";
import { versionRequired } from "../evaluations/services/versioning/submission-version.ts";
import {
  type AcceptJobResult,
  acceptRejudgeJob,
  type RejudgeRequest,
  retryRejudgeJob,
} from "../evaluations/services/versioning/rejudge-jobs.ts";
import {
  acceptUpgradeJob,
  type AcceptUpgradeResult,
  type UpgradeRequest,
} from "../evaluations/services/versioning/upgrade-jobs.ts";
import {
  acceptDomainSubmissionJob,
  cancelDomainSubmissionJob,
  type DomainJobRequest,
} from "../evaluations/services/versioning/domain-jobs.ts";
import type { PolicyChangeResult } from "../evaluations/services/versioning/effective-policy.ts";
import {
  setContestProblemEffectiveVersionPolicyTx,
  setProblemEffectiveVersionPolicyTx,
  upgradeContestProblemPinnedVersionTx,
} from "../evaluations/services/versioning/effective-policy.ts";
import type { EffectiveVersionPolicy } from "../../shared/versioning/types.ts";

/**
 * 由 application 组合的一次受理上下文输入。
 *
 * 版本与比赛标识可能来自 HTTP 的公开引用；解析和授权在这里完成后，
 * evaluations 只接收不可变快照。assignment 由上层 application 组合，不能
 * 由提交 body 选择系统身份或绕过当前域授权。
 */
export interface ComposeEvaluationAdmissionInput {
  readonly problemId: string;
  readonly versionId?: string;
  readonly contestId?: string | null;
  readonly assignment?: EvaluationAdmissionContext["assignment"];
}

/** HTTP 上传流消费前的统一版本字段校验。 */
export function requireEvaluationVersion(versionId?: string): string {
  if (!versionId?.trim()) throw versionRequired();
  return versionId;
}

/**
 * 解析并冻结评价受理所需的题目、访问和比赛事实。
 *
 * 这个函数是 HTTP/CLI adapter 与 evaluations 之间的唯一快照组合入口；
 * evaluations 内部不再为寻找执行上下文回查 contests/education service。
 */
export async function composeEvaluationAdmissionContext(
  actor: UserActor,
  input: ComposeEvaluationAdmissionInput,
): Promise<EvaluationAdmissionContext> {
  const paper = await getPaperOrThrow(input.problemId);
  const problem: ProblemAccessInput = {
    id: paper.id,
    visibility: paper.visibility,
    owner_id: paper.owner_id,
  };
  const contestId = input.contestId
    ? await resolveContestId(input.contestId)
    : null;
  const contestAccess = contestId
    ? await verifyContestAccess(actor, contestId, paper.id)
    : null;
  const workspace = await loadWorkspace(DEFAULT_DOMAIN_SLUG, actor);
  const access = await evaluateProblemAccess(problem, {
    viewerId: actor.userId,
    isAdmin: workspace.platformAdmin ||
      workspace.context.domainPermissions.has("problem:write_any"),
    canReadOwn: paper.owner_id === actor.userId,
    contestAccess,
  });
  // 先完成资源授权，再检查版本字段。否则无权访问者可以通过省略版本号
  // 观测到版本受理协议（409 VERSION_REQUIRED），绕过题目保密/私有资源的
  // 统一 403 口径。版本与比赛策略的细粒度冲突仍在下方快照校验中处理。
  if (!access.result.allowed) {
    throw new AppError(
      "评测受理上下文不允许提交",
      403,
      "EVALUATION_ADMISSION_DENIED",
    );
  }
  const versionId = requireEvaluationVersion(input.versionId);
  const version = await getProblemVersionSnapshot(paper.id, versionId);
  if (!version) {
    throw new Error("评测受理版本不存在或未发布");
  }
  const contest = contestId
    ? await getContestPolicySnapshot(contestId, paper.id)
    : null;
  if (contestId && !contest) {
    throw new Error("评测受理比赛题目不存在");
  }
  return {
    problem: version,
    access: {
      problemId: paper.id,
      allowed: access.result.allowed,
      canSubmit: access.result.allowed,
      mode: access.result.mode === "admin" || access.result.mode === "owner"
        ? "private"
        : access.result.mode === "contest"
        ? "public"
        : access.result.mode,
      sourceDomainId: paper.domain_id,
    },
    contest,
    assignment: input.assignment ?? null,
  };
}

/**
 * 组合使用域提交的固定事实。
 *
 * 域入口的公开引用不是题目 UUID；先通过 evaluations 的兼容解析器解析源题、
 * 绑定、比赛窗口和当前版本，再由 application 读取只读版本/比赛合同。作业来源
 * 也在这里完成一次受理前复核；底层 lockDomainExecution 会在真正写入事务中按
 * 同样的绑定和 actor 再复核，保证这份 DTO 不能绕过撤销或成员变更。
 */
export async function composeDomainEvaluationAdmissionPlan(
  actor: UserActor,
  input: {
    slug: string;
    reference: string;
    versionId?: string;
    contestId?: string;
    assignment?: AssignmentSubmissionOrigin;
  },
): Promise<DomainEvaluationAdmissionPlan> {
  const request: DomainExecutionRequest = {
    slug: input.slug,
    reference: input.reference,
    contestId: input.contestId,
    assignment: input.assignment,
  };
  const versionId = requireEvaluationVersion(input.versionId);
  const resolved = await resolveDomainExecution(
    request,
    actor.userId,
    versionId,
  );
  const problem = await getProblemVersionSnapshot(
    resolved.problem.id,
    resolved.version.id,
  );
  if (!problem) throw new Error("评测受理版本不存在或未发布");
  const contest = resolved.contestId
    ? await getContestPolicySnapshot(resolved.contestId, resolved.problem.id)
    : null;
  if (resolved.contestId && !contest) {
    throw new Error("评测受理比赛题目不存在");
  }
  const assignmentOrigin = input.assignment
    ? await resolveAssignmentSubmissionOrigin(getDb(), {
      domainId: resolved.domain.id,
      actorId: actor.userId,
      bindingId: resolved.binding.id,
      problemId: resolved.problem.id,
      origin: input.assignment,
    })
    : null;
  return {
    request,
    resolved,
    context: {
      problem,
      access: {
        problemId: problem.problemId,
        allowed: true,
        canSubmit: true,
        mode: "public",
        sourceDomainId: resolved.source.id,
        bindingId: resolved.binding.id,
      },
      contest,
      assignment: assignmentOrigin?.assignment_id
        ? { assignmentId: assignmentOrigin.assignment_id, dueAt: null }
        : null,
    },
  };
}

/** 兼容只需要读取快照的 application 调用方；提交路径使用完整 plan。 */
export async function composeDomainEvaluationAdmissionContext(
  actor: UserActor,
  input: Parameters<typeof composeDomainEvaluationAdmissionPlan>[1],
): Promise<EvaluationAdmissionContext> {
  return (await composeDomainEvaluationAdmissionPlan(actor, input)).context;
}

/** 读取当前用户在竞赛中的提交；查询范围由显式 UserActor 固定。 */
export function listContestSubmissionsCommand(
  actor: UserActor,
  contestId: string,
  page: number,
  perPage: number,
) {
  return listSubmissions({
    contestId,
    userId: actor.userId,
    page,
    perPage,
  });
}

async function canReadAllObjectiveSubmissions(
  actor: UserActor,
): Promise<boolean> {
  const workspace = await loadWorkspace(DEFAULT_DOMAIN_SLUG, actor);
  return workspace.platformAdmin ||
    workspace.context.domainPermissions.has("submission:read_all");
}

/** 读取客观题提交历史；授权由显式 UserActor 对应的 workspace 计算。 */
export async function listObjectiveSubmissionsCommand(
  actor: UserActor,
  options: {
    paperId?: string;
    contestId?: string;
    targetUserId?: string;
    page: number;
    perPage: number;
  },
) {
  return listObjectiveSubmissionsForActor({
    actor,
    canReadAll: await canReadAllObjectiveSubmissions(actor),
    ...options,
  });
}

/** 读取单次客观题提交详情；授权由显式 UserActor 对应的 workspace 计算。 */
export async function getObjectiveSubmissionCommand(
  actor: UserActor,
  submissionId: string,
) {
  return getObjectiveSubmissionForActor(
    submissionId,
    actor,
    await canReadAllObjectiveSubmissions(actor),
  );
}

function assertActorMatchesAdmission(
  actor: UserActor,
  context: EvaluationAdmissionContext,
): void {
  // The admission DTO deliberately has no actor field. The caller has already
  // resolved access for this actor; requiring a UserActor here prevents a route
  // from replacing it with a body supplied system identity.
  void actor;
  void context;
}

/** 受理普通代码提交；Judge 派发发生在 DB 提交之后。 */
export function submitCodeCommand(
  actor: UserActor,
  context: EvaluationAdmissionContext,
  input: SubmissionInput,
): Promise<SubmissionResponse> {
  assertEvaluationAdmission(context, {
    problemId: input.problem_id,
    versionId: input.version_id ?? "",
    contestId: input.contest_id ?? context.contest?.contestId ?? null,
  });
  assertActorMatchesAdmission(actor, context);
  return createSubmission(
    actor.userId,
    input,
    context.contest?.contestId ?? input.contest_id ?? undefined,
    context.access.mode === "private",
  );
}

/** 受理 artifact/prediction 上传；上传流在 DB 锁之外消费。 */
export function submitArtifactCommand(
  actor: UserActor,
  context: EvaluationAdmissionContext,
  input: UploadedSubmissionInput,
  mode: "artifact" | "prediction" = "artifact",
): Promise<SubmissionResponse> {
  assertEvaluationAdmission(context, {
    problemId: input.problem_id,
    versionId: input.version_id ?? "",
    contestId: input.contest_id ?? context.contest?.contestId ?? null,
  });
  assertActorMatchesAdmission(actor, context);
  const submit = mode === "prediction"
    ? createPredictionSubmission
    : createArtifactSubmission;
  return submit(
    actor.userId,
    input,
    context.contest?.contestId ?? input.contest_id,
    context.access.mode === "private",
  );
}

/** 域内代码提交：执行上下文必须由 application 组合后显式传入。 */
export function submitDomainCodeCommand(
  actor: UserActor,
  plan: DomainEvaluationAdmissionPlan,
  input: {
    slug: string;
    reference: string;
    submission: Omit<SubmissionInput, "problem_id" | "contest_id"> & {
      assignment?: Parameters<typeof createDomainSubmission>[3]["assignment"];
    };
    contestId?: string;
  },
) {
  assertActorMatchesAdmission(actor, plan.context);
  assertEvaluationAdmission(plan.context, {
    problemId: plan.context.problem.problemId,
    versionId: input.submission.version_id ?? "",
    contestId: input.contestId ?? plan.context.contest?.contestId ?? null,
  });
  return createDomainSubmission(
    input.slug,
    input.reference,
    actor.userId,
    input.submission,
    input.contestId,
    plan,
  );
}

/** 域内产物提交，沿用上传补偿与配额状态机。 */
export function submitDomainArtifactCommand(
  actor: UserActor,
  plan: DomainEvaluationAdmissionPlan,
  input: Parameters<typeof createDomainArtifactSubmission>[0] extends string ? {
      slug: string;
      reference: string;
      submission: Parameters<typeof createDomainArtifactSubmission>[3];
      contestId?: string;
    }
    : never,
) {
  assertActorMatchesAdmission(actor, plan.context);
  assertEvaluationAdmission(plan.context, {
    problemId: plan.context.problem.problemId,
    versionId: input.submission.version_id ?? "",
    contestId: input.contestId ?? plan.context.contest?.contestId ?? null,
  });
  return createDomainArtifactSubmission(
    input.slug,
    input.reference,
    actor.userId,
    input.submission,
    input.contestId,
    plan,
  );
}

/** 域内自测，不进入正式有效成绩投影。 */
export function submitDomainSelfTestCommand(
  actor: UserActor,
  plan: DomainEvaluationAdmissionPlan,
  input: {
    slug: string;
    reference: string;
    selfTest: SelfTestInput & { assignment?: AssignmentSubmissionOrigin };
  },
) {
  assertActorMatchesAdmission(actor, plan.context);
  assertEvaluationAdmission(plan.context, {
    problemId: plan.context.problem.problemId,
    versionId: input.selfTest.version_id ?? "",
    contestId: plan.context.contest?.contestId ?? null,
  });
  return createDomainSelfTest(
    input.slug,
    input.reference,
    actor.userId,
    input.selfTest,
    false,
    plan,
  );
}

/** 普通题库自测；授权和版本快照由 application 先组合。 */
export function submitSelfTestCommand(
  actor: UserActor,
  context: EvaluationAdmissionContext,
  problemId: string,
  input: SelfTestInput,
): Promise<Awaited<ReturnType<typeof createSelfTest>>> {
  assertEvaluationAdmission(context, {
    problemId,
    versionId: input.version_id ?? "",
    contestId: null,
  });
  return createSelfTest(
    actor.userId,
    problemId,
    input,
    context.access.mode === "private",
  );
}

/** 客观题即时判分与提交/尝试/投影在同一事务内完成。 */
export async function submitObjectivePaperCommand(
  actor: UserActor,
  context: EvaluationAdmissionContext,
  paperId: string,
  input: SubmitObjectiveInput,
): Promise<SubmitObjectiveResponse> {
  // 客户端传入的 `contest_id` 可能是公开编号（如 C1001），而受理快照里的
  // `contest.contestId` 一律是内部 UUID；直接比较会让所有带比赛上下文的客观题
  // 交卷稳定 409 EVALUATION_ADMISSION_MISMATCH（CI objective 回归复现）。
  // 因此比较前先把客户端值解析为内部 id；未提供时才回落到快照值。
  const requestedContestId = input.contest_id
    ? await resolveContestId(input.contest_id)
    : context.contest?.contestId ?? null;
  assertEvaluationAdmission(context, {
    problemId: paperId,
    versionId: input.version_id ?? "",
    contestId: requestedContestId,
  });
  assertActorMatchesAdmission(actor, context);
  return submitObjectivePaper(
    paperId,
    {
      ...input,
      contest_id: context.contest?.contestId,
    },
    actor.userId,
    context.access.mode === "private",
  );
}

/** Judge/后台结果写入：一次 DbTx 内完成终态、正式判定和有效成绩。 */
export async function applyAttemptResultCommand(
  actor: EvaluationWriteActor,
  input: ApplyAttemptResultInput,
): Promise<ApplyAttemptOutcome> {
  const db: DbRoot = getDb();
  const result = await db.transaction((tx) =>
    applyAttemptResultTx(tx, actor, input)
  );
  if (result.applied !== "ignored") {
    await runAttemptTerminalRevocationAfterCommit(input.attemptId);
  }
  return result;
}

/**
 * Judge 结果消费者的 application 编排。
 *
 * 结果业务服务只负责原子终态与持久 outbox；统计事件和榜单刷新属于
 * read-model 副作用，由显式的后台 SystemActor 在 application 层组合。
 */
export async function saveEvaluationResultCommand(
  actor: SystemActor,
  result: JudgeResult,
): Promise<SaveEvaluationResultOutcome> {
  if (actor.kind !== "system") {
    throw new TypeError("Judge 结果必须由显式 SystemActor 写入");
  }
  const db: DbRoot = getDb();
  const outcome = await db.transaction((tx) =>
    saveEvaluationResultTx(tx, actor, result)
  );
  if (outcome.applied && outcome.attempt_id) {
    await runAttemptTerminalRevocationAfterCommit(outcome.attempt_id);
  }
  if (!outcome.applied) return outcome;

  // 统计只计算首次结果；竞赛结束前保持全站统计隔离，避免泄露判分信号。
  if (!outcome.is_rejudge && !outcome.auto_retry && outcome.created_at) {
    if (outcome.contest_id) {
      const unended = await filterUnendedContestIds([outcome.contest_id]);
      if (!unended.has(outcome.contest_id)) {
        applyNewResult(outcome.domain_id ?? undefined);
      }
    } else {
      applyNewResult(outcome.domain_id ?? undefined);
    }
  }

  // 结果已提交；刷新失败由 read-model 实现记录并回退内联查询，不回滚正式成绩。
  await refreshRankingsView();
  return outcome;
}

/** 提交首页今日统计；查询聚合由 application 组合给 HTTP adapter。 */
export function getEvaluationTodayStats(userId?: string) {
  return getCachedTodayStats(userId);
}

/** 提交首页全站累计统计；查询聚合由 application 组合给 HTTP adapter。 */
export function getEvaluationTotalStats() {
  return getCachedTotalStats();
}

/** 管理端单条重测；UserActor 由 HTTP adapter 显式提供。 */
export function rejudgeSubmissionCommand(
  actor: UserActor,
  submissionId: string,
) {
  return rejudgeSubmission(submissionId, actor);
}

/** 管理端整题重测。 */
export function rejudgeProblemSubmissionsCommand(
  actor: UserActor,
  problemId: string,
) {
  return rejudgeProblemSubmissions(problemId, actor);
}

/** 管理端删除提交；操作人必须由认证适配器显式提供。 */
export function deleteSubmissionCommand(
  actor: UserActor,
  submissionId: string,
): Promise<void> {
  return deleteSubmission(actor, submissionId);
}

/** 具有显式幂等键的重测受理入口。 */
export function acceptRejudgeJobCommand(
  actor: UserActor,
  request: RejudgeRequest,
  idempotencyKey: string,
): Promise<AcceptJobResult> {
  return acceptRejudgeJob(actor.userId, request, idempotencyKey);
}

export function retryRejudgeJobCommand(
  actor: UserActor,
  jobId: string,
  idempotencyKey: string,
): Promise<AcceptJobResult> {
  return retryRejudgeJob(actor.userId, jobId, idempotencyKey);
}

/** 用户升级任务受理；adapter 不能把认证身份降级成 body/Context 字符串。 */
export function acceptUpgradeJobCommand(
  actor: UserActor,
  request: UpgradeRequest,
  idempotencyKey: string,
): Promise<AcceptUpgradeResult> {
  return acceptUpgradeJob(actor.userId, request, idempotencyKey);
}

/** 使用域批任务受理；slug 是路由资源，actor 由认证合同提供。 */
export function acceptDomainSubmissionJobCommand(
  actor: UserActor,
  slug: string,
  request: DomainJobRequest,
  idempotencyKey: string,
) {
  return acceptDomainSubmissionJob(
    slug,
    actor.userId,
    request,
    idempotencyKey,
  );
}

/** 取消使用域批任务；服务层事务会重新锁定任务和未启动条目。 */
export function cancelDomainSubmissionJobCommand(
  actor: UserActor,
  slug: string,
  jobId: string,
) {
  return cancelDomainSubmissionJob(slug, actor.userId, jobId);
}

/** 客观题批量重判；后台调用者必须传入显式 SystemActor。 */
export function rejudgeObjectiveSubmissionCommand(
  actor: EvaluationWriteActor,
  input: ObjectiveRegradeJobInput,
): Promise<ObjectiveRegradeJobResult> {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    rejudgeObjectiveSubmissionForJobTx(tx, actor, input)
  );
}

export function setProblemEffectiveVersionPolicyCommand(
  actor: UserActor,
  problemId: string,
  policy: EffectiveVersionPolicy,
  expectedRevision: number,
): Promise<PolicyChangeResult> {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    setProblemEffectiveVersionPolicyTx(tx, actor, problemId, {
      policy,
      expectedRevision,
    })
  );
}

export function setContestProblemEffectiveVersionPolicyCommand(
  actor: UserActor,
  contestId: string,
  problemId: string,
  policy: EffectiveVersionPolicy,
  expectedRevision: number,
): Promise<PolicyChangeResult> {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    setContestProblemEffectiveVersionPolicyTx(
      tx,
      actor,
      contestId,
      problemId,
      { policy, expectedRevision },
    )
  );
}

export function upgradeContestProblemPinnedVersionCommand(
  actor: UserActor,
  contestId: string,
  problemId: string,
  input: {
    versionId: string;
    policy?: EffectiveVersionPolicy;
    expectedRevision?: number | null;
  },
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    upgradeContestProblemPinnedVersionTx(
      tx,
      actor,
      contestId,
      problemId,
      input,
    )
  );
}
