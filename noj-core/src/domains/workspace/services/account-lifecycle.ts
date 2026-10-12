import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainMemberships,
  domainResourceCounters,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import { ConflictError, NotFoundError } from "../../../shared/base/errors.ts";
import { workspaceAudit } from "./domains.ts";

/** 成员写入先锁目标账号，再锁域；注销提交后不允许用旧读取创建有效成员关系。 */
export async function lockActiveWorkspaceAccount(
  executor: Executor,
  userId: string,
) {
  const [account] = await executor.select().from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  ).for("update");
  if (!account) throw new NotFoundError("成员账号不可用");
  return account;
}

/** 注销事务已锁定目标账号；与创建及交接按账号 → 域顺序锁定，防止留下失效负责人。 */
export async function assertAccountHasNoOwnedDomain(
  executor: Executor,
  userId: string,
) {
  const owned = await executor.select({ id: domains.id }).from(domains).where(
    eq(domains.owner_id, userId),
  )
    .orderBy(domains.id).for("update");
  if (owned.length) {
    throw new ConflictError(
      "账号仍是工作空间负责人，请先完成交接",
      "DOMAIN_OWNER_TRANSFER_REQUIRED",
    );
  }
}

/** 账号注销保留成员历史，原子释放当前成员名额；事务回滚不会留下半退出状态。 */
export async function retireAccountWorkspaceMemberships(
  executor: Executor,
  userId: string,
  actorId = userId,
) {
  const affected = await executor.select({ id: domains.id }).from(domains)
    .where(
      sql`EXISTS (SELECT 1 FROM domain_memberships membership WHERE membership.domain_id = ${domains.id} AND membership.user_id = ${userId} AND membership.status = 'active')`,
    ).orderBy(domains.id).for("update");
  await executor.update(domainMemberships).set({
    status: "removed",
    left_at: new Date().toISOString(),
  }).where(
    and(
      eq(domainMemberships.user_id, userId),
      eq(domainMemberships.status, "active"),
    ),
  );
  for (const domain of affected) {
    await executor.update(domainResourceCounters).set({
      used:
        sql`(SELECT count(*) FROM domain_memberships membership WHERE membership.domain_id = ${domain.id} AND membership.status = 'active')`,
    }).where(
      and(
        eq(domainResourceCounters.domain_id, domain.id),
        eq(domainResourceCounters.resource, "members"),
      ),
    );
    await workspaceAudit(executor, actorId, domain.id, "domain.member_remove", {
      operation: "account_deleted",
      user_id: userId,
    });
  }
}
