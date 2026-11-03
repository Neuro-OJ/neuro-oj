/**
 * 工作空间业务公开门面。
 *
 * 业务实现只有一份：`modules/access/{domains,members,invitations,registration}.ts`。
 * 这里的 slug-first / 字符串 actor 包装是**过渡适配层**，供尚未迁移的调用方
 * （主要是测试夹具）逐步切换到显式 Actor；新代码应直接从 `modules/access`
 * 引入显式 Actor 合同。
 */
import type { DbTx, Executor } from "../../../shared/db/executor.ts";
import { createSystemActor } from "../../runtime/system-actors.ts";
import { userActorFromAuthenticatedId } from "../contracts/actor.ts";
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
} from "../members.ts";
import {
  createDomain as createDomainForActor,
  ensureDefaultWorkspace as ensureDefaultWorkspaceForActor,
  ensureDefaultWorkspaceOn,
  listDomains as listDomainsForActor,
  setDomainStatus as setDomainStatusForActor,
  updateDomain as updateDomainForActor,
} from "../domains.ts";
import {
  listDomainInvitations as listInvitationsForActor,
} from "../invitations.ts";
import { workspaceAudit, workspaceAuditTx } from "../audit.ts";
import {
  accessMemberRemovalBoundary,
} from "../../application/access-capabilities.ts";

export {
  domainPermissions,
  presetConfiguration,
  validateDomainConfiguration,
  validateDomainSlug,
} from "./types.ts";
export {
  DOMAIN_MEMBER_ROLES,
  DOMAIN_ROLES,
  isDomainMemberRole,
  isDomainRole,
  isPlatformRole,
  parseDomainMemberRole,
  parsePlatformRole,
} from "../../../shared/access/roles.ts";
export type {
  DomainMemberRole,
  PlatformRole,
} from "../../../shared/access/roles.ts";
export {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  DOMAIN_PRESETS,
} from "../../../shared/workspace/types.ts";
export type {
  DomainConfiguration,
  DomainFeatures,
  DomainLimits,
  DomainPreset,
  DomainRole,
  DomainStatus,
  ProblemReference,
  StoredDomainPreset,
  WorkspaceContext,
} from "../../../shared/workspace/types.ts";
export {
  assertWorkspacePermission,
  domainMemberWhere,
  domainReadableWhere,
  loadDomainForJoining,
  loadWorkspace,
} from "./services/access.ts";
export {
  getInstanceAccessPolicy,
  getInstancePolicy,
  getInstanceResourcePolicy,
} from "./services/instance.ts";
export {
  assertDomainFeatureEnabled,
  getDomainEffectiveLimits,
} from "./services/limits.ts";
export {
  consumeDomainSubmissionQuota,
  DOMAIN_SUBMISSION_QUOTA_SCRIPT,
} from "./services/submission-limit.ts";
export {
  assertAccountHasNoOwnedDomain,
  lockActiveWorkspaceAccount,
  retireAccountWorkspaceMemberships,
} from "./services/account-lifecycle.ts";
export {
  listAdminDomains,
  listDomainCreationRequests,
} from "./services/governance.ts";
export { getDomainResourceUsage } from "./services/resource-usage.ts";
export { instanceAccessMiddleware } from "./middleware/instance-access.ts";
export {
  requestDomainCreation,
  reviewDomainCreation,
} from "./services/creation-requests.ts";
export { workspaceAudit, workspaceAuditTx };
export {
  assertInstanceRegistration,
  enrollRegisteredAccountTx,
} from "../registration.ts";
export {
  assertInvitationRegistrationAllowed,
  consumeDomainInvitation as consumeDomainInvitationWithActor,
  createDomainInvitation as createDomainInvitationWithActor,
  hashInvitationToken,
  isInvitationCredential,
  previewDomainInvitation,
  revokeDomainInvitation as revokeDomainInvitationWithActor,
} from "../invitations.ts";
export type { DomainInvitationInput as InvitationInput } from "../invitations.ts";
export type {
  ClassroomInvitationBoundary,
  DomainInvitationInput,
} from "../invitations.ts";

