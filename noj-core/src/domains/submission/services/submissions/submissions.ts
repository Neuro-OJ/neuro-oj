/**
 * Submissions 公共入口（PR-3 拆分 barrel）。
 *
 * 物理拆分（避免单文件 1097 行怪兽）：
 * - submissions-types.ts：共享 DTO（SubmissionInput / SubmissionDetail 等）
 * - submissions-crud.ts：listSubmissions / createSubmission / getSubmission / deleteSubmission
 * - submissions-result.ts：saveEvaluationResult / updateSubmissionStatus
 * - submissions-rejudge.ts：rejudgeSubmission / rejudgeProblemSubmissions
 *
 * 本文件仅 re-export 以保持向后兼容（routes/admin.ts、routes/submissions.ts、
 * routes/sse.ts、mq/consumer.ts 等既有 import 路径不变）。
 *
 * 新代码建议直接从对应子模块 import，避免通过 barrel。
 */

export {
  createSubmission,
  deleteSubmission,
  getSubmission,
  // CRUD
  listSubmissions,
  resolveSubmissionId,
} from "./submissions-crud.ts";

export { createArtifactSubmission } from "./artifact-submissions.ts";

export {
  saveEvaluationResult,
  updateSubmissionStatus,
} from "./submissions-result.ts";

export {
  rejudgeProblemSubmissions,
  rejudgeSubmission,
} from "./submissions-rejudge.ts";

/**
 * 提交域共享 DTO 类型（re-export）。
 *
 * 从 submissions-types.ts 统一导出提交相关的输入/输出类型，供 routes、admin、
 * sse、mq 等模块复用，保持向后兼容。
 */
export type {
  ListSubmissionsParams,
  ListSubmissionsResult,
  SubmissionDetail,
  SubmissionInput,
  SubmissionListItem,
  SubmissionResponse,
  TodayStats,
} from "./submissions-types.ts";
