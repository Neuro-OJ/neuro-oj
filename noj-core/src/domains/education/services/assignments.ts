import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  assignmentItems,
  assignments,
  classroomMemberships,
  domainMemberships,
  domainProblemBindings,
  domains,
  problems,
  users,
} from "../../../shared/db/schema.ts";
import {
  getInstanceResourcePolicy,
  workspaceAudit,
} from "../../workspace/index.ts";
import {
  domainProblemReference,
  readDomainTraining,
  resolveDomainProblem,
} from "../../catalog/index.ts";
import {
  assertClassroomCapability,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";

/** 分数输入与存储沿用 ×100 整数，6000 表示 60 分。 */
export interface AssignmentDraftInput {
  title: string;
  description?: string;
  deadline_at?: string | null;
  include_previous_submissions?: boolean;
  target_student_ids?: string[] | null;
  training?: {
    id: string;
    requirement: "accepted" | "min_score";
    minimum_score?: number | null;
  };
  items?: Array<
    {
      binding_id: string;
      requirement: "accepted" | "min_score";
      minimum_score?: number | null;
    }
  >;
}

/** 边界日期转换为 UTC；省略或 null 表示无截止时间。 */
export function assignmentDate(
  value: string | null | undefined,
  label: string,
) {
  if (value == null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new BadRequestError(`${label}格式错误`);
  }
  return new Date(value).toISOString();
}

function draftInput(input: AssignmentDraftInput) {
  if (
    typeof input.title !== "string" || !input.title.trim() ||
    input.title.length > 200 ||
    input.description !== undefined &&
      (typeof input.description !== "string" ||
        input.description.length > 30000)
  ) {
    throw new BadRequestError("作业标题或描述格式错误");
  }
  if (
    input.include_previous_submissions !== undefined &&
    typeof input.include_previous_submissions !== "boolean"
  ) {
    throw new BadRequestError("历史提交选项必须为布尔值");
  }
  if (input.training && input.items !== undefined) {
    throw new BadRequestError("请选择手工题目或题单，不能同时指定");
  }
  if (input.training) {
    const t = input.training;
    if (
      typeof t.id !== "string" || !t.id ||
      !["accepted", "min_score"].includes(t.requirement) ||
      t.requirement === "accepted" && t.minimum_score != null ||
      t.requirement === "min_score" &&
        (!Number.isSafeInteger(t.minimum_score) || t.minimum_score! < 0 ||
          t.minimum_score! > 10000)
    ) {
      throw new BadRequestError("题单来源及达标要求格式错误");
    }
  } else if (
    !Array.isArray(input.items) || !input.items.length ||
    input.items.length > 200 ||
    input.items.some((i) =>
      !i || typeof i.binding_id !== "string" ||
      !["accepted", "min_score"].includes(i.requirement) ||
      i.requirement === "accepted" && i.minimum_score != null ||
      i.requirement === "min_score" &&
        (!Number.isSafeInteger(i.minimum_score) || i.minimum_score! < 0 ||
          i.minimum_score! > 10000)
    ) ||
    new Set(input.items.map((i) => i.binding_id)).size !== input.items.length
  ) {
    throw new BadRequestError(
      "作业需要 1–200 道不同题目，以及有效的通过或最低分要求",
    );
  }
  const target = input.target_student_ids ?? null;
  if (
    target !== null &&
    (!Array.isArray(target) || !target.length || target.length > 5000 ||
      target.some((id) => typeof id !== "string") ||
      new Set(target).size !== target.length)
  ) {
    throw new BadRequestError("目标学生名单格式错误");
  }
  return {
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
    deadline_at: assignmentDate(input.deadline_at, "截止时间"),
    include_previous_submissions: input.include_previous_submissions ?? false,
    target_student_ids: target,
    source_training_id: input.training?.id ?? null,
    source_training_rule: input.training
      ? {
        requirement: input.training.requirement,
        minimum_score: input.training.minimum_score ?? null,
      }
      : null,
  };
}

/** 发布名单来自当前有效班级学生；手选名单不能掺入教练、离班或跨班账号。 */
export async function assignmentStudents(
  executor: Executor,
  domainId: string,
  classroomId: string,
  target: string[] | null,
) {
  const rows = await executor.select({ user_id: classroomMemberships.user_id })
    .from(classroomMemberships)
    .innerJoin(
      domainMemberships,
      and(
        eq(domainMemberships.domain_id, classroomMemberships.domain_id),
        eq(domainMemberships.user_id, classroomMemberships.user_id),
      ),
    )
    .innerJoin(users, eq(users.id, classroomMemberships.user_id)).where(and(
      eq(classroomMemberships.domain_id, domainId),
      eq(classroomMemberships.classroom_id, classroomId),
      eq(classroomMemberships.role, "student"),
      eq(classroomMemberships.status, "active"),
      eq(domainMemberships.status, "active"),
      isNull(users.deleted_at),
      target ? inArray(classroomMemberships.user_id, target) : undefined,
    )).orderBy(classroomMemberships.user_id);
  if (target && rows.length !== target.length) {
    throw new BadRequestError("目标名单包含当前班级以外的学生");
  }
  return rows;
}

/** 绑定必须属于作业使用域，题面与默认作答版本读取当前源授权。 */
export async function assignmentProblem(
  executor: Executor,
  slug: string,
  domainId: string,
  actorId: string,
  bindingId: string,
) {
  const [row] = await executor.select({
    problem: problems,
    source_slug: domains.slug,
  }).from(domainProblemBindings)
    .innerJoin(problems, eq(problems.id, domainProblemBindings.problem_id))
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(
      and(
        eq(domainProblemBindings.id, bindingId),
        eq(domainProblemBindings.domain_id, domainId),
      ),
    );
  if (!row) throw new NotFoundError("题目不在此域题库中");
  const ref = row.problem.domain_id === domainId
    ? String(row.problem.number)
    : `${row.source_slug}:${row.problem.number}`;
  return await resolveDomainProblem(slug, ref, actorId, { executor });
}

async function replaceItems(
  executor: Executor,
  assignment: typeof assignments.$inferSelect,
  slug: string,
  actorId: string,
  input: AssignmentDraftInput,
) {
  const rows: Array<typeof assignmentItems.$inferInsert> = [];
  if (input.training) {
    const preview = await readDomainTraining(
      slug,
      input.training.id,
      actorId,
      executor,
    );
    if (!preview.items.length || preview.items.length > 200) {
      throw new BadRequestError("作业题单需要 1–200 道题");
    }
  }
  for (const [sort_order, item] of (input.items ?? []).entries()) {
    const resource = await assignmentProblem(
      executor,
      slug,
      assignment.domain_id,
      actorId,
      item.binding_id,
    );
    rows.push({
      id: crypto.randomUUID(),
      domain_id: assignment.domain_id,
      assignment_id: assignment.id,
      problem_id: resource.problem.id,
      binding_id: resource.binding.id,
      sort_order,
      requirement: item.requirement,
      minimum_score: item.minimum_score ?? null,
    });
  }
  await executor.delete(assignmentItems).where(
    eq(assignmentItems.assignment_id, assignment.id),
  );
  if (rows.length) await executor.insert(assignmentItems).values(rows);
}

/** 创建草稿允许修改题目和要求，发布前不向学生开放。 */
export async function createAssignment(
  slug: string,
  classroomId: string,
  actorId: string,
  input: AssignmentDraftInput,
) {
  return await getDb().transaction((tx) =>
    insertAssignmentDraft(tx, slug, classroomId, actorId, input)
  );
}

/** 复制和创建共用已授权事务，避免嵌套根事务重复取班级锁。 */
export async function insertAssignmentDraft(
  tx: Executor,
  slug: string,
  classroomId: string,
  actorId: string,
  input: AssignmentDraftInput,
  sourceAssignmentId?: string,
  sourceContestId?: string,
) {
  const values = draftInput(input);
  const access = await loadClassroom(slug, classroomId, actorId, {
    executor: tx,
    write: true,
  });
  assertClassroomCapability(access, "assignments:manage");
  const policy = await getInstanceResourcePolicy(tx);
  if (
    !access.domain.configuration.features.assignment ||
    !policy.modules.assignment
  ) throw new AppError("作业模块未启用", 403, "MODULE_DISABLED");
  await assignmentStudents(
    tx,
    access.domain.id,
    classroomId,
    values.target_student_ids,
  );
  const now = new Date().toISOString();
  const [assignment] = await tx.insert(assignments).values({
    id: crypto.randomUUID(),
    domain_id: access.domain.id,
    classroom_id: classroomId,
    ...values,
    source_assignment_id: sourceAssignmentId,
    source_contest_id: sourceContestId,
    created_by: actorId,
    created_at: now,
    updated_at: now,
  }).returning();
  await replaceItems(tx, assignment, slug, actorId, input);
  await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
    operation: "assignment.create",
    assignment_id: assignment.id,
  });
  return assignment;
}

