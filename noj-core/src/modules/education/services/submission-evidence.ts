import {
  activeClassmateCondition,
  assertClassroomPeer,
  assignmentHasEnded,
} from "./peer-access.ts";
import { unendedPublicContestForProblem } from "../../access/contest-policy.ts";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import {
  assignmentItems,
  assignmentRecipients,
} from "../../../shared/db/schema.ts";
import { loadBindingAvailability } from "../../problems/contracts/cross-module/services_workspace_binding-availability.ts";
import {
  oiVerdict,
  projectOiDetails,
} from "../../evaluations/contracts/cross-module/services_submissions_oi-details.ts";
import { endedWindowCondition } from "../../contests/contracts/cross-module/services_contest-window.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { assertClassroomCapability } from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";
import type { ProgressScope } from "./progress-read.ts";
import {
  getClassroomStudentSubmission,
  selectTeachingSubmissions,
  type StudentSubmissionRow,
  teachingSubmissionDto,
  type TeachingSubmissionKind,
  teachingSubmissionRelation,
  teachingSubmissionSources,
} from "./student-submissions.ts";

function pageNumber(page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("提交依据分页格式错误");
  }
  return (page - 1) * 25;
}

/** 单元详情只列此任务实际学生、题目和统计窗的提交，候选依据与学情读取同一正式事实。 */
export async function listAssignmentItemSubmissions(
  slug: string,
  assignmentId: string,
  userId: string,
  itemId: string,
  actorId: string,
  options: { page?: number; scope?: ProgressScope } = {},
) {
  const page = options.page ?? 1,
    offset = pageNumber(page),
    scope = options.scope ?? "on_time";
  if (!["on_time", "current"].includes(scope)) {
    throw new BadRequestError("统计范围格式错误");
  }
  const db = getDb(),
    access = await loadAssignment(slug, assignmentId, actorId);
  if (!access.staff) {
    // 本人仍须是当前在班学生；只有查看他人时才要求作业已结束或具备教学权限。
    assertClassroomPeer(access);
    if (userId !== actorId && !assignmentHasEnded(access.assignment)) {
      assertClassroomCapability(access, "submissions:read");
    }
  }
  const [recipient] = await db.select().from(assignmentRecipients).where(and(
    eq(assignmentRecipients.assignment_id, assignmentId),
    eq(assignmentRecipients.user_id, userId),
  ));
  const [item] = await db.select().from(assignmentItems).where(and(
    eq(assignmentItems.assignment_id, assignmentId),
    eq(assignmentItems.id, itemId),
  ));
  if (!recipient || !item || !access.assignment.published_at) {
    throw new NotFoundError("作业单元不存在");
  }
  const [binding] = await loadBindingAvailability(db, access.domain.id, [
    item.binding_id,
  ]);
  const condition = sql`${
    teachingSubmissionRelation(access)
  } AND s.user_id = ${userId} AND s.problem_id = ${item.problem_id}
    ${
    access.staff
      ? sql``
      : sql`AND ${
        activeClassmateCondition(access)
      } AND ${recipient.status} = 'active' AND NOT ${
        unendedPublicContestForProblem(
          sql`s.problem_id`,
          sql`${access.domain.id}`,
        )
      }`
  }
    AND (${access.assignment.include_previous_submissions} OR s.created_at >= ${access.assignment.published_at})
    AND (${access.assignment.submission_source} = 'domain_any' OR
      (s.assignment_id = ${assignmentId} AND s.assignment_item_id = ${itemId} AND s.created_at >= ${access.assignment.published_at}))
    AND (${access.assignment.archived_at}::text IS NULL OR s.created_at <= ${access.assignment.archived_at})
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(${
    JSON.stringify(recipient.credit_intervals)
  }::jsonb) w
      WHERE s.created_at >= w->>'start' AND (w->>'end' IS NULL OR s.created_at <= w->>'end'))
    AND NOT EXISTS (SELECT 1 FROM education_disabled_intervals d WHERE (d.domain_id = s.domain_id OR d.domain_id IS NULL)
      AND s.created_at >= d.started_at AND (d.ended_at IS NULL OR s.created_at < d.ended_at))
    AND NOT EXISTS (SELECT 1 FROM domain_feature_intervals d WHERE d.domain_id = s.domain_id
      AND d.feature IN ('classroom','assignment') AND s.created_at >= d.disabled_at
      AND (d.enabled_at IS NULL OR s.created_at < d.enabled_at))
    ${
    scope === "on_time"
      ? sql`AND (${access.assignment.deadline_at}::text IS NULL OR s.created_at <= ${access.assignment.deadline_at})
      AND (${access.assignment.ended_at}::text IS NULL OR s.created_at <= ${access.assignment.ended_at})`
      : sql``
  }`;
  const [total] = unwrapRows<{ count: number }>(
    await db.execute(sql`SELECT count(*)::int AS count
    FROM ${teachingSubmissionSources} WHERE ${condition}`) as never,
  );
  const rows = unwrapRows<StudentSubmissionRow>(
    await db.execute(sql`${selectTeachingSubmissions(false)}
    WHERE ${condition} ORDER BY s.created_at DESC,s.id DESC,s.kind LIMIT 25 OFFSET ${offset}`) as never,
  );
  const ids = rows.map((row) => row.id);
  const candidates = ids.length
    ? unwrapRows<
      { id: string; kind: TeachingSubmissionKind; attempt_id: string }
    >(
      await db.execute(sql`
    SELECT s.id,s.kind,e.id AS attempt_id FROM ${teachingSubmissionSources}
    JOIN submission_version_results v ON (s.kind='submission' AND v.submission_id=s.id)
      OR (s.kind='objective' AND v.objective_submission_id=s.id)
    JOIN evaluation_attempts e ON e.id=v.current_attempt_id WHERE s.domain_id=${access.domain.id}
      AND s.user_id=${userId} AND s.problem_id=${item.problem_id} AND s.id IN (${
        sql.join(ids.map((id) => sql`${id}`), sql`,`)
      })
      AND e.state='finished' AND e.result_kind='graded' AND e.score IS NOT NULL
      AND (s.contest_id IS NULL OR EXISTS (SELECT 1 FROM contests c WHERE c.id=s.contest_id AND ${
        endedWindowCondition(sql`c.end_time`)
      }))
      AND (${binding.effective_version_mode}='any' OR e.problem_version_id=${binding.required_version_id})`) as never,
    )
    : [];
  if (access.platformAdmin) {
    await workspaceAudit(db, actorId, access.domain.id, "domain.update", {
      operation: "assignment.submissions.read",
      assignment_id: assignmentId,
      item_id: itemId,
      student_id: userId,
    });
  }
  return {
    page,
    per_page: 25,
    total: total.count,
    scope,
    policy: {
      mode: binding.effective_version_mode,
      required_version_id: binding.required_version_id,
      revision: binding.revision,
      resource_available: binding.available,
    },
    data: rows.map((row) => ({
      ...teachingSubmissionDto(row, false),
      candidate_attempt_ids: binding.available
        ? candidates.filter((c) => c.id === row.id && c.kind === row.kind).map((
          c,
        ) => c.attempt_id)
        : [],
    })),
  };
}

