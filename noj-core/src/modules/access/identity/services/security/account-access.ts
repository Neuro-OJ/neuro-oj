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
