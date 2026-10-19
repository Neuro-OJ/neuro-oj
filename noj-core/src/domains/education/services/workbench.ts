import { type SQL, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  educationRevisionScope,
  enqueueEducationRefresh,
} from "../../../shared/education-events.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import { domainProblemBindingAvailableWhere } from "../../catalog/index.ts";
import type {
  AssignmentState,
  AssistantCapability,
} from "../../../shared/education-types.ts";

/** 班级能力在分页前筛选，每次读取当前任职和助教授权。 */
function teachingCapability(
  actorId: string,
  managesDomain: boolean,
  capability: AssistantCapability,
): SQL {
  void actorId;
  void capability;
  return sql`${managesDomain}`;
}

/** 与单元读取相同的八种持久事实范围，不将陈旧投影计为当前未达标。 */
function currentCellRevision(domainId: string): SQL {
  const base = educationRevisionScope(domainId);
  const keys = [
    sql`${base + ":all"}`,
    sql`${base + ":assignment:"} || a.id`,
    sql`${base + ":assignment:"} || a.id || ':user:' || r.user_id`,
    sql`${base + ":class:"} || a.classroom_id`,
    sql`${base + ":class:"} || a.classroom_id || ':user:' || r.user_id`,
    sql`${base + ":problem:"} || i.problem_id`,
    sql`${base + ":user:"} || r.user_id`,
    sql`${base + ":cell:"} || r.user_id || ':' || i.problem_id`,
  ];
  return sql`COALESCE((SELECT MAX(q.data_revision) FROM query_projection_revisions q
    WHERE q.scope_key IN (${sql.join(keys, sql`, `)})), 0)`;
}

export interface EducationWorkbenchAssignment {
  id: string;
  title: string;
  classroom_id: string;
  classroom_name: string;
  state: AssignmentState;
  published_at: string | null;
  deadline_at: string | null;
  ended_at: string | null;
  summary: {
    total_students: number | null;
    total_items: number;
    achieved_cells: number | null;
    below_target_students: number | null;
    unavailable_items: number;
    updating: boolean;
  };
}

