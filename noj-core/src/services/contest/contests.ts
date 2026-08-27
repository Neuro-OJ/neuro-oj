import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  problems,
  submissions,
  users,
} from "../../db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.ts";
import { comparePassword, hashPassword } from "../../lib/password.ts";
import { generatePublicId, isPublicId, isUuid } from "../../lib/public-id.ts";
import { unwrapRows } from "../../lib/sql-rows.ts";
import {
  type ContestConfig,
  type ContestProblemInput,
  type ContestProblemResponse,
  type ContestResponse,
  type ContestStatus,
  type ContestType,
  type CreateContestInput,
  isValidContestConfig,
  isValidContestType,
  type UpdateContestInput,
} from "../../types/contests.ts";

export interface ListContestsParams {
  page?: number;
  perPage?: number;
  type?: ContestType;
  showAll?: boolean;
}

export interface ListContestsResult {
  data: ContestResponse[];
  total: number;
}

export interface ContestParticipantResponse {
  user_id: string;
  username: string;
  avatar_url: string | null;
  registered_at: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function defaultContestConfig(_type: ContestType): ContestConfig {
  return {};
}

function normalizeContestConfig(
  _type: ContestType,
  config: ContestConfig | undefined,
): ContestConfig {
  const value = config ?? defaultContestConfig(_type);
  if (!isValidContestConfig(_type, value)) {
    throw new BadRequestError("竞赛配置不合法");
  }

  const raw = value as Record<string, unknown>;
  const submissionLimits = raw.submission_limits as
    | Record<string, number>
    | undefined;
  return {
    ...(submissionLimits ? { submission_limits: submissionLimits } : {}),
  };
}

function validateTimes(startTime: string, endTime: string): void {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new BadRequestError(
      "start_time 和 end_time 必须为合法 ISO 8601 时间",
    );
  }
  if (end <= start) {
    throw new BadRequestError("end_time 必须晚于 start_time");
  }
}

function normalizeProblems(
  _type: ContestType,
  values: ContestProblemInput[],
): ContestProblemInput[] {
  if (values.length === 0) {
    throw new BadRequestError("竞赛至少需要一道题目");
  }

  const problemIds = new Set<string>();
  const labels = new Set<string>();
  const sortOrders = new Set<number>();

  return values.map((value) => {
    const problemId = value.problem_id.trim();
    const label = value.label.trim();
    if (!problemId || !label) {
      throw new BadRequestError("竞赛题目 ID 和标签不能为空");
    }
    if (!Number.isInteger(value.sort_order) || value.sort_order < 0) {
      throw new BadRequestError("竞赛题目 sort_order 必须为非负整数");
    }
    if (
      value.score === undefined || value.score === null ||
      !Number.isInteger(value.score) || value.score < 0
    ) {
      throw new BadRequestError("竞赛题目 score 必须为非负整数");
    }
    if (problemIds.has(problemId)) {
      throw new BadRequestError("竞赛题目不能重复");
    }
    if (labels.has(label)) {
      throw new BadRequestError("竞赛题目标签不能重复");
    }
    if (sortOrders.has(value.sort_order)) {
      throw new BadRequestError("竞赛题目排序值不能重复");
    }

    problemIds.add(problemId);
    labels.add(label);
    sortOrders.add(value.sort_order);
    return {
      problem_id: problemId,
      label,
      sort_order: value.sort_order,
      score: value.score,
    };
  });
}

async function assertProblemsExist(
  problemInputs: ContestProblemInput[],
  // deno-lint-ignore no-explicit-any -- postgres.js 与 PGlite 事务共享接口
  db: any,
): Promise<void> {
  const ids = problemInputs.map((value) => value.problem_id);
  const rows = await db.select({ id: problems.id }).from(problems).where(
    inArray(problems.id, ids),
  );
  if (rows.length !== ids.length) {
    throw new BadRequestError("竞赛包含不存在的题目");
  }
}

function toContestResponse(
  row: typeof contests.$inferSelect & {
    problem_count: number;
    participant_count: number;
  },
  isRegistered?: boolean,
): ContestResponse {
  return {
    id: row.id,
    public_id: row.public_id,
    title: row.title,
    description: row.description,
    start_time: row.start_time,
    end_time: row.end_time,
    type: row.type as ContestType,
    config: row.config as ContestConfig,
    is_public: row.is_public,
    has_password: row.password !== null,
    affect_global_ranking: row.affect_global_ranking,
    created_by: row.created_by,
    announcement: row.announcement,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: computeContestStatus(row.start_time, row.end_time),
    problem_count: Number(row.problem_count),
    participant_count: Number(row.participant_count),
    ...(isRegistered === undefined ? {} : { is_registered: isRegistered }),
  };
}

