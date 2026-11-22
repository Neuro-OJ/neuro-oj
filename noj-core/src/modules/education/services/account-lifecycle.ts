import { and, eq, sql } from "drizzle-orm";
import type { DbTx } from "../../../shared/db/executor.ts";
import { syncStudentAssignmentRecipients } from "./assignment-recipients.ts";
import { classroomMemberships, classrooms } from "../../../shared/db/schema.ts";

/** 调用方已锁定 Domain；退出或注销结束班级任职，重新入域不恢复旧教学权限。 */
export async function retireDomainEducationMemberships(
  executor: DbTx,
  domainId: string,
  userId: string,
) {
  const affected = await executor.select({ id: classrooms.id }).from(classrooms)
    .innerJoin(
      classroomMemberships,
      eq(classroomMemberships.classroom_id, classrooms.id),
    )
    .where(
      and(
        eq(classroomMemberships.domain_id, domainId),
        eq(classroomMemberships.user_id, userId),
        eq(classroomMemberships.status, "active"),
      ),
    ).orderBy(classrooms.id).for("update", { of: classrooms });
  if (!affected.length) return;
  const now = new Date().toISOString();
  await executor.update(classroomMemberships).set({
    status: "removed",
    left_at: now,
  })
    .where(
      and(
        eq(classroomMemberships.domain_id, domainId),
        eq(classroomMemberships.user_id, userId),
        eq(classroomMemberships.status, "active"),
      ),
    );
  for (const row of affected) {
    await syncStudentAssignmentRecipients(
      executor,
      domainId,
      row.id,
      userId,
      false,
      now,
    );
    await executor.update(classrooms).set({
      revision: sql`${classrooms.revision} + 1`,
      updated_at: now,
    }).where(eq(classrooms.id, row.id));
  }
}
