/**
 * 竞赛答疑服务。
 *
 * 数据模型 `contest_clarifications` 采用扁平线程：提问（reply_to_id 为 NULL，
 * is_public 固定 true）与回复（reply_to_id 指向根提问，is_public 由主办方指定）。
 * 可见性规则：
 * - 匿名 / 未参赛：仅公开问答
 * - 参赛者：公开问答 + 自己的提问（含挂在其下的私密回复）
 * - admin / 竞赛创建者：全部（含所有私密回复）
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db/connection.ts";
import {
  contestClarifications,
  contestProblems,
  users,
} from "../../../db/schema.ts";
import { nowIso } from "./../../../shared/base/dates.ts";
import { findContestRow } from "./contest-row.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { isUserAdmin } from "../../../lib/permissions.ts";
import { computeContestStatus, isParticipant } from "./contests.ts";
import { createNotification } from "../../community/index.ts";

const MAX_CONTENT_LENGTH = 5000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** 答疑发送者信息。 */
export interface ClarificationSender {
  id: string;
  username: string;
  avatar_url: string | null;
}

/** 答疑回复响应结构。 */
export interface ClarificationReplyResponse {
  id: string;
  content: string;
  is_public: boolean;
  created_at: string;
  sender: ClarificationSender;
}

/** 答疑响应结构（根提问 + 其下回复线程）。 */
export interface ClarificationResponse {
  id: string;
  contest_id: string;
  problem_id: string | null;
  problem_label: string | null;
  content: string;
  is_public: boolean;
  created_at: string;
  sender: ClarificationSender;
  replies: ClarificationReplyResponse[];
}

/** 答疑列表查询参数（分页）。 */
export interface ListClarificationsParams {
  page?: number;
  perPage?: number;
}

/** 答疑列表查询结果（分页数据与总数）。 */
export interface ListClarificationsResult {
  data: ClarificationResponse[];
  total: number;
}

type ClarificationRow = typeof contestClarifications.$inferSelect;

/**
 * 校验并规范化内容：去首尾空白、非空且不超过长度上限。
 *
 * @param content 待校验的内容
 * @param label 校验错误提示所用的字段名
 * @returns 规范化后的内容
 * @throws {BadRequestError} 内容为空或超过长度限制时
 */
function validateContent(content: string | undefined, label: string): string {
  const value = content?.trim() ?? "";
  if (!value) {
    throw new BadRequestError(`${label}不能为空`);
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new BadRequestError(
      `${label}超过长度限制（${MAX_CONTENT_LENGTH} 字符）`,
    );
  }
  return value;
}

/**
 * 断言题目属于指定竞赛。
 *
 * @param contestId 竞赛 UUID
 * @param problemId 题目 ID
 * @throws {BadRequestError} 题目不属于该竞赛时
 */
async function assertProblemBelongsToContest(
  contestId: string,
  problemId: string,
): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ problem_id: contestProblems.problem_id })
    .from(contestProblems).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    ).limit(1);
  if (!row) {
    throw new BadRequestError("题目不属于该竞赛");
  }
}

/** 批量查询用户（id → username），供线程组装使用。 */
async function getSenders(
  ids: string[],
): Promise<Map<string, ClarificationSender>> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db.select({
    id: users.id,
    username: users.username,
    avatar_url: users.avatar_url,
  }).from(
    users,
  ).where(inArray(users.id, ids));
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, username: row.username, avatar_url: row.avatar_url },
    ]),
  );
}

/** 批量查询竞赛题目标签（problem_id → label）。 */
async function getProblemLabels(
  contestId: string,
  problemIds: string[],
): Promise<Map<string, string>> {
  if (problemIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db.select({
    problem_id: contestProblems.problem_id,
    label: contestProblems.label,
  }).from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, contestId),
      inArray(contestProblems.problem_id, problemIds),
    ),
  );
  return new Map(rows.map((row) => [row.problem_id, row.label]));
}

/**
 * 参赛者提问（仅竞赛进行期间，可挂竞赛题目或全局）。
 * 提问本身始终公开（is_public=true），避免重复提问。
 */