/** @deprecated 过渡适配：slug-first + 字符串 actor。 */
export function createDomain(
  input: {
    slug: string;
    name: string;
    preset: import("../../../shared/workspace/types.ts").DomainPreset;
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

/** @deprecated 过渡适配：字符串 actor 的默认域初始化。 */
export function ensureDefaultWorkspace(executor?: Executor) {
  const actor = createSystemActor("bootstrap");
  return executor
    ? ensureDefaultWorkspaceOn(executor, actor)
    : ensureDefaultWorkspaceForActor(actor);
}

/** @deprecated 过渡适配：字符串 actor 的域目录。 */
export function listDomains(actorId: string | null, mine = false) {
  return listDomainsForActor(
    actorId ? userActorFromAuthenticatedId(actorId) : null,
    mine,
  );
}

/** @deprecated 过渡适配：字符串 actor 的域状态写入。 */
export function setDomainStatus(
  slug: string,
  actorId: string,
  status: "active" | "archived" | "suspended",
  revision: number,
  options: {
    onAccessPolicyChangedTx: (tx: DbTx, domainId: string) => Promise<void>;
  },
) {
  return setDomainStatusForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    status,
    revision,
    options,
  );
}

/** @deprecated 过渡适配：字符串 actor 的域配置写入。 */
export function updateDomain(
  slug: string,
  actorId: string,
  revision: number,
  patch: {
    name?: string;
    description?: string;
    configuration?:
      import("../../../shared/workspace/types.ts").DomainConfiguration;
  },
  options: {
    onAccessPolicyChangedTx: (tx: DbTx, domainId: string) => Promise<void>;
  },
) {
  return updateDomainForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    revision,
    patch,
    options,
  );
}

/** @deprecated 过渡适配：夹具用成员写入；操作者记为 root。 */
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

/** @deprecated 过渡适配：slug-first 的成员角色写入。 */
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

/** @deprecated 过渡适配：旧数组调用只接受单元素。 */
export function setMemberRoles(
  slug: string,
  actorId: string,
  userId: string,
  roles: readonly unknown[],
) {
  const role = roles.length === 1 ? roles[0] : roles;
  return setMemberRoleForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    userId,
    role,
  );
}

/** @deprecated 过渡适配。 */
export function joinDomain(slug: string, actorId: string, reason = "") {
  return joinDomainForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    reason,
  );
}

/** @deprecated 过渡适配。 */
export function listDomainJoinRequests(slug: string, actorId: string) {
  return listJoinRequestsForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
  );
}

/** @deprecated 过渡适配。 */
export function listDomainMembers(slug: string, actorId: string, offset = 0) {
  return listMembersForActor(
    userActorFromAuthenticatedId(actorId),
    slug,
    offset,
  );
}

/** @deprecated 过渡适配。 */
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

/** @deprecated 过渡适配。 */
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

/** @deprecated 过渡适配。 */
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

/** @deprecated 过渡适配。 */
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

/** @deprecated 过渡适配。 */
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

/** @deprecated 过渡适配：字符串 actor 的邀请写入。 */
export async function createDomainInvitation(
  slug: string,
  actorId: string,
  input: import("../invitations.ts").DomainInvitationInput | string,
  options: { classroomId?: string } = {},
) {
  const { createDomainInvitation: impl } = await import("../invitations.ts");
  return impl(userActorFromAuthenticatedId(actorId), slug, input, options);
}

/** @deprecated 过渡适配：字符串 actor 的邀请兑换。 */
export async function consumeDomainInvitation(
  tokenOrCode: string,
  actorId: string,
  options: {
    classroomId?: string;
    meta?: { ipAddress?: string; requestId?: string };
  } = {},
) {
  const { consumeDomainInvitation: impl } = await import("../invitations.ts");
  return impl(userActorFromAuthenticatedId(actorId), tokenOrCode, options);
}

/** @deprecated 过渡适配：字符串 actor 的邀请撤销。 */
export async function revokeDomainInvitation(
  slug: string,
  actorId: string,
  invitationId: string,
  options: { classroomId?: string } = {},
) {
  const { revokeDomainInvitation: impl } = await import("../invitations.ts");
  return impl(
    userActorFromAuthenticatedId(actorId),
    slug,
    invitationId,
    options,
  );
}
