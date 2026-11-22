// 竞赛参与者：自助报名、批量增删参赛者、参与者列表、参赛判定，以及单题提交次数上限。
import type { Executor } from "../../../shared/db/executor.ts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { enqueueSearchIndexTask } from "../../application/search-tasks.ts";
import { contestParticipants, users } from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from "../../../shared/base/errors.ts";
import { getRedis } from "../../../shared/mq/connection.ts";
import { findContestRow } from "./contest-row.ts";
import { computeContestStatus } from "./contest-window.ts";
import { type ContestConfig } from "../types/contests.ts";

/** 竞赛参与者响应结构。 */
export interface ContestParticipantResponse {
  user_id: string;
  username: string;
  avatar_url: string | null;
  registered_at: string;
}

/**
 * 用户注册参赛：
 * 已具备本域访问权的用户按比赛状态自助报名。
 *
 * @param contestId 竞赛 UUID
 * @param userId 用户 ID
 * @throws {ForbiddenError} 竞赛已结束或域访问被拒时
 * @throws {ConflictError} 已注册该竞赛时
 */
export async function registerForContest(
  contestId: string,
  userId: string,
  executor?: Executor,
): Promise<void> {
  const contest = await findContestRow(contestId, executor);
  if (computeContestStatus(contest.start_time, contest.end_time) === "ended") {
    throw new ForbiddenError("竞赛已结束，无法注册");
  }

  const db = executor ?? getDb();
  const inserted = await db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: userId,
    registered_at: new Date().toISOString(),
  }).onConflictDoNothing().returning({ user_id: contestParticipants.user_id });
  if (inserted.length === 0) {
    throw new ConflictError("已注册该竞赛");
  }

  await enqueueSearchIndexTask("contest", contestId, "upsert", db);
}

/**
 * 批量添加竞赛参与者（已存在的用户自动跳过）。
 *
 * @param contestId 竞赛 UUID
 * @param userIds 待添加的用户 ID 列表
 * @returns 实际新增的参与者数量
 * @throws {NotFoundError} 竞赛不存在时
 * @throws {BadRequestError} 参与者列表为空或包含不存在的用户时
 */
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

  await enqueueSearchIndexTask("contest", contestId, "upsert", db);

  return inserted.length;
}

/**
 * 移除竞赛的某位参与者。
 *
 * @param contestId 竞赛 UUID
 * @param userId 待移除的用户 ID
 * @throws {NotFoundError} 竞赛参与者不存在时
 */
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

  await enqueueSearchIndexTask("contest", contestId, "upsert", db);
}

/**
 * 列出竞赛的全部参与者（按注册时间升序）。
 *
 * @param contestId 竞赛 UUID
 * @returns 参与者响应列表
 * @throws {NotFoundError} 竞赛不存在时
 */
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
 * 校验比赛内每道题提交次数上限（Redis 原子预算）。
 * 未配置 `submission_limits` 的题目不限制；所有提交（含 error）都计入。
 * 键 TTL 指到竞赛截止时间，超限抛 429 RateLimitedError。
 *
 * @throws {RateLimitedError} 达到上限时
 */
export async function assertContestSubmissionLimit(
  contestId: string,
  userId: string,
  problemId: string,
  reservationId?: string,
): Promise<void> {
  const contest = await findContestRow(contestId);
  const config = contest.config as ContestConfig;
  const limit = config.submission_limits?.[problemId];
  if (!limit) return;

  const redis = getRedis();
  const key = `contest:lim:${contestId}:u:${userId}:p:${problemId}`;
  const ttl = Math.max(
    1,
    Math.floor((Date.parse(contest.end_time) - Date.now()) / 1000),
  );
  if (reservationId) {
    const reserved = Number(
      await redis.eval(
        `
      if redis.call('EXISTS', KEYS[2]) == 1 then return 1 end
      if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 0 end
      redis.call('INCR', KEYS[1])
      redis.call('EXPIRE', KEYS[1], ARGV[2])
      redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
      return 1
    `,
        2,
        key,
        `${key}:reservation:${reservationId}`,
        limit,
        ttl,
      ),
    );
    if (!reserved) throw new RateLimitedError("提交次数已达上限");
    return;
  }
  const used = await redis.incr(key);
  if (used === 1) {
    const ttl = Math.max(
      1,
      Math.floor((Date.parse(contest.end_time) - Date.now()) / 1000),
    );
    await redis.expire(key, ttl);
  }
  if (used > limit) {
    throw new RateLimitedError("提交次数已达上限");
  }
}

/**
 * 判断用户是否为某竞赛的参与者。
 *
 * @param contestId 竞赛 UUID
 * @param userId 用户 ID
 * @returns 是否已参赛
 */
export async function isParticipant(
  contestId: string,
  userId: string,
  executor: Executor = getDb(),
): Promise<boolean> {
  const db = executor;
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
