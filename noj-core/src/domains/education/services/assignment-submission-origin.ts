import { and, eq } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import type { AssignmentSubmissionOrigin } from "../../../shared/education-types.ts";
import {
  assignmentItems,
  assignmentRecipients,
  assignments,
  classroomMemberships,
  classrooms,
  domainMemberships,
  domains,
} from "../../../shared/db/schema.ts";
import { AppError, NotFoundError } from "../../../shared/base/errors.ts";
import { assertDomainFeatureEnabled } from "../../workspace/index.ts";

/** 公开同一份共享入口契约，HTTP 边界与教学门面不会各自定义字段。 */
export type { AssignmentSubmissionOrigin } from "../../../shared/education-types.ts";

/**
 * 在受理事务中确认学生的作业入口，复用执行链已经授权并锁定的域和题目。
 * 调用前执行链仍须验证共享、当前版本与比赛规则；没有来源的普通练习不读教学配置。
 */
export async function resolveAssignmentSubmissionOrigin(
  executor: Executor,
  input: {
    domainId: string;
    actorId: string;
    bindingId: string;
    problemId: string;
    origin?: AssignmentSubmissionOrigin;
  },
): Promise<{
  assignment_id: string | null;
  assignment_item_id: string | null;
}> {
  if (!input.origin) {
    return { assignment_id: null, assignment_item_id: null };
  }
  const origin = input.origin;
  const [initial] = await executor.select({
    assignment: assignments,
    domain: domains,
  }).from(assignments).innerJoin(domains, eq(domains.id, assignments.domain_id))
    .where(and(
      eq(assignments.id, origin.assignment_id),
      eq(assignments.domain_id, input.domainId),
    ));
  if (!initial) throw new NotFoundError("作业来源不存在或不可访问");

  // 与教学管理保持域 → 班级 → 作业锁顺序，归档和成员退出不能越过受理事务。
  const [classroom] = await executor.select().from(classrooms).where(and(
    eq(classrooms.id, initial.assignment.classroom_id),
    eq(classrooms.domain_id, input.domainId),
  )).for("share");
  const [assignment] = await executor.select().from(assignments).where(and(
    eq(assignments.id, origin.assignment_id),
    eq(assignments.domain_id, input.domainId),
  )).for("share");
  if (!classroom || !assignment?.published_at) {
    throw new NotFoundError("作业来源不存在或不可访问");
  }
  const [item] = await executor.select({ id: assignmentItems.id }).from(
    assignmentItems,
  ).innerJoin(
    assignmentRecipients,
    and(
      eq(assignmentRecipients.assignment_id, assignment.id),
      eq(assignmentRecipients.user_id, input.actorId),
      eq(assignmentRecipients.status, "active"),
    ),
  ).innerJoin(
    classroomMemberships,
    and(
      eq(classroomMemberships.classroom_id, classroom.id),
      eq(classroomMemberships.user_id, input.actorId),
      eq(classroomMemberships.status, "active"),
      eq(classroomMemberships.role, "student"),
    ),
  ).innerJoin(
    domainMemberships,
    and(
      eq(domainMemberships.domain_id, input.domainId),
      eq(domainMemberships.user_id, input.actorId),
      eq(domainMemberships.status, "active"),
    ),
  ).where(and(
    eq(assignmentItems.id, origin.assignment_item_id),
    eq(assignmentItems.assignment_id, assignment.id),
    eq(assignmentItems.domain_id, input.domainId),
    eq(assignmentItems.problem_id, input.problemId),
    eq(assignmentItems.binding_id, input.bindingId),
  )).for("share");
  if (!item) throw new NotFoundError("作业来源不存在或不可访问");
  if (classroom.status !== "active") {
    throw new AppError("班级已归档，只能读取历史", 403, "CLASSROOM_READ_ONLY");
  }
  if (assignment.state === "archived" || assignment.archived_at) {
    throw new AppError("作业已归档，只能读取历史", 403, "ASSIGNMENT_READ_ONLY");
  }
  await assertDomainFeatureEnabled(initial.domain, "assignment", {
    executor,
    disabledCode: "MODULE_DISABLED",
  });
  // 截止与提前结束只改变按时范围，补做仍可保留入口来源。
  return { assignment_id: assignment.id, assignment_item_id: item.id };
}
