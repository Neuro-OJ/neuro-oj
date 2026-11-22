/**
 * 客观题提交服务：提交判定落库、提交历史、最高分查询。
 *
 * 两种模式（specs/objective-judging）：
 * - 练习（contest_id 为空）：允许重复提交，每次落库，成绩取 MAX(score)
 * - 竞赛（contest_id 非空）：校验竞赛 running + 已注册 + 套卷在题单 +
 *   无既有提交（只允许一次，唯一索引 23505 兜底）
 *
 * 判定详情权限：仅提交者本人或 admin 可读；竞赛模式不展示解析（防泄题）。
 */

/** 门面：仅重新导出原有对外符号，实现按职责拆分到兄弟文件。 */
export { submitObjectivePaper } from "./objective-submission-create.ts";
export {
  getObjectiveSubmission,
  getObjectiveSubmissionForActor,
  listObjectiveSubmissions,
  listObjectiveSubmissionsForActor,
} from "./objective-submission-read.ts";
