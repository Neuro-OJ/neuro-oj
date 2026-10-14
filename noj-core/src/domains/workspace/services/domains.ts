import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ROOT_USER_ID } from "../../../shared/base/constants.ts";
import { recordSourceDomainEducationChange } from "../../catalog/index.ts";
import { recordEducationEvent } from "../../../shared/education-events.ts";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  auditLogs,
  domainFeatureIntervals,
  domainLimits,
  domainMemberRoles,
  domainMemberships,
  domainResourceCounters,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  type DomainConfiguration,
  type DomainPreset,
} from "../../../shared/workspace/types.ts";
import { getAdminUserIds, getUserPermissions } from "../../identity/index.ts";
import { getRequestContext } from "../../system/index.ts";
import type { WorkspaceAuditAction } from "../../../shared/workspace/audit.ts";
import {
  presetConfiguration,
  validateDomainConfiguration,
  validateDomainSlug,
} from "../types.ts";
import { assertWorkspacePermission, loadWorkspace } from "./access.ts";
import {
  getInstanceAccessPolicy,
  getInstanceResourcePolicy,
} from "./instance.ts";
import {
  combineDomainLimits,
  constrainDomainConfiguration,
} from "../../../shared/workspace/resource-policy.ts";

/** 域配置变化的审计与业务操作在同一事务保存。 */
export async function workspaceAudit(
  db: Executor,
  actorId: string,
  domainId: string | null,
  action: WorkspaceAuditAction,
  detail: Record<string, unknown> = {},
  target?: { type: string; id: string },
) {
  let ipAddress = "";
  try {
    ipAddress = getRequestContext().actorIp;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("RequestContext 未注入")
    ) throw error;
  }
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    admin_id: actorId,
    action,
    target_type: target?.type ?? "domain",
    target_id: target?.id ?? domainId,
    ip_address: ipAddress,
    detail: { ...detail, domain_id: domainId },
    created_at: new Date().toISOString(),
  });
}

