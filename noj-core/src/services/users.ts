import { and, eq, isNull, not, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  userBans,
  users,
} from "../db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { scoreFromDb } from "../types/index.ts";
import { invalidateBanCache } from "../lib/banCache.ts";
import { logAudit } from "./audit-log.ts";
import type { UserResponse } from "../types/auth.ts";

/**
 * 用户主页响应——聚合统计、已通过题目、最近提交。
 */
export interface UserProfileResponse {
  user: {
    id: string;
    username: string;
    bio: string;
    created_at: string;
  };
  stats: {
    total_submissions: number;
    accepted: number;
    acceptance_rate: number;
    solved_count: number;
  };
  solved_problems: {
    id: string;
    title: string;
    difficulty: string;
    accepted_at: string;
  }[];
  recent_submissions: {
    id: string;
    problem_id: string;
    problem_title: string;
    language: string;
    status: string;
    result_status: string | null;
    score: number | null;
    created_at: string;
  }[];
}

/**
 * 获取用户主页聚合数据。
 *
 * 执行 3 次独立查询：
 * 1. 统计聚合（total_submissions, accepted, acceptance_rate, solved_count）
 * 2. 已通过题目列表（去重，按首次通过时间排序）
 * 3. 最近 10 条提交（不含 code 字段）
 *
 * @throws {NotFoundError} 用户不存在
 */
export async function getUserProfile(
  userId: string,
): Promise<UserProfileResponse> {
  const db = getDb();

  // PR-4：4 个独立 query 改为 Promise.all 并行执行
  // 原串行：~600ms（最慢 query × 4 + 网络 RTT 累加）
  // 并行后：~150ms（最慢那一个 + RTT），约 4x 提速
  const [userRow, statsRow, solvedRows, recentRows] = await Promise.all([
    // 1. 验证用户存在（同时取基础信息）
    db.select({
      id: users.id,
      username: users.username,
      bio: users.bio,
      created_at: users.created_at,
    })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then((rows) => rows[0]),
    // 2. 统计查询：总提交数、Accepted 数、解题数
    db.select({
      total_submissions: sql<number>`count(*)`,
      accepted: sql<
        number
      >`count(*) filter (where ${evaluationResults.status} = 'Accepted')`,
      solved_count: sql<
        number
      >`count(distinct ${submissions.problem_id}) filter (where ${evaluationResults.status} = 'Accepted')`,
    })
      .from(submissions)
      .leftJoin(
        evaluationResults,
        eq(evaluationResults.submission_id, submissions.id),
      )
      .where(eq(submissions.user_id, userId))
      .then((rows) => rows[0]),
    // 3. 已通过题目列表（去重，取首次通过时间）
    db.select({
      problem_id: submissions.problem_id,
      problem_title: problems.title,
      difficulty: problems.difficulty,
      accepted_at: sql<string>`min(${submissions.created_at})`,
    })
      .from(submissions)
      .innerJoin(problems, eq(submissions.problem_id, problems.id))
      .innerJoin(
        evaluationResults,
        and(
          eq(evaluationResults.submission_id, submissions.id),
          eq(evaluationResults.status, "Accepted"),
        ),
      )
      .where(eq(submissions.user_id, userId))
      .groupBy(submissions.problem_id, problems.title, problems.difficulty)
      .orderBy(sql`min(${submissions.created_at}) DESC`),
    // 4. 最近 10 条提交（不含 code 字段）
    db.select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      problem_title: problems.title,
      language: submissions.language,
      status: submissions.status,
      result_status: evaluationResults.status,
      result_score: evaluationResults.score,
      created_at: submissions.created_at,
    })
      .from(submissions)
      .leftJoin(problems, eq(submissions.problem_id, problems.id))
      .leftJoin(
        evaluationResults,
        eq(evaluationResults.submission_id, submissions.id),
      )
      .where(eq(submissions.user_id, userId))
      .orderBy(sql`${submissions.created_at} DESC`)
      .limit(10),
  ]);

  if (!userRow) {
    throw new NotFoundError("用户不存在");
  }

  const totalSubmissions = Number(statsRow?.total_submissions ?? 0);
  const accepted = Number(statsRow?.accepted ?? 0);
  const solvedCount = Number(statsRow?.solved_count ?? 0);
  const acceptanceRate = totalSubmissions > 0
    ? Math.round((accepted / totalSubmissions) * 1000) / 1000
    : 0;

  // deno-lint-ignore no-explicit-any -- Drizzle 查询返回类型在 Deno 中解析受限
  const solvedProblems = solvedRows.map((row: any) => ({
    id: row.problem_id,
    title: row.problem_title,
    difficulty: row.difficulty,
    accepted_at: row.accepted_at,
  }));

  // deno-lint-ignore no-explicit-any -- Drizzle 查询返回类型在 Deno 中解析受限
  const recentSubmissions = recentRows.map((row: any) => ({
    id: row.id,
    problem_id: row.problem_id,
    problem_title: row.problem_title ?? "",
    language: row.language,
    status: row.status,
    result_status: row.result_status ?? null,
    score: row.result_score != null ? scoreFromDb(row.result_score) : null,
    created_at: row.created_at,
  }));

  return {
    user: {
      id: userRow.id,
      username: userRow.username,
      bio: userRow.bio,
      created_at: userRow.created_at,
    },
    stats: {
      total_submissions: totalSubmissions,
      accepted,
      acceptance_rate: acceptanceRate,
      solved_count: solvedCount,
    },
    solved_problems: solvedProblems,
    recent_submissions: recentSubmissions,
  };
}

