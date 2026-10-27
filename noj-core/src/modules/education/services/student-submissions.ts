import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { oiVerdict } from "../../evaluations/contracts/cross-module/services_submissions_oi-details.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { assertClassroomCapability, loadClassroom } from "./access.ts";

/** 教学提交列表涵盖普通与客观题；账号及域归属始终来自路径和授权关系。 */
export type TeachingSubmissionKind = "submission" | "objective";
export type StudentSubmissionRow = {
  id: string;
  kind: TeachingSubmissionKind;
  domain_id: string;
  user_id: string;
  problem_id: string;
  binding_id: string;
  source_slug: string;
  source_domain_id: string;
  number: number;
  contest_id: string | null;
  created_at: string;
  submitted_version_id: string | null;
  language: string | null;
  status: string;
  score: number | null;
  accepted: boolean;
  code: string | null;
  answers: unknown;
  file_name: string | null;
  has_artifact: boolean;
  verdict_details: unknown;
  time_ms: number | null;
  memory_kb: number | null;
};

/** 同域学生关系、历史任务／批注依据及比赛保密共同约束源码访问。 */
export function teachingSubmissionRelation(
  access: Awaited<ReturnType<typeof loadClassroom>>,
) {
  const classroom = access.classroom.id, domain = access.domain.id;
  const organizes = access.platformAdmin ||
    access.context.domainPermissions.has("contest:manage");
  const managesOwn = access.context.domainPermissions.has("contest:manage_own");
  return sql`
    s.domain_id = ${domain} AND (
      EXISTS (SELECT 1 FROM classroom_memberships cm JOIN domain_memberships dm
        ON dm.domain_id = cm.domain_id AND dm.user_id = cm.user_id
        JOIN users u ON u.id = cm.user_id
        WHERE cm.classroom_id = ${classroom} AND cm.user_id = s.user_id
          AND cm.role = 'student' AND cm.status = 'active' AND dm.status = 'active' AND u.deleted_at IS NULL)
      OR (s.kind = 'submission' AND EXISTS (SELECT 1 FROM submission_annotations n
        WHERE n.domain_id = ${domain} AND n.classroom_id = ${classroom}
          AND n.submission_id = s.id AND n.user_id = s.user_id))
      OR EXISTS (SELECT 1 FROM assignment_recipients r JOIN assignments a ON a.id = r.assignment_id
        JOIN assignment_items i ON i.assignment_id = a.id
        WHERE r.classroom_id = ${classroom} AND r.user_id = s.user_id
          AND i.problem_id = s.problem_id AND a.published_at IS NOT NULL
          AND (a.submission_source = 'domain_any' OR
            (s.assignment_id = a.id AND s.assignment_item_id = i.id AND s.created_at >= a.published_at))
          AND (a.include_previous_submissions OR s.created_at >= a.published_at)
          AND (a.archived_at IS NULL OR s.created_at <= a.archived_at)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.credit_intervals) interval
            WHERE s.created_at >= interval->>'start' AND (interval->>'end' IS NULL OR s.created_at <= interval->>'end')))
    ) AND (${access.classroom.archived_at}::text IS NULL OR s.created_at <= ${access.classroom.archived_at})
    AND (s.contest_id IS NULL OR EXISTS (SELECT 1 FROM contests c
      WHERE c.id = s.contest_id AND c.domain_id = ${domain}
        AND (c.end_time::timestamptz <= NOW() OR ${organizes} OR (${managesOwn} AND c.created_by = ${access.context.actorId}))))`;
}

export const teachingSubmissionSources = sql`(
  SELECT id, 'submission'::text AS kind, domain_id, user_id, problem_id,
    domain_problem_binding_id AS binding_id, contest_id, created_at, submitted_version_id,
    language, status, is_valid, is_accepted, effective_attempt_id, assignment_id, assignment_item_id,
    code, NULL::jsonb AS answers, file_name, artifact_storage_url IS NOT NULL AS has_artifact
  FROM submissions
  UNION ALL
  SELECT id, 'objective'::text, domain_id, user_id, paper_id,
    domain_problem_binding_id, contest_id, created_at, submitted_version_id,
    NULL::text, status, is_valid, is_accepted, effective_attempt_id, assignment_id, assignment_item_id,
    NULL::text, answers, NULL::text, false
  FROM objective_submissions
) s`;

