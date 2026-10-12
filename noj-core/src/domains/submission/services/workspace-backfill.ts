import { eq, sql } from "drizzle-orm";
import { AppError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { domains } from "../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";

/** 扩展迁移后回填历史执行归属，不改提交、版本、尝试和原始内容。 */
export async function backfillExecutionWorkspaces(
  executor?: Executor,
): Promise<Array<{ kind: string; total: number; incomplete: number }>> {
  if (!executor) {
    return await getDb().transaction((tx) => backfillExecutionWorkspaces(tx));
  }
  const [domain] = await executor.select({ id: domains.id }).from(domains)
    .where(eq(domains.id, DEFAULT_DOMAIN_ID)).for("update");
  if (!domain) {
    throw new AppError(
      "请先初始化默认域及回填题库",
      409,
      "DEFAULT_DOMAIN_NOT_READY",
    );
  }
  const invalid = await executor.execute(sql`SELECT 1 FROM (
    SELECT s.problem_id FROM submissions s WHERE s.domain_id IS NULL
    UNION ALL SELECT s.paper_id FROM objective_submissions s WHERE s.domain_id IS NULL
    UNION ALL SELECT s.problem_id FROM self_tests s WHERE s.domain_id IS NULL
  ) unassigned JOIN problems p ON p.id = unassigned.problem_id
  WHERE p.domain_id IS NULL OR p.domain_id <> ${DEFAULT_DOMAIN_ID} LIMIT 1`);
  const invalidRows = Array.isArray(invalid)
    ? invalid
    : (invalid as { rows?: unknown[] }).rows ?? [];
  if (invalidRows.length) {
    throw new AppError(
      "存在尚未归属默认题库的历史执行，请先核实题目归属",
      409,
      "EXECUTION_CONTEXT_REQUIRES_REVIEW",
    );
  }
  const invalidJob = await executor.execute(
    sql`SELECT 1 FROM submission_jobs j JOIN submission_job_items i ON i.job_id = j.id WHERE j.domain_id IS NULL AND i.domain_id IS NOT NULL AND i.domain_id <> ${DEFAULT_DOMAIN_ID} LIMIT 1`,
  );
  const invalidJobRows = Array.isArray(invalidJob)
    ? invalidJob
    : (invalidJob as { rows?: unknown[] }).rows ?? [];
  if (invalidJobRows.length) {
    throw new AppError(
      "存在归属冲突的历史批量任务",
      409,
      "EXECUTION_CONTEXT_REQUIRES_REVIEW",
    );
  }
  for (
    const table of [
      "submissions",
      "objective_submissions",
      "self_tests",
      "submission_jobs",
    ]
  ) {
    await executor.execute(
      sql`UPDATE ${
        sql.identifier(table)
      } SET domain_id = ${DEFAULT_DOMAIN_ID} WHERE domain_id IS NULL`,
    );
  }
  await executor.execute(
    sql`UPDATE submission_job_items item SET domain_id = job.domain_id FROM submission_jobs job WHERE job.id = item.job_id AND item.domain_id IS NULL`,
  );
  for (
    const [table, problemColumn] of [
      ["submissions", "problem_id"],
      ["objective_submissions", "paper_id"],
      ["self_tests", "problem_id"],
      ["submission_job_items", "problem_id"],
    ]
  ) {
    await executor.execute(
      sql`UPDATE ${
        sql.identifier(table)
      } target SET domain_problem_binding_id = binding.id FROM domain_problem_bindings binding
      WHERE target.domain_problem_binding_id IS NULL AND binding.domain_id = target.domain_id AND binding.problem_id = target.${
        sql.identifier(problemColumn)
      }`,
    );
  }
  const summaries = await executor.execute(
    sql`SELECT 'submissions' AS kind, count(*) AS total, count(*) FILTER (WHERE domain_id IS NULL OR domain_problem_binding_id IS NULL) AS incomplete FROM submissions
    UNION ALL SELECT 'objective', count(*), count(*) FILTER (WHERE domain_id IS NULL OR domain_problem_binding_id IS NULL) FROM objective_submissions
    UNION ALL SELECT 'self_tests', count(*), count(*) FILTER (WHERE domain_id IS NULL OR domain_problem_binding_id IS NULL) FROM self_tests
    UNION ALL SELECT 'jobs', count(*), count(*) FILTER (WHERE domain_id IS NULL) FROM submission_jobs
    UNION ALL SELECT 'items', count(*), count(*) FILTER (WHERE domain_id IS NULL OR (problem_id <> '' AND domain_problem_binding_id IS NULL)) FROM submission_job_items`,
  );
  const rows = (Array.isArray(summaries) ? summaries : (summaries as {
    rows: Array<
      { kind: string; total: number | string; incomplete: number | string }
    >;
  }).rows) as Array<
    { kind: string; total: number | string; incomplete: number | string }
  >;
  if (rows.some((row) => Number(row.incomplete) > 0)) {
    throw new AppError(
      "执行记录回填不完整，请核实题库绑定；本次事务已回滚",
      409,
      "EXECUTION_BACKFILL_INCOMPLETE",
    );
  }
  return rows.map((row) => ({
    kind: row.kind,
    total: Number(row.total),
    incomplete: Number(row.incomplete),
  }));
}
