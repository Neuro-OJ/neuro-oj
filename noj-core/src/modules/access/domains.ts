/** access 的工作空间生命周期与默认域 bootstrap。 */
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  domainLimits,
  domainMemberRoles,
  domainMemberships,
  domainResourceCounters,
  domains,
  users,
} from "../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/base/errors.ts";
import { ROOT_USER_ID } from "../../shared/base/constants.ts";
import type { DomainConfiguration, DomainPreset } from "./types.ts";
import type { SystemActor, UserActor } from "./contracts/actor.ts";
import { requireUserActor } from "./contracts/actor.ts";
import { type AccessAuditMeta, workspaceAuditTx } from "./audit.ts";
import { assertWorkspacePermission, loadWorkspaceTx } from "./policy.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  DOMAIN_PRESETS,
  presetConfiguration,
  validateDomainConfiguration,
  validateDomainSlug,
} from "./types.ts";
import {
  getAdminUserIds,
  getUserPermissions,
} from "./identity/services/security/permissions.ts";
import {
  getInstanceAccessPolicy,
  getInstanceResourcePolicy,
} from "./workspace/services/instance.ts";
import {
  combineDomainLimits,
  constrainDomainConfiguration,
} from "../../shared/workspace/resource-policy.ts";

export interface DomainWriteMeta extends AccessAuditMeta {}

export interface DomainChangeBoundary {
  /** education/read-model 等跨模块事实由 application 注入，不能省略。 */
  onAccessPolicyChangedTx: (tx: DbTx, domainId: string) => Promise<void>;
}

function validateCreateInput(input: {
  slug: string;
  name: string;
  preset: DomainPreset;
  description?: string;
}): void {
  validateDomainSlug(input.slug);
  if (
    typeof input.name !== "string" || !input.name.trim() ||
    input.name.length > 100 ||
    input.description !== undefined &&
      (typeof input.description !== "string" || input.description.length > 2000)
  ) throw new BadRequestError("工作空间名称或简介非法");
  if (!DOMAIN_PRESETS.includes(input.preset)) {
    throw new BadRequestError("域类型须为社区、教学或团队");
  }
}

/** 普通用户创建域；owner attribution 只能来自显式 UserActor。 */
export async function createDomainTx(
  tx: DbTx,
  actor: UserActor,
  input: {
    slug: string;
    name: string;
    preset: DomainPreset;
    description?: string;
  },
  options: { approved?: boolean; meta?: DomainWriteMeta } = {},
) {
  const user = requireUserActor(actor);
  validateCreateInput(input);
  const [account] = await tx.select({ id: users.id }).from(users).where(
    and(eq(users.id, user.userId), isNull(users.deleted_at)),
  ).for("update");
  if (!account) throw new NotFoundError("负责人账号不可用");
  const permissions = await getUserPermissions(user.userId, tx);
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
  const [owned] = await tx.select({ count: count() }).from(domains).where(
    eq(domains.owner_id, user.userId),
  );
  if (!platformAdmin && owned.count >= policy.domain_creation_limit) {
    throw new ForbiddenError(
      "已达到工作空间创建数量上限",
      "DOMAIN_CREATION_LIMIT",
    );
  }
  const resourcePolicy = await getInstanceResourcePolicy(tx);
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
  const now = new Date().toISOString();
  const [domain] = await tx.insert(domains).values({
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name.trim(),
    description: input.description ?? "",
    owner_id: user.userId,
    preset: input.preset,
    configuration: constrainDomainConfiguration(
      presetConfiguration(input.preset),
      resourcePolicy.modules,
    ),
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing({ target: domains.slug }).returning();
  if (!domain) throw new ConflictError("工作空间标识已存在");
  const [membership] = await tx.insert(domainMemberships).values({
    id: crypto.randomUUID(),
    domain_id: domain.id,
    user_id: user.userId,
    joined_at: now,
  }).returning();
  await tx.insert(domainMemberRoles).values({
    membership_id: membership.id,
    role: "owner",
  });
  await tx.insert(domainLimits).values({ domain_id: domain.id, ...limits });
  await tx.insert(domainResourceCounters).values(
    ["members", "problems", "storage_bytes"].map((resource) => ({
      domain_id: domain.id,
      resource: resource as "members" | "problems" | "storage_bytes",
      used: resource === "members" ? 1 : 0,
    })),
  );
  await workspaceAuditTx(tx, user, domain.id, "domain.create", {
    preset: input.preset,
  }, options.meta);
  return domain;
}

export function createDomain(
  actor: UserActor,
  input: {
    slug: string;
    name: string;
    preset: DomainPreset;
    description?: string;
  },
  options: { approved?: boolean; meta?: DomainWriteMeta } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) => createDomainTx(tx, actor, input, options));
}