async function findContestRow(id: string) {
  const db = getDb();
  const [row] = await db.select().from(contests).where(eq(contests.id, id))
    .limit(
      1,
    );
  if (!row) {
    throw new NotFoundError("竞赛不存在");
  }
  return row;
}

/** 将 UUID 或 public_id 解析为内部竞赛 UUID；其它格式按主键兜底（兼容旧数据）。 */
export async function resolveContestId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (isPublicId(value, "ct")) {
    const rows = await db.select({ id: contests.id }).from(contests)
      .where(eq(contests.public_id, value)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("竞赛不存在");
    return row.id;
  }
  const byId = await db.select({ id: contests.id }).from(contests)
    .where(eq(contests.id, value)).limit(1);
  if (!byId[0]) throw new NotFoundError("竞赛不存在");
  return byId[0].id;
}

export function computeContestStatus(
  startTime: string,
  endTime: string,
): ContestStatus {
  const now = Date.now();
  if (now < Date.parse(startTime)) return "pending";
  if (now < Date.parse(endTime)) return "running";
  return "ended";
}

export async function createContest(
  input: CreateContestInput,
  userId: string,
): Promise<ContestResponse> {
  if (!input.title.trim()) {
    throw new BadRequestError("竞赛标题不能为空");
  }
  if (!isValidContestType(input.type)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  validateTimes(input.start_time, input.end_time);
  const config = normalizeContestConfig(input.type, input.config);
  const problemInputs = normalizeProblems(input.type, input.problems);
  const passwordHash = input.password
    ? await hashPassword(input.password)
    : null;
  const id = crypto.randomUUID();
  const publicId = generatePublicId("ct");
  const now = new Date().toISOString();
  const db = getDb();

  await db.transaction(async (tx) => {
    await assertProblemsExist(problemInputs, tx);
    await tx.insert(contests).values({
      id,
      public_id: publicId,
      title: input.title.trim(),
      description: input.description ?? "",
      start_time: input.start_time,
      end_time: input.end_time,
      type: input.type,
      config,
      is_public: input.is_public ?? true,
      password: passwordHash,
      affect_global_ranking: input.affect_global_ranking ?? false,
      created_by: userId,
      announcement: input.announcement ?? "",
      created_at: now,
      updated_at: now,
    });
    await tx.insert(contestProblems).values(
      problemInputs.map((value) => ({ contest_id: id, ...value })),
    );
  });

  return getContest(id);
}

export async function updateContest(
  id: string,
  input: UpdateContestInput,
): Promise<ContestResponse> {
  const existing = await findContestRow(id);
  const type = input.type ?? existing.type as ContestType;
  if (!isValidContestType(type)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  const startTime = input.start_time ?? existing.start_time;
  const endTime = input.end_time ?? existing.end_time;
  validateTimes(startTime, endTime);
  if (input.title !== undefined && !input.title.trim()) {
    throw new BadRequestError("竞赛标题不能为空");
  }

  const config = input.config !== undefined || input.type !== undefined
    ? normalizeContestConfig(type, input.config)
    : existing.config as ContestConfig;
  const problemInputs = input.problems === undefined
    ? undefined
    : normalizeProblems(type, input.problems);
  const passwordHash = input.password === undefined
    ? undefined
    : input.password
    ? await hashPassword(input.password)
    : null;
  const db = getDb();

  await db.transaction(async (tx) => {
    if (problemInputs) {
      await assertProblemsExist(problemInputs, tx);
    }

    const updates: Partial<typeof contests.$inferInsert> = {
      updated_at: new Date().toISOString(),
    };
    if (input.title !== undefined) updates.title = input.title.trim();
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.start_time !== undefined) updates.start_time = input.start_time;
    if (input.end_time !== undefined) updates.end_time = input.end_time;
    if (input.type !== undefined) updates.type = input.type;
    if (input.config !== undefined || input.type !== undefined) {
      updates.config = config;
    }
    if (input.is_public !== undefined) updates.is_public = input.is_public;
    if (passwordHash !== undefined) updates.password = passwordHash;
    if (input.affect_global_ranking !== undefined) {
      updates.affect_global_ranking = input.affect_global_ranking;
    }
    if (input.announcement !== undefined) {
      updates.announcement = input.announcement;
    }

    await tx.update(contests).set(updates).where(eq(contests.id, id));

    if (problemInputs) {
      await tx.delete(contestProblems).where(
        eq(contestProblems.contest_id, id),
      );
      await tx.insert(contestProblems).values(
        problemInputs.map((value) => ({ contest_id: id, ...value })),
      );
    }
  });

  return getContest(id);
}

export async function deleteContest(id: string): Promise<void> {
  const db = getDb();
  const deleted = await db.delete(contests).where(eq(contests.id, id))
    .returning({
      id: contests.id,
    });
  if (deleted.length === 0) {
    throw new NotFoundError("竞赛不存在");
  }
}

export async function getContest(
  id: string,
  userId?: string,
): Promise<ContestResponse> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
      (SELECT COUNT(*)::int FROM contest_participants cpa WHERE cpa.contest_id = c.id) AS participant_count
    FROM contests c
    WHERE c.id = ${id}
    LIMIT 1
  `);
  const [row] = unwrapRows<
    typeof contests.$inferSelect & {
      problem_count: number;
      participant_count: number;
    }
  >(rows as never);
  if (!row) {
    throw new NotFoundError("竞赛不存在");
  }
  const registered = userId === undefined
    ? undefined
    : await isParticipant(id, userId);
  return toContestResponse(row, registered);
}

export async function listContests(
  params: ListContestsParams = {},
): Promise<ListContestsResult> {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequestError("page 必须为正整数");
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PAGE_SIZE) {
    throw new BadRequestError(`perPage 必须为 1-${MAX_PAGE_SIZE} 的整数`);
  }
  if (params.type && !isValidContestType(params.type)) {
    throw new BadRequestError("竞赛类型不合法");
  }

  const conditions = [];
  if (!params.showAll) conditions.push(eq(contests.is_public, true));
  if (params.type) conditions.push(eq(contests.type, params.type));
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const db = getDb();
  const [countRow] = await db.select({ total: sql<number>`COUNT(*)` }).from(
    contests,
  ).where(where);
  const total = Number(countRow?.total ?? 0);
  if (total === 0) return { data: [], total: 0 };

  const rows = await db.execute(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
      (SELECT COUNT(*)::int FROM contest_participants cpa WHERE cpa.contest_id = c.id) AS participant_count
    FROM contests c
    WHERE ${params.showAll ? sql`TRUE` : sql`c.is_public = TRUE`}
      ${params.type ? sql`AND c.type = ${params.type}` : sql``}
    ORDER BY c.start_time DESC, c.id ASC
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `);
  const data = unwrapRows<
    typeof contests.$inferSelect & {
      problem_count: number;
      participant_count: number;
    }
  >(rows as never).map((row) => toContestResponse(row));
  return { data, total };
}

