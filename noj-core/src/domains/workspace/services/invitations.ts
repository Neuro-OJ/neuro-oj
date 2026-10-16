import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  classroomMemberships,
  domainInvitationRedemptions,
  domainInvitations,
  domainMemberships,
  domains,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { assertWorkspacePermission, loadWorkspace } from "./access.ts";
import { addDomainMember } from "./members.ts";
import { workspaceAudit } from "./domains.ts";
import { getInstanceAccessPolicy } from "./instance.ts";
import { getEmailConfigStatus, getSetting } from "../../system/index.ts";
import { lockActiveWorkspaceAccount } from "./account-lifecycle.ts";
import {
  assertClassroomInvitationIssuer,
  joinInvitedClassroom,
} from "../../education/index.ts";

/** 邀请创建输入，旧调用方传邮箱时仍表示指定邮箱邀请。 */
export interface DomainInvitationInput {
  mode?: "email" | "general" | "once";
  email?: string;
  expires_at?: string;
  max_uses?: number | null;
}

/** 链接令牌与分组短码共用兑换路径，不将凭据放入 API URL。 */
export function isInvitationCredential(value: unknown): value is string {
  return typeof value === "string" &&
    (/^[0-9a-f-]{72}$/.test(value) ||
      /^[2-9A-HJ-NP-Z]{12}$/.test(
        value.replaceAll("-", "").trim().toUpperCase(),
      ));
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

/** 邀请目录统一字段，永不包含原始凭据或摘要。 */
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

/** 签发者退出或失去邀请能力后，旧链接也不能继续增加成员。 */
async function assertInvitationIssuerActive(
  slug: string,
  userId: string,
  executor: Executor,
  classroomId: string | null = null,
) {
  try {
    const issuer = await loadWorkspace(slug, userId, { executor });
    const classroom = classroomId
      ? await assertClassroomInvitationIssuer(
        slug,
        classroomId,
        userId,
        executor,
      )
      : null;
    if (
      !classroomId &&
      !issuer.platformAdmin &&
      !issuer.context.domainPermissions.has("domain:invitations")
    ) throw new NotFoundError("邀请无效或已失效");
    return {
      platform_admin: issuer.platformAdmin,
      domain_inviter: issuer.context.domainPermissions.has(
        "domain:invitations",
      ),
      classroom_name: classroom?.name,
    };
  } catch (error) {
    if (
      error instanceof AppError && [401, 403, 404].includes(error.statusCode)
    ) throw new NotFoundError("邀请无效或已失效");
    throw error;
  }
}

/** 邀请目录只返回管理所需字段，永不返回令牌或哈希。 */
export async function listDomainInvitations(
  slug: string,
  actorId: string,
  pagination = { offset: 0, perPage: 25 },
) {
  const { domain, context } = await loadWorkspace(slug, actorId);
  assertWorkspacePermission(context, "domain:invitations");
  const where = and(
    eq(domainInvitations.domain_id, domain.id),
    isNull(domainInvitations.classroom_id),
  );
  const [total] = await getDb().select({ count: count() }).from(
    domainInvitations,
  ).where(where);
  const data = await getDb().select(invitationListColumns).from(
    domainInvitations,
  ).where(where)
    .orderBy(desc(domainInvitations.created_at), domainInvitations.id).limit(
      pagination.perPage,
    ).offset(pagination.offset);
  return { data, total: total.count };
}

/** 持有有效邀请可预览限定的加入信息；使用请求体，避免令牌进入 API URL。 */
export async function previewDomainInvitation(
  token: string,
  executor: Executor = getDb(),
) {
  const credential = await credentialWhere(token);
  const [row] = await executor.select({
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
  const authority = await assertInvitationIssuerActive(
    row.domain.slug,
    row.invite.created_by,
    executor,
    row.invite.classroom_id,
  );
  const policy = getInstanceAccessPolicy();
  const canRegister = getSetting("allow_register")?.value !== false &&
    getEmailConfigStatus().configured &&
    policy.registration_mode !== "admin_only" &&
    (policy.registration_mode === "open" ||
      policy.allow_domain_registration_invites && authority.domain_inviter ||
      authority.platform_admin);
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
        classroom_name: authority.classroom_name,
      }
      : {}),
  };
}