/**
 * 根据用户名前缀搜索用户。
 *
 * 使用 ILIKE 模糊匹配，返回匹配用户的基本信息（不含敏感字段）。
 * 排除 root 系统用户（UID=0），限制返回条数防止滥用。
 *
 * @param query 搜索关键词（至少 2 字符）
 * @param limit 最大返回条数（默认 10，最大 20）
 */
export async function searchUsers(
  query: string,
  limit = 10,
): Promise<{ id: string; username: string; created_at: string }[]> {
  if (query.length < 2) {
    return [];
  }
  if (limit > 20) limit = 20;

  const rows = await getDb()
    .select({
      id: users.id,
      username: users.username,
      created_at: users.created_at,
    })
    .from(users)
    .where(
      and(
        sql`${users.username} ILIKE ${`%${query}%`}`,
        sql`${users.id} <> '0'`, // 排除 root
      ),
    )
    .limit(limit);

  return rows;
}

const BIO_MAX_LENGTH = 5000;

/**
 * 更新用户个人简介（bio）。
 *
 * 校验 bio 长度不超过 BIO_MAX_LENGTH（5000 字符），
 * 然后更新 users 表的 bio 字段，返回更新后的用户基本信息。
 *
 * @throws {ValidationError} bio 超长时抛出
 */
export async function updateUserProfile(
  userId: string,
  bio: string,
): Promise<{ id: string; username: string; bio: string }> {
  const db = getDb();

  if (bio.length > BIO_MAX_LENGTH) {
    throw new ValidationError(`bio 长度不能超过 ${BIO_MAX_LENGTH} 字`);
  }

  const [updated] = await db
    .update(users)
    .set({ bio, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      username: users.username,
      bio: users.bio,
    });

  if (!updated) {
    throw new NotFoundError("用户不存在");
  }

  return updated;
}

/**
 * 管理员更新任意用户的资料（email、bio）。
 *
 * 与普通 updateUserProfile 的区别：
 * - 不检查 bio 长度限制（管理员有权设置任意内容）
 * - 支持更新 email（含格式校验和唯一性检查）
 * - 返回用户完整信息（含 email、role）
 *
 * @param targetUserId 目标用户 ID
 * @param input.email 新邮箱（可选）
 * @param input.bio 新简介（可选）
 * @throws {NotFoundError} 目标用户不存在
 * @throws {BadRequestError} 邮箱格式不正确
 * @throws {ConflictError} 邮箱已被其他用户使用
 */
export async function adminUpdateUserProfile(
  targetUserId: string,
  input: { email?: string; bio?: string },
): Promise<{
  id: string;
  username: string;
  email: string;
  role: string;
  bio: string;
}> {
  // 拒绝修改 root 系统用户，避免破坏系统惯例（root 不计入管理员统计、不可登录）
  if (targetUserId === "0") {
    throw new ForbiddenError("不能修改系统 root 用户");
  }

  const db = getDb();

  // 先校验 email 格式（无需查询数据库）
  if (input.email !== undefined) {
    // 强化：local-part 不允许连续点号、不允许首尾点号；TLD 至少 2 字符
    if (
      !/^(?!\.)(?!.*\.\.)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
        input.email,
      )
    ) {
      throw new BadRequestError("邮箱格式不正确");
    }
  }

  // 检查用户是否存在
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("用户不存在");
  }

  const user = existing[0];
  const updates: Record<string, string> = {};
  const now = new Date().toISOString();

  // 处理邮箱更新
  if (input.email !== undefined) {
    if (input.email === user.email) {
      // 邮箱未变更，跳过
    } else {
      // 唯一性检查
      const existingEmail = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.email, input.email),
            sql`${users.id} <> ${targetUserId}`,
          ),
        )
        .limit(1);

      if (existingEmail.length > 0) {
        throw new ConflictError("邮箱已被注册");
      }

      updates.email = input.email;
    }
  }

  // 处理 bio 更新（不检查长度限制）
  if (input.bio !== undefined) {
    updates.bio = input.bio;
  }

  if (Object.keys(updates).length === 0) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      bio: user.bio,
    };
  }

  updates.updated_at = now;

  await db
    .update(users)
    .set(updates)
    .where(eq(users.id, targetUserId));

  // 返回更新后的用户信息
  const [updated] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      bio: users.bio,
    })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  return updated;
}

/**
 * 管理员封禁用户（issue #102 / user-ban-table）。
 *
 * 使用 user_bans 表追踪封禁记录（方案 A：以最新为准）：
 * 1. 关闭已有活跃封禁（SET unbanned_at=now）
 * 2. INSERT 新封禁记录
 *
 * 业务规则：
 * - 禁止封禁 root（id='0'）
 * - 禁止封禁自己
 * - 禁止封禁最后一个可登录 admin
 */
