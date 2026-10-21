/** access 的域邀请事实与兑换流程。 */
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  domainInvitationRedemptions,
  domainInvitations,
  domains,
  users,
} from "../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/base/errors.ts";
import { getEmailConfigStatus } from "../platform/contracts/cross-module/system_services_email-status.ts";
import { getSetting } from "../platform/contracts/cross-module/services_system-settings.ts";
import { getInstanceAccessPolicy } from "../platform/contracts/resource-policy.ts";
import {
  type UserActor,
  userActorFromAuthenticatedId,
} from "./contracts/actor.ts";
import { workspaceAuditTx } from "./audit.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  loadWorkspaceTx,
  requireWorkspaceUser,
} from "./policy.ts";
import { type AccessWriteMeta, addDomainMemberTx } from "./members.ts";

export interface DomainInvitationInput {
  mode?: "email" | "general" | "once";
  email?: string;
  expires_at?: string;
  max_uses?: number | null;
}

export const invitationListColumns = {
  id: domainInvitations.id,
  classroom_id: domainInvitations.classroom_id,
  mode: domainInvitations.mode,
  email: domainInvitations.email,
  max_uses: domainInvitations.max_uses,
  used_count: domainInvitations.used_count,
  expires_at: domainInvitations.expires_at,
  used_at: domainInvitations.used_at,
  revoked_at: domainInvitations.revoked_at,
  created_at: domainInvitations.created_at,
};

/** 链接令牌与分组短码共用兑换路径，不把凭据放进 API URL。 */
export function isInvitationCredential(value: unknown): value is string {
  return typeof value === "string" &&
    (/^[0-9a-f-]{72}$/.test(value) ||
      /^[2-9A-HJ-NP-Z]{12}$/.test(
        value.replaceAll("-", "").trim().toUpperCase(),
      ));
}

export async function hashInvitationToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function credentialWhere(value: string) {
  if (!isInvitationCredential(value)) {
    throw new NotFoundError("邀请无效或已失效");
  }
  return /^[0-9a-f-]{72}$/.test(value)
    ? eq(domainInvitations.token_hash, await hashInvitationToken(value))
    : eq(
      domainInvitations.code_hash,
      await hashInvitationToken(value.replaceAll("-", "").trim().toUpperCase()),
    );
}

export interface ClassroomInvitationBoundary {
  /** 由 application 注入的班级签发者授权检查。 */
  assertIssuerTx?: (
    tx: DbTx,
    slug: string,
    classroomId: string,
    actor: UserActor,
  ) => Promise<{ classroomName?: string } | void>;
  /** 由 application 注入的班级成员事实写入。 */
  joinTx?: (
    tx: DbTx,
    domainId: string,
    classroomId: string,
    actor: UserActor,
  ) => Promise<void>;
}

async function previewDomainInvitationTx(
  tx: DbTx,
  token: string,
  options: ClassroomInvitationBoundary = {},
) {
  const credential = await credentialWhere(token);
  const [row] = await tx.select({
    invite: domainInvitations,
    domain: domains,
  }).from(domainInvitations).innerJoin(
    domains,
    eq(domains.id, domainInvitations.domain_id),
  ).where(and(
    credential,
    isNull(domainInvitations.revoked_at),
    eq(domains.status, "active"),
  ));
  if (
    !row || !Number.isFinite(Date.parse(row.invite.expires_at)) ||
    Date.parse(row.invite.expires_at) <= Date.now() ||
    row.invite.max_uses !== null && row.invite.used_count >= row.invite.max_uses
  ) throw new NotFoundError("邀请无效或已失效");

  let classroomName: string | undefined;
  if (row.invite.classroom_id) {
    if (!options.assertIssuerTx) throw new NotFoundError("邀请无效或已失效");
    try {
      classroomName = (await options.assertIssuerTx(
        tx,
        row.domain.slug,
        row.invite.classroom_id,
        userActorFromAuthenticatedId(row.invite.created_by),
      ))?.classroomName;
    } catch (error) {
      if (
        error instanceof AppError &&
        [401, 403, 404].includes(error.statusCode)
      ) throw new NotFoundError("邀请无效或已失效");
      throw error;
    }
  } else {
    await assertInvitationIssuerActiveTx(
      tx,
      row.domain.slug,
      row.invite.created_by,
    );
  }

  const authority = await loadWorkspaceTx(
    tx,
    row.domain.slug,
    userActorFromAuthenticatedId(row.invite.created_by),
  );
  const policy = getInstanceAccessPolicy();
  const canRegister = getSetting("allow_register")?.value !== false &&
    getEmailConfigStatus().configured &&
    policy.registration_mode !== "admin_only" &&
    (policy.registration_mode === "open" &&
        policy.allow_domain_registration_invites &&
        authority.context.domainPermissions.has("domain:invitations") ||
      authority.platformAdmin);
  return {
    domain_slug: row.domain.slug,
    domain_name: row.domain.name,
    email: row.invite.email,
    mode: row.invite.mode,
    max_uses: row.invite.max_uses,
    used_count: row.invite.used_count,
    expires_at: row.invite.expires_at,
    can_register: canRegister,
    ...(row.invite.classroom_id
      ? {
        classroom_id: row.invite.classroom_id,
        classroom_name: classroomName,
      }
      : {}),
  };
}

