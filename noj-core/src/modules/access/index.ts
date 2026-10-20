/** access 模块公共门面；只显式导出稳定合同和本地用例入口。 */
export type {
  Actor,
  GuestActor,
  SystemActor,
  SystemPurpose,
  UserActor,
  UserId,
} from "./contracts/actor.ts";
export {
  guestActor,
  isSystemActor,
  isUserActor,
  requireUserActor,
  userActorFromAuthenticatedId,
} from "./contracts/actor.ts";

export type {
  DomainConfiguration,
  DomainLimits,
  DomainPreset,
  DomainRole,
} from "./types.ts";
export {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  DOMAIN_PRESETS,
  domainPermissions,
  isDomainRole,
  presetConfiguration,
  validateDomainConfiguration,
  validateDomainSlug,
} from "./types.ts";

export type {
  AccessActor,
  WorkspaceAccessContext,
  WorkspaceAccessResult,
} from "./policy.ts";
export {
  assertWorkspacePermission,
  domainMemberWhere,
  domainReadableWhere,
  loadDomainForJoiningTx,
  loadWorkspace,
  loadWorkspaceTx,
  requireWorkspaceUser,
} from "./policy.ts";

export type {
  ContestAccessInfo,
  ContestPolicySnapshot,
  ContestSecrecyPolicy,
  ContestType,
  PublicContestSecrecyRef,
} from "./contest-policy.ts";

export type {
  ProblemSubmissionSummary,
  SubmissionQueryScope,
} from "./submission-policy.ts";
export {
  domainProblemProgressWhere,
  getProblemSubmissionSummaries,
  submissionQueryVisibility,
} from "./submission-policy.ts";
export type { DomainResourceName } from "./resource-counters.ts";
export {
  adjustDomainResourceCounterTx,
  setDomainResourceCounterTx,
} from "./resource-counters.ts";
export { allocateDomainProblemNumberTx } from "./domain-capabilities.ts";
export {
  filterProblemsInRunningContest,
  getContestPolicySnapshot,
  isProblemInRunningContest,
  isProblemInUnendedPublicContest,
  loadPublicContestSecrecy,
  resolveContestId,
  runningWindowCondition,
  unendedPublicContestForProblem,
  verifyContestAccess as verifyContestAccessWithActor,
} from "./contest-policy.ts";

export type { AccessAuditActor, AccessAuditMeta } from "./audit.ts";
export { workspaceAuditTx } from "./audit.ts";

export type { AccessWriteMeta, MemberRemovalBoundary } from "./members.ts";
export {
  addDomainMemberTx,
  assertAccountHasNoOwnedDomainTx,
  joinDomain,
  joinDomainTx,
  listDomainMembers,
  listDomainMembersPage,
  removeDomainMember,
  removeDomainMemberTx,
  retireAccountWorkspaceMembershipsTx,
  reviewJoinRequest,
  reviewJoinRequestTx,
  setMemberRoles,
  setMemberRolesTx,
  transferDomain,
  transferDomainTx,
} from "./members.ts";

export type {
  ClassroomInvitationBoundary,
  DomainInvitationInput,
} from "./invitations.ts";
export {
  assertInvitationRegistrationAllowed,
  consumeDomainInvitation,
  consumeDomainInvitationTx,
  createDomainInvitation,
  createDomainInvitationTx,
  hashInvitationToken,
  isInvitationCredential,
  listDomainInvitations,
  revokeDomainInvitation,
  revokeDomainInvitationTx,
} from "./invitations.ts";

export type { DomainChangeBoundary, DomainWriteMeta } from "./domains.ts";
export {
  createDomain,
  createDomainTx,
  ensureDefaultWorkspace,
  ensureDefaultWorkspaceTx,
  listDomains,
  setDomainStatus,
  setDomainStatusTx,
  updateDomain,
  updateDomainTx,
} from "./domains.ts";

export type { AccountLifecycleBoundary } from "./account.ts";
export {
  adminDeleteAccount,
  adminDeleteAccountTx,
  deleteOwnAccount,
  deleteOwnAccountTx,
  verifyOwnAccountPassword,
} from "./account.ts";

export {
  assertInstanceRegistration,
  enrollRegisteredAccountTx,
} from "./registration.ts";
