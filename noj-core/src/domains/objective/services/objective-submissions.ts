/**
 * 客观题提交服务：提交判定落库、提交历史、最高分查询。
 *
 * 两种模式（specs/objective-judging）：
 * - 练习（contest_id 为空）：允许重复提交，每次落库，成绩取 MAX(score)
 * - 竞赛（contest_id 非空）：校验竞赛 running + 已注册 + 套卷在题单 +
 *   无既有提交（只允许一次，唯一索引 23505 兜底）
 *
 * 判定详情权限：仅提交者本人或 admin 可读；竞赛模式不展示解析（防泄题）。
 */
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { DEFAULT_DOMAIN_ID } from "../../workspace/index.ts";
import type { Context } from "hono";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  contests,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
} from "./../../../shared/db/schema.ts";
import { FULL_SCORE } from "./../../../shared/base/constants.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { checkPermission } from "./../../identity/index.ts";
import {
  assertDefaultProblemSource,
  evaluateProblemAccess,
  resolveDefaultExecutionContext,
} from "./../../catalog/index.ts";
import { judgePaper } from "./objective-judge.ts";
import {
  applyAttemptResult,
  createAttempt,
  type DomainExecutionRequest,
  loadPublishedVersionContent,
  lockDomainExecution,
  resolveDomainExecution,
  resolveSubmissionVersion,
} from "./../../submission/index.ts";
import type { ObjectiveQuestionSnapshot } from "./../../catalog/index.ts";
import { loadProblemIdentity } from "./../../catalog/index.ts";
import {
  assertObjectivePaper,
  getPaperOrThrow,
  resolvePaperId,
} from "./objective-questions.ts";
import {
  type ContestResponse,
  filterUnendedContestIds,
  getContest,
  getContestProblems,
  isProblemInUnendedPublicContest,
  resolveContestId,
} from "../../contest/index.ts";
import type {
  ObjectiveAttemptSummary,
  ObjectiveAttemptView,
  ObjectiveSubmissionResponse,
  QuestionJudgement,
  SubmitObjectiveInput,
  SubmitObjectiveResponse,
} from "./../types/objective.ts";
import { validateAnswersPayload } from "./../types/objective.ts";
import type { ObjectiveAnswerValue } from "./../types/objective.ts";

/** ×100 分换算回百分制。 */
const SCORE_SCALE_FACTOR = 100;

/**
 * 卷内小题（判分与展示的公共形态）。
 *
 * `key` 是**版本内的稳定小题键**（Handbook §1.2）：已发布版本取快照的 `key`；
 * 迁移存量（`legacy_unknown`，无提交时版本）的卷面已无法还原，按未作答处理
 * （Handbook §8.1「历史信息无法恢复，保留未知状态」）。
 */
interface JudgedQuestion {
  key: string;
  type: string;
  answer: ObjectiveAnswerValue[];
  explanation: string;
}

/** 版本小题快照 → 判分形态。 */
function fromSnapshot(
  questions: readonly ObjectiveQuestionSnapshot[],
): JudgedQuestion[] {
  return questions.map((q) => ({
    key: q.key,
    type: q.type,
    answer: [...q.answer] as ObjectiveAnswerValue[],
    explanation: q.explanation,
  }));
}

/**
 * 读取某条提交实际使用的卷面小题（展示解析用）。
 *
 * 按 `submitted_version_id` 读**提交时版本**的小题快照——套卷在小题增删后仍要
 * 还原当时的卷面；`legacy_unknown`（迁移存量、无提交时版本）返回空卷面，
 * 原始 answers 仍保留可读。
 */
async function loadSubmissionQuestions(
  row: typeof objectiveSubmissions.$inferSelect,
): Promise<JudgedQuestion[]> {
  if (row.submitted_version_id) {
    const loaded = await loadPublishedVersionContent(
      row.paper_id,
      row.submitted_version_id,
    );
    if (loaded && loaded.content.kind === "objective") {
      return fromSnapshot(loaded.content.questions);
    }
  }
  return [];
}

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
 * 裁剪判定详情中的期望答案（expected）。
 * 竞赛模式防泄题：不向参赛者返回标准答案（与不展示解析同一立场）。
 */
function stripExpected(
  details: Record<string, QuestionJudgement>,
): Record<string, QuestionJudgement> {
  const result: Record<string, QuestionJudgement> = {};
  for (const [qid, judgement] of Object.entries(details)) {
    result[qid] = { correct: judgement.correct, given: judgement.given };
  }
  return result;
}

