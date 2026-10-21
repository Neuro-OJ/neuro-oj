/**
 * access application commands。
 *
 * access 模块只维护账户/域/邀请本地事实；涉及教学、搜索、对象存储等
 * 跨模块写入时由这里持有外层事务，并把明确的 `DbTx` 和 callback 传给
 * access 本地命令。HTTP 路由不得直接拼接这些跨模块步骤。
 */
import type { DbRoot } from "../../shared/db/executor.ts";
import { getDb } from "../../shared/db/connection.ts";
import type { UserActor } from "../access/contracts/actor.ts";
import {
  type AccountLifecycleBoundary,
  adminDeleteAccountTx,
  deleteOwnAccountTx,
  verifyOwnAccountPassword,
} from "../access/account.ts";
import {
  createDomainTx,
  setDomainStatusTx,
  updateDomainTx,
} from "../access/domains.ts";
import {
  consumeDomainInvitationTx,
  createDomainInvitationTx,
  type DomainInvitationInput,
  previewDomainInvitation,
  revokeDomainInvitationTx,
} from "../access/invitations.ts";
import type { InvitationRegistrationBoundary } from "../access/registration.ts";
import {
  type AccessWriteMeta,
  joinDomainTx,
  removeDomainMemberTx,
  reviewJoinRequestTx,
  setMemberRolesTx,
  transferDomainTx,
} from "../access/members.ts";
import type { DomainPreset, DomainRole } from "../../shared/workspace/types.ts";
import {
  accessClassroomInvitationBoundary,
  accessDomainChangeBoundary,
  accessMemberRemovalBoundary,
} from "./access-capabilities.ts";

/** 账户命令保留 application 边界，跨 assets/search/legal 的回调由调用方注入。 */
export async function deleteOwnAccountCommand(
  actor: UserActor,
  password: string,
  options: AccountLifecycleBoundary & { meta?: AccessWriteMeta },
) {
  const user = actor;
  const passwordHash = await verifyOwnAccountPassword(user, password);
  const db: DbRoot = getDb();
  const result = await db.transaction((tx) =>
    deleteOwnAccountTx(tx, user, passwordHash, options)
  );
  await options.afterCommit({
    type: "account_deleted",
    userId: user.userId,
    previousAvatarUrl: result.avatarUrl,
  });
}

export async function adminDeleteAccountCommand(
  actor: UserActor,
  targetUserId: string,
  options: AccountLifecycleBoundary & { meta?: AccessWriteMeta },
) {
  const db: DbRoot = getDb();
  const result = await db.transaction((tx) =>
    adminDeleteAccountTx(tx, actor, targetUserId, options)
  );
  await options.afterCommit({
    type: "account_deleted",
    userId: targetUserId,
    previousAvatarUrl: result.avatarUrl,
  });
}

export function createDomainCommand(
  actor: UserActor,
  input: {
    slug: string;
    name: string;
    preset: DomainPreset;
    description?: string;
  },
  options: { approved?: boolean; meta?: AccessWriteMeta } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) => createDomainTx(tx, actor, input, options));
}

export function updateDomainCommand(
  actor: UserActor,
  slug: string,
  revision: number,
  patch: {
    name?: string;
    description?: string;
    configuration?: Record<string, unknown>;
  },
  options: { meta?: AccessWriteMeta } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    updateDomainTx(tx, actor, slug, revision, patch, {
      ...accessDomainChangeBoundary,
      meta: options.meta,
    })
  );
}

export function setDomainStatusCommand(
  actor: UserActor,
  slug: string,
  status: "active" | "archived" | "suspended",
  revision: number,
  options: { meta?: AccessWriteMeta } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    setDomainStatusTx(tx, actor, slug, status, revision, {
      ...accessDomainChangeBoundary,
      meta: options.meta,
    })
  );
}

export function joinDomainCommand(
  actor: UserActor,
  slug: string,
  reason = "",
  meta: AccessWriteMeta = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) => joinDomainTx(tx, actor, slug, reason, meta));
}

export function reviewJoinRequestCommand(
  actor: UserActor,
  slug: string,
  requestId: string,
  approved: boolean,
  meta: AccessWriteMeta = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    reviewJoinRequestTx(tx, actor, slug, requestId, approved, meta)
  );
}

export function setMemberRolesCommand(
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

export function removeDomainMemberCommand(
  actor: UserActor,
  slug: string,
  userId: string,
  meta: AccessWriteMeta = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    removeDomainMemberTx(
      tx,
      actor,
      slug,
      userId,
      meta,
      accessMemberRemovalBoundary,
    )
  );
}

export function transferDomainCommand(
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

export function createDomainInvitationCommand(
  actor: UserActor,
  slug: string,
  input: string | DomainInvitationInput,
  options: {
    classroomId?: string;
    meta?: AccessWriteMeta;
  } = {},
) {
  const db: DbRoot = getDb();
  const boundary = options.classroomId
    ? accessClassroomInvitationBoundary()
    : {};
  return db.transaction((tx) =>
    createDomainInvitationTx(tx, actor, slug, input, {
      ...boundary,
      classroomId: options.classroomId,
      meta: options.meta,
    })
  );
}

/**
 * 班级邀请的完整生产用例。
 *
 * 班级标识属于业务输入；教学授权 callback 由 application 组合根绑定，
 * 因此 HTTP 适配层不需要也不能选择跨模块写入能力。
 */
export function createClassroomInvitationCommand(
  actor: UserActor,
  slug: string,
  classroomId: string,
  input: string | DomainInvitationInput,
  meta: AccessWriteMeta = {},
) {
  return createDomainInvitationCommand(actor, slug, input, {
    classroomId,
    meta,
  });
}

/** 邀请预览也必须经 application 绑定班级签发者授权，避免公开入口绕过教学状态。 */
export function previewDomainInvitationCommand(token: string) {
  return previewDomainInvitation(token, accessClassroomInvitationBoundary());
}

export function consumeDomainInvitationCommand(
  actor: UserActor,
  token: string,
  options: { meta?: AccessWriteMeta } = {},
) {
  const db: DbRoot = getDb();
  return db.transaction((tx) =>
    consumeDomainInvitationTx(tx, actor, token, {
      ...accessClassroomInvitationBoundary(),
      meta: options.meta,
    })
  );
}

export function revokeDomainInvitationCommand(
  actor: UserActor,
  slug: string,
  invitationId: string,
  options: {
    classroomId?: string;
    meta?: AccessWriteMeta;
  } = {},
) {
  const db: DbRoot = getDb();
  const boundary = options.classroomId
    ? accessClassroomInvitationBoundary()
    : {};
  return db.transaction((tx) =>
    revokeDomainInvitationTx(tx, actor, slug, invitationId, {
      ...boundary,
      classroomId: options.classroomId,
      meta: options.meta,
    })
  );
}

/** 班级邀请撤销与授权核验共用 application 已组装的 DbTx。 */
export function revokeClassroomInvitationCommand(
  actor: UserActor,
  slug: string,
  classroomId: string,
  invitationId: string,
  meta: AccessWriteMeta = {},
) {
  return revokeDomainInvitationCommand(actor, slug, invitationId, {
    classroomId,
    meta,
  });
}

/**
 * 注册开户时使用的邀请边界。
 *
 * 班级邀请签发者是否仍有教学授权属于 education 事实，必须由 application
 * 绑定；access 只消费这个已组合能力，不反向导入 education 服务。
 */
export function registrationInvitationBoundary(): InvitationRegistrationBoundary {
  return accessClassroomInvitationBoundary();
}
