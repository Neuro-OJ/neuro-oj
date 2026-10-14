import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  assignmentItems,
  domains,
  problems,
} from "../../../shared/db/schema.ts";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { enqueueEducationRefresh } from "../../../shared/education-events.ts";
import {
  domainProblemReference,
  loadBindingAvailability,
} from "../../catalog/index.ts";
import {
  assertClassroomCapability,
  assertClassroomRevision,
} from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";
import { insertAssignmentDraft } from "./assignments.ts";
import { educationOperation, educationRequestHash } from "./operations.ts";
import { assignmentCellProjectionStaleSql } from "./progress-revisions.ts";
import type { ProgressScope } from "./progress-read.ts";

async function buildPreview(
  access: Awaited<ReturnType<typeof loadAssignment>>,
  scope: ProgressScope,
  tx: Executor,
) {
  assertClassroomCapability(access, "progress:read");
  assertClassroomCapability(access, "assignments:manage");
  if (
    !["on_time", "current"].includes(scope) || !access.assignment.published_at
  ) {
    throw new BadRequestError("补题预览需要已发布作业及有效成绩范围");
  }
  const rows = await tx.select({
    item: assignmentItems,
    problem: {
      id: problems.id,
      domain_id: domains.id,
      number: problems.number,
    },
    source_slug: domains.slug,
  })
    .from(assignmentItems).innerJoin(
      problems,
      eq(problems.id, assignmentItems.problem_id),
    )
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(eq(assignmentItems.assignment_id, access.assignment.id)).orderBy(
      asc(assignmentItems.sort_order),
      assignmentItems.id,
    );
  const available = new Map(
    (await loadBindingAvailability(
      tx,
      access.domain.id,
      rows.map((r) => r.item.binding_id),
    )).map((r) => [r.id, r]),
  );
  const items = rows.map((r) => ({
    id: r.item.id,
    binding_id: r.item.binding_id,
    reference: domainProblemReference(
      r.problem,
      r.source_slug,
      access.domain.id,
    ),
    requirement: r.item.requirement,
    minimum_score: r.item.minimum_score,
    resource_available: available.get(r.item.binding_id)?.available ?? false,
    policy_revision: available.get(r.item.binding_id)?.revision ??
      r.item.policy_revision,
  }));
  const usable = items.filter((i) => i.resource_available).map((i) =>
    i.binding_id
  );
  const availableSql = usable.length
    ? sql`b.id IN (${sql.join(usable.map((id) => sql`${id}`), sql`, `)})`
    : sql`false`;
  const stale = assignmentCellProjectionStaleSql(
    access.domain.id,
    access.classroom.id,
    access.assignment.id,
    sql`r.user_id`,
  );
  const result = await tx.execute(sql`WITH cells AS (
    SELECT r.user_id,u.username,i.id AS item_id,i.sort_order,
      CASE WHEN NOT (${availableSql}) THEN 'unavailable' WHEN ${stale} THEN 'updating' ELSE g.status END AS status
    FROM assignment_recipients r
    JOIN classroom_memberships cm ON cm.classroom_id=r.classroom_id AND cm.user_id=r.user_id AND cm.status='active' AND cm.role='student'
    JOIN domain_memberships dm ON dm.domain_id=r.domain_id AND dm.user_id=r.user_id AND dm.status='active'
    JOIN users u ON u.id=r.user_id AND u.deleted_at IS NULL
    JOIN assignment_items i ON i.assignment_id=r.assignment_id
    JOIN domain_problem_bindings b ON b.id=i.binding_id JOIN problems p ON p.id=i.problem_id
    LEFT JOIN assignment_progress g ON g.assignment_id=r.assignment_id AND g.item_id=i.id AND g.user_id=r.user_id AND g.scope=${scope}
    WHERE r.assignment_id=${access.assignment.id} AND r.status='active'
  ) SELECT user_id,username,
    COALESCE(array_agg(item_id ORDER BY sort_order,item_id) FILTER (WHERE status IN ('not_started','below_target')),ARRAY[]::text[]) AS item_ids,
    count(*) FILTER (WHERE status IN ('judging','updating'))::int AS pending_cells,
    count(*) FILTER (WHERE status='updating')::int AS updating_cells
    FROM cells GROUP BY user_id,username ORDER BY user_id`);
  const candidates = unwrapRows<
    {
      user_id: string;
      username: string;
      item_ids: string[];
      pending_cells: number;
      updating_cells: number;
    }
  >(result as never);
  const [historical] = unwrapRows<{ count: number }>(
    (await tx.execute(
      sql`SELECT count(*)::int AS count FROM assignment_recipients WHERE assignment_id=${access.assignment.id} AND status='historical'`,
    )) as never,
  );
  const preview = {
    source: {
      kind: "assignment" as const,
      id: access.assignment.id,
      title: access.assignment.title,
      revision: access.assignment.revision,
      scope,
    },
    updating: candidates.some((r) => r.updating_cells > 0),
    students: candidates.filter((r) => r.item_ids.length).map((
      { user_id, username, item_ids },
    ) => ({ user_id, username, item_ids })),
    items,
    excluded: {
      pending_cells: candidates.reduce((sum, r) => sum + r.pending_cells, 0),
      unavailable_items: items.filter((i) => !i.resource_available).length,
      historical_students: historical.count,
    },
  };
  return {
    ...preview,
    preview_token: await educationRequestHash({
      actor_id: access.context.actorId,
      ...preview,
    }),
  };
}

