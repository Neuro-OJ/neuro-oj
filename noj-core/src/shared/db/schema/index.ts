/**
 * schema 聚合入口：只做逐文件显式转出。
 *
 * P3 目标要求生产门面不整体 `export *`：这里逐表列出转出符号，
 * 使模块检查能区分真实运行时导出与纯类型导出，并防止 schema 聚合入口
 * 成为绕过边界检查的隐式通道。
 */

// access
export {
  domainCreationRequests,
  domainFeatureIntervals,
  domainJoinRequests,
  domainLimits,
  domainLlmSettings,
  domainMemberRoles,
  domainMemberships,
  domainResourceCounters,
  domains,
  userWorkspacePreferences,
} from "./workspace.ts";
export {
  domainInvitationRedemptions,
  domainInvitations,
} from "./workspace-invitations.ts";
export {
  checkIns,
  oauthAccounts,
  passwordResetTokens,
  permissions,
  rolePermissions,
  roles,
  tfaRecoveryCodes,
  userBans,
  userRoles,
  users,
} from "./identity.ts";

// problems
export {
  problemDraftObjects,
  problemDrafts,
  problems,
  problemTags,
  problemVersionObjects,
  problemVersions,
  tags,
  trainingProblems,
  trainings,
} from "./catalog.ts";
export {
  domainProblemBindings,
  domainTrainingBindings,
  problemBindingHistory,
  problemShareSettings,
  problemShareTargets,
  trainingShareSettings,
  trainingShareTargets,
} from "./catalog-workspace.ts";

// evaluations
export {
  evaluationAttempts,
  objectiveSubmissions,
  submissionReceiptSequence,
  submissions,
} from "./evaluation-records.ts";
export {
  llmTokenRevocations,
  selfTests,
  sseEvents,
  submissionJobItems,
  submissionJobs,
  submissionVersionResults,
} from "./submission.ts";

// contests
export {
  contestClarifications,
  contestParticipants,
  contestProblems,
  contestRankingSnapshots,
  contests,
} from "./contest.ts";

// education
export {
  classroomAssistantGrants,
  classroomContestLinks,
  classroomJoinRequests,
  classroomMemberships,
  classrooms,
} from "./education.ts";
export {
  assignmentItemHistory,
  assignmentItems,
  assignmentRecipients,
  assignments,
  educationDisabledIntervals,
  educationOperations,
  educationOutbox,
} from "./assignment.ts";
export { assignmentProgress } from "./assignment-progress.ts";
export {
  assignmentFeedback,
  assignmentHelpReplies,
  assignmentHelpRequests,
  educationNotificationEmails,
  educationNotifications,
} from "./education-interactions.ts";
export { submissionAnnotations } from "./submission-annotations.ts";

// communication
export {
  communityBoardRoleGrants,
  communityBoards,
  communityBookmarks,
  communityCommentLikes,
  communityComments,
  communityFollows,
  communityModerationActions,
  communityNotifications,
  communityPostLikes,
  communityPosts,
  communityReports,
  communitySanctions,
} from "./community.ts";
export {
  conversationPreferences,
  conversationReads,
  conversations,
  messageDeletions,
  messageReactions,
  messages,
} from "./messaging.ts";
export { contentReviewQueue } from "./content-review.ts";

// platform
export {
  announcements,
  auditLogs,
  ipBans,
  judgeImages,
  llmModelAliases,
  storageObjectReservations,
  storageObjects,
  systemSettings,
} from "./system.ts";
export { carouselSlides } from "./carousel.ts";
export {
  dataRequests,
  legalDocuments,
  legalDocumentVersions,
  userConsents,
} from "./legal.ts";
export { emailDeliveryEvents, emailSuppressions } from "./email.ts";

// read-models
export { queryProjectionRevisions } from "./query.ts";
export { searchEntries } from "./search.ts";

// assets
export {
  domainStorageObjects,
  domainStorageUploads,
} from "./workspace-storage.ts";

// runtime
export {
  type BackgroundTaskRow,
  backgroundTasks,
  type BackgroundTaskStatus,
  type NewBackgroundTaskRow,
} from "./background-tasks.ts";
