import { sql } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { endedWindowCondition } from "../../contest/index.ts";
import type { EducationCandidate } from "./progress-selection.ts";

/** 只按作业域、题目、实际学生和时间索引读取，不扫描全实例提交。 */
export async function loadAssignmentCandidates(
  executor: Executor,
  assignmentId: string,
  userIds: string[],
) {
  if (!userIds.length) return [];
  const userCondition = sql.join(userIds.map((id) => sql`${id}`), sql`, `);
  const rows = await executor.execute(sql`WITH sources AS (
    SELECT s.id AS submission_id, 'submission' AS source_kind, s.domain_id, s.problem_id, s.user_id,
      s.created_at AS received_at, s.receipt_sequence, s.contest_id, s.active_attempt_id
    FROM submissions s JOIN assignment_items i ON i.problem_id = s.problem_id AND i.domain_id = s.domain_id
    WHERE i.assignment_id = ${assignmentId} AND s.user_id IN (${userCondition})
    UNION ALL
    SELECT s.id, 'objective', s.domain_id, s.paper_id, s.user_id, s.created_at, s.receipt_sequence,
      s.contest_id, s.active_attempt_id
    FROM objective_submissions s JOIN assignment_items i ON i.problem_id = s.paper_id AND i.domain_id = s.domain_id
    WHERE i.assignment_id = ${assignmentId} AND s.user_id IN (${userCondition})
  ), eligible AS (
    SELECT s.*, i.binding_id, a.deadline_at, a.ended_at FROM sources s
    JOIN assignment_items i ON i.assignment_id = ${assignmentId} AND i.domain_id = s.domain_id AND i.problem_id = s.problem_id
    JOIN assignments a ON a.id = i.assignment_id
    JOIN assignment_recipients r ON r.assignment_id = a.id AND r.user_id = s.user_id
    JOIN classrooms class ON class.id = a.classroom_id
    WHERE a.published_at IS NOT NULL AND (a.include_previous_submissions OR s.received_at >= a.published_at)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.credit_intervals) w
        WHERE s.received_at >= w->>'start' AND (w->>'end' IS NULL OR s.received_at <= w->>'end'))
      AND (a.archived_at IS NULL OR s.received_at <= a.archived_at)
      AND (class.archived_at IS NULL OR s.received_at <= class.archived_at)
      AND NOT EXISTS (SELECT 1 FROM education_disabled_intervals d WHERE (d.domain_id = s.domain_id OR d.domain_id IS NULL)
        AND s.received_at >= d.started_at AND (d.ended_at IS NULL OR s.received_at < d.ended_at))
      AND NOT EXISTS (SELECT 1 FROM domain_feature_intervals d WHERE d.domain_id = s.domain_id
        AND d.feature IN ('classroom', 'assignment') AND s.received_at >= d.disabled_at
        AND (d.enabled_at IS NULL OR s.received_at < d.enabled_at))
      AND (s.contest_id IS NULL OR EXISTS (SELECT 1 FROM contests c WHERE c.id = s.contest_id
        AND ${endedWindowCondition(sql`c.end_time`)}))
  ), graded AS (
    SELECT s.submission_id, s.source_kind, s.user_id, s.problem_id, s.received_at, s.receipt_sequence,
      e.id AS attempt_id, e.problem_version_id AS version_id, e.score, e.accepted, false AS pending, scope.name AS scope
    FROM eligible s JOIN domain_problem_bindings b ON b.id = s.binding_id
    JOIN submission_version_results v ON (s.source_kind = 'submission' AND v.submission_id = s.submission_id)
      OR (s.source_kind = 'objective' AND v.objective_submission_id = s.submission_id)
    JOIN evaluation_attempts e ON e.id = v.current_attempt_id
    CROSS JOIN (VALUES ('on_time'), ('current')) AS scope(name)
    WHERE e.problem_id = s.problem_id AND e.state = 'finished' AND e.result_kind = 'graded' AND e.score IS NOT NULL
      AND (scope.name = 'current' OR s.deadline_at IS NULL OR s.received_at <= s.deadline_at)
      AND (scope.name = 'current' OR s.ended_at IS NULL OR s.received_at <= s.ended_at)
      AND (b.effective_version_mode = 'any' OR e.problem_version_id = b.required_version_id)
  ), pending AS (
    SELECT s.submission_id, s.source_kind, s.user_id, s.problem_id, s.received_at, s.receipt_sequence,
      NULL::text AS attempt_id, e.problem_version_id AS version_id, NULL::integer AS score, false AS accepted, true AS pending, scope.name AS scope
    FROM eligible s JOIN domain_problem_bindings b ON b.id = s.binding_id
    JOIN evaluation_attempts e ON e.id = s.active_attempt_id
    CROSS JOIN (VALUES ('on_time'), ('current')) AS scope(name)
    WHERE e.state IN ('queued', 'judging')
      AND (scope.name = 'current' OR s.deadline_at IS NULL OR s.received_at <= s.deadline_at)
      AND (scope.name = 'current' OR s.ended_at IS NULL OR s.received_at <= s.ended_at)
      AND (b.effective_version_mode = 'any' OR e.problem_version_id = b.required_version_id)
  ), ranked AS (
    SELECT g.*, row_number() OVER (PARTITION BY user_id, problem_id, scope
      ORDER BY score DESC, receipt_sequence, attempt_id) AS best_rank,
      row_number() OVER (PARTITION BY user_id, problem_id, scope
      ORDER BY accepted DESC, score DESC, receipt_sequence, attempt_id) AS accepted_rank FROM graded g
  ), selected AS (
    SELECT submission_id, source_kind, user_id, problem_id, received_at, receipt_sequence,
      attempt_id, version_id, score, accepted, pending, scope FROM ranked
    WHERE best_rank = 1 OR (accepted = true AND accepted_rank = 1)
    UNION ALL
    (SELECT DISTINCT ON (user_id, problem_id, scope) * FROM pending
    ORDER BY user_id, problem_id, scope, receipt_sequence)
  ) SELECT * FROM selected`);
  return unwrapRows<EducationCandidate>(rows as never).map((row) => ({
    ...row,
    receipt_sequence: Number(row.receipt_sequence),
  }));
}
