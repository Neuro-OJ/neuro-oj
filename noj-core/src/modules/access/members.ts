/**
 * access 的账户成员关系写入。
 *
 * `*_Tx` 函数是唯一的原子实现：它们接收必填 `DbTx`，按账号 → 域锁序
 * 重新读取授权，并把成员、角色、配额计数和审计放进同一事务。无后缀的
 * 应用入口只负责取得 `DbRoot` 并开启一次事务。
 */
import { and, count, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  domainJoinRequests,
  domainLimits,
  domainMemberRoles,
  domainMemberships,
  domainResourceCounters,
  domains,
  userBans,
  users,
} from "../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/base/errors.ts";
import { ROOT_USER_ID } from "../../shared/base/constants.ts";
import type { DomainRole } from "../../shared/workspace/types.ts";
import { combineDomainLimits } from "../../shared/workspace/resource-policy.ts";
import { getInstanceResourcePolicy } from "./workspace/services/instance.ts";
import { requireUserActor, type UserActor } from "./contracts/actor.ts";
import { workspaceAuditTx } from "./audit.ts";
import {
  assertWorkspacePermission,
  loadDomainForJoiningTx,
  loadWorkspace,
  loadWorkspaceTx,
  requireWorkspaceUser,
} from "./policy.ts";
import { isDomainRole } from "./types.ts";

export interface AccessWriteMeta {
  readonly ipAddress?: string;
  readonly requestId?: string;
}

/** 由 application 注入的教育/其他成员关系副作用。 */
export interface MemberRemovalBoundary {
  readonly onMemberRemovedTx: (
    tx: DbTx,
    domainId: string,
    userId: string,
    actor: UserActor,
  ) => Promise<void>;
}

async function lockActiveAccountTx(
  tx: DbTx,
  userId: string,
): Promise<void> {
  const [account] = await tx.select({ id: users.id }).from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  ).for("update");
  if (!account) throw new NotFoundError("成员账号不可用");
  const [ban] = await tx.select({ until: userBans.banned_until }).from(
    userBans,
  ).where(and(
    eq(userBans.user_id, userId),
    eq(userBans.scope, "platform"),
    isNull(userBans.unbanned_at),
  )).orderBy(sql`${userBans.banned_at} DESC`).limit(1);
  if (ban && (!ban.until || Date.parse(ban.until) > Date.now())) {
    throw new ForbiddenError("账号已被封禁", "USER_BANNED");
  }
}

/** 账号注销和成员写入共用的负责人保护查询。 */
export async function assertAccountHasNoOwnedDomainTx(
  tx: DbTx,
  userId: string,
): Promise<void> {
  const owned = await tx.select({ id: domains.id }).from(domains).where(
    eq(domains.owner_id, userId),
  ).orderBy(domains.id).for("update");
  if (owned.length > 0) {
    throw new ConflictError(
      "账号仍是工作空间负责人，请先完成交接",
      "DOMAIN_OWNER_TRANSFER_REQUIRED",
    );
  }
}

/**
 * 在已锁定账号和域的事务中增加/恢复成员。调用者身份始终显式传入，
 * 不能把缺省 root 当作审计操作者。
 */