/** 全班候选由数据库聚合；评测中、失效及陈旧口径不标为未达标。 */
export async function previewAssignmentRemediation(
  slug: string,
  id: string,
  actorId: string,
  scope: ProgressScope = "on_time",
) {
  const tx = getDb(), access = await loadAssignment(slug, id, actorId);
  const preview = await buildPreview(access, scope, tx);
  if (preview.updating) await enqueueEducationRefresh(tx, access.domain.id, id);
  return preview;
}

/** 补题创建仍需显式选择学生与题目，并重新检查已预览事实。 */
export interface AssignmentRemediationInput {
  title: string;
  scope: ProgressScope;
  preview_token: string;
  target_student_ids: string[];
  item_ids: string[];
  deadline_at?: string | null;
}

/** 原成绩不修改，所有所选学生收到同一份所选题目的独立草稿。 */
export async function createAssignmentRemediation(
  slug: string,
  id: string,
  actorId: string,
  revision: number | null,
  key: string,
  input: AssignmentRemediationInput,
) {
  return await getDb().transaction(async (tx) => {
    const access = await loadAssignment(slug, id, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCapability(access, "progress:read");
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "assignment.remediation",
      key,
      { id, revision, input },
      async () => {
        assertClassroomRevision(access.assignment.revision, revision);
        const preview = await buildPreview(access, input.scope, tx);
        if (
          input.preview_token !== preview.preview_token
        ) {
          throw new ConflictError(
            "补题候选已变化，请重新预览",
            "REMEDIATION_PREVIEW_CHANGED",
          );
        }
        if (
          !Array.isArray(input.target_student_ids) ||
          !input.target_student_ids.length || !Array.isArray(input.item_ids) ||
          !input.item_ids.length ||
          new Set(input.target_student_ids).size !==
            input.target_student_ids.length ||
          new Set(input.item_ids).size !== input.item_ids.length
        ) {
          throw new BadRequestError("请选择不同的学生及题目");
        }
        const chosen = new Set(input.item_ids);
        const eligible = new Set(
          preview.students.filter((s) => s.item_ids.some((i) => chosen.has(i)))
            .map((s) => s.user_id),
        );
        const candidates = new Set(preview.students.flatMap((s) => s.item_ids));
        if (
          input.target_student_ids.some((userId) => !eligible.has(userId)) ||
          input.item_ids.some((itemId) => !candidates.has(itemId))
        ) {
          throw new BadRequestError("所选学生与题目不属于当前未达标候选");
        }
        const result = await insertAssignmentDraft(
          tx,
          access,
          {
            title: input.title,
            deadline_at: input.deadline_at,
            target_student_ids: input.target_student_ids,
            items: preview.items.filter((i) => chosen.has(i.id)).map((i) => ({
              binding_id: i.binding_id,
              requirement: i.requirement,
              minimum_score: i.minimum_score,
            })),
          },
          id,
        );
        return result;
      },
    );
  });
}
