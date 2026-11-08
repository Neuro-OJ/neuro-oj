/** 客观题提交创建：竞赛提交校验、访问判定、即时判分与落库（含初次尝试与有效成绩）。 */
import { and, eq } from "drizzle-orm";
import { consumeDomainSubmissionQuota } from "../../../access/contracts/cross-module/workspace_services_submission-limit.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { objectiveSubmissions } from "../../../../shared/db/schema.ts";
import { FULL_SCORE } from "../../../../shared/base/constants.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  assertDefaultProblemSource,
  resolveDefaultExecutionContext,
} from "../../../problems/contracts/cross-module/services_workspace_execution-context.ts";
import { evaluateProblemAccess } from "../../../problems/contracts/cross-module/services_problem-access-check.ts";
import { judgePaper } from "./objective-judge.ts";
import { applyAttemptResult } from "../versioning/result-write.ts";
import { createAttempt } from "../versioning/attempts.ts";
import type { DomainExecutionRequest } from "../workspace-execution.ts";
import {
  lockDomainExecution,
  resolveDomainExecution,
} from "../workspace-execution.ts";
import {
  loadPublishedVersionContent,
  resolveSubmissionVersion,
} from "../versioning/submission-version.ts";
import { loadProblemIdentity } from "../../../problems/contracts/cross-module/services_versioning_draft.ts";
import {
  assertObjectivePaper,
  getPaperOrThrow,
} from "../../../problems/contracts/cross-module/services_objective_objective-questions.ts";
import { type ContestResponse } from "../../../contests/types/contests.ts";
import {
  getContest,
  resolveContestId,
} from "../../../contests/contracts/cross-module/services_contests.ts";
import { getContestProblems } from "../../../contests/contracts/cross-module/services_contest-problems.ts";
import type {
  SubmitObjectiveInput,
  SubmitObjectiveResponse,
} from "../../../problems/types/objective.ts";
import { validateAnswersPayload } from "../../../problems/types/objective.ts";
import {
  fromSnapshot,
  type JudgedQuestion,
  stripExpected,
  withExplanation,
} from "./objective-submission-read.ts";

/** ×100 分换算回百分制。 */
const SCORE_SCALE_FACTOR = 100;

/**
 * 竞赛模式提交校验（specs/contest-participation）：
 * 1. 竞赛存在且 running；2. 用户已注册；3. 套卷在题单；4. 无既有提交。
 */