/** 经实例创建政策和数量上限检查后原子创建域及负责人身份。 */
export async function createDomain(
  input: {
    slug: string;
    name: string;
    preset: DomainPreset;
    description?: string;
  },
  actorId: string,
  options: { executor?: Executor; approved?: boolean } = {},
): Promise<typeof domains.$inferSelect> {
  validateDomainSlug(input.slug);
  if (
    typeof input.name !== "string" || !input.name.trim() ||
    input.name.length > 100 ||
    typeof input.description !== "undefined" &&
      (typeof input.description !== "string" || input.description.length > 2000)
  ) throw new BadRequestError("工作空间名称或简介非法");
  if (!["community", "education", "team", "custom"].includes(input.preset)) {
    throw new BadRequestError("工作空间模板非法");
  }
  if (!options.executor) {
    return await getDb().transaction((tx) =>
      createDomain(input, actorId, { ...options, executor: tx })
    );
  }
  const db = options.executor;
  const [actor] = await db.select({ id: users.id }).from(users).where(
    and(eq(users.id, actorId), isNull(users.deleted_at)),
  ).for("update");
  if (!actor) throw new NotFoundError("负责人账号不可用");
  const permissions = await getUserPermissions(actorId, db);
  const platformAdmin = permissions.has("admin:full_access");
  const policy = getInstanceAccessPolicy();
  if (
    !platformAdmin && !options.approved &&
    policy.domain_creation_policy !== "open"
  ) {
    throw new ForbiddenError(
      policy.domain_creation_policy === "approval"
        ? "请先申请创建工作空间"
        : "仅平台管理员可创建工作空间",
      "DOMAIN_CREATION_RESTRICTED",
    );
  }
  const [owned] = await db.select({ count: count() }).from(domains).where(
    eq(domains.owner_id, actorId),
  );
  if (!platformAdmin && owned.count >= policy.domain_creation_limit) {
    throw new ForbiddenError(
      "已达到工作空间创建数量上限",
      "DOMAIN_CREATION_LIMIT",
    );
  }
  const now = new Date().toISOString();
  const resourcePolicy = await getInstanceResourcePolicy(db);
  const limits = combineDomainLimits(
    resourcePolicy.default_limits,
    resourcePolicy.limit_caps,
  );
  if (limits.members !== null && limits.members < 1) {
    throw new ForbiddenError(
      "实例成员额度不足以建立负责人身份",
      "DOMAIN_MEMBER_LIMIT",
    );
  }
  const [domain] = await db.insert(domains).values({
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name.trim(),
    description: input.description ?? "",
    owner_id: actorId,
    preset: input.preset,
    configuration: constrainDomainConfiguration(
      presetConfiguration(input.preset),
      resourcePolicy.modules,
    ),
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing({ target: domains.slug }).returning();
  if (!domain) throw new ConflictError("工作空间标识已存在");
  const [membership] = await db.insert(domainMemberships).values({
    id: crypto.randomUUID(),
    domain_id: domain.id,
    user_id: actorId,
    joined_at: now,
  }).returning();
  await db.insert(domainMemberRoles).values({
    membership_id: membership.id,
    role: "owner",
  });
  await db.insert(domainLimits).values({ domain_id: domain.id, ...limits });
  await db.insert(domainResourceCounters).values(
    ["members", "problems", "storage_bytes"].map((resource) => ({
      domain_id: domain.id,
      resource: resource as "members" | "problems" | "storage_bytes",
      used: resource === "members" ? 1 : 0,
    })),
  );
  await workspaceAudit(db, actorId, domain.id, "domain.create", {
    preset: input.preset,
  });
  return domain;
}

/** 默认域种子幂等；重启不覆盖现有域配置或负责人。 */
export async function ensureDefaultWorkspace(
  executor?: Executor,
): Promise<void> {
  if (!executor) {
    return await getDb().transaction((tx) => ensureDefaultWorkspace(tx));
  }
  const [existing] = await executor.select().from(domains).where(
    eq(domains.slug, DEFAULT_DOMAIN_SLUG),
  );
  if (existing && existing.owner_id !== ROOT_USER_ID) return;
  const now = new Date().toISOString();
  const admins = await getAdminUserIds(executor);
  const candidates = [...admins].filter((id) => id !== ROOT_USER_ID);
  const [admin] = candidates.length
    ? await executor.select({ id: users.id }).from(users).where(
      and(inArray(users.id, candidates), isNull(users.deleted_at)),
    )
      .orderBy(users.id).limit(1).for("update")
    : [];
  const ownerId = admin?.id ?? ROOT_USER_ID;
  const [inserted] = await executor.insert(domains).values({
    id: DEFAULT_DOMAIN_ID,
    slug: DEFAULT_DOMAIN_SLUG,
    name: "Neuro OJ",
    owner_id: ownerId,
    preset: "community",
    configuration: presetConfiguration("community"),
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing({ target: domains.slug }).returning();
  if (!inserted) {
    if (ownerId === ROOT_USER_ID) return;
    const [current] = await executor.select().from(domains).where(
      eq(domains.slug, DEFAULT_DOMAIN_SLUG),
    ).for("update");
    if (!current || current.owner_id !== ROOT_USER_ID) return;
    const [owner] = await executor.insert(domainMemberships).values({
      id: crypto.randomUUID(),
      domain_id: current.id,
      user_id: ownerId,
      joined_at: now,
    }).onConflictDoUpdate({
      target: [domainMemberships.domain_id, domainMemberships.user_id],
      set: { status: "active", left_at: null },
    }).returning();
    await executor.insert(domainMemberRoles).values({
      membership_id: owner.id,
      role: "owner",
    }).onConflictDoNothing();
    const [root] = await executor.select().from(domainMemberships).where(
      and(
        eq(domainMemberships.domain_id, current.id),
        eq(domainMemberships.user_id, ROOT_USER_ID),
      ),
    );
    if (root) {
      await executor.delete(domainMemberRoles).where(
        eq(domainMemberRoles.membership_id, root.id),
      );
      await executor.update(domainMemberships).set({
        status: "removed",
        left_at: now,
      }).where(eq(domainMemberships.id, root.id));
    }
    await executor.update(domains).set({
      owner_id: ownerId,
      revision: current.revision + 1,
      updated_at: now,
    }).where(eq(domains.id, current.id));
    const [members] = await executor.select({ count: count() }).from(
      domainMemberships,
    ).where(
      and(
        eq(domainMemberships.domain_id, current.id),
        eq(domainMemberships.status, "active"),
      ),
    );
    await executor.insert(domainResourceCounters).values({
      domain_id: current.id,
      resource: "members",
      used: members.count,
    })
      .onConflictDoUpdate({
        target: [
          domainResourceCounters.domain_id,
          domainResourceCounters.resource,
        ],
        set: { used: members.count },
      });
    await workspaceAudit(executor, ownerId, current.id, "domain.transfer", {
      operation: "bootstrap_owner",
      previous_owner_id: ROOT_USER_ID,
      owner_id: ownerId,
    });
    return;
  }
  await executor.insert(domainLimits).values({ domain_id: inserted.id });
  const accounts = await executor.select({ id: users.id }).from(users).where(
    and(isNull(users.deleted_at), ne(users.id, ROOT_USER_ID)),
  );
  for (const account of accounts) {
    const [member] = await executor.insert(domainMemberships).values({
      id: crypto.randomUUID(),
      domain_id: inserted.id,
      user_id: account.id,
      joined_at: now,
    }).returning();
    await executor.insert(domainMemberRoles).values({
      membership_id: member.id,
      role: account.id === ownerId ? "owner" : "member",
    });
  }
  await executor.insert(domainResourceCounters).values(
    ["members", "problems", "storage_bytes"].map((resource) => ({
      domain_id: inserted.id,
      resource: resource as "members" | "problems" | "storage_bytes",
      used: resource === "members" ? accounts.length : 0,
    })),
  );
}

/** 修改必须携带旧 revision；模板应用调用相同的授权与修改入口。 */
export async function updateDomain(
  slug: string,
  actorId: string,
  revision: number,
  patch: {
    name?: string;
    description?: string;
    configuration?: DomainConfiguration;
  },
) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new AppError("缺少有效配置版本", 428, "REVISION_REQUIRED");
  }
  if (patch.configuration !== undefined) {
    validateDomainConfiguration(patch.configuration);
  }
  if (
    patch.name !== undefined &&
    (typeof patch.name !== "string" || !patch.name.trim() ||
      patch.name.length > 100)
  ) throw new BadRequestError("名称非法");
  if (
    patch.description !== undefined &&
    (typeof patch.description !== "string" || patch.description.length > 2000)
  ) throw new BadRequestError("简介非法");
  return await getDb().transaction(async (tx) => {
    const { domain, context } = await loadWorkspace(slug, actorId, {
      write: true,
      lock: true,
      executor: tx,
    });
    assertWorkspacePermission(context, "domain:settings");
    if (domain.revision !== revision) {
      throw new ConflictError("配置已被其他管理员更新");
    }
    const now = new Date().toISOString();
    if (patch.configuration) {
      const allowed = (await getInstanceResourcePolicy(tx)).modules;
      for (const key of Object.keys(allowed) as Array<keyof typeof allowed>) {
        if (
          patch.configuration.features[key] &&
          !domain.configuration.features[key] && !allowed[key]
        ) {
          throw new ForbiddenError(
            "实例未允许启用此模块",
            "DOMAIN_FEATURE_NOT_ALLOWED",
          );
        }
      }
      for (
        const feature of [
          "classroom",
          "assignment",
          "analytics",
          "community",
        ] as const
      ) {
        if (
          domain.configuration.features[feature] &&
          !patch.configuration.features[feature]
        ) {
          await tx.insert(domainFeatureIntervals).values({
            id: crypto.randomUUID(),
            domain_id: domain.id,
            feature,
            disabled_at: now,
          });
        }
        if (
          !domain.configuration.features[feature] &&
          patch.configuration.features[feature]
        ) {
          await tx.update(domainFeatureIntervals).set({ enabled_at: now })
            .where(
              and(
                eq(domainFeatureIntervals.domain_id, domain.id),
                eq(domainFeatureIntervals.feature, feature),
                isNull(domainFeatureIntervals.enabled_at),
              ),
            );
        }
      }
    }
    const [updated] = await tx.update(domains).set({
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.description === undefined
        ? {}
        : { description: patch.description }),
      ...(patch.configuration === undefined
        ? {}
        : { configuration: patch.configuration }),
      revision: domain.revision + 1,
      updated_at: now,
    }).where(eq(domains.id, domain.id)).returning();
    await workspaceAudit(tx, actorId, domain.id, "domain.update", {
      revision: updated.revision,
    });
    if (
      patch.configuration &&
      patch.configuration.access !== domain.configuration.access
    ) {
      await recordSourceDomainEducationChange(tx, domain.id);
    } else if (
      patch.configuration &&
      (["classroom", "assignment"] as const).some((feature) =>
        patch.configuration!.features[feature] !==
          domain.configuration.features[feature]
      )
    ) {
      await recordEducationEvent(tx, {
        domain_id: domain.id,
        event_type: "module.changed",
      });
    }
    return updated;
  });
}

/** 域生命周期只允许授权动作；默认域不能归档或停用。 */
export async function setDomainStatus(
  slug: string,
  actorId: string,
  status: "active" | "archived" | "suspended",
  revision: number,
) {
  if (!["active", "archived", "suspended"].includes(status)) {
    throw new BadRequestError("工作空间状态非法");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new AppError("缺少有效配置版本", 428, "REVISION_REQUIRED");
  }
  return await getDb().transaction(async (tx) => {
    const { domain, context, platformAdmin } = await loadWorkspace(
      slug,
      actorId,
      { lock: true, executor: tx },
    );
    if (status === "suspended" || domain.status === "suspended") {
      if (!platformAdmin) {
        throw new ForbiddenError("仅平台管理员可停用或恢复工作空间");
      }
    } else assertWorkspacePermission(context, "domain:archive");
    if (domain.slug === DEFAULT_DOMAIN_SLUG && status !== "active") {
      throw new ConflictError("默认工作空间不能归档或停用");
    }
    if (domain.revision !== revision) throw new ConflictError("配置已变化");
    const [updated] = await tx.update(domains).set({
      status,
      revision: domain.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(domains.id, domain.id)).returning();
    await workspaceAudit(tx, actorId, domain.id, "domain.status", {
      before: domain.status,
      after: status,
    });
    await recordSourceDomainEducationChange(tx, domain.id);
    return updated;
  });
}

/** 域目录仅返回可发现且当前可访问的条目，不暴露私有域存在性。 */
export async function listDomains(actorId: string | null, mine = false) {
  if (getInstanceAccessPolicy().access === "authenticated" && !actorId) {
    throw new ForbiddenError("此实例需要登录");
  }
  const db = getDb();
  const conditions = [sql`${domains.status} <> 'suspended'`];
  if (mine) {
    if (!actorId) throw new ForbiddenError("请先登录");
    conditions.push(
      sql`EXISTS (SELECT 1 FROM domain_memberships m WHERE m.domain_id = ${domains.id} AND m.user_id = ${actorId} AND m.status = 'active')`,
    );
  } else {conditions.push(
      sql`${domains.configuration}->>'discoverable' = 'true'`,
    );}
  return await db.select({
    id: domains.id,
    slug: domains.slug,
    name: domains.name,
    description: domains.description,
    status: domains.status,
  }).from(domains).where(and(...conditions)).orderBy(domains.slug).limit(100);
}
