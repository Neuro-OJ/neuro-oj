import { eq } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { domainInvitations, domains } from "../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../shared/workspace/types.ts";
import { ForbiddenError } from "../../../shared/base/errors.ts";
import { getInstancePolicy } from "./instance.ts";
import {
  assertInvitationRegistrationAllowed,
  consumeDomainInvitation,
  hashInvitationToken,
} from "./invitations.ts";
import { getUserPermissions } from "../../identity/index.ts";
import { addDomainMember } from "./members.ts";
import { ensureDefaultWorkspace } from "./domains.ts";

/** 在创建账号前检查实例注册政策；域邀请不能越过管理员开户政策。 */
export function assertInstanceRegistration(invitationToken?: string) {
  const policy = getInstancePolicy();
  if (
    invitationToken !== undefined &&
    (typeof invitationToken !== "string" ||
      !/^[0-9a-f-]{72}$/.test(invitationToken))
  ) throw new ForbiddenError("注册邀请无效", "REGISTER_INVITATION_INVALID");
  assertInvitationRegistrationAllowed(
    policy.registration_mode,
    true, // 签发者是否获准邀请新账号，在注册事务内检查。
    !!invitationToken,
  );
}

/** 新账号的成员关系与账号在同一事务保存，邀请失败回滚账号创建。 */
export async function enrollRegisteredAccount(
  executor: Executor,
  userId: string,
  invitationToken?: string,
) {
  const policy = getInstancePolicy();
  if (
    invitationToken && policy.registration_mode === "invite" &&
    !policy.allow_domain_registration_invites
  ) {
    const hash = await hashInvitationToken(invitationToken);
    const [invitation] = await executor.select().from(domainInvitations).where(
      eq(domainInvitations.token_hash, hash),
    );
    if (
      !invitation ||
      !(await getUserPermissions(invitation.created_by, executor)).has(
        "admin:full_access",
      )
    ) {
      throw new ForbiddenError(
        "实例未授权域管理员邀请新账号",
        "REGISTER_INVITATION_UNAUTHORIZED",
      );
    }
  }
  await ensureDefaultWorkspace(executor);
  const [main] = await executor.select().from(domains).where(
    eq(domains.slug, DEFAULT_DOMAIN_SLUG),
  ).for("update");
  if (main?.status === "active" && main.configuration.join_policy === "open") {
    await addDomainMember(executor, main.id, userId);
  }
  if (invitationToken) {
    await consumeDomainInvitation(invitationToken, userId, executor);
  }
}
