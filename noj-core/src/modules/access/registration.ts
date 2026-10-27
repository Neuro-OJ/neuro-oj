/** 账户注册后的工作空间加入编排适配。 */
import { eq } from "drizzle-orm";
import type { DbTx } from "../../shared/db/executor.ts";
import { domains } from "../../shared/db/schema.ts";
import { ForbiddenError, NotFoundError } from "../../shared/base/errors.ts";
import type { SystemActor, UserActor } from "./contracts/actor.ts";
import { requireUserActor } from "./contracts/actor.ts";
import {
  assertInvitationRegistrationAllowed,
  consumeDomainInvitationTx,
  isInvitationCredential,
  loadInvitationAccountAuthorityTx,
} from "./invitations.ts";
import type { ClassroomInvitationBoundary } from "./invitations.ts";
import { addDomainMemberTx } from "./members.ts";
import { ensureDefaultWorkspaceTx } from "./domains.ts";
import { getInstanceAccessPolicy } from "./workspace/services/instance.ts";

/**
 * 邀请开户授权边界。
 *
 * 班级邀请签发者只具备“加学生进班级”的教学能力，不等于“可以开新账号”。
 * 只有平台管理员或持有 `domain:invitations` 的域邀请管理员签发者，才可
 * 在 `allow_domain_registration_invites` 打开时注册新账号；该检查必须在
 * 注册事务内读取签发者当前权限，签发者撤权后旧链接立即失效。
 *
 * 与邀请兑换复用同一 `ClassroomInvitationBoundary` 形状：注册用例只消费
 * application 已绑定的课堂授权检查，不自己导入 education 服务。
 */
export type InvitationRegistrationBoundary = ClassroomInvitationBoundary;

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
 * 邀请开户授权核验：实例政策 + 签发者当前权限，必须在注册事务内执行。
 *
 * 只有平台管理员，或 `allow_domain_registration_invites` 打开且签发者当前
 * 持有域邀请权限时，才允许凭邀请开户。班级能力本身不能开户。
 */
async function assertInvitationAccountRegistrationTx(
  tx: DbTx,
  invitationToken: string,
  options: InvitationRegistrationBoundary,
): Promise<void> {
  const authority = await loadInvitationAccountAuthorityTx(
    tx,
    invitationToken,
    options,
  );
  if (!authority) {
    throw new ForbiddenError("注册邀请无效", "REGISTER_INVITATION_INVALID");
  }
  const policy = getInstanceAccessPolicy();
  if (
    !authority.platformAdmin &&
    (!policy.allow_domain_registration_invites || !authority.domainInviter)
  ) {
    throw new ForbiddenError(
      "签发者没有邀请注册账号的授权",
      "REGISTER_INVITATION_UNAUTHORIZED",
    );
  }
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
    invitationBoundary?: InvitationRegistrationBoundary;
  } = {},
): Promise<void> {
  const user = requireUserActor(actor);
  const policy = getInstanceAccessPolicy();
  if (invitationToken && policy.registration_mode === "invite") {
    // 先核验开户授权，再在同一个事务内兑换邀请并写入两层成员事实。
    await assertInvitationAccountRegistrationTx(
      tx,
      invitationToken,
      options.invitationBoundary ?? {},
    );
    await consumeDomainInvitationTx(tx, user, invitationToken, {
      ...(options.invitationBoundary ?? {}),
      meta: options.meta,
    });
  } else if (invitationToken) {
    // 非 invite 模式下的邀请仍需在事务内兑换，否则账号会静默丢掉邀请语义。
    await consumeDomainInvitationTx(tx, user, invitationToken, {
      ...(options.invitationBoundary ?? {}),
      meta: options.meta,
    });
  }
  if (options.systemActor) {
    await ensureDefaultWorkspaceTx(tx, options.systemActor, options.meta);
  }
  const [main] = await tx.select().from(domains).where(
    eq(domains.slug, "main"),
  ).for("update");
  if (!main) {
    throw new NotFoundError("注册默认工作空间尚未初始化");
  }
  if (
    main.status === "active"
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
