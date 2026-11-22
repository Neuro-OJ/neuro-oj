import { sql } from "drizzle-orm";
import { ForbiddenError } from "../../../shared/base/errors.ts";
import type { loadClassroom } from "./access.ts";
import { unendedPublicContestForProblem } from "../../access/contest-policy.ts";

type ClassroomAccess = Awaited<ReturnType<typeof loadClassroom>>;

/** 同学只读权限要求当前仍在班内，不沿用离班后的本人历史读取权限。 */
export function assertClassroomPeer(access: ClassroomAccess) {
  if (access.classMembership?.role !== "student") {
    throw new ForbiddenError(
      "仅当前同班学生可查看",
      "CLASSROOM_PERMISSION_DENIED",
    );
  }
}

/** 只匹配当前同班且账号、域身份均有效的学生。 */
export function activeClassmateCondition(
  access: ClassroomAccess,
  userId = sql`s.user_id`,
) {
  return sql`EXISTS (SELECT 1 FROM classroom_memberships peer
    JOIN domain_memberships dm ON dm.domain_id=peer.domain_id AND dm.user_id=peer.user_id
    JOIN users u ON u.id=peer.user_id
    WHERE peer.domain_id=${access.domain.id} AND peer.classroom_id=${access.classroom.id}
      AND peer.user_id=${userId} AND peer.role='student' AND peer.status='active'
      AND dm.status='active' AND u.deleted_at IS NULL)`;
}

/** 代码必须来自已结束的共同作业，不能借同题或已知提交 ID 读取其他练习。 */
export function peerSubmissionCondition(access: ClassroomAccess) {
  if (access.classMembership?.role !== "student") return sql`false`;
  return sql`NOT ${
    unendedPublicContestForProblem(sql`s.problem_id`, sql`${access.domain.id}`)
  } AND ${activeClassmateCondition(access)} AND EXISTS (
    SELECT 1 FROM assignments a
    JOIN assignment_items i ON i.assignment_id=a.id
    JOIN assignment_recipients r ON r.assignment_id=a.id AND r.user_id=s.user_id
    JOIN assignment_recipients viewer ON viewer.assignment_id=a.id AND viewer.user_id=${access.context.actorId}
    WHERE a.domain_id=${access.domain.id} AND a.classroom_id=${access.classroom.id}
      AND a.published_at IS NOT NULL AND r.status='active' AND viewer.status='active'
      AND (a.ended_at::timestamptz <= NOW() OR a.archived_at::timestamptz <= NOW() OR a.deadline_at::timestamptz <= NOW())
      AND i.problem_id=s.problem_id AND i.binding_id=s.binding_id
      AND (a.include_previous_submissions OR s.created_at >= a.published_at)
      AND (a.submission_source='domain_any' OR (s.assignment_id=a.id AND s.assignment_item_id=i.id AND s.created_at >= a.published_at))
      AND (a.archived_at IS NULL OR s.created_at <= a.archived_at)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.credit_intervals) w
        WHERE s.created_at >= w->>'start' AND (w->>'end' IS NULL OR s.created_at <= w->>'end'))
  )`;
}

/** 无截止时间的作业持续进行，只有显式结束或归档后开放同学代码。 */
export function assignmentHasEnded(assignment: {
  deadline_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
}) {
  return [assignment.deadline_at, assignment.ended_at, assignment.archived_at]
    .some((at) => at !== null && Date.parse(at) <= Date.now());
}
