/** 教学模块公开门面，其他模块不得深路径调用教学实现。 */
export * from "./services/access.ts";
export * from "./services/classrooms.ts";
export * from "./services/members.ts";
export * from "./services/account-lifecycle.ts";
export * from "./services/invitations.ts";
export * from "./services/join-requests.ts";
export * from "./services/classroom-import.ts";
export * from "./services/assignments.ts";
export * from "./services/assignment-access.ts";
export * from "./services/assignment-lifecycle.ts";
export * from "./services/assignment-copy.ts";
export * from "./services/worker-lifecycle.ts";
export * from "./services/submission-lifecycle.ts";
export * from "./services/progress-read.ts";
export * from "./services/student-submissions.ts";
export * from "./services/submission-access-sql.ts";
export * from "./services/matrix-csv.ts";
export * from "./services/feedback.ts";
export * from "./services/help.ts";
export * from "./services/notifications.ts";
export * from "./services/notification-email.ts";
export * from "./services/history-read.ts";
export * from "./services/workbench.ts";
export * from "./services/annotations.ts";
export {
  downloadTeachingArtifact,
  getTeachingTextFile,
  listTeachingTextFiles,
} from "./services/submission-text.ts";
export * from "../../shared/education-types.ts";
export * from "./services/assignment-remediation.ts";
export * from "./services/contest-remediation.ts";
