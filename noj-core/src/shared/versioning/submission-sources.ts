/** 两类正式提交的共同读取面；仅统一 SQL 列名，不改变权限或有效策略谓词。 */
import { sql } from "drizzle-orm";

/** 使用 submissions 别名，供既有列谓词、权限过滤和有效尝试关联共同使用。 */
export const unifiedSubmissionSources = sql`(
  SELECT id, user_id, problem_id, contest_id, language, status, created_at,
    domain_id, domain_problem_binding_id,
    is_valid, is_accepted, effective_attempt_id, accepted_attempt_id, latest_attempt_id
  FROM submissions
  UNION ALL
  SELECT id, user_id, paper_id AS problem_id, contest_id, 'objective' AS language,
    status, created_at, domain_id, domain_problem_binding_id,
    is_valid, is_accepted, effective_attempt_id, accepted_attempt_id, latest_attempt_id
  FROM objective_submissions
) submissions`;
