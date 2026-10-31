/** 工作空间业务公开门面。 */
export {
  domainPermissions,
  isDomainRole,
  presetConfiguration,
  validateDomainConfiguration,
  validateDomainSlug,
} from "./types.ts";
export {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  DOMAIN_PRESETS,
  DOMAIN_ROLES,
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
  createDomain,
  ensureDefaultWorkspace,
  listDomains,
  setDomainStatus,
  updateDomain,
  workspaceAudit,
} from "./services/domains.ts";
export {
  getInstanceAccessPolicy,
  getInstancePolicy,
  getInstanceResourcePolicy,
} from "./services/instance.ts";
export {
  addDomainMember,
  joinDomain,
  listDomainJoinRequests,
  listDomainMembers,
  listDomainMembersPage,
  removeDomainMember,
  reviewJoinRequest,
  setMemberRoles,
  transferDomain,
} from "./services/members.ts";
export {
  assertInvitationAccountRegistration,
  assertInvitationRegistrationAllowed,
  consumeDomainInvitation,
  createDomainInvitation,
  hashInvitationToken,
  invitationListColumns,
  isInvitationCredential,
  listDomainInvitations,
  previewDomainInvitation,
  revokeDomainInvitation,
} from "./services/invitations.ts";
export type { DomainInvitationInput } from "./services/invitations.ts";
export {
  requestDomainCreation,
  reviewDomainCreation,
} from "./services/creation-requests.ts";
export {
  assertInstanceRegistration,
  enrollRegisteredAccount,
  enrollRegisteredAccountInExecutor,
  enrollRegisteredAccountTxLegacy,
} from "./services/registration.ts";
export { instanceAccessMiddleware } from "./middleware/instance-access.ts";
export {
  assertDomainFeatureEnabled,
  getDomainEffectiveLimits,
  updateDomainLimits,
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
