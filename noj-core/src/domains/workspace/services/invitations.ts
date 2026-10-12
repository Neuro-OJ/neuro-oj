import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainInvitations,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { assertWorkspacePermission, loadWorkspace } from "./access.ts";
import { addDomainMember } from "./members.ts";
import { workspaceAudit } from "./domains.ts";

/** 邀请令牌不可逆摘要，不把令牌写入审计或列表。 */
export async function hashInvitationToken(token: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 创建单次、绑定邮箱的七日邀请；明文只在创建响应出现一次。 */
export async function createDomainInvitation(
  slug: string,
  actorId: string,
  email: string,
) {
  if (
    typeof email !== "string" || email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) throw new BadRequestError("邀请邮箱非法");
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await hashInvitationToken(token);
  return await getDb().transaction(async (tx) => {
    const { domain, context } = await loadWorkspace(slug, actorId, {
      write: true,
      lock: true,
      executor: tx,
    });
    assertWorkspacePermission(context, "domain:invitations");
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString();
    await tx.insert(domainInvitations).values({
      id,
      domain_id: domain.id,
      token_hash: tokenHash,
      email: email.trim().toLowerCase(),
      expires_at: expiresAt,
      created_by: actorId,
      created_at: new Date().toISOString(),
    });
    await workspaceAudit(tx, actorId, domain.id, "domain.invite_create", {
      invitation_id: id,
    });
    return { id, token, expires_at: expiresAt };
  });
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
  if (typeof token !== "string" || !/^[0-9a-f-]{72}$/.test(token)) {
    throw new NotFoundError("邀请无效");
  }
  const tokenHash = await hashInvitationToken(token);
  const [found] = await executor.select({
    domain_id: domainInvitations.domain_id,
  }).from(domainInvitations).where(eq(domainInvitations.token_hash, tokenHash));
  if (!found) throw new NotFoundError("邀请无效");
  const [domain] = await executor.select().from(domains).where(
    and(eq(domains.id, found.domain_id), eq(domains.status, "active")),
  ).for("update");
  const [invite] = await executor.select().from(domainInvitations).where(
    and(
      eq(domainInvitations.token_hash, tokenHash),
      isNull(domainInvitations.used_at),
      isNull(domainInvitations.revoked_at),
    ),
  ).for("update");
  const [user] = await executor.select().from(users).where(
    and(eq(users.id, userId), isNull(users.deleted_at)),
  );
  if (
    !domain || !invite || !user ||
    !Number.isFinite(Date.parse(invite.expires_at)) ||
    Date.parse(invite.expires_at) <= Date.now() ||
    invite.email !== user.email.toLowerCase()
  ) throw new NotFoundError("邀请无效、过期或不属于此账号");
  await addDomainMember(executor, domain.id, userId, true);
  await executor.update(domainInvitations).set({
    used_at: new Date().toISOString(),
  }).where(eq(domainInvitations.id, invite.id));
  await workspaceAudit(executor, userId, domain.id, "domain.invite_accept", {
    invitation_id: invite.id,
  });
  return { domain_id: domain.id, domain_slug: domain.slug };
}

/** 撤销不会删除既有成员或邀请审计。 */
export async function revokeDomainInvitation(
  slug: string,
  actorId: string,
  invitationId: string,
) {
  return await getDb().transaction(async (tx) => {
    const { domain, context } = await loadWorkspace(slug, actorId, {
      write: true,
      lock: true,
      executor: tx,
    });
    assertWorkspacePermission(context, "domain:invitations");
    const [invite] = await tx.update(domainInvitations).set({
      revoked_at: new Date().toISOString(),
    }).where(
      and(
        eq(domainInvitations.id, invitationId),
        eq(domainInvitations.domain_id, domain.id),
        isNull(domainInvitations.used_at),
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