/** 默认域只由 bootstrap/migration system actor 进入；普通 HTTP 无法调用。 */
export async function ensureDefaultWorkspaceTx(
  tx: DbTx,
  actor: SystemActor,
  meta: DomainWriteMeta = {},
): Promise<void> {
  if (
    actor.kind !== "system" ||
    !["bootstrap", "migration"].includes(actor.purpose)
  ) {
    throw new ForbiddenError("默认工作空间只能由 bootstrap/migration 初始化");
  }
  const [existing] = await tx.select().from(domains).where(
    eq(domains.slug, DEFAULT_DOMAIN_SLUG),
  );
  if (existing && existing.owner_id !== ROOT_USER_ID) return;
  const now = new Date().toISOString();
  const admins = await getAdminUserIds(tx);
  const candidates = [...admins].filter((id) => id !== ROOT_USER_ID);
  const [admin] = candidates.length
    ? await tx.select({ id: users.id }).from(users).where(and(
      inArray(users.id, candidates),
      isNull(users.deleted_at),
    )).orderBy(users.id).limit(1).for("update")
    : [];
  const ownerId = admin?.id ?? ROOT_USER_ID;
  const [inserted] = await tx.insert(domains).values({
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
    const [current] = await tx.select().from(domains).where(
      eq(domains.slug, DEFAULT_DOMAIN_SLUG),
    ).for("update");
    if (!current || current.owner_id !== ROOT_USER_ID) return;
    const [owner] = await tx.insert(domainMemberships).values({
      id: crypto.randomUUID(),
      domain_id: current.id,
      user_id: ownerId,
      joined_at: now,
    }).onConflictDoUpdate({
      target: [domainMemberships.domain_id, domainMemberships.user_id],
      set: { status: "active", left_at: null },
    }).returning();
    await tx.insert(domainMemberRoles).values({
      membership_id: owner.id,
      role: "owner",
    }).onConflictDoNothing();
    const [root] = await tx.select().from(domainMemberships).where(and(
      eq(domainMemberships.domain_id, current.id),
      eq(domainMemberships.user_id, ROOT_USER_ID),
    ));
    if (root) {
      await tx.delete(domainMemberRoles).where(
        eq(domainMemberRoles.membership_id, root.id),
      );
      await tx.update(domainMemberships).set({
        status: "removed",
        left_at: now,
      }).where(eq(domainMemberships.id, root.id));
    }
    await tx.update(domains).set({
      owner_id: ownerId,
      revision: current.revision + 1,
      updated_at: now,
    }).where(eq(domains.id, current.id));
    const [members] = await tx.select({ count: count() }).from(
      domainMemberships,
    )
      .where(and(
        eq(domainMemberships.domain_id, current.id),
        eq(domainMemberships.status, "active"),
      ));
    await tx.insert(domainResourceCounters).values({
      domain_id: current.id,
      resource: "members",
      used: members.count,
    }).onConflictDoUpdate({
      target: [
        domainResourceCounters.domain_id,
        domainResourceCounters.resource,
      ],
      set: { used: members.count },
    });
    await workspaceAuditTx(tx, actor, current.id, "domain.transfer", {
      operation: "bootstrap_owner",
      previous_owner_id: ROOT_USER_ID,
      owner_id: ownerId,
    }, meta);
    return;
  }
  await tx.insert(domainLimits).values({ domain_id: inserted.id });
  const accounts = await tx.select({ id: users.id }).from(users).where(and(
    isNull(users.deleted_at),
    ne(users.id, ROOT_USER_ID),
  ));
  for (const account of accounts) {
    const [member] = await tx.insert(domainMemberships).values({
      id: crypto.randomUUID(),
      domain_id: inserted.id,
      user_id: account.id,
      joined_at: now,
    }).returning();
    await tx.insert(domainMemberRoles).values({
      membership_id: member.id,
      role: account.id === ownerId ? "owner" : "member",
    });
  }
  await tx.insert(domainResourceCounters).values(
    ["members", "problems", "storage_bytes"].map((resource) => ({
      domain_id: inserted.id,
      resource: resource as "members" | "problems" | "storage_bytes",
      used: resource === "members" ? accounts.length : 0,
    })),
  );
}

export async function ensureDefaultWorkspace(
  actor: SystemActor,
  meta: DomainWriteMeta = {},
): Promise<void> {
  const db: DbRoot = getDb();
  await db.transaction((tx) => ensureDefaultWorkspaceTx(tx, actor, meta));
}

export async function updateDomainTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  revision: number,
  patch: {
    name?: string;
    description?: string;
    configuration?: Partial<DomainConfiguration>;
  },
  options: DomainChangeBoundary & { meta?: DomainWriteMeta },
) {
  const user = requireUserActor(actor);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new AppError("缺少有效配置版本", 428, "REVISION_REQUIRED");
  }
  if (
    patch.configuration !== undefined &&
    (!patch.configuration || typeof patch.configuration !== "object" ||
      Array.isArray(patch.configuration))
  ) throw new BadRequestError("域配置须为对象");
  if (
    patch.name !== undefined &&
    (typeof patch.name !== "string" || !patch.name.trim() ||
      patch.name.length > 100)
  ) throw new BadRequestError("名称非法");
  if (
    patch.description !== undefined &&
    (typeof patch.description !== "string" || patch.description.length > 2000)
  ) throw new BadRequestError("简介非法");
  const { domain, context } = await loadWorkspaceTx(tx, slug, user, {
    write: true,
    lock: true,
  });
  assertWorkspacePermission(context, "domain:settings");
  if (domain.revision !== revision) {
    throw new ConflictError("配置已被其他管理员更新");
  }
  let configuration: DomainConfiguration | undefined;
  if (patch.configuration) {
    const resourcePolicy = await getInstanceResourcePolicy(tx);
    const fixed = constrainDomainConfiguration(
      domain.configuration,
      resourcePolicy.modules,
    );
    if (
      patch.configuration.features &&
        Object.keys(fixed.features).some((key) =>
          patch.configuration!.features![key as keyof typeof fixed.features] !==
            fixed.features[key as keyof typeof fixed.features]
        ) ||
      patch.configuration.homepage !== undefined &&
        patch.configuration.homepage !== fixed.homepage
    ) {
      throw new BadRequestError(
        "域能力和首页由固定类型决定",
        "DOMAIN_TYPE_FIXED",
      );
    }
    configuration = {
      ...domain.configuration,
      access: patch.configuration.access ?? domain.configuration.access,
      discoverable: patch.configuration.discoverable ??
        domain.configuration.discoverable,
      join_policy: patch.configuration.join_policy ??
        domain.configuration.join_policy,
    };
    validateDomainConfiguration(configuration);
  }
  const [updated] = await tx.update(domains).set({
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    ...(patch.description === undefined
      ? {}
      : { description: patch.description }),
    ...(configuration === undefined ? {} : { configuration }),
    revision: domain.revision + 1,
    updated_at: new Date().toISOString(),
  }).where(eq(domains.id, domain.id)).returning();
  await workspaceAuditTx(tx, user, domain.id, "domain.update", {
    revision: updated.revision,
  }, options.meta);
  if (configuration && configuration.access !== domain.configuration.access) {
    await options.onAccessPolicyChangedTx(tx, domain.id);
  }
  return updated;
}