/** 正式尝试按原提交分页；只读元数据和现有 OI 白名单，不取 output、平台诊断或客观题判题答案。 */
export async function getTeachingSubmissionAttempts(
  slug: string,
  classroomId: string,
  submissionId: string,
  kind: TeachingSubmissionKind,
  actorId: string,
  page = 1,
) {
  const offset = pageNumber(page), db = getDb();
  const submission = await getClassroomStudentSubmission(
    slug,
    classroomId,
    submissionId,
    kind,
    actorId,
  );
  const [binding] = await loadBindingAvailability(db, submission.domain_id, [
    submission.binding_id,
  ]);
  const source = kind === "submission"
    ? sql`e.submission_id`
    : sql`e.objective_submission_id`;
  const [total] = unwrapRows<{ count: number }>(
    await db.execute(sql`SELECT count(*)::int AS count
    FROM evaluation_attempts e WHERE ${source}=${submissionId}`) as never,
  );
  const rows = unwrapRows<{
    id: string;
    sequence: number;
    source: string;
    state: string;
    result_kind: string | null;
    problem_version_id: string | null;
    created_at: string;
    finished_at: string | null;
    score: number | null;
    accepted: boolean;
    verdict: string | null;
    time_ms: number | null;
    memory_kb: number | null;
    current_formal: boolean;
    matches_policy: boolean;
    oi: unknown;
  }>(
    await db.execute(
      sql`SELECT e.id,e.sequence,e.source,e.state,e.result_kind,e.problem_version_id,e.created_at,e.finished_at,
    CASE WHEN e.result_kind='graded' THEN e.score END AS score,
    e.result_kind='graded' AND e.accepted AS accepted,
    CASE WHEN e.result_kind='graded' THEN e.time_ms END AS time_ms,
    CASE WHEN e.result_kind='graded' THEN e.memory_kb END AS memory_kb,
    CASE WHEN e.result_kind='graded' AND ${kind}='submission' AND pv.content->>'kind'='oi' THEN e.details->'oi'->>'verdict' END AS verdict,
    EXISTS (SELECT 1 FROM submission_version_results v WHERE v.current_attempt_id=e.id) AS current_formal,
    COALESCE((${binding.effective_version_mode}='any' OR e.problem_version_id=${binding.required_version_id}),false) AS matches_policy,
    CASE WHEN ${binding.available} AND e.result_kind='graded' AND ${kind}='submission' AND pv.content->>'kind'='oi' THEN e.details->'oi' END AS oi
    FROM evaluation_attempts e LEFT JOIN problem_versions pv ON pv.id=e.problem_version_id
    WHERE ${source}=${submissionId} ORDER BY e.sequence DESC,e.id LIMIT 25 OFFSET ${offset}`,
    ) as never,
  );
  return {
    page,
    per_page: 25,
    total: total.count,
    resource_available: binding.available,
    data: rows.map(({ oi, verdict, ...row }) => ({
      ...row,
      verdict: oiVerdict({ oi: { verdict } }) ?? null,
      oi: oi === null ? null : projectOiDetails(oi),
    })),
  };
}
