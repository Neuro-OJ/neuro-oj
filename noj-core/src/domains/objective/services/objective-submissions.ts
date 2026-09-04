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
import { and, count, desc, eq, max } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  objectiveQuestions,
  objectiveSubmissions,
} from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { checkPermission } from "./../../identity/index.ts";
import { judgePaper } from "./objective-judge.ts";
import {
  assertObjectivePaper,
  getPaperOrThrow,
  resolvePaperId,
} from "./objective-questions.ts";
import { getContest, getContestProblems } from "../../contest/index.ts";
import type {
  ObjectiveSubmissionResponse,
  QuestionJudgement,
  SubmitObjectiveInput,
  SubmitObjectiveResult,
} from "./../types/objective.ts";
import { validateAnswersPayload } from "./../types/objective.ts";
import type { ObjectiveAnswerValue } from "./../types/objective.ts";

/** ×100 分换算回百分制。 */
const SCORE_SCALE_FACTOR = 100;

/** 卷内小题（含答案，判分用）。 */
type QuestionWithAnswer = typeof objectiveQuestions.$inferSelect;

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
 * 合并解析到判定详情（仅练习模式返回 explanation，防泄题）。
 */
function withExplanation(
  details: Record<string, QuestionJudgement>,
  questions: QuestionWithAnswer[],
): Record<string, QuestionJudgement & { explanation?: string }> {
  const result: Record<string, QuestionJudgement & { explanation?: string }> =
    {};
  for (const q of questions) {
    result[q.id] = {
      ...(details[q.id] ?? { correct: false, expected: [], given: [] }),
      explanation: q.explanation || undefined,
    };
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
): Promise<SubmitObjectiveResult> {
  const db = getDb();
  const paper = await getPaperOrThrow(paperId);
  assertObjectivePaper(paper);
  const paperUuid = paper.id;

  // 载荷校验
  try {
    validateAnswersPayload(input.answers);
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }

  const questions = await db
    .select()
    .from(objectiveQuestions)
    .where(eq(objectiveQuestions.paper_id, paperUuid));

  const contestId = input.contest_id ?? null;
  const contestMode = contestId !== null;
  if (contestMode) {
    await validateContestSubmission(contestId, paperUuid, userId);
  }

  // 服务端即时判定（纯函数）
  const judgement = judgePaper({
    questions: questions.map((q) => ({
      id: q.id,
      type: q.type,
      answer: q.answer as ObjectiveAnswerValue[],
      explanation: q.explanation,
    })),
    answers: input.answers,
  });

  const now = new Date().toISOString();
  const submissionId = crypto.randomUUID();
  const row = {
    id: submissionId,
    paper_id: paperUuid,
    user_id: userId,
    contest_id: contestId,
    submission_type: contestMode ? ("contest" as const) : ("practice" as const),
    answers: input.answers,
    status: "finished",
    score: judgement.score,
    details: judgement.details,
    created_at: now,
  };

  try {
    await db.insert(objectiveSubmissions).values(row);
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

  return {
    submission_id: submissionId,
    paper_id: paperId,
    score: judgement.score / SCORE_SCALE_FACTOR,
    score_db: judgement.score,
    correct_count: judgement.correct_count,
    total_count: judgement.total_count,
    details: contestMode
      ? stripExpected(judgement.details)
      : withExplanation(judgement.details, questions),
    contest_mode: contestMode,
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
    throw new ForbiddenError("无权查看他人提交详情");
  }

  const response = toSubmissionResponse(row);
  if (row.submission_type === "contest") {
    // 竞赛模式：隐藏解析与期望答案（防泄题）
    return {
      ...response,
      details: stripExpected(response.details),
    };
  }
  // 练习模式：合并解析到逐题判定
  const questions = await db
    .select()
    .from(objectiveQuestions)
    .where(eq(objectiveQuestions.paper_id, row.paper_id));
  const details = withExplanation(
    row.details as Record<string, QuestionJudgement>,
    questions,
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

  // 练习模式最高分（仅按套卷筛选时有意义；竞赛提交不计入最高分）
  let bestScore: number | null = null;
  if (paperUuid) {
    const best = await db
      .select({ best: max(objectiveSubmissions.score) })
      .from(objectiveSubmissions)
      .where(
        and(
          eq(objectiveSubmissions.user_id, userId),
          eq(objectiveSubmissions.paper_id, paperUuid),
          eq(objectiveSubmissions.submission_type, "practice"),
        ),
      );
    bestScore = best[0]?.best ?? null;
  }

  return {
    data: rows.map(toSubmissionResponse),
    total,
    best_score: bestScore,
  };
}
