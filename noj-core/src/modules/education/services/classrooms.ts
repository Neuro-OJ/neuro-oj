import { and, eq, isNull, sql } from "drizzle-orm";
import { recordEducationEvent } from "../contracts/facts.ts";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  classrooms,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { assertDomainFeatureEnabled } from "../../access/contracts/cross-module/workspace_services_limits.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../access/contracts/cross-module/workspace_services_access.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
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

/** 创建班级；教练权限由域角色提供，不写入班级名单。 */
export async function createClassroom(slug: string, actorId: string, input: {
  name: string;
  description?: string;
  stage_tag?: string;
}) {
  const values = details(input, true);
  return await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: "share",
    });
    assertWorkspacePermission(workspace.context, "classroom:create");
    await assertDomainFeatureEnabled(workspace.domain, "classroom", {
      executor: tx,
      disabledCode: "MODULE_DISABLED",
    });
    const now = new Date().toISOString();
    const [classroom] = await tx.insert(classrooms).values({
      id: crypto.randomUUID(),
      domain_id: workspace.domain.id,
      name: values.name!,
      description: values.description,
      stage_tag: values.stage_tag,
      created_at: now,
      updated_at: now,
    }).returning();
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: "classroom.create",
      classroom_id: classroom.id,
    });
    return classroom;
  });
}

/** 教学人员可列出全域班级；学生在分页前按当前成员关系筛选。 */
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
  const access = await loadClassroom(slug, classroomId, actorId, {
    historicalStudent: true,
  });
  return {
    ...access.classroom,
    membership: access.classMembership,
    capabilities: [...access.capabilities],
    manages_domain: access.managesDomain,
    historical_student: !access.classMembership && !access.managesDomain,
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
      ...(input.archive
        ? { status: "archived" as const, archived_at: new Date().toISOString() }
        : {}),
      revision: access.classroom.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(classrooms.id, classroomId)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: input.archive ? "classroom.archive" : "classroom.update",
      classroom_id: classroomId,
      revision: updated.revision,
    });
    if (input.archive) {
      await recordEducationEvent(tx, {
        domain_id: access.domain.id,
        classroom_id: classroomId,
        event_type: "recipient.changed",
      });
    }
    return updated;
  });
}