async function validateContestSubmission(
  contestId: string,
  paperId: string,
  userId: string,
): Promise<ContestResponse> {
  const contest = await getContest(contestId, userId);
  if (contest.status !== "running") {
    throw new ForbiddenError("竞赛未在进行中，无法提交");
  }
  if (!contest.is_registered) {
    throw new ForbiddenError("未报名参赛，无法提交");
  }
  const problems = await getContestProblems(contestId, userId);
  if (!problems.some((p) => p.problem_id === paperId)) {
    throw new BadRequestError("该套卷不属于此竞赛的题目");
  }
  const db = getDb();
  const existing = await db
    .select({ id: objectiveSubmissions.id })
    .from(objectiveSubmissions)
    .where(
      and(
        eq(objectiveSubmissions.paper_id, paperId),
        eq(objectiveSubmissions.user_id, userId),
        eq(objectiveSubmissions.contest_id, contestId),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new BadRequestError("该竞赛中已提交过此套卷，只允许提交一次");
  }
  return contest;
}

/**
 * 提交套卷答案并即时判定落库。
 *
 * @returns 判定结果（含逐题对错；练习模式含解析）
 */
export async function submitObjectivePaper(
  paperId: string,
  input: SubmitObjectiveInput,
  userId: string,
  isAdmin = false,
  domainRequest?: DomainExecutionRequest,
): Promise<SubmitObjectiveResponse> {
  const db = getDb();
  if (domainRequest && input.contest_id && !domainRequest.contestId) {
    throw new BadRequestError("域内练习不能携带比赛上下文");
  }
  const domainExecution = domainRequest
    ? await resolveDomainExecution(domainRequest, userId, input.version_id)
    : null;
  const paper = domainExecution?.problem ?? await getPaperOrThrow(paperId);
  if (domainExecution && paper.id !== paperId) {
    throw new NotFoundError("域题目引用与内部身份不一致");
  }
  if (!domainExecution) assertDefaultProblemSource(paper);
  assertObjectivePaper(paper);
  const paperUuid = paper.id;

  // 练习/竞赛提交统一访问判定（F-05/C1）：private 套卷非 owner/admin 且无竞赛
  // 上下文一律拒绝；被公开赛保密的套卷同此口径（无法从独立路径提交）；
  // 竞赛上下文由 validateContestSubmission 独立校验，不接受伪造。
  // 对外竞赛 URL 使用 public_id；落库、版本绑定与一次提交约束统一使用 UUID。
  const requestedContestId = input.contest_id
    ? await resolveContestId(input.contest_id)
    : null;
  if (
    domainExecution?.contestId && requestedContestId &&
    domainExecution.contestId !== requestedContestId
  ) throw new BadRequestError("比赛路径与交卷上下文不一致");
  const contestId = domainExecution?.contestId ?? requestedContestId;
  if (!contestId && !domainExecution) {
    const { result: access } = await evaluateProblemAccess(paper, {
      purpose: "write",
      viewerId: userId,
      isAdmin,
    });
    if (!access.allowed) {
      throw new ForbiddenError("无权对该套卷提交");
    }
  }

  // 载荷校验
  try {
    validateAnswersPayload(input.answers);
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }

  const contestMode = contestId !== null;
  const contest = contestId
    ? await validateContestSubmission(contestId, paperUuid, userId)
    : null;

  // 提交时版本（Handbook §4.2/§6.4）：**必须显式携带** `version_id`——竞赛只接受该
  // 竞赛的固定版本（不一致 → 409 `CONTEST_PROBLEM_VERSION_CHANGED`），题库显式版本
  // 逐字生效（不属于该题 → 404），未携带版本一律 409 `VERSION_REQUIRED`，绝不静默绑定
  // 最新版；`legacy_unknown` 仅供存量迁移，线上入口不再产生。已发布版本的小题快照是
  // 判卷事实源（旧 `objective_questions` 表已随 0107 删除，未知版本无卷面可还原）。
  const identity = await loadProblemIdentity(paperUuid);
  const resolved = await resolveSubmissionVersion(paperUuid, {
    contestId,
    requestedVersionId: input.version_id,
    latestVersionId: identity.latest_version_id,
  });
  let versionQuestions: JudgedQuestion[] | null = null;
  let submittedVersionId: string | null = null;
  if (resolved.kind === "known") {
    submittedVersionId = resolved.version.version_id;
    const loaded = await loadPublishedVersionContent(
      paperUuid,
      submittedVersionId,
    );
    if (!loaded || loaded.content.kind !== "objective") {
      throw new BadRequestError("该套卷版本内容不可用于判卷，请联系管理员");
    }
    versionQuestions = fromSnapshot(loaded.content.questions);
  }

  // 判卷事实源是**提交时版本的卷面**；`legacy_unknown`（迁移存量、无版本可解析）
  // 只可能来自尚未版本化且已不可访问的题目，按空卷面处理（全部按未作答）。
  const questions = versionQuestions ?? [];

  // 服务端即时判定（纯函数）。
  const judgement = judgePaper({
    questions: questions.map((q) => ({
      id: q.key,
      type: q.type,
      answer: q.answer,
      explanation: q.explanation,
    })),
    answers: input.answers,
  });

  const now = new Date().toISOString();
  const submissionId = crypto.randomUUID();
  // F-14：入库前剥离 expected，任何后续读路径都不可能泄露标准答案。
  const storedDetails = stripExpected(judgement.details);
  const row = {
    id: submissionId,
    paper_id: paperUuid,
    user_id: userId,
    contest_id: contestId,
    submission_type: contestMode ? ("contest" as const) : ("practice" as const),
    answers: input.answers,
    status: "finished",
    score: judgement.score,
    details: storedDetails,
    // 提交时版本不可变：`known` 必须有版本，`legacy_unknown` 必须为空
    submitted_version_id: submittedVersionId,
    version_origin: submittedVersionId ? ("known" as const) : (
      "legacy_unknown" as const
    ),
    created_at: now,
  };

  // 客观题判定是同步纯函数，因此「提交行 + 初次尝试 + 当前正式判定 + 有效成绩
  // 投影」可以在**一个事务**内完成（Handbook §5.4 第 3–8 步）：任何一步失败都不会
  // 留下"有提交行却没有成绩"的半成品。
  const source = {
    kind: "objective" as const,
    id: submissionId,
    problem_id: paperUuid,
    contest_id: contestId,
  };

  try {
    await db.transaction(async (tx) => {
      const workspace = domainExecution && domainRequest
        ? await lockDomainExecution(
          domainExecution,
          domainRequest,
          userId,
          input.version_id,
          tx,
        )
        : await resolveDefaultExecutionContext(paperUuid, userId, tx);
      await consumeDomainSubmissionQuota(
        workspace.domain_id,
        userId,
        submissionId,
        tx,
      );
      await tx.insert(objectiveSubmissions).values({ ...row, ...workspace });
      const attempt = await createAttempt({
        source,
        problemVersionId: submittedVersionId,
        source_kind: "initial",
        // 非敏感执行快照：版本、题型与卷面题量（不含标准答案）
        taskSnapshot: {
          kind: "objective",
          problem_version_id: submittedVersionId,
          submission_mode: contestMode ? "contest" : "practice",
          total_count: judgement.total_count,
        },
        createdBy: userId,
        executor: tx,
      });
      const outcome = await applyAttemptResult({
        attemptId: attempt.id,
        resultKind: "graded",
        resultStatus: "finished",
        score: judgement.score,
        // 客观题通过口径 = 满分（与迁移基线 `score >= 10000` 及题单进度一致）
        accepted: judgement.score >= FULL_SCORE,
        details: storedDetails as unknown as Record<string, unknown>,
      }, tx);
      if (outcome.applied !== "graded") {
        throw new Error(`客观题判定写入未生效：${outcome.applied}`);
      }
    });
  } catch (err) {
    // 竞赛一次性提交唯一索引兜底（23505）
    const pgCode = (err as Record<string, unknown>)?.code ??
      ((err as Record<string, unknown>)?.cause as Record<string, unknown>)
        ?.code;
    if (contestMode && pgCode === "23505") {
      throw new BadRequestError("该竞赛中已提交过此套卷，只允许提交一次");
    }
    throw err;
  }

  // 比赛一次正式交卷：Kaggle 只给本人原始总分，OI 隐藏成绩；均不返回逐题对错。
  if (contestMode) {
    return {
      submission_id: submissionId,
      paper_id: paperId,
      status: "finished",
      contest_mode: true,
      score: contest?.type === "kaggle"
        ? judgement.score / SCORE_SCALE_FACTOR
        : null,
      score_db: contest?.type === "kaggle" ? judgement.score : null,
      correct_count: null,
      total_count: judgement.total_count,
      details: {},
    };
  }

  return {
    submission_id: submissionId,
    paper_id: paperId,
    score: judgement.score / SCORE_SCALE_FACTOR,
    score_db: judgement.score,
    correct_count: judgement.correct_count,
    total_count: judgement.total_count,
    details: paper.visibility === "public"
      ? withExplanation(judgement.details, questions, true)
      : withExplanation(judgement.details, questions, false),
    contest_mode: false,
  };
}
