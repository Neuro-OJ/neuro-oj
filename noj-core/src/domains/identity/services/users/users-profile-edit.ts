import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import { users } from "../../../../db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./../../../../shared/base/errors.ts";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";

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
