import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import type { Executor } from "../../../../../shared/db/executor.ts";
import { userBans, users } from "../../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  UnauthorizedError,
} from "../../../../../shared/base/errors.ts";

/** 后台操作及长请求按当前数据库账号状态授权，不依赖 HTTP 入口的封禁缓存。 */
export async function assertActiveInstanceAccount(
  userId: string,
  executor: Executor = getDb(),
) {
  const [user] = await executor.select({ id: users.id }).from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  );
  if (!user) throw new UnauthorizedError("账号不可用");
  await assertInstanceAccountNotBanned(userId, executor);
}

/** 已锁定并验证存在的目标账号复用全站封禁检查，邀请不能绕过该状态。 */
export async function assertInstanceAccountNotBanned(
  userId: string,
  executor: Executor = getDb(),
) {
  const [ban] = await executor.select({
    until: userBans.banned_until,
  }).from(userBans).where(and(
    eq(userBans.user_id, userId),
    eq(userBans.scope, "platform"),
    isNull(userBans.unbanned_at),
  )).orderBy(desc(userBans.banned_at)).limit(1);
  if (ban && (!ban.until || Date.parse(ban.until) > Date.now())) {
    throw new ForbiddenError("账号已被封禁", "USER_BANNED");
  }
}

/**
 * 内容写能力（会产出公开/私密用户内容的写用例）的账号政策。
 *
 * 背景（2026-11-02 rc/v0.11 审计 F2）：邮箱验证政策原先挂在认证中间件的**URL 前缀
 * 清单**上，新域入口 `/domains/:slug/...` 不在清单里，未验证账号可以照常发帖、
 * 提交评测。这里把政策收敛成一个**能力函数**，由写用例的必经闸口调用：
 *
 * - 社区内容写：`assertCommunityWritable()`（旧 `/community` 与
 *   `/domains/:slug/community/*` 共用）；
 * - 评测受理：`composeEvaluationAdmissionContext()` /
 *   `composeDomainEvaluationAdmissionPlan()`（旧 `/submissions`、域提交、
 *   代码/产物/客观题答卷、自测共用）。
 *
 * 判定只看账号事实（未验证邮箱 ⇒ 拒绝），不看请求路径、不看角色：管理员与旧入口
 * 行为保持一致；`/api/v1/admin/*` 的管理端写路径不经过上述闸口，因此仍不受限。
 *
 * @param userId 已经认证的用户 ID
 * @param executor 当前事务/连接（写用例必须在同一连接上读账号状态）
 * @throws {UnauthorizedError} 账号不可用
 * @throws {ForbiddenError} 邮箱未验证（`EMAIL_VERIFICATION_REQUIRED`）或账号被封禁
 */
export async function assertContentWriteAccount(
  userId: string,
  executor: Executor = getDb(),
) {
  const [user] = await executor.select({
    emailVerified: users.email_verified,
  }).from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  );
  if (!user) throw new UnauthorizedError("账号不可用");
  if (!user.emailVerified) {
    throw new ForbiddenError("请先验证邮箱", "EMAIL_VERIFICATION_REQUIRED");
  }
  await assertInstanceAccountNotBanned(userId, executor);
}