export async function addDomainMemberTx(
  tx: DbTx,
  actor: UserActor,
  domainId: string,
  userId: string,
  reactivate = false,
  meta: AccessWriteMeta = {},
): Promise<typeof domainMemberships.$inferSelect> {
  requireUserActor(actor);
  await lockActiveAccountTx(tx, userId);
  // 成员计数和恢复必须在域锁内完成；锁序固定为账号 → 域。
  const [domain] = await tx.select({ id: domains.id }).from(domains).where(
    eq(domains.id, domainId),
  ).for("update");
  if (!domain) throw new NotFoundError("工作空间不存在");
  const [existing] = await tx.select().from(domainMemberships).where(and(
    eq(domainMemberships.domain_id, domainId),
    eq(domainMemberships.user_id, userId),
  ));
  if (existing?.status === "active") return existing;
  if (existing && !reactivate) {
    throw new ForbiddenError(
      "已移除的成员需要管理员重新邀请",
      "DOMAIN_MEMBER_REMOVED",
    );
  }
  const [storedLimit] = await tx.select().from(domainLimits).where(
    eq(domainLimits.domain_id, domainId),
  );
  if (!storedLimit) throw new NotFoundError("工作空间配额未初始化");
  const resourcePolicy = await getInstanceResourcePolicy(tx);
  const configuredLimit = {
    members: storedLimit.members,
    problems: storedLimit.problems,
    storage_bytes: storedLimit.storage_bytes,
    submissions_per_minute: storedLimit.submissions_per_minute,
  };
  const effectiveLimit = combineDomainLimits(
    configuredLimit,
    resourcePolicy.limit_caps,
  ).members;
  const [used] = await tx.select({ count: count() }).from(domainMemberships)
    .where(and(
      eq(domainMemberships.domain_id, domainId),
      eq(domainMemberships.status, "active"),
    ));
  if (effectiveLimit != null && used.count >= effectiveLimit) {
    throw new ForbiddenError("工作空间成员数量已达上限", "DOMAIN_MEMBER_LIMIT");
  }
  const now = new Date().toISOString();
  let member: typeof domainMemberships.$inferSelect;
  if (existing) {
    [member] = await tx.update(domainMemberships).set({
      status: "active",
      joined_at: now,
      left_at: null,
    }).where(eq(domainMemberships.id, existing.id)).returning();
    await tx.delete(domainMemberRoles).where(
      eq(domainMemberRoles.membership_id, existing.id),
    );
  } else {
    [member] = await tx.insert(domainMemberships).values({
      id: crypto.randomUUID(),
      domain_id: domainId,
      user_id: userId,
      joined_at: now,
    }).returning();
  }
  await tx.insert(domainMemberRoles).values({
    membership_id: member.id,
    role: "member",
  });
  await tx.insert(domainResourceCounters).values({
    domain_id: domainId,
    resource: "members",
    used: used.count + 1,
  }).onConflictDoUpdate({
    target: [domainResourceCounters.domain_id, domainResourceCounters.resource],
    set: { used: used.count + 1 },
  });
  await workspaceAuditTx(tx, actor, domainId, "domain.join", {
    user_id: userId,
    operation: existing ? "reactivate" : "add",
  }, meta);
  return member;
}

/** 按加入政策直接加入或创建申请；邀请域不允许公开加入。 */
export async function joinDomainTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  reason = "",
  meta: AccessWriteMeta = {},
): Promise<
  { membership: typeof domainMemberships.$inferSelect } | {
    request: typeof domainJoinRequests.$inferSelect;
  }
> {
  requireUserActor(actor);
  if (typeof reason !== "string" || reason.length > 1000) {
    throw new BadRequestError("申请理由非法");
  }
  await lockActiveAccountTx(tx, actor.userId);
  const domain = await loadDomainForJoiningTx(tx, slug);
  const [member] = await tx.select().from(domainMemberships).where(and(
    eq(domainMemberships.domain_id, domain.id),
    eq(domainMemberships.user_id, actor.userId),
  ));
  if (member?.status === "active") return { membership: member };
  if (member) throw new ForbiddenError("已移除的成员需要重新邀请");
  if (domain.configuration.join_policy === "invite") {
    throw new ForbiddenError("请通过有效邀请加入");
  }
  if (domain.configuration.join_policy === "approval") {
    const [pending] = await tx.select().from(domainJoinRequests).where(and(
      eq(domainJoinRequests.domain_id, domain.id),
      eq(domainJoinRequests.user_id, actor.userId),
      eq(domainJoinRequests.status, "pending"),
    ));
    if (pending) return { request: pending };
    const [request] = await tx.insert(domainJoinRequests).values({
      id: crypto.randomUUID(),
      domain_id: domain.id,
      user_id: actor.userId,
      reason,
      created_at: new Date().toISOString(),
    }).returning();
    await workspaceAuditTx(tx, actor, domain.id, "domain.join", {
      operation: "request",
      request_id: request.id,
    }, meta);
    return { request };
  }
  const membership = await addDomainMemberTx(
    tx,
    actor,
    domain.id,
    actor.userId,
    false,
    meta,
  );
  return { membership };
}

