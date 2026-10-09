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
import { and, count, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  objectiveQuestions,
  objectiveSubmissions,
} from "./../../../shared/db/schema.ts";
import { FULL_SCORE } from "./../../../shared/base/constants.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { checkPermission } from "./../../identity/index.ts";
import { evaluateProblemAccess } from "./../../catalog/index.ts";
import { judgePaper } from "./objective-judge.ts";
import {
  applyAttemptResult,
  createAttempt,
  loadPublishedVersionContent,
  resolveSubmissionVersion,
} from "./../../submission/index.ts";
import type { SubmissionVersionResolution } from "./../../submission/index.ts";
import { resolveDefaultAnswerVersion } from "./../../../shared/versioning/policy.ts";
import type { ObjectiveQuestionSnapshot } from "./../../catalog/index.ts";
import { loadProblemIdentity } from "./../../catalog/index.ts";
import {
  assertObjectivePaper,
  getPaperOrThrow,
  resolvePaperId,
} from "./objective-questions.ts";
import {
  filterUnendedContestIds,
  getContest,
  getContestProblems,
  isProblemInUnendedPublicContest,
} from "../../contest/index.ts";
import type {
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
 * `key` 是**版本内的稳定小题键**（Handbook §1.2）：已发布版本取快照的 `key`，
 * 未版本化的存量套卷回退旧小题表的主键 UUID——两者都是用户答案映射的键，
 * 也保证了「同一份答案在 `any` 策略下跨版本重判仍能按 key 匹配」。
 */
interface JudgedQuestion {
  key: string;
  type: string;
  answer: ObjectiveAnswerValue[];
  explanation: string;
}

/** 旧小题表行 → 判分形态（存量套卷回退路径）。 */
function fromLegacyRows(
  rows: readonly (typeof objectiveQuestions.$inferSelect)[],
): JudgedQuestion[] {
  return rows.map((q) => ({
    key: q.id,
    type: q.type,
    answer: q.answer as ObjectiveAnswerValue[],
    explanation: q.explanation,
  }));
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
 * 优先按 `submitted_version_id` 读**提交时版本**的小题快照——套卷在小题增删
 * 后仍要还原当时的卷面；`legacy_unknown`（迁移存量）回退旧小题表。
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
  const db = getDb();
  const legacy = await db
    .select()
    .from(objectiveQuestions)
    .where(eq(objectiveQuestions.paper_id, row.paper_id));
  return fromLegacyRows(legacy);
}

/**
 * 竞赛模式提交校验（specs/contest-participation）：
 * 1. 竞赛存在且 running；2. 用户已注册；3. 套卷在题单；4. 无既有提交。
 */
async function validateContestSubmission(
  contestId: string,
  paperId: string,
  userId: string,
): Promise<void> {
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
): Promise<SubmitObjectiveResponse> {
  const db = getDb();
  const paper = await getPaperOrThrow(paperId);
  assertObjectivePaper(paper);
  const paperUuid = paper.id;

  // 练习/竞赛提交统一访问判定（F-05/C1）：private 套卷非 owner/admin 且无竞赛
  // 上下文一律拒绝；被公开赛保密的套卷同此口径（无法从独立路径提交）；
  // 竞赛上下文由 validateContestSubmission 独立校验，不接受伪造。
  const contestId = input.contest_id ?? null;
  if (!contestId) {
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
  if (contestMode) {
    await validateContestSubmission(contestId, paperUuid, userId);
  }

  // 提交时版本（Handbook §4.2/§6.4）：竞赛用固定版本；题库**显式指定**的版本必须
  // 逐字生效（不属于该题一律 404，绝不静默换版本）；题库**未指定**时才按有效策略
  // 解析默认作答版本（any → 最新版、exact → 要求版本）。已发布版本的小题快照是
  // 判卷事实源，未版本化的存量套卷回退旧小题表（key = 旧小题 UUID，与迁移基线一致）。
  const identity = await loadProblemIdentity(paperUuid);
  const requestedVersionId = input.version_id?.trim() || null;
  let resolved: SubmissionVersionResolution;
  if (contestId || requestedVersionId) {
    resolved = await resolveSubmissionVersion(paperUuid, {
      contestId,
      requestedVersionId,
      latestVersionId: identity.latest_version_id,
    });
  } else {
    const defaultVersionId = resolveDefaultAnswerVersion(identity);
    resolved = defaultVersionId
      ? await resolveSubmissionVersion(paperUuid, {
        requestedVersionId: defaultVersionId,
        latestVersionId: identity.latest_version_id,
      })
      : { kind: "legacy_unknown" };
  }

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

  const questions = versionQuestions ?? fromLegacyRows(
    await db
      .select()
      .from(objectiveQuestions)
      .where(eq(objectiveQuestions.paper_id, paperUuid)),
  );

  // 服务端即时判定（纯函数）。判卷事实源是**提交时版本的卷面**，
  // 未版本化的存量套卷回退旧小题表（key = 旧小题 UUID，与迁移基线一致）。
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
      await tx.insert(objectiveSubmissions).values(row);
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

  // ── 竞赛模式：只回执"已提交"事实（审计 VULN-03）──
  //
  // 此前这里返回 `stripExpected(details)`——虽剥离了标准答案，却**保留每题
  // correct: true/false**，并即时返回精确分数。协同作弊者据此把小号提交当作答案
  // 预言机，逐题试探即可拼出全套满分答案。
  // 现赛期不返回任何判定与分数；竞赛结束后由详情/历史接口给出（见
  // getObjectiveSubmission / listObjectiveSubmissions 的赛后放行逻辑）。
  if (contestMode) {
    return {
      submission_id: submissionId,
      paper_id: paperId,
      status: "finished",
      contest_mode: true,
      score: null,
      score_db: null,
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
 * 将数据库行转换为对外返回的提交响应对象。
 *
 * @param row 客观题提交记录（数据库行）
 * @returns 面向 API 的提交响应（ObjectiveSubmissionResponse）
 */
function toSubmissionResponse(
  row: typeof objectiveSubmissions.$inferSelect,
): ObjectiveSubmissionResponse {
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
  // 实时权限查询（submission:read_all，admin:full_access 通配），与编程题 getSubmission 一致
  const isAdmin = c
    ? await checkPermission(c, "submission:read_all")
    : viewerRole === "admin";
  if (row.user_id !== viewerId && !isAdmin) {
    throw new NotFoundError("提交记录不存在");
  }

  const response = toSubmissionResponse(row);
  if (row.submission_type === "contest") {
    // 竞赛模式：隐藏解析与期望答案（防泄题）；竞赛**尚未结束**时进一步屏蔽逐题
    // 对错与分数（审计 VULN-03）——否则参赛者提交后调用详情接口即可拿到答案预言机。
    const unended = row.contest_id
      ? await filterUnendedContestIds([row.contest_id])
      : new Set<string>();
    const contestUnended = row.contest_id !== null &&
      unended.has(row.contest_id);
    if (contestUnended) {
      return {
        ...response,
        score: null,
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
    contestId,
    targetUserId,
    page,
    perPage,
  } = params;

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

  const conditions = [eq(objectiveSubmissions.user_id, userId)];
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

  // 竞赛模式的赛期屏蔽（审计 VULN-03）：一次查询算出本页涉及的"未结束竞赛"集合，
  // 再对命中行剥离逐题对错与分数。与详情接口同一口径，避免"列表是旁路"。
  const unendedContests = await filterUnendedContestIds(
    rows
      .filter((row) => row.submission_type === "contest" && row.contest_id)
      .map((row) => row.contest_id as string),
  );
  const data = rows.map((row) => {
    const response = toSubmissionResponse(row);
    if (
      row.submission_type !== "contest" || !row.contest_id ||
      !unendedContests.has(row.contest_id)
    ) {
      return response;
    }
    return {
      ...response,
      score: null,
      details: stripContestJudgement(response.details),
    };
  });

  return {
    data,
    total,
    best_score: bestScore,
  };
}