export function teachingSubmissionDto(
  row: StudentSubmissionRow,
  detail: boolean,
) {
  const { verdict_details, code, answers, ...metadata } = row;
  return {
    ...metadata,
    display_ref: row.source_domain_id === row.domain_id
      ? String(row.number)
      : `${row.source_slug}:${row.number}`,
    verdict: oiVerdict(verdict_details) ?? null,
    ...(detail ? { code: row.has_artifact ? null : code, answers } : {}),
  };
}

export function selectTeachingSubmissions(detail: boolean) {
  return sql`SELECT s.id, s.kind, s.domain_id, s.user_id, s.problem_id, s.binding_id,
    src.slug AS source_slug, src.id AS source_domain_id, p.number, s.contest_id, s.created_at, s.submitted_version_id,
    s.language, s.status, CASE WHEN s.is_valid THEN e.score END AS score,
    s.is_valid AND s.is_accepted AS accepted, s.file_name, s.has_artifact,
    CASE WHEN s.is_valid THEN jsonb_build_object('oi', jsonb_build_object('verdict', e.details->'oi'->'verdict')) END AS verdict_details,
    CASE WHEN s.is_valid THEN e.time_ms END AS time_ms,
    CASE WHEN s.is_valid THEN e.memory_kb END AS memory_kb,
    ${detail ? sql`s.code` : sql`NULL::text`} AS code,
    ${detail ? sql`s.answers` : sql`NULL::jsonb`} AS answers
    FROM ${teachingSubmissionSources} JOIN problems p ON p.id = s.problem_id JOIN domains src ON src.id = p.domain_id
    LEFT JOIN evaluation_attempts e ON e.id = s.effective_attempt_id`;
}

/** 当前班级学生可读取全部同域练习；离班后仅保留该班已有作业依据，不获得后续练习。 */
export async function listClassroomStudentSubmissions(
  slug: string,
  classroomId: string,
  userId: string,
  actorId: string,
  options: { page?: number; kind?: TeachingSubmissionKind } = {},
) {
  const access = await loadClassroom(slug, classroomId, actorId);
  assertClassroomCapability(access, "submissions:read");
  const page = options.page ?? 1;
  if (
    !Number.isSafeInteger(page) || page < 1 || page > 100000 ||
    options.kind !== undefined &&
      !["submission", "objective"].includes(options.kind)
  ) throw new BadRequestError("提交分页或类型格式错误");
  const db = getDb();
  const condition = sql`${
    teachingSubmissionRelation(access)
  } AND s.user_id = ${userId} ${
    options.kind ? sql`AND s.kind = ${options.kind}` : sql``
  }`;
  const totalResult = await db.execute(
    sql`SELECT count(*)::int AS count FROM ${teachingSubmissionSources} WHERE ${condition}`,
  );
  const [total] = unwrapRows<{ count: number }>(totalResult as never);
  const result = await db.execute(
    sql`${selectTeachingSubmissions(false)} WHERE ${condition}
    ORDER BY s.created_at DESC, s.id DESC, s.kind LIMIT 50 OFFSET ${
      (page - 1) * 50
    }`,
  );
  const rows = unwrapRows<StudentSubmissionRow>(result as never);
  if (access.platformAdmin) {
    await workspaceAudit(db, actorId, access.domain.id, "domain.update", {
      operation: "classroom.submissions.read",
      classroom_id: classroomId,
      student_id: userId,
    });
  }
  return {
    page,
    per_page: 50,
    total: total.count,
    data: rows.map((row) => teachingSubmissionDto(row, false)),
  };
}

/** 源题撤销后仍可读取已授权学生原提交；不返回题面、原始 output/details、存储地址或标准答案。 */
export async function getClassroomStudentSubmission(
  slug: string,
  classroomId: string,
  id: string,
  kind: TeachingSubmissionKind,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId);
  assertClassroomCapability(access, "submissions:read");
  if (!["submission", "objective"].includes(kind)) {
    throw new BadRequestError("提交类型格式错误");
  }
  const result = await getDb().execute(sql`${selectTeachingSubmissions(true)}
    WHERE ${
    teachingSubmissionRelation(access)
  } AND s.id = ${id} AND s.kind = ${kind} LIMIT 1`);
  const [row] = unwrapRows<StudentSubmissionRow>(result as never);
  if (!row) throw new NotFoundError("提交不存在或不可访问");
  if (access.platformAdmin) {
    await workspaceAudit(getDb(), actorId, access.domain.id, "domain.update", {
      operation: "classroom.submission.read",
      classroom_id: classroomId,
      submission_id: id,
      kind,
    });
  }
  return teachingSubmissionDto(row, true);
}
