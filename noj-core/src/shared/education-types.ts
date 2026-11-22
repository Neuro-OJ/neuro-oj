/** 班级内身份，不能作为 Domain 或平台权限。 */
export type ClassroomRole = "student";
/** 教学只可组合这些教学能力，不能提交任意权限字符串。 */
export const TEACHING_CAPABILITIES = [
  "progress:read",
  "submissions:read",
  "assignments:manage",
  "feedback:write",
  "help:manage",
  "students:manage",
] as const;
/** 固定的教学授权项。 */
export type TeachingCapability = typeof TEACHING_CAPABILITIES[number];
/** 作业持久生命周期，截止与评测等待由事实计算。 */
export type AssignmentState = "draft" | "scheduled" | "published" | "archived";

/** 用户实际进入的作业及条目；它不限定该提交自动计入哪些作业。 */
export interface AssignmentSubmissionOrigin {
  assignment_id: string;
  assignment_item_id: string;
}

/** 正式进度状态，updating 仅由读取接口描述尚未完成的投影。 */
export const ASSIGNMENT_PROGRESS_STATES = [
  "not_started",
  "judging",
  "below_target",
  "achieved",
  "unavailable",
] as const;
/** 教学通知使用定位与类型，不保存私有正文摘要。 */
export type EducationNoticeType =
  | "assignment"
  | "assignment_changed"
  | "resource_unavailable"
  | "feedback"
  | "help"
  | "help_reply";

/** 持久进度状态与筛选契约统一。 */
export type AssignmentProgressStatus =
  typeof ASSIGNMENT_PROGRESS_STATES[number];
