import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  assignmentRecipients,
  assignments,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import type { TeachingCapability } from "../../../shared/education-types.ts";
import { assertDomainFeatureEnabled } from "../../access/contracts/cross-module/workspace_services_limits.ts";
import { loadClassroom } from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";

/** 教学互动只使用已发布任务；写操作重新锁定班级和任务，并检查当前域教学权限。 */
export async function loadInteractionAccess(
  slug: string,
  id: string,
  actorId: string,
  executor: Executor = getDb(),
  write = false,
) {
  const access = await loadAssignment(slug, id, actorId, { executor });
  if (!access.assignment.published_at) {
    throw new NotFoundError("互动只对已发布任务开放");
  }
  if (!write) return access;
  const classroom = await loadClassroom(slug, access.classroom.id, actorId, {
    executor,
    write: true,
  });
  const [assignment] = await executor.select().from(assignments).where(
    eq(assignments.id, id),
  ).for("update");
  await assertDomainFeatureEnabled(classroom.domain, "assignment", {
    executor,
    disabledCode: "MODULE_DISABLED",
  });
  if (assignment.state === "archived") {
    throw new AppError("作业已归档，只能读取历史", 403, "ASSIGNMENT_READ_ONLY");
  }
  return { ...access, ...classroom, assignment };
}

/** 互动读取区分固定能力，学情或源码能力不隐含私人反馈和求助读取。 */
export function interactionStaff(
  access: Awaited<ReturnType<typeof loadInteractionAccess>>,
  _capability: TeachingCapability,
) {
  return access.managesDomain;
}

/** 非教学管理者必须是本任务实际目标学生，不能借普通班级成员身份查看私人互动。 */
export async function assertInteractionRecipient(
  access: Awaited<ReturnType<typeof loadInteractionAccess>>,
  userId: string,
  executor: Executor = getDb(),
) {
  const [recipient] = await executor.select({ id: assignmentRecipients.id })
    .from(assignmentRecipients).where(and(
      eq(assignmentRecipients.domain_id, access.domain.id),
      eq(assignmentRecipients.assignment_id, access.assignment.id),
      eq(assignmentRecipients.user_id, userId),
    ));
  if (!recipient) throw new NotFoundError("学生不在此作业目标名单中");
}

/** 互动正文一次校验，服务内不重复清洗已验证值。 */
export function interactionText(body: string) {
  if (typeof body !== "string" || !body.trim() || body.length > 30000) {
    throw new BadRequestError("正文需要 1–30000 个字符");
  }
  return body.trim();
}

/** 编辑及处理状态使用前置版本，避免覆盖另一位教师的新操作。 */
export function interactionRevision(actual: number, expected: number | null) {
  if (expected === null || !Number.isSafeInteger(expected) || expected < 0) {
    throw new AppError("需要互动记录 revision", 428, "REVISION_REQUIRED");
  }
  if (actual !== expected) {
    throw new AppError("互动记录已变化，请重新读取", 409, "REVISION_CONFLICT");
  }
}

/** 非作者不能改写别人的反馈正文，治理人员可撤回并留下原作者依据。 */
export function assertFeedbackAuthor(authorId: string, actorId: string) {
  if (authorId !== actorId) {
    throw new ForbiddenError(
      "只有原作者可以修改反馈正文",
      "FEEDBACK_AUTHOR_REQUIRED",
    );
  }
}
