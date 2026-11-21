/**
 * 测试夹具：工作空间 slug-first / 字符串 actor 适配。
 *
 * 生产代码一律使用 `modules/access` 的显式 Actor 合同；这里只为测试夹具保留
 * 简短调用形状（字符串用户 ID → `UserActor`），不得被 `src/` 或 `scripts/` 导入。
 */
import type { DbTx, Executor } from "../../src/shared/db/executor.ts";
import { createSystemActor } from "../../src/modules/runtime/system-actors.ts";
import { userActorFromAuthenticatedId } from "../../src/modules/access/contracts/actor.ts";
import {
  addDomainMemberTx,
  joinDomain as joinDomainForActor,
  listDomainJoinRequests as listJoinRequestsForActor,
  listDomainMembers as listMembersForActor,
  listDomainMembersPage as listMembersPageForActor,
  removeDomainMember as removeMemberForActor,
  reviewJoinRequest as reviewJoinForActor,
  setMemberRole as setMemberRoleForActor,
  transferDomain as transferDomainForActor,
} from "../../src/modules/access/members.ts";
import {
  createDomain as createDomainForActor,
  ensureDefaultWorkspace as ensureDefaultWorkspaceForActor,
  ensureDefaultWorkspaceOn,
  listDomains as listDomainsForActor,
  setDomainStatus as setDomainStatusForActor,
  updateDomain as updateDomainForActor,
} from "../../src/modules/access/domains.ts";
import {
  consumeDomainInvitation as consumeInvitationForActor,
  consumeDomainInvitationTx,
  createDomainInvitation as createInvitationForActor,
  type DomainInvitationInput,
  listDomainInvitations as listInvitationsForActor,
  revokeDomainInvitation as revokeInvitationForActor,
} from "../../src/modules/access/invitations.ts";
import { updateDomainLimits as updateDomainLimitsForActor } from "../../src/modules/access/workspace/services/limits.ts";
import {
  accessDomainChangeBoundary,
  accessMemberRemovalBoundary,
} from "../../src/modules/application/access-capabilities.ts";
import type {
  DomainConfiguration,
  DomainLimits,
  DomainPreset,
} from "../../src/shared/workspace/types.ts";

/** slug-first + 字符串 actor。 */
export function createDomain(
  input: {
    slug: string;
    name: string;
    preset: DomainPreset;
    description?: string;
  },
  actorId: string,
  options: { approved?: boolean } = {},
) {
  return createDomainForActor(
    userActorFromAuthenticatedId(actorId),
    input,
    options,
  );
}

/** 字符串 actor 的默认域初始化。 */
export function ensureDefaultWorkspace(executor?: Executor) {
  const actor = createSystemActor("bootstrap");
  return executor
    ? ensureDefaultWorkspaceOn(executor, actor)
    : ensureDefaultWorkspaceForActor(actor);
}

/** 字符串 actor 的域目录。 */
export function listDomains(actorId: string | null, mine = false) {
  return listDomainsForActor(
    actorId ? userActorFromAuthenticatedId(actorId) : null,
    mine,
  );
}

/** 字符串 actor 的域状态写入。 */
export function setDomainStatus(
  slug: string,
  actorId: string,
  status: "active" | "archived" | "suspended",
  revision: number,
  options: {
    onAccessPolicyChangedTx: (tx: DbTx, domainId: string) => Promise<void>;
  } = accessDomainChangeBoundary,
) {
  return setDomainStatusForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    status,
    revision,
    options,
  );
}

/** 字符串 actor 的域配置写入。 */
export function updateDomain(
  slug: string,
  actorId: string,
  revision: number,
  patch: {
    name?: string;
    description?: string;
    configuration?: Partial<
      DomainConfiguration
    >;
  },
  options: {
    onAccessPolicyChangedTx: (tx: DbTx, domainId: string) => Promise<void>;
  } = accessDomainChangeBoundary,
) {
  return updateDomainForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    revision,
    patch,
    options,
  );
}

/** 字符串 actor 的域限额写入。 */
export function updateDomainLimits(
  slug: string,
  actorId: string,
  expectedRevision: number | null,
  input: DomainLimits,
) {
  return updateDomainLimitsForActor(
    slug,
    userActorFromAuthenticatedId(actorId),
    expectedRevision,
    input,
  );
}

/** 夹具用成员写入；操作者记为 root。 */
export function addDomainMember(
  executor: Executor,
  domainId: string,
  userId: string,
  reactivate = false,
) {
  return addDomainMemberTx(
    executor as DbTx,
    userActorFromAuthenticatedId("0"),
    domainId,
    userId,
    reactivate,
  );
}

/** slug-first 的成员角色写入。 */
export function setMemberRole(
  slug: string,
  actorId: string,
  userId: string,
  role: unknown,
) {
  return setMemberRoleForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    userId,
    role,
  );
}

export function joinDomain(slug: string, actorId: string, reason = "") {
  return joinDomainForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    reason,
  );
}

export function listDomainJoinRequests(slug: string, actorId: string) {
  return listJoinRequestsForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
  );
}

export function listDomainMembers(slug: string, actorId: string, offset = 0) {
  return listMembersForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    offset,
  );
}

export function listDomainMembersPage(
  slug: string,
  actorId: string,
  options: { offset: number; perPage: number; keyword?: string },
) {
  return listMembersPageForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    options,
  );
}

export function reviewJoinRequest(
  slug: string,
  requestId: string,
  actorId: string,
  approved: boolean,
) {
  return reviewJoinForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    requestId,
    approved,
  );
}

export function transferDomain(
  slug: string,
  actorId: string,
  newOwnerId: string,
) {
  return transferDomainForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    newOwnerId,
  );
}

export function removeDomainMember(
  slug: string,
  actorId: string,
  userId: string,
) {
  return removeMemberForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    userId,
    {},
    accessMemberRemovalBoundary,
  );
}

export function listDomainInvitations(
  slug: string,
  actorId: string,
  pagination?: { offset: number; perPage: number },
) {
  return listInvitationsForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    pagination,
  );
}

/** 字符串 actor 的邀请写入。 */
export async function createDomainInvitation(
  slug: string,
  actorId: string,
  input: DomainInvitationInput | string,
  options: { classroomId?: string } = {},
) {
  return await createInvitationForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    input,
    options,
  );
}

/** 字符串 actor 的邀请兑换；第三参数可传事务句柄。 */
export async function consumeDomainInvitation(
  tokenOrCode: string,
  actorId: string,
  third?:
    | DbTx
    | {
      classroomId?: string;
      meta?: { ipAddress?: string; requestId?: string };
    },
) {
  const actor = userActorFromAuthenticatedId(actorId);
  if (third && typeof (third as Partial<DbTx>).rollback === "function") {
    return consumeDomainInvitationTx(third as DbTx, actor, tokenOrCode, {});
  }
  return await consumeInvitationForActor(
    actor,
    tokenOrCode,
    (third ?? {}) as {
      classroomId?: string;
      meta?: { ipAddress?: string; requestId?: string };
    },
  );
}

/** 字符串 actor 的邀请撤销。 */
export async function revokeDomainInvitation(
  slug: string,
  actorId: string,
  invitationId: string,
  options: { classroomId?: string } = {},
) {
  return await revokeInvitationForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    invitationId,
    options,
  );
}