export function updateDomain(
  actor: UserActor,
  slug: string,
  revision: number,
  patch: {
    name?: string;
    description?: string;
    configuration?: Partial<DomainConfiguration>;
  },
  options: DomainChangeBoundary & { meta?: DomainWriteMeta },
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    updateDomainTx(tx, actor, slug, revision, patch, options)
  );
}

export async function setDomainStatusTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  status: "active" | "archived" | "suspended",
  revision: number,
  options: DomainChangeBoundary & { meta?: DomainWriteMeta },
) {
  const user = requireUserActor(actor);
  if (!["active", "archived", "suspended"].includes(status)) {
    throw new BadRequestError("工作空间状态非法");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new AppError("缺少有效配置版本", 428, "REVISION_REQUIRED");
  }
  const { domain, context, platformAdmin } = await loadWorkspaceTx(
    tx,
    slug,
    user,
    {
      lock: true,
    },
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
  await workspaceAuditTx(tx, user, domain.id, "domain.status", {
    before: domain.status,
    after: status,
  }, options.meta);
  await options.onAccessPolicyChangedTx(tx, domain.id);
  return updated;
}

export function setDomainStatus(
  actor: UserActor,
  slug: string,
  status: "active" | "archived" | "suspended",
  revision: number,
  options: DomainChangeBoundary & { meta?: DomainWriteMeta },
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    setDomainStatusTx(tx, actor, slug, status, revision, options)
  );
}

export async function listDomains(actor: UserActor | null, mine = false) {
  if (!actor && getInstanceAccessPolicy().access === "authenticated") {
    throw new ForbiddenError("此实例需要登录");
  }
  const db = getDb();
  const conditions = [sql`${domains.status} <> 'suspended'`];
  if (mine) {
    if (!actor) throw new ForbiddenError("请先登录");
    const user = requireUserActor(actor);
    conditions.push(
      sql`EXISTS (SELECT 1 FROM domain_memberships m WHERE m.domain_id = ${domains.id} AND m.user_id = ${user.userId} AND m.status = 'active')`,
    );
  } else {
    conditions.push(sql`${domains.configuration}->>'discoverable' = 'true'`);
  }
  return await db.select({
    id: domains.id,
    slug: domains.slug,
    name: domains.name,
    description: domains.description,
    status: domains.status,
  }).from(domains).where(and(...conditions)).orderBy(domains.slug).limit(100);
}
