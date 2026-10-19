import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { annotationSources, annotationThreads } from "../../../shared/db/schema.ts";
import { ConflictError } from "../../../shared/base/errors.ts";

/** 删除原提交沿用旧批注的证据保留规则；调用方先持有提交行的排他锁。 */
export async function assertSubmissionAnnotationRetention(executor: Executor, submissionId: string): Promise<void> {
  const [source] = await executor.select({ id: annotationSources.id }).from(annotationSources).where(
    sql`${annotationSources.target}->>'kind' = 'submission' AND ${annotationSources.target}->>'submission_id' = ${submissionId}`,
  ).limit(1);
  if (source) throw new ConflictError("此提交有批注，需要保留原代码依据", "SUBMISSION_HAS_ANNOTATIONS");
}

/** 共享批注可作为参与区间内的历史提交依据，私人笔记不能成为他人的存在性信号。 */
export function sharedSubmissionAnnotationHistoryWhere(domainId: string, submissionId: SQL, studentId: SQL, joinedAt: SQL, leftAt: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM ${annotationSources} INNER JOIN ${annotationThreads}
    ON ${annotationThreads.source_id} = ${annotationSources.id} AND ${annotationThreads.domain_id} = ${annotationSources.domain_id}
    WHERE ${annotationSources.domain_id} = ${domainId} AND ${annotationSources.target}->>'kind' = 'submission'
      AND ${annotationSources.target}->>'submission_id' = ${submissionId} AND ${annotationThreads.student_id} = ${studentId}
      AND ${annotationThreads.visibility} = 'teaching' AND ${annotationThreads.created_at} >= ${joinedAt}
      AND (${leftAt} IS NULL OR ${annotationThreads.created_at} <= ${leftAt}))`;
}