/** 公开邀请预览；班级授权由 application 注入，不能在 access 内猜测教学事实。 */
export function previewDomainInvitation(
  token: string,
  options: ClassroomInvitationBoundary = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) => previewDomainInvitationTx(tx, token, options));
}

function validateInvitationInput(input: string | DomainInvitationInput) {
  const config = typeof input === "string" ? { email: input } : input;
  const mode = config.mode ?? "email";
  if (!["email", "general", "once"].includes(mode)) {
    throw new BadRequestError("邀请类型非法");
  }
  const email = mode === "email" ? config.email?.trim().toLowerCase() : null;
  if (
    mode === "email" &&
    (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  ) throw new BadRequestError("邀请邮箱非法");
  if (mode !== "email" && config.email) {
    throw new BadRequestError("通用及一次性邀请不绑定邮箱");
  }
  const maxUses = mode === "general" ? config.max_uses ?? null : 1;
  if (
    maxUses !== null &&
    (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 2147483647)
  ) throw new BadRequestError("使用人数须为正整数或不限人数");
  if (mode !== "general" && config.max_uses != null && config.max_uses !== 1) {
    throw new BadRequestError("指定邮箱和一次性邀请仅限一人使用");
  }
  const expiry = config.expires_at === undefined
    ? Date.now() + 7 * 86400000
    : Date.parse(config.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new BadRequestError("邀请到期时间须晚于当前时间");
  }
  return {
    mode,
    email,
    maxUses,
    expiresAt: new Date(expiry).toISOString(),
  } as const;
}

function createToken(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

function createCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (byte) => alphabet[byte % alphabet.length],
  ).join("");
}

/** 创建邀请；令牌只在返回值中出现一次，事务内写入审计。 */
export async function createDomainInvitationTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  input: string | DomainInvitationInput,
  options: ClassroomInvitationBoundary & {
    classroomId?: string;
    meta?: AccessWriteMeta;
  } = {},
) {
  const user = requireWorkspaceUser(actor);
  const config = validateInvitationInput(input);
  const { domain, context } = await loadWorkspaceTx(tx, slug, user, {
    write: true,
    lock: true,
  });
  if (options.classroomId) {
    if (!options.assertIssuerTx) {
      throw new ForbiddenError("班级邀请必须通过教学授权入口");
    }
    await options.assertIssuerTx(tx, slug, options.classroomId, user);
  } else {
    assertWorkspacePermission(context, "domain:invitations");
  }
  const token = createToken();
  const code = createCode();
  const id = crypto.randomUUID();
  await tx.insert(domainInvitations).values({
    id,
    domain_id: domain.id,
    classroom_id: options.classroomId ?? null,
    token_hash: await hashInvitationToken(token),
    code_hash: await hashInvitationToken(code),
    mode: config.mode,
    email: config.email,
    max_uses: config.maxUses,
    expires_at: config.expiresAt,
    created_by: user.userId,
    created_at: new Date().toISOString(),
  });
  await workspaceAuditTx(tx, user, domain.id, "domain.invite_create", {
    invitation_id: id,
    ...(options.classroomId ? { classroom_id: options.classroomId } : {}),
  }, options.meta);
  return {
    id,
    token,
    code: code.match(/.{4}/g)!.join("-"),
    mode: config.mode,
    max_uses: config.maxUses,
    expires_at: config.expiresAt,
  };
}

export function createDomainInvitation(
  actor: UserActor,
  slug: string,
  input: string | DomainInvitationInput,
  options: ClassroomInvitationBoundary & {
    classroomId?: string;
    meta?: AccessWriteMeta;
  } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    createDomainInvitationTx(tx, actor, slug, input, options)
  );
}

/**
 * 邀请签发者的开户授权事实（只读，复用调用方事务）。
 *
 * 与 `consumeDomainInvitationTx` 分离：开户发生在账号已插入、成员尚未加入的
 * 注册事务里，需要先判断签发者是否具备“邀请新账号”的平台/域权限；班级邀请
 * 的签发者授权由 application 注入的 classroom 边界核验，教学能力本身不等于
 * 开户能力。
 */
