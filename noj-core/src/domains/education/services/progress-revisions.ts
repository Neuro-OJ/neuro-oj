import { inArray } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { queryProjectionRevisions } from "../../../shared/db/schema.ts";
import { educationCellScopes } from "../../../shared/education-events.ts";

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
