import { and, count, eq, inArray, isNull, like } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentItems,
  assignmentProgress,
  assignmentRecipients,
  users,
} from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { enqueueEducationRefresh } from "../../../shared/education-events.ts";
import { loadBindingAvailability } from "../../catalog/index.ts";
import { assertClassroomCapability } from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";
import { recomputeAssignmentProgress } from "./progress-materializer.ts";
import { loadEducationCellRevisions } from "./progress-revisions.ts";

/** 学情读取范围沿用两种正式统计，不接受任意范围字符串。 */
export type ProgressScope = "on_time" | "current";

/** 成绩矩阵按学生分页；无源码权限也不会随学情数据返回代码或 evaluator 文本。 */
export async function getAssignmentMatrix(
  slug: string,
  id: string,
  actorId: string,
  options: {
    page?: number;
    scope?: ProgressScope;
    recipients?: "current" | "historical" | "all";
    search?: string;
  } = {},
) {
  const access = await loadAssignment(slug, id, actorId);
  assertClassroomCapability(access, "progress:read");
  const scope = options.scope ?? "on_time", page = options.page ?? 1;
  const recipients = options.recipients ?? "current";
  if (
    !["on_time", "current"].includes(scope) ||
    !["current", "historical", "all"].includes(recipients) ||
    !Number.isSafeInteger(page) || page < 1 || page > 100000 ||
    options.search !== undefined &&
      (typeof options.search !== "string" || options.search.length > 100)
  ) {
    throw new BadRequestError("矩阵分页、统计范围或筛选格式错误");
  }
  const db = getDb();
  const condition = and(
    eq(assignmentRecipients.assignment_id, id),
    recipients === "all" ? undefined : eq(
      assignmentRecipients.status,
      recipients === "current" ? "active" : "historical",
    ),
    options.search
      ? and(
        isNull(users.deleted_at),
        like(
          users.username,
          `%${
            options.search.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
              .replaceAll("_", "\\_")
          }%`,
        ),
      )
      : undefined,
  );
  const [total] = await db.select({ count: count() }).from(assignmentRecipients)
    .innerJoin(users, eq(users.id, assignmentRecipients.user_id)).where(
      condition,
    );
  const students = await db.select({
    recipient: assignmentRecipients,
    username: users.username,
    deleted_at: users.deleted_at,
  })
    .from(assignmentRecipients).innerJoin(
      users,
      eq(users.id, assignmentRecipients.user_id),
    ).where(condition)
    .orderBy(assignmentRecipients.joined_at, assignmentRecipients.user_id)
    .limit(50).offset((page - 1) * 50);
  const result = await readCells(
    access,
    students.map((s) => s.recipient.user_id),
    scope,
  );
  return {
    page,
    per_page: 50,
    total: total.count,
    scope,
    updating: result.updating,
    items: result.items,
    rows: students.map((s) => ({
      user_id: s.recipient.user_id,
      username: s.deleted_at ? "已注销账号" : s.username,
      recipient_status: s.recipient.status,
      joined_at: s.recipient.joined_at,
      left_at: s.recipient.left_at,
      cells: result.cells.filter((c) => c.user_id === s.recipient.user_id),
    })),
  };
}

/** 本人小范围同步补算；不能通过 user_id 参数读取同学成绩。 */
export async function getMyAssignmentProgress(
  slug: string,
  id: string,
  actorId: string,
  scope: ProgressScope = "on_time",
) {
  if (!["on_time", "current"].includes(scope)) {
    throw new BadRequestError("统计范围格式错误");
  }
  const access = await loadAssignment(slug, id, actorId), db = getDb();
  const [recipient] = await db.select().from(assignmentRecipients).where(and(
    eq(assignmentRecipients.assignment_id, id),
    eq(assignmentRecipients.user_id, actorId),
  ));
  if (!recipient) throw new NotFoundError("你不是此作业的目标学生");
  let result = await readCells(access, [actorId], scope, false);
  if (result.updating) {
    await recomputeAssignmentProgress(id, [actorId]);
    result = await readCells(access, [actorId], scope, false);
  }
  return {
    scope,
    updating: result.updating,
    recipient_status: recipient.status,
    items: result.items,
    cells: result.cells,
  };
}

async function readCells(
  access: Awaited<ReturnType<typeof loadAssignment>>,
  userIds: string[],
  scope: ProgressScope,
  enqueue = true,
) {
  const db = getDb(), id = access.assignment.id;
  const items = await db.select().from(assignmentItems).where(
    eq(assignmentItems.assignment_id, id),
  ).orderBy(assignmentItems.sort_order);
  const resources = new Map(
    (await loadBindingAvailability(
      db,
      access.domain.id,
      items.map((i) => i.binding_id),
    )).map((b) => [b.id, b]),
  );
  const revisionFor = await loadEducationCellRevisions(
    db,
    access.domain.id,
    access.classroom.id,
    id,
    userIds,
    items.map((i) => i.problem_id),
  );
  const projections = userIds.length
    ? await db.select().from(assignmentProgress).where(and(
      eq(assignmentProgress.assignment_id, id),
      eq(assignmentProgress.scope, scope),
      inArray(assignmentProgress.user_id, userIds),
    ))
    : [];
  const lookup = new Map(
    projections.map((p) => [`${p.item_id}:${p.user_id}`, p]),
  );
  const cells = userIds.flatMap((userId) =>
    items.map((item) => {
      const projection = lookup.get(`${item.id}:${userId}`),
        resource = resources.get(item.binding_id);
      const updating = !projection ||
        projection.projection_revision < revisionFor(userId, item.problem_id) ||
        projection.policy_revision !== resource?.revision ||
        item.answer_version_id !== resource?.answer_version_id;
      const unavailable = !resource?.available;
      return {
        item_id: item.id,
        user_id: userId,
        updating,
        status: unavailable
          ? "unavailable"
          : updating
          ? "updating"
          : projection.status,
        score: updating ? null : projection.score,
        accepted: !updating && projection.accepted,
        source_submission_id: updating ? null : projection.source_submission_id,
        source_kind: updating ? null : projection.source_kind,
        source_attempt_id: updating ? null : projection.source_attempt_id,
        accepted_attempt_id: updating ? null : projection.accepted_attempt_id,
        evaluated_version_id: updating ? null : projection.evaluated_version_id,
        late: !updating && projection.late,
        policy_revision: resource?.revision ?? item.policy_revision,
        projection_revision: projection?.projection_revision ?? null,
        updated_at: projection?.updated_at ?? null,
      };
    })
  );
  const updating = cells.some((c) => c.updating);
  if (updating && enqueue) {
    await enqueueEducationRefresh(db, access.domain.id, id);
  }
  return {
    updating,
    cells,
    items: items.map((i) => ({
      id: i.id,
      problem_id: i.problem_id,
      binding_id: i.binding_id,
      sort_order: i.sort_order,
      requirement: i.requirement,
      minimum_score: i.minimum_score,
      resource_available: resources.get(i.binding_id)?.available ?? false,
      answer_version_id: resources.get(i.binding_id)?.available
        ? resources.get(i.binding_id)!.answer_version_id
        : null,
      policy_revision: resources.get(i.binding_id)?.revision ??
        i.policy_revision,
    })),
  };
}