export async function loadInvitationAccountAuthorityTx(
  tx: DbTx,
  token: string,
  options: ClassroomInvitationBoundary = {},
): Promise<
  | {
    domainSlug: string;
    classroomId: string | null;
    platformAdmin: boolean;
    domainInviter: boolean;
  }
  | null
> {
  const credential = await credentialWhere(token);
  const [invite] = await tx.select().from(domainInvitations).where(and(
    credential,
    isNull(domainInvitations.revoked_at),
  )).for("update");
  if (!invite) return null;
  const [domain] = await tx.select().from(domains).where(and(
    eq(domains.id, invite.domain_id),
    eq(domains.status, "active"),
  )).for("update");
  if (!domain) return null;
  if (
    Date.parse(invite.expires_at) <= Date.now() ||
    invite.max_uses !== null && invite.used_count >= invite.max_uses
  ) return null;
  try {
    if (invite.classroom_id) {
      if (!options.assertIssuerTx) return null;
      await options.assertIssuerTx(
        tx,
        domain.slug,
        invite.classroom_id,
        userActorFromAuthenticatedId(invite.created_by),
      );
    }
    const issuer = await loadWorkspaceTx(
      tx,
      domain.slug,
      userActorFromAuthenticatedId(invite.created_by),
    );
    if (invite.classroom_id) {
      // 班级签发者的域邀请权限仍需真实解析；没有该权限时不能开新账号。
      return {
        domainSlug: domain.slug,
        classroomId: invite.classroom_id,
        platformAdmin: issuer.platformAdmin,
        domainInviter: issuer.context.domainPermissions.has(
          "domain:invitations",
        ),
      };
    }
    const domainInviter = issuer.context.domainPermissions.has(
      "domain:invitations",
    );
    if (!issuer.platformAdmin && !domainInviter) return null;
    return {
      domainSlug: domain.slug,
      classroomId: null,
      platformAdmin: issuer.platformAdmin,
      domainInviter,
    };
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      return null;
    }
    throw error;
  }
}

async function assertInvitationIssuerActiveTx(
  tx: DbTx,
  domainSlug: string,
  issuerId: string,
): Promise<void> {
  try {
    const issuer = await loadWorkspaceTx(
      tx,
      domainSlug,
      userActorFromAuthenticatedId(issuerId),
    );
    if (
      !issuer.platformAdmin &&
      !issuer.context.domainPermissions.has("domain:invitations")
    ) throw new NotFoundError("邀请无效或已失效");
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      throw new NotFoundError("邀请无效或已失效");
    }
    throw error;
  }
}

/** 消费邀请的域成员、兑换记录和计数在同一个 DbTx 中提交。 */
export async function consumeDomainInvitationTx(
  tx: DbTx,
  actor: UserActor,
  token: string,
  options: ClassroomInvitationBoundary & { meta?: AccessWriteMeta } = {},
): Promise<{ domain_id: string; domain_slug: string; classroom_id?: string }> {
  const user = requireWorkspaceUser(actor);
  const credential = await credentialWhere(token);
  const [found] = await tx.select({ domain_id: domainInvitations.domain_id })
    .from(domainInvitations).where(credential);
  if (!found) throw new NotFoundError("邀请无效");
  const [account] = await tx.select().from(users).where(
    and(eq(users.id, user.userId), isNull(users.deleted_at)),
  ).for("update");
  if (!account) throw new NotFoundError("成员账号不可用");
  const [domain] = await tx.select().from(domains).where(and(
    eq(domains.id, found.domain_id),
    eq(domains.status, "active"),
  )).for("update");
  const [invite] = await tx.select().from(domainInvitations).where(and(
    credential,
    isNull(domainInvitations.revoked_at),
  )).for("update");
  if (
    !domain || !invite ||
    invite.mode === "email" && invite.email !== account.email.toLowerCase()
  ) throw new NotFoundError("邀请无效、过期或不属于此账号");
  const result = {
    domain_id: domain.id,
    domain_slug: domain.slug,
    ...(invite.classroom_id ? { classroom_id: invite.classroom_id } : {}),
  };
  const [redeemed] = await tx.select().from(domainInvitationRedemptions).where(
    and(
      eq(domainInvitationRedemptions.invitation_id, invite.id),
      eq(domainInvitationRedemptions.user_id, user.userId),
    ),
  );
  if (redeemed) return result;
  if (
    Date.parse(invite.expires_at) <= Date.now() ||
    invite.max_uses !== null && invite.used_count >= invite.max_uses
  ) throw new NotFoundError("邀请已过期或使用人数已满");
  if (invite.classroom_id) {
    const assertIssuerTx = options.assertIssuerTx;
    const joinTx = options.joinTx;
    if (!assertIssuerTx || !joinTx) {
      throw new ForbiddenError("班级邀请必须通过教学写入入口");
    }
    // 班级邀请的签发者权限由课堂能力决定；教师不需要域级邀请权限。
    try {
      await assertIssuerTx(
        tx,
        domain.slug,
        invite.classroom_id,
        userActorFromAuthenticatedId(invite.created_by),
      );
    } catch (error) {
      // 失效班级、撤职和能力撤销对公开兑换路径统一表现为不存在，
      // 避免把签发者当前教学状态泄露给持有旧令牌的调用方。
      if (
        error instanceof AppError &&
        [401, 403, 404].includes(error.statusCode)
      ) throw new NotFoundError("邀请无效或已失效");
      throw error;
    }
  } else {
    await assertInvitationIssuerActiveTx(tx, domain.slug, invite.created_by);
  }
  await addDomainMemberTx(tx, user, domain.id, user.userId, true, options.meta);
  if (invite.classroom_id) {
    await options.joinTx!(tx, domain.id, invite.classroom_id, user);
  }
  const now = new Date().toISOString();
  await tx.insert(domainInvitationRedemptions).values({
    invitation_id: invite.id,
    user_id: user.userId,
    redeemed_at: now,
  });
  await tx.update(domainInvitations).set({
    used_count: invite.used_count + 1,
    used_at: now,
  }).where(eq(domainInvitations.id, invite.id));
  await workspaceAuditTx(tx, user, domain.id, "domain.invite_accept", {
    invitation_id: invite.id,
  }, options.meta);
  return result;
}

