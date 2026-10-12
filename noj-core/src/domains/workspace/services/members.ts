import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainJoinRequests,
  domainMemberRoles,
  domainMemberships,
  domainResourceCounters,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import type { DomainRole } from "../../../shared/workspace/types.ts";
import { isDomainRole } from "../types.ts";
import {
  assertWorkspacePermission,
  loadDomainForJoining,
  loadWorkspace,
} from "./access.ts";
import { workspaceAudit } from "./domains.ts";
import { getDomainEffectiveLimits } from "./limits.ts";
import { ROOT_USER_ID } from "../../../shared/base/constants.ts";
import { lockActiveWorkspaceAccount } from "./account-lifecycle.ts";

/** 调用方已按账号 → Domain 顺序加锁；成员数检查和身份恢复同事务执行。 */
export async function addDomainMember(
  db: Executor,
  domainId: string,
  userId: string,
  reactivate = false,
) {
  const [user] = await db.select({ id: users.id }).from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  );
  if (!user) throw new NotFoundError("成员账号不可用");
  const [existing] = await db.select().from(domainMemberships).where(
    and(
      eq(domainMemberships.domain_id, domainId),
      eq(domainMemberships.user_id, userId),
    ),
  );
  if (existing?.status === "active") return existing;
  if (existing && !reactivate) {
    throw new ForbiddenError(
      "已移除的成员需要管理员重新邀请",
      "DOMAIN_MEMBER_REMOVED",
    );
  }
  const { effective: limit } = await getDomainEffectiveLimits(domainId, db);
  const [used] = await db.select({ count: count() }).from(domainMemberships)
    .where(
      and(
        eq(domainMemberships.domain_id, domainId),
        eq(domainMemberships.status, "active"),
      ),
    );
  if (limit?.members != null && used.count >= limit.members) {
    throw new ForbiddenError("工作空间成员数量已达上限", "DOMAIN_MEMBER_LIMIT");
  }
  const now = new Date().toISOString();
  let member;
  if (existing) {
    [member] = await db.update(domainMemberships).set({
      status: "active",
      joined_at: now,
      left_at: null,
    }).where(eq(domainMemberships.id, existing.id)).returning();
    // 恢复成员不恢复上次离开前的管理权限。
    await db.delete(domainMemberRoles).where(
      eq(domainMemberRoles.membership_id, existing.id),
    );
  } else {[member] = await db.insert(domainMemberships).values({
      id: crypto.randomUUID(),
      domain_id: domainId,
      user_id: userId,
      joined_at: now,
    }).returning();}
  await db.insert(domainMemberRoles).values({
    membership_id: member.id,
    role: "member",
  });
  await db.insert(domainResourceCounters).values({
    domain_id: domainId,
    resource: "members",
    used: used.count + 1,
  }).onConflictDoUpdate({
    target: [domainResourceCounters.domain_id, domainResourceCounters.resource],
    set: { used: used.count + 1 },
  });
  return member;
}

/** 按加入政策直接加入或创建申请；邀请域不允许公开加入。 */
export async function joinDomain(slug: string, actorId: string, reason = "") {
  if (typeof reason !== "string" || reason.length > 1000) {
    throw new BadRequestError("申请理由非法");
  }
  return await getDb().transaction(async (tx) => {
    await lockActiveWorkspaceAccount(tx, actorId);
    const domain = await loadDomainForJoining(slug, tx);
    const [member] = await tx.select().from(domainMemberships).where(
      and(
        eq(domainMemberships.domain_id, domain.id),
        eq(domainMemberships.user_id, actorId),
      ),
    );
    if (member?.status === "active") return { membership: member };
    if (member) throw new ForbiddenError("已移除的成员需要重新邀请");
    if (domain.configuration.join_policy === "invite") {
      throw new ForbiddenError("请通过有效邀请加入");
    }
    if (domain.configuration.join_policy === "approval") {
      const [pending] = await tx.select().from(domainJoinRequests).where(
        and(
          eq(domainJoinRequests.domain_id, domain.id),
          eq(domainJoinRequests.user_id, actorId),
          eq(domainJoinRequests.status, "pending"),
        ),
      );
      if (pending) return { request: pending };
      const [request] = await tx.insert(domainJoinRequests).values({
        id: crypto.randomUUID(),
        domain_id: domain.id,
        user_id: actorId,
        reason,
        created_at: new Date().toISOString(),
      }).returning();
      return { request };
    }
    const membership = await addDomainMember(tx, domain.id, actorId);
    await workspaceAudit(tx, actorId, domain.id, "domain.join");
    return { membership };
  });
}

