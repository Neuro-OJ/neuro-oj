import { inArray, type SQL, sql } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { queryProjectionRevisions } from "../../../shared/db/schema.ts";
import {
  educationCellScopes,
  educationRevisionScope,
} from "../contracts/facts.ts";

/** 矩阵筛选与补题候选共用单元事实版本表达式；i/b/p/g 为同一成绩查询的表别名。 */
export function assignmentCellProjectionStaleSql(
  domainId: string,
  classroomId: string,
  assignmentId: string,
  user: SQL,
) {
  const base = educationRevisionScope(domainId);
  const keys = [
    sql`${base + ":all"}`,
    sql`${base + ":assignment:" + assignmentId}`,
    sql`${base + ":assignment:" + assignmentId + ":user:"} || ${user}`,
    sql`${base + ":class:" + classroomId}`,
    sql`${base + ":class:" + classroomId + ":user:"} || ${user}`,
    sql`${base + ":problem:"} || i.problem_id`,
    sql`${base + ":user:"} || ${user}`,
    sql`${base + ":cell:"} || ${user} || ':' || i.problem_id`,
  ];
  const revision =
    sql`COALESCE((SELECT MAX(q.data_revision) FROM query_projection_revisions q WHERE q.scope_key IN (${
      sql.join(keys, sql`, `)
    })),0)`;
  return sql`g.id IS NULL OR g.projection_revision<${revision} OR g.policy_revision<>b.revision
    OR i.answer_version_id IS DISTINCT FROM CASE WHEN p.effective_version_mode='exact' THEN p.required_version_id ELSE p.latest_version_id END`;
}

/** 当前页所有单元的事实版本批量读取，避免每个单元各发查询。 */
export async function loadEducationCellRevisions(
  executor: Executor,
  domainId: string,
  classroomId: string,
  assignmentId: string,
  userIds: string[],
  problemIds: string[],
) {
  const keys = new Set<string>();
  for (const userId of userIds) {
    for (const problemId of problemIds) {
      for (
        const key of educationCellScopes(
          domainId,
          classroomId,
          assignmentId,
          userId,
          problemId,
        )
      ) keys.add(key);
    }
  }
  const revisions = new Map<string, number>();
  const list = [...keys];
  for (let start = 0; start < list.length; start += 5000) {
    const rows = await executor.select().from(queryProjectionRevisions).where(
      inArray(
        queryProjectionRevisions.scope_key,
        list.slice(start, start + 5000),
      ),
    );
    for (const row of rows) revisions.set(row.scope_key, row.data_revision);
  }
  return (userId: string, problemId: string) =>
    Math.max(
      0,
      ...educationCellScopes(
        domainId,
        classroomId,
        assignmentId,
        userId,
        problemId,
      ).map((key) => revisions.get(key) ?? 0),
    );
}