/** 聚合教学任务和本人学习，不在浏览器逐班请求矩阵。 */
export async function getEducationWorkbench(
  slug: string,
  actorId: string,
  mode: "teaching" | "learning",
  page = 1,
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("工作台页码无效");
  }
  const workspace = await loadWorkspace(slug, actorId), db = getDb();
  const domainId = workspace.domain.id,
    managesDomain = workspace.platformAdmin ||
      workspace.context.domainPermissions.has("classroom:manage_any");
  const canProgress = teachingCapability(
    actorId,
    managesDomain,
    "progress:read",
  );
  const canManage = teachingCapability(
    actorId,
    managesDomain,
    "assignments:manage",
  );
  const canHelp = teachingCapability(actorId, managesDomain, "help:manage");
  const learning = mode === "learning";
  const visible = learning
    ? sql`a.published_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM assignment_recipients self_recipient WHERE self_recipient.assignment_id = a.id
      AND self_recipient.user_id = ${actorId})`
    : sql`(${canProgress} OR ${canManage})`;
  type Task = Omit<EducationWorkbenchAssignment, "summary"> & {
    can_progress: boolean;
  };
  const [totals, tasks, help] = await Promise.all([
    db.execute(sql`SELECT COUNT(*)::integer AS total FROM assignments a
      JOIN classrooms c ON c.id = a.classroom_id WHERE a.domain_id = ${domainId} AND ${visible}`),
    db.execute(
      sql`SELECT a.id, a.title, a.classroom_id, c.name AS classroom_name, a.state,
      a.published_at, a.deadline_at, a.ended_at, ${
        learning ? sql`true` : canProgress
      } AS can_progress
      FROM assignments a JOIN classrooms c ON c.id = a.classroom_id
      WHERE a.domain_id = ${domainId} AND ${visible}
      ORDER BY (a.state = 'archived'), a.deadline_at NULLS LAST, a.created_at DESC, a.id
      LIMIT 20 OFFSET ${(page - 1) * 20}`,
    ),
    db.execute(
      sql`SELECT h.id, h.assignment_id, a.title AS assignment_title, a.classroom_id,
      c.name AS classroom_name, h.state, h.created_at
      FROM assignment_help_requests h JOIN assignments a ON a.id = h.assignment_id
      JOIN classrooms c ON c.id = a.classroom_id WHERE h.domain_id = ${domainId}
      AND h.state = 'open' AND ${
        learning ? sql`h.user_id = ${actorId}` : canHelp
      }
      ORDER BY h.created_at, h.id LIMIT 20`,
    ),
  ]);
  const rows = unwrapRows<Task>(tasks as never),
    ids = rows.map((row) => row.id);
  type Summary = {
    id: string;
    total_students: number;
    total_items: number;
    achieved_cells: number;
    below_target_students: number;
    unavailable_items: number;
    updating: boolean;
  };
  const summaryRows: Summary[] = [];
  if (ids.length) {
    const available = domainProblemBindingAvailableWhere(
      sql`b.id`,
      sql`a.domain_id`,
      { member: true },
    );
    const stale = sql`g.id IS NULL OR g.projection_revision < ${
      currentCellRevision(domainId)
    }
      OR g.policy_revision <> b.revision OR i.answer_version_id IS DISTINCT FROM
        CASE WHEN b.effective_version_mode = 'exact' THEN b.required_version_id ELSE p.latest_version_id END`;
    const result = await db.execute(sql`WITH cells AS (
      SELECT a.id, i.id AS item_id, r.user_id,
        CASE WHEN NOT (${available}) THEN 'unavailable'
          WHEN r.user_id IS NULL THEN NULL WHEN ${stale} THEN 'updating' ELSE g.status END AS status
      FROM assignments a LEFT JOIN assignment_items i ON i.assignment_id = a.id
      LEFT JOIN domain_problem_bindings b ON b.id = i.binding_id LEFT JOIN problems p ON p.id = i.problem_id
      LEFT JOIN assignment_recipients r ON r.assignment_id = a.id
        ${
      learning ? sql`AND r.user_id = ${actorId}` : sql`AND r.status = 'active'`
    }
      LEFT JOIN assignment_progress g ON g.item_id = i.id AND g.user_id = r.user_id AND g.scope = 'current'
      WHERE a.domain_id = ${domainId} AND a.id IN (${
      sql.join(ids.map((id) => sql`${id}`), sql`, `)
    })
    ) SELECT id, COUNT(DISTINCT user_id)::integer AS total_students,
      COUNT(DISTINCT item_id)::integer AS total_items,
      COUNT(*) FILTER (WHERE status = 'achieved')::integer AS achieved_cells,
      COUNT(DISTINCT user_id) FILTER (WHERE status IN ('below_target', 'not_started'))::integer AS below_target_students,
      COUNT(DISTINCT item_id) FILTER (WHERE status = 'unavailable')::integer AS unavailable_items,
      COALESCE(bool_or(status = 'updating'), false) AS updating FROM cells GROUP BY id`);
    summaryRows.push(...unwrapRows<Summary>(result as never));
  }
  const lookup = new Map(summaryRows.map((row) => [row.id, row]));
  const data = rows.map(({ can_progress, ...row }) => {
    const aggregate = lookup.get(row.id)!;
    const updating = can_progress && row.published_at !== null &&
      aggregate.updating;
    return {
      ...row,
      summary: {
        total_students: !learning && can_progress
          ? aggregate.total_students
          : null,
        total_items: aggregate.total_items,
        achieved_cells: can_progress && !updating
          ? aggregate.achieved_cells
          : null,
        below_target_students: !learning && can_progress && !updating
          ? aggregate.below_target_students
          : null,
        unavailable_items: aggregate.unavailable_items,
        updating,
      },
    };
  });
  // 每页最多 20 个任务，陈旧投影只登记幂等补算；通知丢失不能使进度永久停滞。
  for (const row of data) {
    if (row.summary.updating) {
      await enqueueEducationRefresh(
        db,
        domainId,
        row.id,
        learning ? actorId : undefined,
      );
    }
  }
  return {
    assignments: data,
    help_requests: unwrapRows<
      {
        id: string;
        assignment_id: string;
        assignment_title: string;
        classroom_id: string;
        classroom_name: string;
        state: string;
        created_at: string;
      }
    >(help as never),
    page,
    per_page: 20,
    total: unwrapRows<{ total: number }>(totals as never)[0].total,
  };
}
