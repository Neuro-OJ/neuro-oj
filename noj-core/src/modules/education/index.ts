/** 教学模块公开门面，其他模块不得深路径调用教学实现。 */
export {
  assertClassroomCapability,
  assertClassroomCoach,
  assertClassroomRevision,
  loadClassroom,
} from "./services/access.ts";
export {
  assertActiveDomainStudent,
  createClassroom,
  getClassroom,
  listClassrooms,
  updateClassroom,
} from "./services/classrooms.ts";
export {
  listClassroomMembers,
  removeClassroomMember,
  setClassroomMember,
} from "./services/members.ts";
export { retireDomainEducationMemberships } from "./services/account-lifecycle.ts";
export {
  assertClassroomInvitationIssuer,
  createClassroomInvitation,
  joinInvitedClassroom,
  listClassroomInvitations,
  revokeClassroomInvitation,
} from "./services/invitations.ts";
export {
  listClassroomJoinRequests,
  readClassroomJoin,
  requestClassroomJoin,
  reviewClassroomJoin,
} from "./services/join-requests.ts";
export {
  executeClassroomImport,
  previewClassroomImport,
} from "./services/classroom-import.ts";
export type { ClassroomImportRow } from "./services/classroom-import.ts";
export {
  assignmentDate,
  assignmentProblem,
  assignmentStudents,
  createAssignment,
  getAssignment,
  insertAssignmentDraft,
  listAssignments,
  updateAssignment,
} from "./services/assignments.ts";
export type { AssignmentDraftInput } from "./services/assignments.ts";
export { loadAssignment } from "./services/assignment-access.ts";
export {
  changeAssignmentLifecycle,
  publishAssignment,
  publishDueAssignments,
  scheduleAssignment,
} from "./services/assignment-lifecycle.ts";
export { copyAssignment } from "./services/assignment-copy.ts";
export type { AssignmentCopyInput } from "./services/assignment-copy.ts";
export {
  _resetEducationWorkerForTest,
  startEducationEmailWorker,
  startEducationPublishingWorker,
  startEducationWorker,
} from "./services/worker-lifecycle.ts";
export { processEducationBackgroundTask } from "./services/progress-worker.ts";
export type {
  EducationBackgroundTaskOutcome,
} from "./services/progress-worker.ts";
export { prepareEducationSubmissionDeletion } from "./services/submission-lifecycle.ts";
export {
  getAssignmentMatrix,
  getMyAssignmentProgress,
} from "./services/progress-read.ts";
export type {
  AssignmentMatrixOptions,
  ProgressScope,
} from "./services/progress-read.ts";
export {
  getClassroomStudentSubmission,
  listClassroomStudentSubmissions,
  selectTeachingSubmissions,
  teachingSubmissionDto,
  teachingSubmissionRelation,
  teachingSubmissionSources,
} from "./services/student-submissions.ts";
export type {
  StudentSubmissionRow,
  TeachingSubmissionKind,
} from "./services/student-submissions.ts";
export {
  getTeachingSubmissionAttempts,
  listAssignmentItemSubmissions,
} from "./services/submission-evidence.ts";
export { currentTeacherSubmissionAccessWhere } from "./services/submission-access-sql.ts";
export { exportAssignmentMatrixCsv } from "./services/matrix-csv.ts";
export {
  createAssignmentFeedback,
  getAssignmentFeedback,
  listAssignmentFeedback,
  updateAssignmentFeedback,
} from "./services/feedback.ts";
export {
  createAssignmentHelp,
  getAssignmentHelp,
  listAssignmentHelp,
  replyAssignmentHelp,
  setAssignmentHelpState,
} from "./services/help.ts";
export type { AssignmentHelpInput } from "./services/help.ts";
export {
  getEducationNotification,
  listEducationNotifications,
  markEducationNotificationRead,
  processEducationNotice,
} from "./services/notifications.ts";
export {
  claimEducationEmails,
  educationEmailContent,
  processEducationEmail,
  processEducationEmailBatch,
} from "./services/notification-email.ts";
export { getAssignmentHistory } from "./services/history-read.ts";
export { getEducationWorkbench } from "./services/workbench.ts";
export type { EducationWorkbenchAssignment } from "./services/workbench.ts";
export {
  createSubmissionAnnotation,
  listSubmissionAnnotations,
  updateSubmissionAnnotation,
} from "./services/annotations.ts";
export type { SubmissionAnnotationInput } from "./services/annotations.ts";
export {
  downloadTeachingArtifact,
  getTeachingTextFile,
  listTeachingTextFiles,
} from "./services/submission-text.ts";
export {
  ASSIGNMENT_PROGRESS_STATES,
  TEACHING_CAPABILITIES,
} from "../../shared/education-types.ts";
export type {
  AssignmentProgressStatus,
  AssignmentState,
  AssignmentSubmissionOrigin,
  ClassroomRole,
  EducationNoticeType,
  TeachingCapability,
} from "../../shared/education-types.ts";
export {
  createAssignmentRemediation,
  previewAssignmentRemediation,
} from "./services/assignment-remediation.ts";
export type { AssignmentRemediationInput } from "./services/assignment-remediation.ts";
export {
  createContestRemediation,
  previewContestRemediation,
} from "./services/contest-remediation.ts";
export type {
  ContestRemediationInput,
  ContestRemediationRule,
} from "./services/contest-remediation.ts";
export { getTrainingComparison } from "./services/training-comparison.ts";
export type {
  TrainingComparison,
  TrainingComparisonInput,
} from "./services/training-comparison.ts";
export { resolveAssignmentSubmissionOrigin } from "./services/assignment-submission-origin.ts";
export { registerEducationObservability } from "./observability.ts";
