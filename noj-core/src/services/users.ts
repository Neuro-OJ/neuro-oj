import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityPosts,
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
import { getStorageProvider } from "../lib/storage/factory.ts";
import { isStorageUrl, parseStorageUrl } from "../lib/storage/types.ts";
import type { UserResponse } from "../types/auth.ts";
import { ROOT_USER_ID } from "../lib/constants.ts";
import { getAdminUserIds, isUserAdmin } from "../lib/permissions.ts";

/**
 * 用户主页响应——聚合统计、已通过题目、最近提交。
 */
export interface UserProfileResponse {
  user: {
    id: string;
    username: string;
    bio: string;
    avatar_url: string | null;
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
  community_stats: {
    following_count: number;
    follower_count: number;
    solution_count: number;
    moment_count: number;
  };
  solutions: { id: string; title: string; created_at: string }[];
  moments: { id: string; content: string; created_at: string }[];
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
export async function getUserProfileAggregate(
  userId: string,
): Promise<UserProfileResponse> {
  const db = getDb();

  // PR-4：4 个独立 query 改为 Promise.all 并行执行
  // 原串行：~600ms（最慢 query × 4 + 网络 RTT 累加）
  // 并行后：~150ms（最慢那一个 + RTT），约 4x 提速
  const [
    userRow,
    statsRow,
    solvedRows,
    recentRows,
    communityStats,
    solutions,
    moments,
  ] = await Promise.all([
    // 1. 验证用户存在（同时取基础信息）
    db.select({
      id: users.id,
      username: users.username,
      bio: users.bio,
      avatar_url: users.avatar_url,
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
    db.select({
      following_count: sql<
        number
      >`(select count(*) from community_follows where follower_id = ${userId})`,
      follower_count: sql<
        number
      >`(select count(*) from community_follows where followee_id = ${userId})`,
      solution_count: sql<
        number
      >`(select count(*) from community_posts where author_id = ${userId} and type = 'solution' and status = 'published')`,
      moment_count: sql<
        number
      >`(select count(*) from community_posts where author_id = ${userId} and type = 'moment' and status = 'published')`,
    }).from(users).where(eq(users.id, userId)).limit(1).then((rows) => rows[0]),
    db.select({
      id: communityPosts.id,
      title: communityPosts.title,
      created_at: communityPosts.created_at,
    })
      .from(communityPosts).where(
        and(
          eq(communityPosts.author_id, userId),
          eq(communityPosts.type, "solution"),
          eq(communityPosts.status, "published"),
        ),
      ).orderBy(sql`${communityPosts.created_at} DESC`).limit(10),
    db.select({
      id: communityPosts.id,
      content: communityPosts.content,
      created_at: communityPosts.created_at,
    })
      .from(communityPosts).where(
        and(
          eq(communityPosts.author_id, userId),
          eq(communityPosts.type, "moment"),
          eq(communityPosts.status, "published"),
        ),
      ).orderBy(sql`${communityPosts.created_at} DESC`).limit(10),
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

  type SolvedProblemRow = {
    problem_id: string;
    problem_title: string;
    difficulty: string;
    accepted_at: string;
  };
  type RecentSubmissionRow = {
    id: string;
    problem_id: string;
    problem_title: string | null;
    language: string;
    status: string;
    result_status: string | null;
    result_score: number | null;
    created_at: string;
  };

  const solvedProblems = solvedRows.map((row: SolvedProblemRow) => ({
    id: row.problem_id,
    title: row.problem_title,
    difficulty: row.difficulty,
    accepted_at: row.accepted_at,
  }));

  const recentSubmissions = recentRows.map((row: RecentSubmissionRow) => ({
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
      avatar_url: userRow.avatar_url ?? null,
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
    community_stats: {
      following_count: Number(communityStats?.following_count ?? 0),
      follower_count: Number(communityStats?.follower_count ?? 0),
      solution_count: Number(communityStats?.solution_count ?? 0),
      moment_count: Number(communityStats?.moment_count ?? 0),
    },
    solutions: solutions.map(
      (item: { id: string; title: string | null; created_at: string }) => ({
        ...item,
        title: item.title ?? "",
      }),
    ),
    moments,
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
): Promise<
  {
    id: string;
    username: string;
    avatar_url: string | null;
    created_at: string;
  }[]
> {
  if (query.length < 2) {
    return [];
  }
  if (limit > 20) limit = 20;

  const rows = await getDb()
    .select({
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
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
  bio: string;
}> {
  // 拒绝修改 root 系统用户，避免破坏系统惯例（root 不计入管理员统计、不可登录）
  if (targetUserId === ROOT_USER_ID) {
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

/** users 表行类型 */
type UserRow = typeof users.$inferSelect;

/** 按 ID 查询用户，不存在则抛 NotFoundError。 */
async function requireUser(targetUserId: string): Promise<UserRow> {
  const existing = await getDb().select().from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("用户不存在");
  }
  return existing[0];
}

/** 由 users 行构造 UserResponse（active_ban 由调用方提供，is_admin 实时计算）。 */
async function toUserResponse(
  user: UserRow,
  activeBan: UserResponse["active_ban"],
  now: string,
): Promise<UserResponse> {
  const isAdmin = await isUserAdmin(user.id);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    is_admin: isAdmin,
    must_change_password: user.must_change_password,
    active_ban: activeBan,
    avatar_url: user.avatar_url ?? null,
    tfa_enabled: user.tfa_enabled,
    created_at: user.created_at,
    updated_at: now,
  };
}

export async function banUser(
  targetUserId: string,
  reason: string | undefined,
  bannedUntil: string | null | undefined,
  currentUserId: string,
): Promise<UserResponse> {
  if (targetUserId === ROOT_USER_ID) {
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
  const existing = await requireUser(targetUserId);

  // 防封禁最后一个 admin（admin:full_access 权限，含继承链，排除 root）
  if (await isUserAdmin(existing.id)) {
    const adminIds = await getAdminUserIds();
    const adminCount = [...adminIds].filter((id) => id !== ROOT_USER_ID).length;
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
  await logAudit(
    "users.ban",
    { action: "users.ban", reason: reason ?? "", until: bannedUntil ?? null },
    { type: "users", id: targetUserId },
  );

  return await toUserResponse(
    existing,
    { reason: reason ?? "", banned_until: bannedUntil ?? null },
    now,
  );
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
  const existing = await requireUser(targetUserId);

  const now = new Date().toISOString();
  await db.update(userBans)
    .set({ unbanned_at: now, unbanned_by: currentUserId })
    .where(
      and(eq(userBans.user_id, targetUserId), isNull(userBans.unbanned_at)),
    );

  invalidateBanCache({ userId: targetUserId });
  await logAudit(
    "users.unban",
    { action: "users.unban" },
    { type: "users", id: targetUserId },
  );

  return await toUserResponse(existing, null, now);
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

// ── 头像（issue #229）────────────────────────────────────────

/** 头像大小上限（2MB） */
export const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

/** 允许的头像 MIME 类型 */
const AVATAR_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 允许的头像扩展名（jpeg 与 jpg 均接受） */
const AVATAR_EXT = /\.(png|jpe?g|webp)$/i;

/** magic bytes 推导的图片类型 → 标准 MIME */
const AVATAR_MAGIC_MIME: Record<"png" | "jpeg" | "webp", string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** 头像文件校验结果：字节 + magic bytes 推导的图片类型 */
interface AvatarFile {
  bytes: Uint8Array;
  /** magic bytes 推导的类型（"png" | "jpeg" | "webp"） */
  type: "png" | "jpeg" | "webp";
}

/** 由 magic bytes 推导图片类型；无法识别返回 null */
function detectImageType(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return "png";
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  if (isJpeg) return "jpeg";
  const isWebp = bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (isWebp) return "webp";
  return null;
}

/** 文件名扩展名 → 图片类型；无扩展名返回 null */
function imageTypeFromName(name: string): "png" | "jpeg" | "webp" | null {
  const m = AVATAR_EXT.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "png") return "png";
  if (ext === "webp") return "webp";
  return "jpeg"; // jpg / jpeg
}

/**
 * 校验头像文件并返回字节与 magic 推导类型。
 *
 * 校验链：扩展名 → Content-Type → 大小 → magic bytes，
 * 并要求扩展名 / Content-Type / magic bytes 三者推导的类型一致
 * （如 `a.png` + `image/png` + JPEG 字节 MUST 400）。
 * 拒绝 SVG（内嵌脚本 XSS 风险）。
 *
 * @throws {BadRequestError} 任一项不满足
 */
async function validateAvatarFile(file: File): Promise<AvatarFile> {
  const nameType = imageTypeFromName(file.name);
  if (!nameType) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.type && !AVATAR_MIME.has(file.type)) {
    throw new BadRequestError("仅支持 png/jpeg/webp 图片");
  }
  if (file.size > MAX_AVATAR_SIZE) {
    throw new BadRequestError("头像大小超过限制（最大 2MB）");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const magicType = detectImageType(bytes);
  if (!magicType) {
    throw new BadRequestError("文件不是有效的图片");
  }
  // 扩展名与内容一致性（spec：扩展名/Content-Type 不匹配 MUST 400）
  if (nameType !== magicType) {
    throw new BadRequestError("文件扩展名与图片内容不匹配");
  }
  // Content-Type 与内容一致性（file.type 为空时跳过）
  if (file.type && file.type !== AVATAR_MAGIC_MIME[magicType]) {
    throw new BadRequestError("文件 Content-Type 与图片内容不匹配");
  }
  return { bytes, type: magicType };
}

/**
 * 判断两个存储 URL 是否指向同一存储对象。
 *
 * 以 provider + key 为判等依据（同一 key 视为同一对象，校验和差异忽略）：
 * S3 固定 key 模式下替换头像会覆盖同一对象，新旧 URL 仅 checksum
 * 不同，直接比较字符串会误判为不同对象并删除刚写入的新文件。
 * provider 不同（local vs s3）即使 key 相同也属于不同对象；
 * 非 `noj-storage://` URL（脏数据）短路返回 false，不抛错。
 */
export function sameStorageObject(a: string, b: string): boolean {
  if (!isStorageUrl(a) || !isStorageUrl(b)) return false;
  const pa = parseStorageUrl(a);
  const pb = parseStorageUrl(b);
  return pa.provider === pb.provider && pa.key === pb.key;
}

/**
 * 清理旧头像文件（仅当无其他用户仍引用同一存储对象时）。
 *
 * local 内容寻址模式下，字节相同的头像共享同一存储对象（URL 相同），
 * 直接删除会破坏仍引用它的其他用户的头像；S3 固定 key 按用户隔离
 * （avatar/<userId>.<ext>），不可能共享，无需检查。
 * 仍有引用时跳过删除——内容寻址下文件按内容哈希命名，保留不产生孤儿。
 *
 * @param db 数据库连接
 * @param userId 当前操作的用户（排除其自身引用）
 * @param oldUrl 待清理的旧头像 URL
 * @throws 沿用 provider.delete 的异常语义（调用方按需静默）
 */
async function deleteAvatarIfUnreferenced(
  db: ReturnType<typeof getDb>,
  userId: string,
  oldUrl: string,
): Promise<void> {
  const provider = await getStorageProvider();
  if (parseStorageUrl(oldUrl).provider === "local") {
    const refs = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.avatar_url, oldUrl), ne(users.id, userId)))
      .limit(1);
    if (refs.length > 0) return; // 仍有其他用户引用，跳过删除
  }
  await provider.delete(oldUrl);
}

/**
 * 上传/替换头像。
 *
 * 顺序：先存新文件 → 更新 DB → 清理旧文件。
 * 内容寻址下同图 URL 相同，固定 key 模式下同 key 不误删。
 */
export async function updateUserAvatar(
  userId: string,
  file: File,
): Promise<{ avatar_url: string | null }> {
  const { bytes, type } = await validateAvatarFile(file);
  const provider = await getStorageProvider();
  // 1. 先存新文件（key 带用户 id 与扩展名，供 S3 模式的 Content-Type 推断）
  const ext = type === "png" ? "png" : type === "webp" ? "webp" : "jpg";
  const newUrl = await provider.put(
    `avatar/${userId}.${ext}`,
    bytes,
    AVATAR_MAGIC_MIME[type],
  );

  const db = getDb();
  // 2. 更新 DB（先取旧 URL 用于清理）
  const old = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  if (!old[0]) {
    throw new NotFoundError("用户不存在");
  }
  await db.update(users)
    .set({ avatar_url: newUrl, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId));

  // 3. 清理旧文件（幂等；同 key 同一对象不误删；local 共享引用不误删）
  const oldUrl = old[0].avatar_url;
  if (oldUrl && !sameStorageObject(oldUrl, newUrl)) {
    try {
      await deleteAvatarIfUnreferenced(db, userId, oldUrl);
    } catch {
      // 旧文件不存在时静默忽略
    }
  }
  return { avatar_url: newUrl };
}

/**
 * 删除头像：清空字段 + 删除文件（幂等）。
 */
export async function clearUserAvatar(
  userId: string,
): Promise<{ avatar_url: null }> {
  const db = getDb();
  const old = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  if (!old[0]) {
    throw new NotFoundError("用户不存在");
  }
  await db.update(users)
    .set({ avatar_url: null, updated_at: new Date().toISOString() })
    .where(eq(users.id, userId));

  const oldUrl = old[0].avatar_url;
  if (oldUrl) {
    try {
      await deleteAvatarIfUnreferenced(db, userId, oldUrl);
    } catch {
      // 幂等：文件不存在时静默忽略
    }
  }
  return { avatar_url: null };
}

/**
 * 读取头像字节与元数据。
 *
 * @throws {NotFoundError} 用户无头像
 */
export async function getUserAvatarBytes(
  userId: string,
): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
  const db = getDb();
  const row = await db.select({ avatar_url: users.avatar_url }).from(users)
    .where(eq(users.id, userId)).limit(1);
  const url = row[0]?.avatar_url;
  if (!url) {
    throw new NotFoundError("该用户未设置头像");
  }
  const provider = await getStorageProvider();
  const bytes = await provider.get(url);
  const parsed = parseStorageUrl(url);
  const contentType = /\.png$/i.test(parsed.key)
    ? "image/png"
    : /\.webp$/i.test(parsed.key)
    ? "image/webp"
    : "image/jpeg";
  const etag = parsed.checksumSha256
    ? `"${parsed.checksumSha256}"`
    : `"${parsed.key}"`;
  return { bytes, contentType, etag };
}