/** 邀请令牌不可逆摘要，不把令牌写入审计或列表。 */
export async function hashInvitationToken(token: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 邀请注册仅由实例政策允许的平台或域邀请管理员签发，班级权限不能绕过。 */
export async function assertInvitationAccountRegistration(
  token: string,
  executor: Executor,
) {
  const credential = await credentialWhere(token);
  const [row] = await executor.select({
    invite: domainInvitations,
    domain: domains,
  })
    .from(domainInvitations).innerJoin(
      domains,
      eq(domains.id, domainInvitations.domain_id),
    )
    .where(credential);
  if (!row) {
    throw new ForbiddenError("注册邀请无效", "REGISTER_INVITATION_INVALID");
  }
  const authority = await assertInvitationIssuerActive(
    row.domain.slug,
    row.invite.created_by,
    executor,
    row.invite.classroom_id,
  );
  const policy = getInstanceAccessPolicy();
  if (
    !authority.platform_admin &&
    (!policy.allow_domain_registration_invites || !authority.domain_inviter)
  ) {
    throw new ForbiddenError(
      "签发者没有邀请注册账号的授权",
      "REGISTER_INVITATION_UNAUTHORIZED",
    );
  }
}

/** 创建三种邀请，链接和短码只在创建响应出现一次。 */
export async function createDomainInvitation(
  slug: string,
  actorId: string,
  input: string | DomainInvitationInput,
  options: { classroomId?: string; executor?: Executor } = {},
) {
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
  const expiresAt = new Date(expiry).toISOString();
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await hashInvitationToken(token);
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const code = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (byte) => alphabet[byte % 32],
  ).join("");
  const codeHash = await hashInvitationToken(code);
  const write = async (tx: Executor) => {
    const { domain, context } = await loadWorkspace(slug, actorId, {
      write: true,
      lock: true,
      executor: tx,
    });
    if (options.classroomId) {
      await assertClassroomInvitationIssuer(
        slug,
        options.classroomId,
        actorId,
        tx,
      );
    } else assertWorkspacePermission(context, "domain:invitations");
    const id = crypto.randomUUID();
    await tx.insert(domainInvitations).values({
      id,
      domain_id: domain.id,
      classroom_id: options.classroomId ?? null,
      token_hash: tokenHash,
      code_hash: codeHash,
      mode,
      email,
      max_uses: maxUses,
      expires_at: expiresAt,
      created_by: actorId,
      created_at: new Date().toISOString(),
    });
    await workspaceAudit(tx, actorId, domain.id, "domain.invite_create", {
      invitation_id: id,
    });
    return {
      id,
      token,
      code: code.match(/.{4}/g)!.join("-"),
      mode,
      max_uses: maxUses,
      expires_at: expiresAt,
    };
  };
  return options.executor
    ? await write(options.executor)
    : await getDb().transaction(write);
}