export function consumeDomainInvitation(
  actor: UserActor,
  token: string,
  options: ClassroomInvitationBoundary & { meta?: AccessWriteMeta } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    consumeDomainInvitationTx(tx, actor, token, options)
  );
}

export async function revokeDomainInvitationTx(
  tx: DbTx,
  actor: UserActor,
  slug: string,
  invitationId: string,
  options: ClassroomInvitationBoundary & {
    classroomId?: string;
    meta?: AccessWriteMeta;
  } = {},
) {
  const user = requireWorkspaceUser(actor);
  const { domain, context } = await loadWorkspaceTx(tx, slug, user, {
    write: true,
    lock: true,
  });
  if (options.classroomId) {
    if (!options.assertIssuerTx) {
      throw new ForbiddenError("班级邀请必须通过教学授权入口");
    }
    await options.assertIssuerTx(tx, slug, options.classroomId, user);
  } else {
    assertWorkspacePermission(context, "domain:invitations");
  }
  const [invite] = await tx.update(domainInvitations).set({
    revoked_at: new Date().toISOString(),
  }).where(and(
    eq(domainInvitations.id, invitationId),
    eq(domainInvitations.domain_id, domain.id),
    options.classroomId
      ? eq(domainInvitations.classroom_id, options.classroomId)
      : undefined,
    isNull(domainInvitations.revoked_at),
  )).returning({ id: domainInvitations.id });
  if (!invite) throw new NotFoundError("邀请不存在或已使用");
  await workspaceAuditTx(tx, user, domain.id, "domain.invite_revoke", {
    invitation_id: invitationId,
  }, options.meta);
  return invite;
}

export function revokeDomainInvitation(
  actor: UserActor,
  slug: string,
  invitationId: string,
  options: ClassroomInvitationBoundary & {
    classroomId?: string;
    meta?: AccessWriteMeta;
  } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    revokeDomainInvitationTx(tx, actor, slug, invitationId, options)
  );
}

export async function listDomainInvitations(
  actor: UserActor,
  slug: string,
  pagination = { offset: 0, perPage: 25 },
) {
  const user = requireWorkspaceUser(actor);
  const { domain, context } = await loadWorkspace(slug, user);
  assertWorkspacePermission(context, "domain:invitations");
  const where = and(
    eq(domainInvitations.domain_id, domain.id),
    isNull(domainInvitations.classroom_id),
  );
  const db = getDb();
  const [total] = await db.select({ count: count() }).from(domainInvitations)
    .where(where);
  const data = await db.select(invitationListColumns).from(domainInvitations)
    .where(where).orderBy(
      desc(domainInvitations.created_at),
      domainInvitations.id,
    )
    .limit(pagination.perPage).offset(pagination.offset);
  return { data, total: total.count };
}

export function assertInvitationRegistrationAllowed(
  mode: string,
  domainInvitesAllowed: boolean,
  hasInvitation: boolean,
): void {
  if (mode === "admin_only") {
    throw new ForbiddenError("账号由平台管理员管理", "REGISTER_ADMIN_ONLY");
  }
  if (mode === "invite" && (!domainInvitesAllowed || !hasInvitation)) {
    throw new ForbiddenError(
      "需要有效注册邀请",
      "REGISTER_INVITATION_REQUIRED",
    );
  }
}