/** 草稿编辑使用完整表单和 revision；发布后调整题目需复制新任务。 */
export async function updateAssignment(
  slug: string,
  id: string,
  actorId: string,
  revision: number | null,
  input: AssignmentDraftInput,
) {
  const values = draftInput(input);
  return await getDb().transaction(async (tx) => {
    const access = await loadAssignment(slug, id, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomRevision(access.assignment.revision, revision);
    if (access.assignment.state !== "draft") {
      throw new ConflictError(
        "只有草稿可修改题目、要求及发布选项",
        "ASSIGNMENT_IMMUTABLE",
      );
    }
    await assignmentStudents(
      tx,
      access.domain.id,
      access.classroom.id,
      values.target_student_ids,
    );
    await replaceItems(tx, access.assignment, slug, actorId, input);
    const [updated] = await tx.update(assignments).set({
      ...values,
      revision: access.assignment.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(assignments.id, id)).returning();
    return updated;
  });
}

/** 班级作业列表先按接收关系过滤再分页，不泄露其他学生的补题任务。 */
export async function listAssignments(
  slug: string,
  classroomId: string,
  actorId: string,
  page = 1,
) {
  const access = await loadClassroom(slug, classroomId, actorId, {
    historicalStudent: true,
  });
  const staff = access.managesDomain ||
    access.classMembership?.role === "coach" ||
    access.classMembership?.role === "assistant" &&
      access.capabilities.size > 0;
  const draftAccess = access.managesDomain ||
    access.classMembership?.role === "coach" ||
    access.capabilities.has("assignments:manage");
  const rows = await getDb().select().from(assignments).where(
    and(
      eq(assignments.classroom_id, classroomId),
      draftAccess ? undefined : sql`${assignments.published_at} IS NOT NULL`,
      staff
        ? undefined
        : sql`${assignments.published_at} IS NOT NULL AND EXISTS (
      SELECT 1 FROM assignment_recipients r WHERE r.assignment_id = ${assignments.id} AND r.user_id = ${actorId})`,
    ),
  ).orderBy(asc(assignments.created_at), assignments.id).limit(50).offset(
    (page - 1) * 50,
  );
  return rows.map(({ target_student_ids, ...detail }) => ({
    ...detail,
    ...(staff ? { target_student_ids } : {}),
  }));
}

/** 学生详情不返回其他人的接收名单，也不返回可修改的目标账号配置。 */
export async function getAssignment(slug: string, id: string, actorId: string) {
  const access = await loadAssignment(slug, id, actorId);
  const rows = await getDb().select({
    item: assignmentItems,
    problemId: problems.id,
    number: problems.number,
    sourceId: domains.id,
    sourceSlug: domains.slug,
  }).from(assignmentItems)
    .innerJoin(problems, eq(problems.id, assignmentItems.problem_id))
    .innerJoin(domains, eq(domains.id, problems.domain_id)).where(
      eq(assignmentItems.assignment_id, id),
    ).orderBy(assignmentItems.sort_order);
  const { target_student_ids, ...detail } = access.assignment;
  return {
    ...detail,
    ...(access.staff ? { target_student_ids } : {}),
    items: rows.map((r) => ({
      ...r.item,
      reference: domainProblemReference(
        { id: r.problemId, number: r.number, domain_id: r.sourceId },
        r.sourceSlug,
        access.domain.id,
      ),
    })),
  };
}