/** 授权邀请消费参与调用方事务，账号和域关系能同时提交或回滚。 */
export async function consumeDomainInvitation(
  token: string,
  userId: string,
  executor?: Executor,
): Promise<{ domain_id: string; domain_slug: string }> {
  if (!executor) {
    return await getDb().transaction((tx) =>
      consumeDomainInvitation(token, userId, tx)
    );
  }
  const credential = await credentialWhere(token);
  const [found] = await executor.select({
    domain_id: domainInvitations.domain_id,
  }).from(domainInvitations).where(credential);
  if (!found) throw new NotFoundError("邀请无效");
  const user = await lockActiveWorkspaceAccount(executor, userId);
  const [domain] = await executor.select().from(domains).where(
    and(eq(domains.id, found.domain_id), eq(domains.status, "active")),
  ).for("update");
  const [invite] = await executor.select().from(domainInvitations).where(
    and(
      credential,
      isNull(domainInvitations.revoked_at),
    ),
  ).for("update");
  if (
    !domain || !invite || !user ||
    invite.mode === "email" && invite.email !== user.email.toLowerCase()
  ) throw new NotFoundError("邀请无效、过期或不属于此账号");
  const result = {
    domain_id: domain.id,
    domain_slug: domain.slug,
    ...(invite.classroom_id ? { classroom_id: invite.classroom_id } : {}),
  };
  const [redeemed] = await executor.select().from(domainInvitationRedemptions)
    .where(and(
      eq(domainInvitationRedemptions.invitation_id, invite.id),
      eq(domainInvitationRedemptions.user_id, userId),
    ));
  if (redeemed) return result;
  if (
    Date.parse(invite.expires_at) <= Date.now() ||
    invite.max_uses !== null && invite.used_count >= invite.max_uses
  ) throw new NotFoundError("邀请已过期或使用人数已满");
  await assertInvitationIssuerActive(
    domain.slug,
    invite.created_by,
    executor,
    invite.classroom_id,
  );
  const [existing] = invite.classroom_id
    ? await executor.select({ status: classroomMemberships.status }).from(
      classroomMemberships,
    ).where(
      and(
        eq(classroomMemberships.classroom_id, invite.classroom_id),
        eq(classroomMemberships.user_id, userId),
      ),
    )
    : await executor.select({ status: domainMemberships.status }).from(
      domainMemberships,
    ).where(
      and(
        eq(domainMemberships.domain_id, domain.id),
        eq(domainMemberships.user_id, userId),
      ),
    );
  if (existing?.status === "active") return result;
  await addDomainMember(executor, domain.id, userId, true);
  if (invite.classroom_id) {
    await joinInvitedClassroom(
      executor,
      domain.id,
      invite.classroom_id,
      userId,
    );
  }
  const now = new Date().toISOString();
  await executor.insert(domainInvitationRedemptions).values({
    invitation_id: invite.id,
    user_id: userId,
    redeemed_at: now,
  });
  await executor.update(domainInvitations).set({
    used_count: invite.used_count + 1,
    used_at: now,
  }).where(eq(domainInvitations.id, invite.id));
  await workspaceAudit(executor, userId, domain.id, "domain.invite_accept", {
    invitation_id: invite.id,
  });
  return result;
}

/** 撤销不会删除既有成员或邀请审计。 */
export async function revokeDomainInvitation(
  slug: string,
  actorId: string,
  invitationId: string,
  options: { classroomId?: string } = {},
) {
  return await getDb().transaction(async (tx) => {
    const { domain, context } = await loadWorkspace(slug, actorId, {
      write: true,
      lock: true,
      executor: tx,
    });
    if (options.classroomId) {
      await assertClassroomInvitationIssuer(
        slug,
        options.classroomId,
        actorId,
        tx,
      );
    } else assertWorkspacePermission(context, "domain:invitations");
    const [invite] = await tx.update(domainInvitations).set({
      revoked_at: new Date().toISOString(),
    }).where(
      and(
        eq(domainInvitations.id, invitationId),
        eq(domainInvitations.domain_id, domain.id),
        options.classroomId
          ? eq(domainInvitations.classroom_id, options.classroomId)
          : undefined,
        isNull(domainInvitations.revoked_at),
      ),
    ).returning({ id: domainInvitations.id });
    if (!invite) throw new NotFoundError("邀请不存在或已使用");
    await workspaceAudit(tx, actorId, domain.id, "domain.invite_revoke", {
      invitation_id: invitationId,
    });
    return invite;
  });
}

/** 公开注册政策检查不会把已有账号的密码或角色交给域管理员。 */
export function assertInvitationRegistrationAllowed(
  mode: string,
  domainInvitesAllowed: boolean,
  hasInvitation: boolean,
) {
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
