import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  assignmentRecipients,
  assignments,
} from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { assertDomainFeatureEnabled } from "../../access/contracts/cross-module/workspace_services_limits.ts";
import { assertClassroomCapability, loadClassroom } from "./access.ts";

/** 单个作业 ID 不能跳过 URL 域校验，学生只可读取自己的已发布任务。 */
export async function loadAssignment(
  slug: string,
  id: string,
  actorId: string,
  options: { executor?: Executor; write?: boolean } = {},
) {
  const executor = options.executor ?? getDb();
  const [row] = await executor.select().from(assignments).where(
    and(
      eq(assignments.id, id),
      sql`${assignments.domain_id} IN (SELECT id FROM domains WHERE slug = ${slug})`,
    ),
  );
  if (!row) throw new NotFoundError("作业不存在");
  const access = await loadClassroom(slug, row.classroom_id, actorId, {
    executor,
    write: options.write,
    historicalStudent: !options.write,
  });
  // 班级与作业同域由复合外键保证，班级访问已校验路径域。
  const staff = access.managesDomain;
  if (staff && !row.published_at) {
    assertClassroomCapability(access, "assignments:manage");
  }
  if (!staff) {
    const [recipient] = await executor.select({ id: assignmentRecipients.id })
      .from(assignmentRecipients)
      .where(
        and(
          eq(assignmentRecipients.assignment_id, id),
          eq(assignmentRecipients.user_id, actorId),
        ),
      );
    if (!recipient || !row.published_at) {
      throw new NotFoundError("作业不存在或不可访问");
    }
  }
  if (options.write) {
    assertClassroomCapability(access, "assignments:manage");
    await assertDomainFeatureEnabled(access.domain, "assignment", {
      executor,
      disabledCode: "MODULE_DISABLED",
    });
  }
  const [assignment] = options.write
    ? await executor.select().from(assignments).where(eq(assignments.id, id))
      .for("update")
    : [row];
  return { ...access, assignment, staff };
}
