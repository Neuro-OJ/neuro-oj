/**
 * 提交列表、创建、详情及删除。
 * 重测入口在 submissions-rejudge.ts，评测结果写入在 submissions-result.ts。
 * Drizzle LEFT JOIN 的 or/ilike 条件返回 SQL<unknown>；局部条件转换为 eq 的
 * SQL 类型，仅用于统一条件数组，不涉及查询结果行的 unwrapRows。
 *
 * 本文件为门面：查询、创建、详情与 ID 解析已拆分到同目录的
 * submission-list.ts / submission-create.ts / submission-detail.ts /
 * submission-id.ts。
 */

export { listSubmissions } from "./submission-list.ts";
export { createSubmission } from "./submission-create.ts";
export { getSubmission } from "./submission-detail.ts";
export { resolveSubmissionId } from "./submission-id.ts";
export { deleteSubmission } from "./submission-deletion.ts";
