import { and, eq, sql } from "drizzle-orm";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentItems,
  assignmentRecipients,
  domains,
  problems,
} from "../../../shared/db/schema.ts";
import { domainProblemReference } from "../../problems/contracts/cross-module/services_workspace_problem-reference.ts";
import { loadBindingAvailability } from "../../problems/contracts/cross-module/services_workspace_binding-availability.ts";
import { endedWindowCondition } from "../../contests/contracts/cross-module/services_contest-window.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { assertClassroomCapability } from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";
import { teachingSubmissionRelation } from "./student-submissions.ts";
import {
  type EducationCandidate,
  selectAssignmentProgress,
} from "./progress-selection.ts";

/** 两个显式时间窗使用 UTC 半开区间，统计训练记录而非原作业截止口径。 */
export interface TrainingComparisonInput {
  before_start: string;
  before_end: string;
  after_start: string;
  after_end: string;
}

function comparisonWindows(input: TrainingComparisonInput) {
  const date = (value: string) => {
    if (
      typeof value !== "string" ||
      !/(Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new BadRequestError("训练时间窗必须包含有效时区");
    }
    return new Date(value).toISOString();
  };
  const values = {
    before_start: date(input.before_start),
    before_end: date(input.before_end),
    after_start: date(input.after_start),
    after_end: date(input.after_end),
  };
  if (
    values.before_start >= values.before_end ||
    values.after_start >= values.after_end ||
    values.before_end > values.after_start
  ) {
    throw new BadRequestError("训练前后时间窗必须按顺序排列且不重叠");
  }
  return values;
}

type ComparisonRow = {
  item_id: string;
  window: "before" | "after";
  submitted_count: number;
  candidate_count: number;
  pending_count: number;
  version_mismatch_count: number;
  best: EducationCandidate | null;
  passed: EducationCandidate | null;
};

/** 只比较目标学生同域任务题目；当前正式版本结果和权威通过分别选取。 */
export async function getTrainingComparison(
  slug: string,
  assignmentId: string,
  userId: string,
  actorId: string,
  input: TrainingComparisonInput,
) {
  const windows = comparisonWindows(input), db = getDb();
  const access = await loadAssignment(slug, assignmentId, actorId);
  if (!access.assignment.published_at) {
    throw new BadRequestError("训练比较需要已发布作业");
  }
  if (userId !== actorId) assertClassroomCapability(access, "progress:read");
  const [recipient] = await db.select().from(assignmentRecipients).where(and(
    eq(assignmentRecipients.assignment_id, assignmentId),
    eq(assignmentRecipients.user_id, userId),
  ));
  if (!recipient) throw new NotFoundError("学生不是此作业的接收者");
  const items = await db.select({
    item: assignmentItems,
    problem: {
      id: problems.id,
      number: problems.number,
      domain_id: problems.domain_id,
    },
    source_slug: domains.slug,
  }).from(assignmentItems).innerJoin(
    problems,
    eq(problems.id, assignmentItems.problem_id),
  )
    .innerJoin(domains, eq(domains.id, problems.domain_id)).where(
      eq(assignmentItems.assignment_id, assignmentId),
    ).orderBy(assignmentItems.sort_order);
  if (!items.length) throw new NotFoundError("已发布任务没有可比较的题目");
  const policy = await loadBindingAvailability(
    db,
    access.domain.id,
    items.map((row) => row.item.binding_id),
  );
  const policies = new Map(policy.map((row) => [row.id, row]));
  const policyRows = sql.join(
    policy.map((row) =>
      sql`(${row.id}::text,${row.effective_version_mode}::text,${row.required_version_id}::text)`
    ),
    sql`, `,
  );
  const rows = await db.execute(
    sql`WITH policy(binding_id, mode, required_version_id) AS (VALUES ${policyRows}),
    windows(name, start_at, end_at) AS (VALUES ('before', ${windows.before_start}::timestamptz, ${windows.before_end}::timestamptz),
      ('after', ${windows.after_start}::timestamptz, ${windows.after_end}::timestamptz)),
    sources AS (
      SELECT id, 'submission'::text AS kind, domain_id, user_id, problem_id, created_at, receipt_sequence, contest_id, active_attempt_id, assignment_id, assignment_item_id
      FROM submissions WHERE domain_id = ${access.domain.id} AND user_id = ${userId}
        AND created_at::timestamptz >= ${windows.before_start}::timestamptz AND created_at::timestamptz < ${windows.after_end}::timestamptz
      UNION ALL SELECT id, 'objective', domain_id, user_id, paper_id, created_at, receipt_sequence, contest_id, active_attempt_id, assignment_id, assignment_item_id
      FROM objective_submissions WHERE domain_id = ${access.domain.id} AND user_id = ${userId}
        AND created_at::timestamptz >= ${windows.before_start}::timestamptz AND created_at::timestamptz < ${windows.after_end}::timestamptz
    ), eligible AS (
      SELECT s.*, i.id AS item_id, w.name AS period, p.mode, p.required_version_id
      FROM sources s JOIN assignment_items i ON i.problem_id = s.problem_id AND i.domain_id = s.domain_id AND i.assignment_id = ${assignmentId}
      JOIN policy p ON p.binding_id = i.binding_id JOIN windows w ON s.created_at::timestamptz >= w.start_at AND s.created_at::timestamptz < w.end_at
      WHERE ${
      teachingSubmissionRelation(access)
    } AND (s.contest_id IS NULL OR EXISTS
        (SELECT 1 FROM contests c WHERE c.id = s.contest_id AND ${
      endedWindowCondition(sql`c.end_time`)
    }))
    ), graded AS (
      SELECT s.*, e.id AS attempt_id, e.problem_version_id AS version_id, e.score, e.accepted,
        (s.mode = 'any' OR e.problem_version_id = s.required_version_id) AS matches_policy
      FROM eligible s JOIN submission_version_results v ON
        (s.kind = 'submission' AND v.submission_id = s.id) OR (s.kind = 'objective' AND v.objective_submission_id = s.id)
      JOIN evaluation_attempts e ON e.id = v.current_attempt_id
      WHERE e.problem_id = s.problem_id AND e.state = 'finished' AND e.result_kind = 'graded' AND e.score IS NOT NULL
    ), ranked AS (
      SELECT g.*, row_number() OVER (PARTITION BY item_id, period ORDER BY score DESC, receipt_sequence, attempt_id) AS best_rank,
        row_number() OVER (PARTITION BY item_id, period ORDER BY accepted DESC, score DESC, receipt_sequence, attempt_id) AS passed_rank
      FROM graded g WHERE matches_policy
    ), counts AS (
      SELECT s.item_id, s.period, count(*)::int AS submitted_count,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM graded g WHERE g.id = s.id AND g.kind = s.kind AND g.matches_policy))::int AS candidate_count,
        count(*) FILTER (WHERE active.state IN ('queued','judging') AND (s.mode = 'any' OR active.problem_version_id = s.required_version_id))::int AS pending_count,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM graded g WHERE g.id = s.id AND g.kind = s.kind) AND NOT EXISTS
          (SELECT 1 FROM graded g WHERE g.id = s.id AND g.kind = s.kind AND g.matches_policy))::int AS version_mismatch_count
      FROM eligible s LEFT JOIN evaluation_attempts active ON active.id = s.active_attempt_id GROUP BY s.item_id, s.period
    ) SELECT i.id AS item_id, w.name AS "window", COALESCE(c.submitted_count, 0) AS submitted_count,
      COALESCE(c.candidate_count,0) AS candidate_count, COALESCE(c.pending_count,0) AS pending_count,
      COALESCE(c.version_mismatch_count,0) AS version_mismatch_count,
      (SELECT jsonb_build_object('submission_id', r.id, 'source_kind', r.kind, 'user_id', r.user_id, 'problem_id', r.problem_id,
        'scope', 'current', 'received_at', r.created_at, 'receipt_sequence', r.receipt_sequence, 'attempt_id', r.attempt_id,
        'version_id', r.version_id, 'score', r.score, 'accepted', r.accepted, 'pending', false) FROM ranked r
        WHERE r.item_id = i.id AND r.period = w.name AND r.best_rank = 1) AS best,
      (SELECT jsonb_build_object('submission_id', r.id, 'source_kind', r.kind, 'user_id', r.user_id, 'problem_id', r.problem_id,
        'scope', 'current', 'received_at', r.created_at, 'receipt_sequence', r.receipt_sequence, 'attempt_id', r.attempt_id,
        'version_id', r.version_id, 'score', r.score, 'accepted', r.accepted, 'pending', false) FROM ranked r
        WHERE r.item_id = i.id AND r.period = w.name AND r.accepted AND r.passed_rank = 1) AS passed
      FROM assignment_items i CROSS JOIN windows w LEFT JOIN counts c ON c.item_id = i.id AND c.period = w.name
      WHERE i.assignment_id = ${assignmentId} ORDER BY i.sort_order,w.name`,
  );
  const result = unwrapRows<ComparisonRow>(rows as never);
  const details = items.map(({ item, problem, source_slug }) => {
    const binding = policies.get(item.binding_id)!;
    const window = (name: "before" | "after") => {
      const row = result.find((r) =>
        r.item_id === item.id && r.window === name
      )!;
      const candidates = [row.best, row.passed].filter((
        r,
      ): r is EducationCandidate => r !== null);
      const progress = selectAssignmentProgress(
        candidates,
        item.requirement,
        item.minimum_score,
        binding.available,
        null,
      );
      return {
        submitted_count: row.submitted_count,
        candidate_count: row.candidate_count,
        pending_count: row.pending_count,
        version_mismatch_count: row.version_mismatch_count,
        score: progress.score,
        accepted: progress.accepted,
        achieved: item.requirement === "accepted"
          ? progress.accepted
          : progress.score !== null && progress.score >= item.minimum_score!,
        best: row.best,
        passed: row.passed,
      };
    };
    const before = window("before"), after = window("after");
    return {
      item_id: item.id,
      reference: domainProblemReference(
        { ...problem, domain_id: problem.domain_id! },
        source_slug,
        access.domain.id,
      ),
      requirement: item.requirement,
      minimum_score: item.minimum_score,
      resource_available: binding.available,
      policy: {
        mode: binding.effective_version_mode,
        required_version_id: binding.required_version_id,
        revision: binding.revision,
        answer_version_id: binding.answer_version_id,
      },
      before,
      after,
      score_change: before.score !== null && after.score !== null
        ? after.score - before.score
        : null,
    };
  });
  const summary = (name: "before" | "after") => ({
    accepted_items: details.filter((row) => row[name].accepted).length,
    achieved_items: details.filter((row) => row[name].achieved).length,
    scored_items: details.filter((row) => row[name].score !== null).length,
    submitted_count: details.reduce(
      (sum, row) => sum + row[name].submitted_count,
      0,
    ),
    candidate_count: details.reduce(
      (sum, row) => sum + row[name].candidate_count,
      0,
    ),
  });
  if (access.platformAdmin) {
    await workspaceAudit(db, actorId, access.domain.id, "domain.update", {
      operation: "training.comparison.read",
      assignment_id: assignmentId,
      student_id: userId,
      windows,
    });
  }
  return {
    assignment_id: assignmentId,
    user_id: userId,
    domain_id: access.domain.id,
    windows,
    interval: "[start,end)" as const,
    strategy: "current_domain_policy" as const,
    computed_at: new Date().toISOString(),
    interpretation:
      "两段时间窗内的同域训练记录比较，不替代原作业成绩，也不表示能力评价。",
    before: summary("before"),
    after: summary("after"),
    items: details,
  };
}

/** Web与测试共享训练记录比较的只读契约。 */
export type TrainingComparison = Awaited<
  ReturnType<typeof getTrainingComparison>
>;
