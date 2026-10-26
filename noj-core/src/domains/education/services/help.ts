import { and, count, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentHelpReplies,
  assignmentHelpRequests,
  assignmentItems,
  objectiveSubmissions,
  submissions,
  users,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { recordEducationNotice } from "../../../shared/education-events.ts";
import { workspaceAudit } from "../../workspace/index.ts";
import { assertClassroomCapability } from "./access.ts";
import {
  assertInteractionRecipient,
  interactionRevision,
  interactionStaff,
  interactionText,
  loadInteractionAccess,
} from "./interaction-access.ts";
import { educationOperation } from "./operations.ts";

/** 求助只可关联本人同域提交及当前任务题目。 */
export interface AssignmentHelpInput {
  body: string;
  item_id?: string | null;
  submission?: { id: string; kind: "submission" | "objective" } | null;
}

/** 学生从实际目标名单发起求助，题目与原提交在同一事务校验。 */
export async function createAssignmentHelp(
  slug: string,
  id: string,
  actorId: string,
  key: string,
  input: AssignmentHelpInput,
) {
  const body = interactionText(input.body);
  if (
    input.item_id != null &&
      (typeof input.item_id !== "string" || !input.item_id) ||
    input.submission != null &&
      (typeof input.submission.id !== "string" || !input.submission.id ||
        !["submission", "objective"].includes(input.submission.kind))
  ) throw new BadRequestError("求助关联格式错误");
  return await getDb().transaction(async (tx) => {
    const access = await loadInteractionAccess(slug, id, actorId, tx, true);
    if (access.classMembership?.role !== "student") {
      throw new ForbiddenError("仅本班学生可发起求助");
    }
    await assertInteractionRecipient(access, actorId, tx);
    let itemId = input.item_id ?? null;
    if (input.submission) {
      const ordinary = input.submission.kind === "submission";
      const table = ordinary ? submissions : objectiveSubmissions;
      const [source] = await tx.select({
        problem_id: ordinary
          ? submissions.problem_id
          : objectiveSubmissions.paper_id,
      }).from(table).where(and(
        eq(table.id, input.submission.id),
        eq(table.domain_id, access.domain.id),
        eq(table.user_id, actorId),
      ));
      if (!source) throw new NotFoundError("本人提交不存在或不属于当前域");
      const [item] = await tx.select({ id: assignmentItems.id }).from(
        assignmentItems,
      ).where(
        and(
          eq(assignmentItems.assignment_id, id),
          eq(assignmentItems.problem_id, source.problem_id),
          itemId ? eq(assignmentItems.id, itemId) : undefined,
        ),
      );
      if (!item) throw new BadRequestError("关联提交的题目不属于此作业");
      itemId = item.id;
    } else if (itemId) {
      const [item] = await tx.select({ id: assignmentItems.id }).from(
        assignmentItems,
      ).where(
        and(
          eq(assignmentItems.assignment_id, id),
          eq(assignmentItems.id, itemId),
        ),
      );
      if (!item) throw new BadRequestError("题目不属于此作业");
    }
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "help.create",
      key,
      { id, body, itemId, submission: input.submission ?? null },
      async () => {
        const now = new Date().toISOString();
        const [help] = await tx.insert(assignmentHelpRequests).values({
          id: crypto.randomUUID(),
          domain_id: access.domain.id,
          assignment_id: id,
          user_id: actorId,
          item_id: itemId,
          submission_id: input.submission?.kind === "submission"
            ? input.submission.id
            : null,
          objective_submission_id: input.submission?.kind === "objective"
            ? input.submission.id
            : null,
          body,
          created_at: now,
          updated_at: now,
        }).returning();
        await recordEducationNotice(tx, {
          domain_id: access.domain.id,
          assignment_id: id,
          type: "help",
          help_id: help.id,
        });
        return help;
      },
    );
  });
}

async function helpReader(slug: string, id: string, actorId: string) {
  const access = await loadInteractionAccess(slug, id, actorId),
    all = interactionStaff(access, "help:manage");
  if (!all) await assertInteractionRecipient(access, actorId);
  return { access, all };
}

/** 求助目录只显示本人或获授权的本班求助，过滤在分页和计数之前。 */
export async function listAssignmentHelp(
  slug: string,
  id: string,
  actorId: string,
  options: { page?: number; state?: "open" | "resolved" } = {},
) {
  const { all } = await helpReader(slug, id, actorId), page = options.page ?? 1;
  if (
    !Number.isSafeInteger(page) || page < 1 || page > 100000 ||
    options.state !== undefined && !["open", "resolved"].includes(options.state)
  ) throw new BadRequestError("求助分页或状态格式错误");
  const db = getDb(),
    where = and(
      eq(assignmentHelpRequests.assignment_id, id),
      all ? undefined : eq(assignmentHelpRequests.user_id, actorId),
      options.state
        ? eq(assignmentHelpRequests.state, options.state)
        : undefined,
    );
  const [total] = await db.select({ count: count() }).from(
    assignmentHelpRequests,
  ).where(where);
  const data = await db.select().from(assignmentHelpRequests).where(where)
    .orderBy(assignmentHelpRequests.updated_at, assignmentHelpRequests.id)
    .limit(50).offset((page - 1) * 50);
  return { page, per_page: 50, total: total.count, data };
}