export async function registerForContest(
  contestId: string,
  userId: string,
  password?: string,
): Promise<void> {
  const contest = await findContestRow(contestId);
  if (!contest.is_public) {
    throw new ForbiddenError("非公开竞赛仅支持管理员邀请");
  }
  if (computeContestStatus(contest.start_time, contest.end_time) === "ended") {
    throw new ForbiddenError("竞赛已结束，无法注册");
  }
  if (
    contest.password &&
    (!password || !await comparePassword(password, contest.password))
  ) {
    throw new ForbiddenError("竞赛密码错误");
  }

  const db = getDb();
  const inserted = await db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: userId,
    registered_at: new Date().toISOString(),
  }).onConflictDoNothing().returning({ user_id: contestParticipants.user_id });
  if (inserted.length === 0) {
    throw new ConflictError("已注册该竞赛");
  }
}

export async function addParticipants(
  contestId: string,
  userIds: string[],
): Promise<number> {
  await findContestRow(contestId);
  const uniqueUserIds = [
    ...new Set(userIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (uniqueUserIds.length === 0) {
    throw new BadRequestError("参与者列表不能为空");
  }

  const db = getDb();
  const existingUsers = await db.select({ id: users.id }).from(users).where(
    inArray(users.id, uniqueUserIds),
  );
  if (existingUsers.length !== uniqueUserIds.length) {
    throw new BadRequestError("参与者列表包含不存在的用户");
  }
  const registeredAt = new Date().toISOString();
  const inserted = await db.insert(contestParticipants).values(
    uniqueUserIds.map((userId) => ({
      contest_id: contestId,
      user_id: userId,
      registered_at: registeredAt,
    })),
  ).onConflictDoNothing().returning({ user_id: contestParticipants.user_id });
  return inserted.length;
}

export async function removeParticipant(
  contestId: string,
  userId: string,
): Promise<void> {
  const db = getDb();
  const deleted = await db.delete(contestParticipants).where(
    and(
      eq(contestParticipants.contest_id, contestId),
      eq(contestParticipants.user_id, userId),
    ),
  ).returning({ user_id: contestParticipants.user_id });
  if (deleted.length === 0) {
    throw new NotFoundError("竞赛参与者不存在");
  }
}

export async function listParticipants(
  contestId: string,
): Promise<ContestParticipantResponse[]> {
  await findContestRow(contestId);
  const db = getDb();
  return db.select({
    user_id: contestParticipants.user_id,
    username: users.username,
    avatar_url: users.avatar_url,
    registered_at: contestParticipants.registered_at,
  }).from(contestParticipants).innerJoin(
    users,
    eq(users.id, contestParticipants.user_id),
  ).where(eq(contestParticipants.contest_id, contestId)).orderBy(
    asc(contestParticipants.registered_at),
    asc(contestParticipants.user_id),
  );
}

/**
 * 校验比赛内每道题提交次数上限。
 * 未配置 `submission_limits` 的题目不限制；所有提交（含 error）都计入。
 *
 * @throws {BadRequestError} 达到上限时
 */
export async function assertContestSubmissionLimit(
  contestId: string,
  userId: string,
  problemId: string,
): Promise<void> {
  const contest = await findContestRow(contestId);
  const config = contest.config as ContestConfig;
  const limit = config.submission_limits?.[problemId];
  if (!limit) return;

  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(submissions)
    .where(
      and(
        eq(submissions.contest_id, contestId),
        eq(submissions.user_id, userId),
        eq(submissions.problem_id, problemId),
      ),
    );
  const count = Number(row?.count ?? 0);
  if (count >= limit) {
    throw new BadRequestError(`该题提交次数已达上限（${limit} 次）`);
  }
}

export async function isParticipant(
  contestId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select({ user_id: contestParticipants.user_id }).from(
    contestParticipants,
  ).where(
    and(
      eq(contestParticipants.contest_id, contestId),
      eq(contestParticipants.user_id, userId),
    ),
  ).limit(1);
  return row !== undefined;
}

export async function getContestProblems(
  contestId: string,
  userId?: string,
): Promise<ContestProblemResponse[]> {
  await findContestRow(contestId);
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT
      cp.problem_id,
      cp.sort_order,
      cp.label,
      cp.score,
      p.title,
      p.description,
      p.difficulty,
      p.submission_mode,
      p.artifact_max_size_mb,
      CONCAT(p.type, p.number::text) AS display_id,
      CASE
        WHEN ${userId ?? null}::text IS NULL THEN 'untouched'
        WHEN EXISTS (
          SELECT 1
          FROM submissions s
          JOIN evaluation_results er ON er.submission_id = s.id
          WHERE s.contest_id = cp.contest_id
            AND s.problem_id = cp.problem_id
            AND s.user_id = ${userId ?? null}
            AND er.status = 'finished'
            AND er.score > 0
        ) THEN 'solved'
        WHEN EXISTS (
          SELECT 1
          FROM submissions s
          WHERE s.contest_id = cp.contest_id
            AND s.problem_id = cp.problem_id
            AND s.user_id = ${userId ?? null}
        ) THEN 'attempted'
        ELSE 'untouched'
      END AS user_status
    FROM contest_problems cp
    JOIN problems p ON p.id = cp.problem_id
    WHERE cp.contest_id = ${contestId}
    ORDER BY cp.sort_order ASC, cp.label ASC
  `);

  return unwrapRows<Record<string, unknown>>(rows as never).map((row) => ({
    problem_id: row.problem_id as string,
    sort_order: Number(row.sort_order),
    label: row.label as string,
    score: Number(row.score),
    title: row.title as string,
    description: row.description as string,
    difficulty: row.difficulty as string,
    display_id: row.display_id as string,
    submission_mode: row
      .submission_mode as ContestProblemResponse["submission_mode"],
    artifact_max_size_mb: row.artifact_max_size_mb === null
      ? null
      : Number(row.artifact_max_size_mb),
    user_status: row.user_status as ContestProblemResponse["user_status"],
  }));
}