/**
 * 竞赛赛期屏蔽：只保留"用户自己的作答"，剥离逐题对错。
 *
 * 与 {@link stripExpected}（只剥离标准答案）的区别：本函数连 `correct` 一起剥离。
 * 赛期返回逐题对错等于给出答案预言机——参赛者可用小号逐题试探、协同排除错误选项
 * （审计 VULN-03）。
 */
function stripContestJudgement(
  details: Record<string, QuestionJudgement>,
): Record<string, QuestionJudgement> {
  const result: Record<string, QuestionJudgement> = {};
  for (const [qid, judgement] of Object.entries(details)) {
    result[qid] = { given: judgement.given };
  }
  return result;
}

/**
 * 合并解析到判定详情（仅练习模式返回 explanation，防泄题）。
 * includeExpected=false 时同时剥离 expected（private 套卷练习响应不泄标准答案）。
 */
function withExplanation(
  details: Record<string, QuestionJudgement>,
  questions: readonly JudgedQuestion[],
  includeExpected = true,
): Record<string, QuestionJudgement> {
  const result: Record<string, QuestionJudgement> = {};
  for (const q of questions) {
    const judgement = details[q.key] ?? { correct: false, given: [] };
    const entry: QuestionJudgement = {
      correct: judgement.correct,
      given: judgement.given,
    };
    if (includeExpected && judgement.expected !== undefined) {
      entry.expected = judgement.expected;
    }
    entry.explanation = q.explanation || undefined;
    result[q.key] = entry;
  }
  return result;
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

/**
 * 版本元信息：提交时版本号 + 该版本是否仍是本套卷最新已发布版本。
 *
 * 批量查询（列表路径一次取回，避免 N+1）：一次查全部 `problem_versions` 与
 * 涉及的套卷行。
 */
interface ObjectiveReadMeta {
  submitted_version: number | null;
  is_latest: boolean;
}

async function loadReadMeta(
  rows: readonly (typeof objectiveSubmissions.$inferSelect)[],
): Promise<Map<string, ObjectiveReadMeta>> {
  const meta = new Map<string, ObjectiveReadMeta>();
  if (rows.length === 0) return meta;
  const db = getDb();
  const versionIds = [
    ...new Set(
      rows.map((row) => row.submitted_version_id).filter((
        id,
      ): id is string => !!id),
    ),
  ];
  const paperIds = [...new Set(rows.map((row) => row.paper_id))];

  const versionNumberById = new Map<string, number>();
  if (versionIds.length > 0) {
    const versions = await db.select({
      id: problemVersions.id,
      version: problemVersions.version,
    }).from(problemVersions).where(inArray(problemVersions.id, versionIds));
    for (const version of versions) {
      versionNumberById.set(version.id, version.version);
    }
  }
  const latestByPaper = new Map<string, string | null>();
  if (paperIds.length > 0) {
    const papers = await db.select({
      id: problems.id,
      latest_version_id: problems.latest_version_id,
    }).from(problems).where(inArray(problems.id, paperIds));
    for (const paper of papers) {
      latestByPaper.set(paper.id, paper.latest_version_id);
    }
  }
  for (const row of rows) {
    const versionId = row.submitted_version_id ?? null;
    meta.set(row.id, {
      submitted_version: versionId
        ? (versionNumberById.get(versionId) ?? null)
        : null,
      is_latest: versionId !== null &&
        latestByPaper.get(row.paper_id) === versionId,
    });
  }
  return meta;
}

/** 尝试展示状态：与普通提交侧同口径（finished/error，未终结回落 pending/judging）。 */
function attemptDisplayStatus(
  state: string,
  resultStatus: string | null,
): string {
  if (resultStatus) {
    if (
      resultStatus === "error" || resultStatus === "SystemError" ||
      resultStatus === "TimeLimitExceeded" ||
      resultStatus === "MemoryLimitExceeded" || resultStatus === "RuntimeError"
    ) {
      return "error";
    }
    return "finished";
  }
  if (state === "queued") return "pending";
  if (state === "judging") return "judging";
  return "error";
}

/**
 * 批量加载逐次执行历史（`evaluation_attempts.objective_submission_id`）。
 *
 * 只取非敏感字段；`maskCorrectness` 为 true（竞赛未结束）时 `is_accepted` /
 * `is_effective` 一律 false——否则相对分差可被当作答案预言机（审计 VULN-03）。
 */
async function loadAttempts(
  submissionIds: readonly string[],
  maskCorrectness = false,
): Promise<Map<string, ObjectiveAttemptView[]>> {
  const bySubmission = new Map<string, ObjectiveAttemptView[]>();
  if (submissionIds.length === 0) return bySubmission;
  const db = getDb();
  const rows = await db.select({
    attempt_id: evaluationAttempts.id,
    submission_id: evaluationAttempts.objective_submission_id,
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
    .where(
      inArray(evaluationAttempts.objective_submission_id, [...submissionIds]),
    );

  const pointers = new Map<
    string,
    { accepted: string | null; effective: string | null; latest: string | null }
  >();
  const pointerRows = await db.select({
    id: objectiveSubmissions.id,
    accepted: objectiveSubmissions.accepted_attempt_id,
    effective: objectiveSubmissions.effective_attempt_id,
    latest: objectiveSubmissions.latest_attempt_id,
  }).from(objectiveSubmissions).where(
    inArray(objectiveSubmissions.id, [...submissionIds]),
  );
  for (const pointer of pointerRows) {
    pointers.set(pointer.id, {
      accepted: pointer.accepted,
      effective: pointer.effective,
      latest: pointer.latest,
    });
  }

  for (const item of rows) {
    const submissionId = item.submission_id;
    if (!submissionId) continue;
    const pointer = pointers.get(submissionId);
    const view: ObjectiveAttemptView = {
      attempt_id: item.attempt_id,
      sequence: item.sequence,
      problem_version_id: item.problem_version_id ?? null,
      version: item.version ?? null,
      source: item.source as ObjectiveAttemptView["source"],
      state: item.state as ObjectiveAttemptView["state"],
      result_kind: item.result_kind ?? null,
      status: attemptDisplayStatus(item.state, item.result_status),
      score: item.score ?? 0,
      time_ms: item.time_ms ?? null,
      memory_kb: item.memory_kb ?? null,
      is_effective: !maskCorrectness && pointer?.effective === item.attempt_id,
      is_accepted: !maskCorrectness && pointer?.accepted === item.attempt_id,
      is_latest: pointer?.latest === item.attempt_id,
      created_at: item.created_at,
      finished_at: item.finished_at ?? null,
    };
    const list = bySubmission.get(submissionId) ?? [];
    list.push(view);
    bySubmission.set(submissionId, list);
  }
  for (const list of bySubmission.values()) {
    list.sort((a, b) =>
      a.sequence - b.sequence || a.attempt_id.localeCompare(b.attempt_id)
    );
  }
  return bySubmission;
}

/** 尝试摘要（与普通提交侧 `summarizeAttempt` 同字段）。 */
function summarizeAttempt(
  attempts: readonly ObjectiveAttemptView[],
  attemptId: string | null,
): ObjectiveAttemptSummary | null {
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
}

/**
 * 将数据库行转换为对外返回的提交响应对象。
 *
 * @param row 客观题提交记录（数据库行）
 * @param options.meta 版本元信息（缺省时版本号/最新标记为未知）
 * @param options.attempts 逐次执行历史
 * @param options.maskCorrectness 竞赛未结束：屏蔽通过与否（防答案预言机）
 */
function toSubmissionResponse(
  row: typeof objectiveSubmissions.$inferSelect,
  options: {
    meta?: ObjectiveReadMeta;
    attempts?: ObjectiveAttemptView[];
    maskCorrectness?: boolean;
  } = {},
): ObjectiveSubmissionResponse {
  const attempts = options.attempts ?? [];
  return {
    id: row.id,
    paper_id: row.paper_id,
    user_id: row.user_id,
    contest_id: row.contest_id,
    submission_type: row.submission_type as "practice" | "contest",
    answers: row.answers as ObjectiveSubmissionResponse["answers"],
    status: row.status,
    score: row.score,
    details: row.details as ObjectiveSubmissionResponse["details"],
    created_at: row.created_at,
    submitted_version_id: row.submitted_version_id ?? null,
    submitted_version: options.meta?.submitted_version ?? null,
    version_origin: (row.version_origin ?? "legacy_unknown") as
      | "known"
      | "legacy_unknown",
    is_latest: options.meta?.is_latest ?? false,
    is_valid: row.is_valid,
    is_accepted: options.maskCorrectness ? null : row.is_accepted,
    active_attempt_id: row.active_attempt_id ?? null,
    latest_attempt_id: row.latest_attempt_id ?? null,
    effective_attempt_id: row.effective_attempt_id ?? null,
    accepted_attempt_id: options.maskCorrectness
      ? null
      : (row.accepted_attempt_id ?? null),
    upgraded_from_id: row.upgraded_from_id ?? null,
    attempts,
    latest_attempt: summarizeAttempt(attempts, row.latest_attempt_id ?? null),
    effective_attempt: options.maskCorrectness
      ? null
      : summarizeAttempt(attempts, row.effective_attempt_id ?? null),
  };
}

/**
 * 获取单次提交详情。
 * 权限：仅提交者本人或具备 submission:read_all 权限者（admin）可读。
 * 竞赛模式不展示解析（防泄题）。
 */
export async function getObjectiveSubmission(
  submissionId: string,
  viewerId: string,
  viewerRole?: string,
  c?: Context,
): Promise<ObjectiveSubmissionResponse> {
  const db = getDb();
  const rows = await db
    .select()
    .from(objectiveSubmissions)
    .where(eq(objectiveSubmissions.id, submissionId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError("提交记录不存在");
  }
  const row = rows[0];
  if (row.domain_id !== null && row.domain_id !== DEFAULT_DOMAIN_ID) {
    throw new NotFoundError("默认域不存在此提交");
  }
  // 实时权限查询（submission:read_all，admin:full_access 通配），与编程题 getSubmission 一致
  const isAdmin = c
    ? await checkPermission(c, "submission:read_all")
    : viewerRole === "admin";
  if (row.user_id !== viewerId && !isAdmin) {
    throw new NotFoundError("提交记录不存在");
  }

  // 赛期按赛制裁剪：Kaggle 可读总分，OI 不返回执行历史，均隐藏逐题正确性。
  const contestUnended = row.submission_type === "contest" && row.contest_id
    ? (await filterUnendedContestIds([row.contest_id])).has(row.contest_id)
    : false;

  const meta = (await loadReadMeta([row])).get(row.id);
  const attempts = (await loadAttempts([row.id], contestUnended)).get(row.id) ??
    [];
  const response = toSubmissionResponse(row, {
    meta,
    attempts,
    maskCorrectness: contestUnended,
  });

  if (row.submission_type === "contest") {
    // 比赛题的答案与解析按窗口裁剪，赛制决定本人总分是否可见。
    if (contestUnended) {
      const contest = await getContest(row.contest_id!, viewerId);
      if (contest.type === "oi") return hiddenObjectiveResult(response);
      return {
        ...response,
        score: contest.type === "kaggle" ? response.score : null,
        details: stripContestJudgement(response.details),
      };
    }
    return {
      ...response,
      details: stripExpected(response.details),
    };
  }
  // 练习模式：仅公开套卷或 owner/admin 可看到解析（F-01 解析门）
  const paper = await getPaperOrThrow(row.paper_id);
  // 审计 DL-01：若该套卷归属于尚未结束的公开赛，严禁回传解析与标准答案！
  const inUnendedContest = await isProblemInUnendedPublicContest(row.paper_id);
  const canExplain = !inUnendedContest && (
    paper.visibility === "public" ||
    paper.owner_id === viewerId || isAdmin
  );
  if (!canExplain) {
    return {
      ...response,
      details: stripExpected(response.details),
    };
  }
  const questions = await loadSubmissionQuestions(row);
  const details = withExplanation(
    row.details as Record<string, QuestionJudgement>,
    questions,
    paper.visibility === "public",
  );
  return {
    ...response,
    details: details as unknown as ObjectiveSubmissionResponse["details"],
  };
}

/**
 * 提交历史（默认本人；admin 可指定 user_id 查看他人）。
 * 返回分页列表 + 练习最高分（仅当筛选了 paper_id 时）。
 */
export async function listObjectiveSubmissions(params: {
  viewerId: string;
  viewerRole?: string;
  c?: Context;
  paperId?: string;
  contestId?: string;
  targetUserId?: string;
  page: number;
  perPage: number;
}): Promise<{
  data: ObjectiveSubmissionResponse[];
  total: number;
  best_score: number | null;
}> {
  const db = getDb();
  const {
    viewerId,
    viewerRole,
    c,
    paperId,
    contestId: contestReference,
    targetUserId,
    page,
    perPage,
  } = params;

  const contestId = contestReference
    ? await resolveContestId(contestReference)
    : undefined;

  // 非 admin（submission:read_all）只能查自己；他人查询参数被忽略
  const isAdmin = c
    ? await checkPermission(c, "submission:read_all")
    : viewerRole === "admin";
  const userId = targetUserId && isAdmin ? targetUserId : viewerId;

  // paper_id 支持 display_id / UUID 双索引（解析为规范 UUID 后过滤提交记录）
  // 套卷不存在时按“无该套卷提交”处理，保持列表接口返回空结果而非 404
  const paper = paperId ? await resolvePaperId(paperId) : null;
  if (paperId && !paper) {
    return { data: [], total: 0, best_score: null };
  }
  const paperUuid = paper?.id;

  const defaultDomain =
    sql`(${objectiveSubmissions.domain_id} = ${DEFAULT_DOMAIN_ID} OR ${objectiveSubmissions.domain_id} IS NULL)`;
  const conditions = [eq(objectiveSubmissions.user_id, userId), defaultDomain];
  if (paperUuid) conditions.push(eq(objectiveSubmissions.paper_id, paperUuid));
  if (contestId) {
    conditions.push(eq(objectiveSubmissions.contest_id, contestId));
  }

  const [totalRow] = await db
    .select({ total: count() })
    .from(objectiveSubmissions)
    .where(and(...conditions));
  const total = totalRow?.total ?? 0;

  const rows = await db
    .select()
    .from(objectiveSubmissions)
    .where(and(...conditions))
    .orderBy(desc(objectiveSubmissions.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  // 练习模式最高分（仅按套卷筛选时有意义；竞赛提交不计入最高分）。
  // 读**有效成绩**：取 `is_valid` 提交的有效尝试分数，因此 `exact(X)` 策略下
  // 非 X 版本的历史提交不再计入最高分（Handbook §3.2 读取统一）。
  let bestScore: number | null = null;
  if (paperUuid) {
    const effective = await db
      .select({ score: evaluationAttempts.score })
      .from(objectiveSubmissions)
      .innerJoin(
        evaluationAttempts,
        eq(evaluationAttempts.id, objectiveSubmissions.effective_attempt_id),
      )
      .where(
        and(
          eq(objectiveSubmissions.user_id, userId),
          defaultDomain,
          eq(objectiveSubmissions.paper_id, paperUuid),
          eq(objectiveSubmissions.submission_type, "practice"),
          eq(objectiveSubmissions.is_valid, true),
        ),
      );
    for (const row of effective) {
      const score = row.score ?? 0;
      bestScore = bestScore === null ? score : Math.max(bestScore, score);
    }
  }

  // 批量加载本页比赛政策，列表和详情采用相同的总分及逐题正确性口径。
  const unendedContests = await filterUnendedContestIds(
    rows
      .filter((row) => row.submission_type === "contest" && row.contest_id)
      .map((row) => row.contest_id as string),
  );
  // 版本元信息与逐次执行历史批量加载（避免按行 N+1）；未结束竞赛的行屏蔽通过标记。
  const maskedRows = rows.filter((row) =>
    row.submission_type === "contest" && row.contest_id !== null &&
    unendedContests.has(row.contest_id)
  );
  const plainRows = rows.filter((row) => !maskedRows.includes(row));
  const metaBySubmission = await loadReadMeta(rows);
  const maskedAttempts = await loadAttempts(
    maskedRows.map((row) => row.id),
    true,
  );
  const plainAttempts = await loadAttempts(plainRows.map((row) => row.id));
  const contestTypes = new Map(
    (unendedContests.size
      ? await db.select({ id: contests.id, type: contests.type }).from(contests)
        .where(inArray(contests.id, [...unendedContests]))
      : []).map((row) => [row.id, row.type]),
  );
  const data = rows.map((row) => {
    const contestUnended = maskedRows.includes(row);
    const attempts = contestUnended
      ? (maskedAttempts.get(row.id) ?? [])
      : (plainAttempts.get(row.id) ?? []);
    const response = toSubmissionResponse(row, {
      meta: metaBySubmission.get(row.id),
      attempts,
      maskCorrectness: contestUnended,
    });
    if (!contestUnended) return response;
    if (contestTypes.get(row.contest_id!) === "oi") {
      return hiddenObjectiveResult(response);
    }
    return {
      ...response,
      score: contestTypes.get(row.contest_id!) === "kaggle"
        ? response.score
        : null,
      details: stripContestJudgement(response.details),
    };
  });

  return {
    data,
    total,
    best_score: bestScore,
  };
}

/** OI 赛期只保留本人原答案与不可变提交身份，执行历史不能成为成绩旁路。 */
function hiddenObjectiveResult(
  row: ObjectiveSubmissionResponse,
): ObjectiveSubmissionResponse {
  return {
    id: row.id,
    paper_id: row.paper_id,
    user_id: row.user_id,
    contest_id: row.contest_id,
    submission_type: row.submission_type,
    answers: row.answers,
    created_at: row.created_at,
    submitted_version_id: row.submitted_version_id,
    submitted_version: row.submitted_version,
    version_origin: row.version_origin,
    is_latest: row.is_latest,
    upgraded_from_id: row.upgraded_from_id,
    status: "submitted",
    score: null,
    details: {},
    is_valid: null,
    is_accepted: null,
    active_attempt_id: null,
    latest_attempt_id: null,
    effective_attempt_id: null,
    accepted_attempt_id: null,
    attempts: [],
    latest_attempt: null,
    effective_attempt: null,
  };
}