export async function banUser(
  targetUserId: string,
  reason: string | undefined,
  bannedUntil: string | null | undefined,
  currentUserId: string,
): Promise<UserResponse> {
  if (targetUserId === "0") {
    throw new BadRequestError("不能封禁 root 账户");
  }
  if (currentUserId === targetUserId) {
    throw new BadRequestError("不能封禁自己");
  }

  if (bannedUntil) {
    const t = Date.parse(bannedUntil);
    if (Number.isNaN(t)) {
      throw new ValidationError("banned_until 必须是有效 ISO 8601 字符串");
    }
  }

  const db = getDb();
  const existing = await db.select().from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("用户不存在");
  }

  // 防封禁最后一个 admin
  if (existing[0].role === "admin") {
    const [adminCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, "admin"), not(eq(users.id, "0"))));
    const adminCount = Number(adminCountRow?.count ?? 0);
    if (adminCount <= 1) {
      throw new BadRequestError(
        "系统当前仅有 1 个可登录管理员，不能封禁；如需调整请先创建新的管理员账户",
      );
    }
  }

  const now = new Date().toISOString();

  // 1. 关闭已有活跃封禁
  await db.update(userBans)
    .set({ unbanned_at: now })
    .where(
      and(eq(userBans.user_id, targetUserId), isNull(userBans.unbanned_at)),
    );

  // 2. 插入新封禁记录
  const banId = crypto.randomUUID();
  await db.insert(userBans).values({
    id: banId,
    user_id: targetUserId,
    reason: reason ?? "",
    banned_until: bannedUntil ?? null,
    banned_at: now,
    banned_by: currentUserId,
  });

  invalidateBanCache({ userId: targetUserId });
  logAudit(
    "users.ban",
    { action: "users.ban", reason: reason ?? "", until: bannedUntil ?? null },
    { type: "users", id: targetUserId },
  );

  return {
    id: existing[0].id,
    username: existing[0].username,
    email: existing[0].email,
    role: existing[0].role,
    must_change_password: existing[0].must_change_password,
    active_ban: { reason: reason ?? "", banned_until: bannedUntil ?? null },
    created_at: existing[0].created_at,
    updated_at: now,
  };
}

/**
 * 管理员解封用户（issue #102 / user-ban-table）。
 *
 * 将活跃封禁记录的 unbanned_at/unbanned_by 设为当前值。
 */
export async function unbanUser(
  targetUserId: string,
  currentUserId: string,
): Promise<UserResponse> {
  const db = getDb();
  const existing = await db.select().from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("用户不存在");
  }

  const now = new Date().toISOString();
  await db.update(userBans)
    .set({ unbanned_at: now, unbanned_by: currentUserId })
    .where(
      and(eq(userBans.user_id, targetUserId), isNull(userBans.unbanned_at)),
    );

  invalidateBanCache({ userId: targetUserId });
  logAudit(
    "users.unban",
    { action: "users.unban" },
    { type: "users", id: targetUserId },
  );

  return {
    id: existing[0].id,
    username: existing[0].username,
    email: existing[0].email,
    role: existing[0].role,
    must_change_password: existing[0].must_change_password,
    active_ban: null,
    created_at: existing[0].created_at,
    updated_at: now,
  };
}

/**
 * 获取用户封禁历史（user-ban-table）。
 * 返回所有封禁记录，按 banned_at DESC 排序。
 * JOIN users 以获取 banned_by / unbanned_by 的用户名。
 */
export interface BanRecord {
  id: string;
  reason: string;
  banned_until: string | null;
  banned_at: string;
  banned_by: { id: string; username: string } | null;
  unbanned_at: string | null;
  unbanned_by: { id: string; username: string } | null;
}

export async function getUserBanHistory(
  userId: string,
): Promise<BanRecord[]> {
  const db = getDb();
  const unbannedUser = db.select().from(users).as("unbanned_user");

  const rows = await db
    .select({
      id: userBans.id,
      reason: userBans.reason,
      banned_until: userBans.banned_until,
      banned_at: userBans.banned_at,
      banned_by_id: userBans.banned_by,
      banned_by_username: users.username,
      unbanned_at: userBans.unbanned_at,
      unbanned_by_id: userBans.unbanned_by,
      unbanned_by_username: unbannedUser.username,
    })
    .from(userBans)
    .leftJoin(users, eq(userBans.banned_by, users.id))
    .leftJoin(unbannedUser, eq(userBans.unbanned_by, unbannedUser.id))
    .where(eq(userBans.user_id, userId))
    .orderBy(sql`${userBans.banned_at} DESC`);

  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    banned_until: r.banned_until,
    banned_at: r.banned_at,
    banned_by: r.banned_by_id
      ? { id: r.banned_by_id, username: r.banned_by_username ?? "" }
      : null,
    unbanned_at: r.unbanned_at,
    unbanned_by: r.unbanned_by_id
      ? { id: r.unbanned_by_id, username: r.unbanned_by_username ?? "" }
      : null,
  }));
}
