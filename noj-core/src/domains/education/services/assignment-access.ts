import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  assignmentRecipients,
  assignments,
} from "../../../shared/db/schema.ts";
import { AppError, NotFoundError } from "../../../shared/base/errors.ts";
import { getInstanceResourcePolicy } from "../../workspace/index.ts";
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
    eq(assignments.id, id),
  );
  if (!row) throw new NotFoundError("作业不存在");
  const access = await loadClassroom(slug, row.classroom_id, actorId, {
    executor,
    write: options.write,
    historicalStudent: !options.write,
  });
  // 班级与作业同域由复合外键保证，班级访问已校验路径域。
  const staff = access.managesDomain ||
    access.classMembership?.role === "coach" ||
    access.classMembership?.role === "assistant" &&
      access.capabilities.size > 0;
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
    const policy = await getInstanceResourcePolicy(executor);
    if (
      !access.domain.configuration.features.assignment ||
      !policy.modules.assignment
    ) {
      throw new AppError(
        "作业模块已停用，只能读取历史",
        403,
        "MODULE_DISABLED",
      );
    }
  }
  const [assignment] = options.write
    ? await executor.select().from(assignments).where(eq(assignments.id, id))
      .for("update")
    : [row];
  return { ...access, assignment, staff };
}