/** 加入申请目录只返回当前域的管理字段，已注销账号不保留旧显示身份。 */
export async function listDomainJoinRequests(slug: string, actorId: string) {
  const { domain, context } = await loadWorkspace(slug, actorId);
  assertWorkspacePermission(context, "domain:members");
  const rows = await getDb().select({
    id: domainJoinRequests.id,
    user_id: domainJoinRequests.user_id,
    username: users.username,
    deleted_at: users.deleted_at,
    reason: domainJoinRequests.reason,
    status: domainJoinRequests.status,
    created_at: domainJoinRequests.created_at,
  }).from(domainJoinRequests).innerJoin(
    users,
    eq(users.id, domainJoinRequests.user_id),
  )
    .where(eq(domainJoinRequests.domain_id, domain.id))
    .orderBy(domainJoinRequests.created_at, domainJoinRequests.id).limit(100);
  return rows.map(({ deleted_at, ...row }) => ({
    ...row,
    username: deleted_at ? "已注销用户" : row.username,
    can_approve: !deleted_at && row.status === "pending",
  }));
}

/** 加入申请审批不改变平台账号角色。 */
export async function reviewJoinRequest(
  slug: string,
  requestId: string,
  actorId: string,
  approved: boolean,
) {
  return await getDb().transaction(async (tx) => {
    const initial = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
    });
    assertWorkspacePermission(initial.context, "domain:members");
    // 先读不可变的申请人与域定位，授权前不返回任何申请信息。
    const [candidate] = await tx.select({ user_id: domainJoinRequests.user_id })
      .from(domainJoinRequests)
      .innerJoin(domains, eq(domains.id, domainJoinRequests.domain_id))
      .where(and(eq(domainJoinRequests.id, requestId), eq(domains.slug, slug)));
    if (approved && candidate) {
      await lockActiveWorkspaceAccount(tx, candidate.user_id);
    }
    const { domain, context } = await loadWorkspace(slug, actorId, {
      write: true,
      lock: true,
      executor: tx,
    });
    assertWorkspacePermission(context, "domain:members");
    const [request] = await tx.select().from(domainJoinRequests).where(
      and(
        eq(domainJoinRequests.id, requestId),
        eq(domainJoinRequests.domain_id, domain.id),
      ),
    );
    if (!request) throw new NotFoundError("加入申请不存在");
    if (request.status !== "pending") throw new ConflictError("申请已经处理");
    if (approved) await addDomainMember(tx, domain.id, request.user_id, true);
    const [updated] = await tx.update(domainJoinRequests).set({
      status: approved ? "approved" : "rejected",
      reviewed_by: actorId,
      reviewed_at: new Date().toISOString(),
    }).where(eq(domainJoinRequests.id, requestId)).returning();
    await workspaceAudit(tx, actorId, domain.id, "domain.join_review", {
      request_id: requestId,
      approved,
    });
    return updated;
  });
}

/** 只有负责人或平台管理员可以授予管理员，owner 不通过普通角色接口授予。 */
export async function setMemberRoles(
  slug: string,
  actorId: string,
  userId: string,
  roles: readonly DomainRole[],
) {
  if (
    !Array.isArray(roles) || roles.length < 1 ||
    roles.some((role) => !isDomainRole(role) || role === "owner")
  ) throw new BadRequestError("域成员角色非法；负责人须通过交接设置");
  return await getDb().transaction(async (tx) => {
    const { domain, context, platformAdmin } = await loadWorkspace(
      slug,
      actorId,
      { write: true, lock: true, executor: tx },
    );
    assertWorkspacePermission(context, "domain:members");
    if (userId === domain.owner_id) {
      throw new ConflictError("不能通过角色编辑移除负责人");
    }
    const [member] = await tx.select().from(domainMemberships).where(
      and(
        eq(domainMemberships.domain_id, domain.id),
        eq(domainMemberships.user_id, userId),
        eq(domainMemberships.status, "active"),
      ),
    );
    if (!member) throw new NotFoundError("成员不存在");
    const previous = await tx.select().from(domainMemberRoles).where(
      eq(domainMemberRoles.membership_id, member.id),
    );
    if (
      (roles.includes("admin") || previous.some((r) => r.role === "admin")) &&
      !platformAdmin && domain.owner_id !== actorId
    ) throw new ForbiddenError("仅负责人可管理管理员角色");
    await tx.delete(domainMemberRoles).where(
      eq(domainMemberRoles.membership_id, member.id),
    );
    await tx.insert(domainMemberRoles).values(
      [...new Set(roles)].map((role) => ({ membership_id: member.id, role })),
    );
    await workspaceAudit(tx, actorId, domain.id, "domain.member_roles", {
      user_id: userId,
      roles,
    });
    return { user_id: userId, roles: [...new Set(roles)] };
  });
}

