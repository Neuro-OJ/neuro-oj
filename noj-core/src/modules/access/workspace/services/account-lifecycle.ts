import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import { users } from "../../../../shared/db/schema.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { assertInstanceAccountNotBanned } from "../../identity/services/security/account-access.ts";

/** 成员写入先锁目标账号，再锁域；注销提交后不允许用旧读取创建有效成员关系。 */
export async function lockActiveWorkspaceAccount(
  executor: Executor,
  userId: string,
) {
  const [account] = await executor.select().from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  ).for("update");
  if (!account) throw new NotFoundError("成员账号不可用");
  await assertInstanceAccountNotBanned(userId, executor);
  return account;
}