export async function createClarification(
  contestId: string,
  userId: string,
  input: { content?: string; problem_id?: string },
): Promise<ClarificationResponse> {
  const content = validateContent(input.content, "提问内容");
  const contest = await findContestRow(contestId);
  if (
    computeContestStatus(contest.start_time, contest.end_time) !== "running"
  ) {
    throw new ForbiddenError("仅可在竞赛进行期间提问");
  }
  if (!await isParticipant(contestId, userId)) {
    throw new ForbiddenError("仅参赛者可提问");
  }
  const problemId = input.problem_id?.trim() || null;
  if (problemId) {
    await assertProblemBelongsToContest(contestId, problemId);
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  await db.insert(contestClarifications).values({
    id,
    contest_id: contestId,
    problem_id: problemId,
    sender_id: userId,
    content,
    reply_to_id: null,
    is_public: true,
    created_at: createdAt,
  });
  const [senders, labels] = await Promise.all([
    getSenders([userId]),
    problemId
      ? getProblemLabels(contestId, [problemId])
      : Promise.resolve(new Map<string, string>()),
  ]);
  return {
    id,
    contest_id: contestId,
    problem_id: problemId,
    problem_label: problemId ? labels.get(problemId) ?? null : null,
    content,
    is_public: true,
    created_at: createdAt,
    sender: senders.get(userId) ??
      { id: userId, username: "未知用户", avatar_url: null },
    replies: [],
  };
}

/**
 * 主办方回复（admin 或竞赛创建者），支持公开（全员可见）与私密（仅提问者可见）。
 * 回复仅允许指向根提问（reply_to_id IS NULL），不构成多层对话树。
 * 回复后向提问者发送 clarification 通知（经现有 SSE 通道推送）。
 */
export async function replyToClarification(
  contestId: string,
  clarId: string,
  userId: string,
  input: { content?: string; is_public?: boolean },
): Promise<ClarificationReplyResponse> {
  const content = validateContent(input.content, "回复内容");
  if (typeof input.is_public !== "boolean") {
    throw new BadRequestError("is_public 必须为布尔值");
  }
  const contest = await findContestRow(contestId);
  const canManage = await isUserAdmin(userId) || contest.created_by === userId;
  if (!canManage) {
    throw new ForbiddenError("仅管理员或竞赛创建者可回复");
  }

  const db = getDb();
  const [root] = await db.select().from(contestClarifications).where(
    and(
      eq(contestClarifications.id, clarId),
      eq(contestClarifications.contest_id, contestId),
    ),
  ).limit(1);
  if (!root) {
    throw new NotFoundError("提问不存在");
  }
  if (root.reply_to_id !== null) {
    throw new BadRequestError("仅可回复提问本身，不支持回复的回复");
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  await db.insert(contestClarifications).values({
    id,
    contest_id: contestId,
    problem_id: null,
    sender_id: userId,
    content,
    reply_to_id: clarId,
    is_public: input.is_public,
    created_at: createdAt,
  });

  // 通知提问者（回复者为提问者本人时由 createNotification 内部跳过）
  const problemLabel = root.problem_id
    ? (await getProblemLabels(contestId, [root.problem_id])).get(
      root.problem_id,
    ) ?? null
    : null;
  await createNotification(
    root.sender_id,
    userId,
    "clarification",
    null,
    null,
    {
      contest_id: contestId,
      clarification_id: clarId,
      problem_label: problemLabel,
      is_public: input.is_public,
    },
  );

  const senders = await getSenders([userId]);
  return {
    id,
    content,
    is_public: input.is_public,
    created_at: createdAt,
    sender: senders.get(userId) ??
      { id: userId, username: "未知用户", avatar_url: null },
  };
}

/**
 * 答疑列表（线程结构：提问 + 其下回复，均按时间升序）。
 * 可见性按请求者身份过滤：匿名/未参赛仅公开，参赛者加自己的私密，
 * admin/竞赛创建者见全部。分页基于提问数，回复跟随根提问返回。
 */
export async function listClarifications(
  contestId: string,
  userId: string | undefined,
  params: ListClarificationsParams = {},
): Promise<ListClarificationsResult> {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequestError("page 必须为正整数");
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PAGE_SIZE) {
    throw new BadRequestError(`perPage 必须为 1-${MAX_PAGE_SIZE} 的整数`);
  }
  const contest = await findContestRow(contestId);
  const isManager = userId !== undefined &&
    (await isUserAdmin(userId) || contest.created_by === userId);
  const isPart = userId !== undefined &&
    (await isParticipant(contestId, userId));

  const db = getDb();
  const rows = await db.select().from(contestClarifications).where(
    eq(contestClarifications.contest_id, contestId),
  ).orderBy(
    asc(contestClarifications.created_at),
    asc(contestClarifications.id),
  );

  // 过滤可见提问（匿名/未参赛仅公开；参赛者公开 + 自己的）
  const questions = rows.filter((row: ClarificationRow) =>
    row.reply_to_id === null
  )
    .filter(
      (row: ClarificationRow) =>
        isManager || row.is_public || (isPart && row.sender_id === userId),
    );
  const total = questions.length;
  const pageQuestions = questions.slice((page - 1) * perPage, page * perPage);
  if (pageQuestions.length === 0) {
    return { data: [], total };
  }

  // 回复可见性：admin 全部；否则公开，或根提问属于自己（私密回复仅提问者可见）
  const questionIds = new Set(pageQuestions.map((row) => row.id));
  const rootSenderId = new Map(
    pageQuestions.map((row) => [row.id, row.sender_id]),
  );
  const replies = rows.filter(
    (row: ClarificationRow) =>
      row.reply_to_id !== null && questionIds.has(row.reply_to_id),
  ).filter(
    (row: ClarificationRow) =>
      isManager || row.is_public ||
      (isPart && rootSenderId.get(row.reply_to_id as string) === userId),
  );

  const senderIds = [
    ...new Set([
      ...pageQuestions.map((row) => row.sender_id),
      ...replies.map((row) => row.sender_id),
    ]),
  ];
  const problemIds = [
    ...new Set(
      pageQuestions.map((row) => row.problem_id).filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const [senders, labels] = await Promise.all([
    getSenders(senderIds),
    getProblemLabels(contestId, problemIds),
  ]);

  const data = pageQuestions.map((question) => ({
    id: question.id,
    contest_id: question.contest_id,
    problem_id: question.problem_id,
    problem_label: question.problem_id
      ? labels.get(question.problem_id) ?? null
      : null,
    content: question.content,
    is_public: question.is_public,
    created_at: question.created_at,
    sender: senders.get(question.sender_id) ?? {
      id: question.sender_id,
      username: "未知用户",
      avatar_url: null,
    },
    replies: replies.filter((row) => row.reply_to_id === question.id).map(
      (row) => ({
        id: row.id,
        content: row.content,
        is_public: row.is_public,
        created_at: row.created_at,
        sender: senders.get(row.sender_id) ?? {
          id: row.sender_id,
          username: "未知用户",
          avatar_url: null,
        },
      }),
    ),
  }));
  return { data, total };
}