/** 成员移除只撤销当前关系；保护负责人和管理员的授权边界。 */
export async function removeDomainMember(
  slug: string,
  actorId: string,
  userId: string,
) {
  return await getDb().transaction(async (tx) => {
    const { domain, context, platformAdmin } = await loadWorkspace(
      slug,
      actorId,
      { write: true, lock: true, executor: tx },
    );
    if (actorId !== userId) {
      assertWorkspacePermission(context, "domain:members");
    }
    if (userId === domain.owner_id) {
      throw new ConflictError("负责人必须先交接再退出");
    }
    const [member] = await tx.select().from(domainMemberships).where(
      and(
        eq(domainMemberships.domain_id, domain.id),
        eq(domainMemberships.user_id, userId),
        eq(domainMemberships.status, "active"),
      ),
    );
    if (!member) throw new NotFoundError("成员不存在");
    const roles = await tx.select().from(domainMemberRoles).where(
      eq(domainMemberRoles.membership_id, member.id),
    );
    if (
      actorId !== userId && roles.some((r) => r.role === "admin") &&
      !platformAdmin && actorId !== domain.owner_id
    ) throw new ForbiddenError("仅负责人可移除管理员");
    await tx.update(domainMemberships).set({
      status: "removed",
      left_at: new Date().toISOString(),
    }).where(eq(domainMemberships.id, member.id));
    await tx.update(domainResourceCounters).set({
      used: sql`GREATEST(used - 1, 0)`,
    }).where(
      and(
        eq(domainResourceCounters.domain_id, domain.id),
        eq(domainResourceCounters.resource, "members"),
      ),
    );
    await workspaceAudit(tx, actorId, domain.id, "domain.member_remove", {
      user_id: userId,
    });
    return { removed: true };
  });
}

/** 交接更新身份与负责人引用的同一事务，旧负责人保留管理员身份。 */
export async function transferDomain(
  slug: string,
  actorId: string,
  newOwnerId: string,
) {
  if (newOwnerId === ROOT_USER_ID) {
    throw new BadRequestError("系统账号不能担任新的空间负责人");
  }
  return await getDb().transaction(async (tx) => {
    const [account] = await tx.select({ id: users.id }).from(users).where(
      and(eq(users.id, newOwnerId), isNull(users.deleted_at)),
    ).for("update");
    if (!account) throw new NotFoundError("新负责人必须是有效域成员");
    const { domain, context, platformAdmin } = await loadWorkspace(
      slug,
      actorId,
      {
        lock: true,
        executor: tx,
      },
    );
    assertWorkspacePermission(context, "domain:transfer");
    if (domain.status !== "active" && !platformAdmin) {
      throw new ForbiddenError("工作空间只读或停用", "DOMAIN_READ_ONLY");
    }
    if (newOwnerId === domain.owner_id) return domain;
    const [next] = await tx.select().from(domainMemberships).where(
      and(
        eq(domainMemberships.domain_id, domain.id),
        eq(domainMemberships.user_id, newOwnerId),
        eq(domainMemberships.status, "active"),
      ),
    );
    if (!next) throw new NotFoundError("新负责人必须是有效域成员");
    const [previous] = await tx.select().from(domainMemberships).where(
      and(
        eq(domainMemberships.domain_id, domain.id),
        eq(domainMemberships.user_id, domain.owner_id),
      ),
    );
    if (!previous) throw new ConflictError("当前负责人身份缺失");
    await tx.delete(domainMemberRoles).where(
      and(
        eq(domainMemberRoles.membership_id, previous.id),
        eq(domainMemberRoles.role, "owner"),
      ),
    );
    await tx.insert(domainMemberRoles).values({
      membership_id: previous.id,
      role: "admin",
    }).onConflictDoNothing();
    await tx.insert(domainMemberRoles).values({
      membership_id: next.id,
      role: "owner",
    }).onConflictDoNothing();
    const [updated] = await tx.update(domains).set({
      owner_id: newOwnerId,
      revision: domain.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(domains.id, domain.id)).returning();
    await workspaceAudit(tx, actorId, domain.id, "domain.transfer", {
      previous_owner_id: domain.owner_id,
      owner_id: newOwnerId,
    });
    return updated;
  });
}

/** 成员目录只对获授权管理员开放，不允许普通学生枚举邮箱。 */
export async function listDomainMembers(
  slug: string,
  actorId: string,
  offset = 0,
) {
  const { domain, context } = await loadWorkspace(slug, actorId);
  assertWorkspacePermission(context, "domain:members");
  const members = await getDb().select({
    id: domainMemberships.id,
    user_id: users.id,
    username: users.username,
    email: users.email,
    deleted_at: users.deleted_at,
    status: domainMemberships.status,
  }).from(domainMemberships).innerJoin(
    users,
    eq(users.id, domainMemberships.user_id),
  ).where(eq(domainMemberships.domain_id, domain.id)).orderBy(
    users.username,
    users.id,
  )
    .limit(100).offset(Math.max(0, offset));
  const assignments = members.length
    ? await getDb().select().from(domainMemberRoles).where(
      inArray(
        domainMemberRoles.membership_id,
        members.map((member) => member.id),
      ),
    )
    : [];
  return members.map((member) => ({
    id: member.id,
    user_id: member.user_id,
    username: member.deleted_at ? "已注销用户" : member.username,
    email: member.deleted_at ? "" : member.email,
    status: member.status,
    roles: assignments.filter((role) => role.membership_id === member.id).map((
      role,
    ) => role.role),
    is_owner: member.user_id === domain.owner_id,
  }));
}
