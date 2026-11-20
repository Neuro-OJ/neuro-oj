import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/** 当前有效班级关系的同域提交读取；历史任务依据另走教学单资源接口。 */
export function currentTeacherSubmissionAccessWhere(
  studentId: AnyColumn | SQL | string,
  domainId: AnyColumn | SQL | string,
  actorId: AnyColumn | SQL | string,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM classroom_memberships student_membership
    JOIN domain_memberships student_domain ON student_domain.domain_id = student_membership.domain_id
      AND student_domain.user_id = student_membership.user_id AND student_domain.status = 'active'
    JOIN domain_memberships teacher_domain ON teacher_domain.domain_id = student_membership.domain_id
      AND teacher_domain.user_id = ${actorId} AND teacher_domain.status = 'active'
    WHERE student_membership.domain_id = ${domainId} AND student_membership.user_id = ${studentId}
      AND student_membership.role = 'student' AND student_membership.status = 'active'
      AND teacher_domain.role IN ('educator', 'admin')
  )`;
}
