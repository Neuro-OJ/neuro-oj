import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentItems,
  assignmentRecipients,
} from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { assignmentCellProjectionStaleSql } from "./progress-revisions.ts";
import { loadBindingAvailability } from "../../../modules/problems/index.ts";
import {
  OI_VERDICTS,
  type OiVerdict,
} from "../../../modules/evaluations/index.ts";
import {
  ASSIGNMENT_PROGRESS_STATES,
  type AssignmentProgressStatus,
} from "../../../shared/education-types.ts";
import type { loadAssignment } from "./assignment-access.ts";

/** 状态及判定筛选均使用允许公开的正式事实，过期投影不会当作当前成绩筛选。 */
export interface MatrixFilters {
  student_id?: string;
  item_id?: string;
  status?: AssignmentProgressStatus | "updating";
  verdict?: OiVerdict;
}

/** 在分页前选择具有匹配单元的学生，保持列表数量与权限一致。 */
export async function matrixStudentFilter(
  access: Awaited<ReturnType<typeof loadAssignment>>,
  scope: "on_time" | "current",
  filters: MatrixFilters,
) {
  if (
    [filters.student_id, filters.item_id].some((value) =>
      value !== undefined &&
      (typeof value !== "string" || !value || value.length > 120)
    ) ||
    filters.status !== undefined &&
      ![...ASSIGNMENT_PROGRESS_STATES, "updating"].includes(filters.status) ||
    filters.verdict !== undefined && !OI_VERDICTS.includes(filters.verdict)
  ) throw new BadRequestError("学生、题目、状态或判定筛选格式错误");
  if (!filters.item_id && !filters.status && !filters.verdict) return undefined;
  const db = getDb(), id = access.assignment.id;
  const items = await db.select().from(assignmentItems).where(
    eq(assignmentItems.assignment_id, id),
  );
  if (filters.item_id && !items.some((item) => item.id === filters.item_id)) {
    throw new BadRequestError("所选题目不属于此作业");
  }
  if (!filters.status && !filters.verdict) return undefined;
  const available = (await loadBindingAvailability(
    db,
    access.domain.id,
    items.map((i) => i.binding_id),
  ))
    .filter((item) => item.available).map((item) => item.id);
  const resourceAvailable = available.length
    ? sql`b.id IN (${sql.join(available.map((id) => sql`${id}`), sql`, `)})`
    : sql`false`;
  const user = assignmentRecipients.user_id;
  const stale = assignmentCellProjectionStaleSql(
    access.domain.id,
    access.classroom.id,
    id,
    sql`${user}`,
  );
  const status = sql`CASE WHEN NOT (${resourceAvailable}) THEN 'unavailable'
    WHEN ${stale} THEN 'updating' ELSE g.status END`;
  return sql`EXISTS (SELECT 1 FROM assignment_items i
    JOIN domain_problem_bindings b ON b.id = i.binding_id JOIN problems p ON p.id = i.problem_id
    LEFT JOIN assignment_progress g ON g.item_id = i.id AND g.user_id = ${user} AND g.scope = ${scope}
    LEFT JOIN evaluation_attempts e ON e.id = g.source_attempt_id
    WHERE i.assignment_id = ${id}
      ${filters.item_id ? sql`AND i.id = ${filters.item_id}` : sql``}
      ${filters.status ? sql`AND (${status}) = ${filters.status}` : sql``}
      ${
    filters.verdict
      ? sql`AND NOT (${stale}) AND e.details->'oi'->>'verdict' = ${filters.verdict}`
      : sql``
  })`;
}