/** 通知点击不能依赖旧访问结果，详情重新验证目标学生与助教能力。 */
export async function getAssignmentHelp(
  slug: string,
  id: string,
  helpId: string,
  actorId: string,
  replyPage = 1,
) {
  const { all } = await helpReader(slug, id, actorId);
  const [help] = await getDb().select().from(assignmentHelpRequests).where(
    and(
      eq(assignmentHelpRequests.assignment_id, id),
      eq(assignmentHelpRequests.id, helpId),
      all ? undefined : eq(assignmentHelpRequests.user_id, actorId),
    ),
  );
  if (!help) throw new NotFoundError("求助不存在或不可访问");
  if (!Number.isSafeInteger(replyPage) || replyPage < 1 || replyPage > 100000) {
    throw new BadRequestError("回复分页格式错误");
  }
  const db = getDb(),
    [total] = await db.select({ count: count() }).from(assignmentHelpReplies)
      .where(eq(assignmentHelpReplies.help_id, helpId));
  const rows = await db.select({
    reply: assignmentHelpReplies,
    username: users.username,
    deleted_at: users.deleted_at,
  }).from(assignmentHelpReplies)
    .innerJoin(users, eq(users.id, assignmentHelpReplies.author_id)).where(
      eq(assignmentHelpReplies.help_id, helpId),
    )
    .orderBy(assignmentHelpReplies.created_at, assignmentHelpReplies.id).limit(
      50,
    ).offset((replyPage - 1) * 50);
  return {
    ...help,
    replies: rows.map((row) => ({
      ...row.reply,
      author_name: row.deleted_at ? "已注销账号" : row.username,
    })),
    reply_page: replyPage,
    reply_total: total.count,
  };
}

/** 回复独立追加；学生追问重新打开，教师可明确选择同时标记已处理。 */
export async function replyAssignmentHelp(
  slug: string,
  id: string,
  helpId: string,
  actorId: string,
  key: string,
  input: { body: string; resolve?: boolean },
) {
  const body = interactionText(input.body);
  if (input.resolve !== undefined && typeof input.resolve !== "boolean") {
    throw new BadRequestError("处理选项必须为布尔值");
  }
  return await getDb().transaction(async (tx) => {
    const access = await loadInteractionAccess(slug, id, actorId, tx, true),
      staff = interactionStaff(access, "help:manage");
    const [help] = await tx.select().from(assignmentHelpRequests).where(
      and(
        eq(assignmentHelpRequests.assignment_id, id),
        eq(assignmentHelpRequests.id, helpId),
      ),
    ).for("update");
    if (!help || !staff && help.user_id !== actorId) {
      throw new NotFoundError("求助不存在或不可访问");
    }
    if (!staff && input.resolve) {
      throw new ForbiddenError("只有获授权教学人员可标记已处理");
    }
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "help.reply",
      key,
      { id, helpId, body, resolve: input.resolve ?? false },
      async () => {
        const now = new Date().toISOString();
        const [reply] = await tx.insert(assignmentHelpReplies).values({
          id: crypto.randomUUID(),
          domain_id: access.domain.id,
          assignment_id: id,
          help_id: helpId,
          author_id: actorId,
          body,
          created_at: now,
        }).returning();
        await tx.update(assignmentHelpRequests).set({
          revision: help.revision + 1,
          updated_at: now,
          ...(input.resolve
            ? { state: "resolved", handled_by: actorId, handled_at: now }
            : !staff
            ? { state: "open", handled_by: null, handled_at: null }
            : {}),
        }).where(eq(assignmentHelpRequests.id, helpId));
        await recordEducationNotice(tx, {
          domain_id: access.domain.id,
          assignment_id: id,
          type: "help_reply",
          help_id: helpId,
          reply_id: reply.id,
          ...(staff ? { user_id: help.user_id } : {}),
        });
        return reply;
      },
    );
  });
}

/** 处理状态只授予固定 help:manage 能力，学生不能代替教师确认处理。 */
export async function setAssignmentHelpState(
  slug: string,
  id: string,
  helpId: string,
  actorId: string,
  revision: number | null,
  state: "open" | "resolved",
) {
  if (!["open", "resolved"].includes(state)) {
    throw new BadRequestError("求助状态格式错误");
  }
  return await getDb().transaction(async (tx) => {
    const access = await loadInteractionAccess(slug, id, actorId, tx, true);
    assertClassroomCapability(access, "help:manage");
    const [help] = await tx.select().from(assignmentHelpRequests).where(
      and(
        eq(assignmentHelpRequests.assignment_id, id),
        eq(assignmentHelpRequests.id, helpId),
      ),
    ).for("update");
    if (!help) throw new NotFoundError("求助不存在或不可访问");
    interactionRevision(help.revision, revision);
    const now = new Date().toISOString();
    const [updated] = await tx.update(assignmentHelpRequests).set({
      state,
      revision: help.revision + 1,
      updated_at: now,
      handled_by: state === "resolved" ? actorId : null,
      handled_at: state === "resolved" ? now : null,
    }).where(eq(assignmentHelpRequests.id, helpId)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "help.state",
      help_id: helpId,
      state,
      revision: updated.revision,
    });
    return updated;
  });
}