/** 用户边界的独立应用入口；事务所有权在此明确。 */
export function joinDomain(
  actor: UserActor,
  slug: string,
  reason = "",
  meta: AccessWriteMeta = {},
) {
  const user = requireWorkspaceUser(actor);
  const db: DbRoot = getDb();
  return db.transaction((tx) => joinDomainTx(tx, user, slug, reason, meta));
}

export async function reviewJoinRequestTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  requestId: string,
  approved: boolean,
  meta: AccessWriteMeta = {},
): Promise<typeof domainJoinRequests.$inferSelect> {
  const user = requireUserActor(actor);
  const initial = await loadWorkspaceTx(tx, slug, user, {
    write: true,
  });
  assertWorkspacePermission(initial.context, "domain:members");
  const [candidate] = await tx.select({ user_id: domainJoinRequests.user_id })
    .from(domainJoinRequests).innerJoin(
      domains,
      eq(domains.id, domainJoinRequests.domain_id),
    ).where(and(
      eq(domainJoinRequests.id, requestId),
      eq(domains.slug, slug),
    ));
  if (approved && candidate) await lockActiveAccountTx(tx, candidate.user_id);
  const { domain, context } = await loadWorkspaceTx(tx, slug, user, {
    write: true,
    lock: true,
  });
  assertWorkspacePermission(context, "domain:members");
  const [request] = await tx.select().from(domainJoinRequests).where(and(
    eq(domainJoinRequests.id, requestId),
    eq(domainJoinRequests.domain_id, domain.id),
  ));
  if (!request) throw new NotFoundError("加入申请不存在");
  if (request.status !== "pending") throw new ConflictError("申请已经处理");
  if (approved) {
    await addDomainMemberTx(tx, user, domain.id, request.user_id, true, meta);
  }
  const [updated] = await tx.update(domainJoinRequests).set({
    status: approved ? "approved" : "rejected",
    reviewed_by: user.userId,
    reviewed_at: new Date().toISOString(),
  }).where(eq(domainJoinRequests.id, requestId)).returning();
  await workspaceAuditTx(tx, user, domain.id, "domain.join_review", {
    request_id: requestId,
    approved,
  }, meta);
  return updated;
}

export function reviewJoinRequest(
  actor: UserActor,
  slug: string,
  requestId: string,
  approved: boolean,
  meta: AccessWriteMeta = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    reviewJoinRequestTx(
      tx,
      requireUserActor(actor),
      slug,
      requestId,
      approved,
      meta,
    )
  );
}

export async function setMemberRolesTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  userId: string,
  roles: readonly DomainRole[],
  meta: AccessWriteMeta = {},
) {
  const user = requireUserActor(actor);
  if (
    !Array.isArray(roles) || roles.length < 1 ||
    roles.some((role) => !isDomainRole(role) || role === "owner")
  ) throw new BadRequestError("域成员角色非法；负责人须通过交接设置");
  // 与加入、交接和账号注销保持账号 → 域锁序，避免角色写入与注销交叉。
  await lockActiveAccountTx(tx, userId);
  const { domain, context, platformAdmin } = await loadWorkspaceTx(
    tx,
    slug,
    user,
    {
      write: true,
      lock: true,
    },
  );
  assertWorkspacePermission(context, "domain:members");
  if (userId === domain.owner_id) {
    throw new ConflictError("不能通过角色编辑移除负责人");
  }
  const [member] = await tx.select().from(domainMemberships).where(and(
    eq(domainMemberships.domain_id, domain.id),
    eq(domainMemberships.user_id, userId),
    eq(domainMemberships.status, "active"),
  ));
  if (!member) throw new NotFoundError("成员不存在");
  const previous = await tx.select().from(domainMemberRoles).where(
    eq(domainMemberRoles.membership_id, member.id),
  );
  if (
    (roles.includes("admin") || previous.some((row) => row.role === "admin")) &&
    !platformAdmin && domain.owner_id !== user.userId
  ) throw new ForbiddenError("仅负责人可管理管理员角色");
  const normalizedRoles = [...new Set(roles)];
  await tx.delete(domainMemberRoles).where(
    eq(domainMemberRoles.membership_id, member.id),
  );
  await tx.insert(domainMemberRoles).values(
    normalizedRoles.map((role) => ({ membership_id: member.id, role })),
  );
  await workspaceAuditTx(tx, user, domain.id, "domain.member_roles", {
    user_id: userId,
    roles: normalizedRoles,
  }, meta);
  return { user_id: userId, roles: normalizedRoles };
}

