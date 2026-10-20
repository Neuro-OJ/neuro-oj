/** 账户注册后的工作空间加入编排适配。 */
import { eq } from "drizzle-orm";
import type { DbTx } from "../../shared/db/executor.ts";
import { domains } from "../../shared/db/schema.ts";
import { ForbiddenError } from "../../shared/base/errors.ts";
import type { SystemActor, UserActor } from "./contracts/actor.ts";
import { requireUserActor } from "./contracts/actor.ts";
import {
  assertInvitationRegistrationAllowed,
  consumeDomainInvitationTx,
  isInvitationCredential,
} from "./invitations.ts";
import { addDomainMemberTx } from "./members.ts";
import { ensureDefaultWorkspaceTx } from "./domains.ts";
import { getInstanceAccessPolicy } from "../../domains/workspace/services/instance.ts";

/** 注册前检查实例政策；邀请不会绕过 admin_only。 */
export function assertInstanceRegistration(invitationToken?: string): void {
  const policy = getInstanceAccessPolicy();
  if (
    invitationToken !== undefined && !isInvitationCredential(invitationToken)
  ) throw new ForbiddenError("注册邀请无效", "REGISTER_INVITATION_INVALID");
  assertInvitationRegistrationAllowed(
    policy.registration_mode,
    true,
    !!invitationToken,
  );
}

/**
 * 账号与成员关系共享注册事务。没有邀请时，默认域的 bootstrap 必须由
 * application 明确提供 SystemActor；不会把 ROOT_USER_ID 当作缺省操作者。
 */
export async function enrollRegisteredAccountTx(
  tx: DbTx,
  actor: UserActor,
  invitationToken?: string,
  options: {
    systemActor?: SystemActor;
    meta?: { ipAddress?: string; requestId?: string };
  } = {},
): Promise<void> {
  const user = requireUserActor(actor);
  const policy = getInstanceAccessPolicy();
  if (invitationToken && policy.registration_mode === "invite") {
    // 注册邀请的签发者、过期时间、兑换记录均在同一事务校验。
    await consumeDomainInvitationTx(tx, user, invitationToken, {
      meta: options.meta,
    });
    return;
  }
  if (options.systemActor) {
    await ensureDefaultWorkspaceTx(tx, options.systemActor, options.meta);
  }
  const [main] = await tx.select().from(domains).where(
    eq(domains.slug, "main"),
  ).for("update");
  if (!main) {
    throw new ForbiddenError("注册默认工作空间尚未初始化");
  }
  if (
    main?.status === "active" &&
    main.configuration.join_policy === "open"
  ) {
    await addDomainMemberTx(
      tx,
      user,
      main.id,
      user.userId,
      false,
      options.meta,
    );
  }
}
