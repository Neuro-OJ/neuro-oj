import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  classroomMemberships,
  classrooms,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  getInstanceResourcePolicy,
  loadWorkspace,
  workspaceAudit,
} from "../../workspace/index.ts";
import {
  assertClassroomCoach,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";

function details(
  input: { name?: string; description?: string; stage_tag?: string },
  required = false,
) {
  if (required && input.name === undefined) {
    throw new BadRequestError("需要班级名称");
  }
  const values: { name?: string; description?: string; stage_tag?: string } =
    {};
  for (
    const [key, max] of [["name", 120], ["description", 10000], [
      "stage_tag",
      80,
    ]] as const
  ) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" || value.length > max ||
      key === "name" && !value.trim()
    ) {
      throw new BadRequestError("班级名称、简介或阶段标签格式错误");
    }
    values[key] = value.trim();
  }
  return values;
}

/** 学生与教练必须是当前域有效成员，账号注销和移除不能留下新任职。 */
export async function assertActiveDomainStudent(
  executor: Executor,
  domainId: string,
  userId: string,
) {
  const [member] = await executor.select({ id: domainMemberships.id }).from(
    domainMemberships,
  )
    .innerJoin(users, eq(users.id, domainMemberships.user_id)).where(and(
      eq(domainMemberships.domain_id, domainId),
      eq(domainMemberships.user_id, userId),
      eq(domainMemberships.status, "active"),
      isNull(users.deleted_at),
    ));
  if (!member) throw new NotFoundError("账号不是此域的有效成员");
}

/** 创建班级与初始教练任职在同一事务提交。 */
export async function createClassroom(slug: string, actorId: string, input: {
  name: string;
  description?: string;
  stage_tag?: string;
  primary_coach_id?: string;
}) {
  const values = details(input, true),
    coachId = input.primary_coach_id ?? actorId;
  return await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: "share",
    });
    assertWorkspacePermission(workspace.context, "classroom:create");
    const policy = await getInstanceResourcePolicy(tx);
    if (
      !workspace.domain.configuration.features.classroom ||
      !policy.modules.classroom
    ) {
      throw new AppError("教学模块未启用", 403, "MODULE_DISABLED");
    }
    if (coachId !== actorId) {
      assertWorkspacePermission(workspace.context, "classroom:manage_any");
    }
    await assertActiveDomainStudent(tx, workspace.domain.id, coachId);
    const now = new Date().toISOString();
    const [classroom] = await tx.insert(classrooms).values({
      id: crypto.randomUUID(),
      domain_id: workspace.domain.id,
      name: values.name!,
      description: values.description,
      stage_tag: values.stage_tag,
      primary_coach_id: coachId,
      created_at: now,
      updated_at: now,
    }).returning();
    await tx.insert(classroomMemberships).values({
      id: crypto.randomUUID(),
      domain_id: workspace.domain.id,
      classroom_id: classroom.id,
      user_id: coachId,
      role: "coach",
      joined_at: now,
      appointed_at: now,
    });
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: "classroom.create",
      classroom_id: classroom.id,
      primary_coach_id: coachId,
    });
    return classroom;
  });
}

/** 列表在分页前限定当前班级关系，不泄露其他教练或历史学生的班级。 */
export async function listClassrooms(slug: string, actorId: string, page = 1) {
  const workspace = await loadWorkspace(slug, actorId), db = getDb();
  const manage = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("classroom:manage_any");
  return await db.select().from(classrooms).where(and(
    eq(classrooms.domain_id, workspace.domain.id),
    manage ? undefined : sql`EXISTS (SELECT 1 FROM classroom_memberships m
      JOIN domain_memberships d ON d.domain_id = m.domain_id AND d.user_id = m.user_id
      WHERE m.classroom_id = ${classrooms.id} AND m.user_id = ${actorId}
      AND m.status = 'active' AND d.status = 'active')`,
  )).orderBy(classrooms.created_at, classrooms.id).limit(50).offset(
    (page - 1) * 50,
  );
}

/** 班级详情仅包含当前访问者任职及其能力，不附带同学成绩。 */
export async function getClassroom(
  slug: string,
  classroomId: string,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId);
  return {
    ...access.classroom,
    membership: access.classMembership,
    capabilities: [...access.capabilities],
    manages_domain: access.managesDomain,
  };
}

/** 编辑或归档只改变班级配置，不移动、删除任何历史。 */
export async function updateClassroom(
  slug: string,
  classroomId: string,
  actorId: string,
  expectedRevision: number | null,
  input: {
    name?: string;
    description?: string;
    stage_tag?: string;
    archive?: boolean;
  },
) {
  const values = details(input);
  return await getDb().transaction(async (tx) => {
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCoach(access);
    assertClassroomRevision(access.classroom.revision, expectedRevision);
    const [updated] = await tx.update(classrooms).set({
      ...values,
      ...(input.archive ? { status: "archived" as const } : {}),
      revision: access.classroom.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(classrooms.id, classroomId)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: input.archive ? "classroom.archive" : "classroom.update",
      classroom_id: classroomId,
      revision: updated.revision,
    });
    return updated;
  });
}