export function setMemberRoles(
  actor: UserActor,
  slug: string,
  userId: string,
  roles: readonly DomainRole[],
  meta: AccessWriteMeta = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    setMemberRolesTx(tx, actor, slug, userId, roles, meta)
  );
}

export async function removeDomainMemberTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  userId: string,
  meta: AccessWriteMeta = {},
  boundary: MemberRemovalBoundary,
) {
  const user = requireUserActor(actor);
  // 目标账号先锁定，再取得域锁；注销和成员移除按同一顺序线性化。
  await lockActiveAccountTx(tx, userId);
  const { domain, context, platformAdmin } = await loadWorkspaceTx(
    tx,
    slug,
    user,
    {
      write: true,
      lock: true,
    },
  );
  if (user.userId !== userId) {
    assertWorkspacePermission(context, "domain:members");
  }
  if (userId === domain.owner_id) {
    throw new ConflictError("负责人必须先交接再退出");
  }
  const [member] = await tx.select().from(domainMemberships).where(and(
    eq(domainMemberships.domain_id, domain.id),
    eq(domainMemberships.user_id, userId),
    eq(domainMemberships.status, "active"),
  ));
  if (!member) throw new NotFoundError("成员不存在");
  const roles = await tx.select().from(domainMemberRoles).where(
    eq(domainMemberRoles.membership_id, member.id),
  );
  if (
    user.userId !== userId && roles.some((row) => row.role === "admin") &&
    !platformAdmin && user.userId !== domain.owner_id
  ) throw new ForbiddenError("仅负责人可移除管理员");
  await tx.update(domainMemberships).set({
    status: "removed",
    left_at: new Date().toISOString(),
  }).where(eq(domainMemberships.id, member.id));
  await tx.update(domainResourceCounters).set({
    used: sql`GREATEST(used - 1, 0)`,
  }).where(and(
    eq(domainResourceCounters.domain_id, domain.id),
    eq(domainResourceCounters.resource, "members"),
  ));
  await boundary.onMemberRemovedTx(tx, domain.id, userId, user);
  await workspaceAuditTx(tx, user, domain.id, "domain.member_remove", {
    user_id: userId,
  }, meta);
  return { removed: true };
}

export function removeDomainMember(
  actor: UserActor,
  slug: string,
  userId: string,
  meta: AccessWriteMeta = {},
  boundary: MemberRemovalBoundary,
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    removeDomainMemberTx(tx, actor, slug, userId, meta, boundary)
  );
}

export async function transferDomainTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  newOwnerId: string,
  meta: AccessWriteMeta = {},
) {
  const user = requireUserActor(actor);
  if (newOwnerId === ROOT_USER_ID) {
    throw new BadRequestError("系统账号不能担任新的空间负责人");
  }
  await lockActiveAccountTx(tx, newOwnerId);
  const { domain, context, platformAdmin } = await loadWorkspaceTx(
    tx,
    slug,
    user,
    {
      lock: true,
    },
  );
  assertWorkspacePermission(context, "domain:transfer");
  if (domain.status !== "active" && !platformAdmin) {
    throw new ForbiddenError("工作空间只读或停用", "DOMAIN_READ_ONLY");
  }
  if (newOwnerId === domain.owner_id) return domain;
  const [next] = await tx.select().from(domainMemberships).where(and(
    eq(domainMemberships.domain_id, domain.id),
    eq(domainMemberships.user_id, newOwnerId),
    eq(domainMemberships.status, "active"),
  ));
  if (!next) throw new NotFoundError("新负责人必须是有效域成员");
  const [previous] = await tx.select().from(domainMemberships).where(and(
    eq(domainMemberships.domain_id, domain.id),
    eq(domainMemberships.user_id, domain.owner_id),
  ));
  if (!previous) throw new ConflictError("当前负责人身份缺失");
  await tx.delete(domainMemberRoles).where(and(
    eq(domainMemberRoles.membership_id, previous.id),
    eq(domainMemberRoles.role, "owner"),
  ));
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
  await workspaceAuditTx(tx, user, domain.id, "domain.transfer", {
    previous_owner_id: domain.owner_id,
    owner_id: newOwnerId,
  }, meta);
  return updated;
}

