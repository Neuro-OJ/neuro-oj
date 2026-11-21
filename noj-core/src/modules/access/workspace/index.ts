/**
 * 工作空间业务公开门面。
 *
 * 业务实现只有一份：`modules/access/{domains,members,invitations,registration}.ts`，
 * 全部使用显式 Actor 合同。测试夹具的字符串 actor 适配见
 * `tests/helpers/workspace-actors.ts`。
 */
import { workspaceAudit, workspaceAuditTx } from "../audit.ts";
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
} from "../../platform/contracts/resource-policy.ts";
export {
    assertDomainFeatureEnabled,
    getDomainEffectiveLimits,
} from "./services/limits.ts";
export {
    consumeDomainSubmissionQuota,
    DOMAIN_SUBMISSION_QUOTA_SCRIPT,
} from "./services/submission-limit.ts";
export { lockActiveWorkspaceAccount } from "./services/account-lifecycle.ts";
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
