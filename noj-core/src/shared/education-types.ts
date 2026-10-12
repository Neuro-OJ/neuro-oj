/** 班级内身份，不能作为 Domain 或平台权限。 */
export type ClassroomRole = "coach" | "assistant" | "student";
/** 助教只可组合这些教学能力，不能提交任意权限字符串。 */
export const ASSISTANT_CAPABILITIES = [
  "progress:read",
  "submissions:read",
  "assignments:manage",
  "feedback:write",
  "help:manage",
  "students:manage",
] as const;
/** 固定的助教授权项。 */
export type AssistantCapability = typeof ASSISTANT_CAPABILITIES[number];
/** 作业持久生命周期，截止与评测等待由事实计算。 */
export type AssignmentState = "draft" | "scheduled" | "published" | "archived";