export function transferDomain(
  actor: UserActor,
  slug: string,
  newOwnerId: string,
  meta: AccessWriteMeta = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    transferDomainTx(tx, actor, slug, newOwnerId, meta)
  );
}

/** 成员目录复用同一 access policy；分页前先完成域授权。 */
export async function listDomainMembersPage(
  actor: UserActor,
  slug: string,
  options: { offset: number; perPage: number; keyword?: string },
) {
  const user = requireUserActor(actor);
  const { domain, context } = await loadWorkspace(slug, user);
  assertWorkspacePermission(context, "domain:members");
  const keyword = options.keyword?.trim();
  const where = and(
    eq(domainMemberships.domain_id, domain.id),
    keyword
      ? and(
        isNull(users.deleted_at),
        or(
          ilike(users.username, `%${keyword}%`),
          ilike(users.email, `%${keyword}%`),
        ),
      )
      : undefined,
  );
  const db = getDb();
  const [total] = await db.select({ count: count() }).from(domainMemberships)
    .innerJoin(users, eq(users.id, domainMemberships.user_id)).where(where);
  const members = await db.select({
    id: domainMemberships.id,
    user_id: users.id,
    username: users.username,
    email: users.email,
    deleted_at: users.deleted_at,
    status: domainMemberships.status,
  }).from(domainMemberships).innerJoin(
    users,
    eq(users.id, domainMemberships.user_id),
  )
    .where(where).orderBy(users.username, users.id)
    .limit(options.perPage).offset(options.offset);
  const assignments = members.length
    ? await db.select().from(domainMemberRoles).where(inArray(
      domainMemberRoles.membership_id,
      members.map((row) => row.id),
    ))
    : [];
  const rolesByMembership = new Map<string, DomainRole[]>();
  for (const row of assignments) {
    const roles = rolesByMembership.get(row.membership_id) ?? [];
    roles.push(row.role);
    rolesByMembership.set(row.membership_id, roles);
  }
  return {
    data: members.map(({ deleted_at, ...row }) => ({
      ...row,
      username: deleted_at ? "已注销用户" : row.username,
      roles: rolesByMembership.get(row.id) ?? [],
    })),
    total: total.count,
  };
}

export async function listDomainMembers(
  actor: UserActor,
  slug: string,
  offset = 0,
) {
  return (await listDomainMembersPage(actor, slug, {
    offset,
    perPage: 100,
  })).data;
}

/** 供 account deletion/application 使用的成员清理原子步骤。 */
export async function retireAccountWorkspaceMembershipsTx(
  tx: DbTx,
  actor: UserActor,
  userId: string,
  meta: AccessWriteMeta = {},
  boundary: MemberRemovalBoundary,
): Promise<void> {
  const operationActor = requireUserActor(actor);
  const affected = await tx.select({ id: domains.id }).from(domains).where(
    sql`EXISTS (SELECT 1 FROM domain_memberships membership WHERE membership.domain_id = ${domains.id} AND membership.user_id = ${userId} AND membership.status = 'active')`,
  ).orderBy(domains.id).for("update");
  await tx.update(domainMemberships).set({
    status: "removed",
    left_at: new Date().toISOString(),
  }).where(and(
    eq(domainMemberships.user_id, userId),
    eq(domainMemberships.status, "active"),
  ));
  for (const domain of affected) {
    await tx.update(domainResourceCounters).set({
      used:
        sql`(SELECT count(*) FROM domain_memberships membership WHERE membership.domain_id = ${domain.id} AND membership.status = 'active')`,
    }).where(and(
      eq(domainResourceCounters.domain_id, domain.id),
      eq(domainResourceCounters.resource, "members"),
    ));
    await boundary.onMemberRemovedTx(
      tx,
      domain.id,
      userId,
      operationActor,
    );
    await workspaceAuditTx(
      tx,
      operationActor,
      domain.id,
      "domain.member_remove",
      {
        operation: "account_deleted",
        user_id: userId,
      },
      meta,
    );
  }
}
