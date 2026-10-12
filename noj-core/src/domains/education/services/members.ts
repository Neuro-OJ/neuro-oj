import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  classroomAssistantGrants,
  classroomMemberships,
  classrooms,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  ASSISTANT_CAPABILITIES,
  type AssistantCapability,
  type ClassroomRole,
} from "../../../shared/education-types.ts";
import { workspaceAudit } from "../../workspace/index.ts";
import { assertActiveDomainStudent } from "./classrooms.ts";
import { syncStudentAssignmentRecipients } from "./assignment-recipients.ts";
import {
  assertClassroomCapability,
  assertClassroomCoach,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";

function memberInput(
  role: ClassroomRole,
  input: readonly AssistantCapability[],
) {
  if (!["coach", "assistant", "student"].includes(role)) {
    throw new BadRequestError("班级角色非法");
  }
  if (
    !Array.isArray(input) || input.length > ASSISTANT_CAPABILITIES.length ||
    input.some((c) => !ASSISTANT_CAPABILITIES.includes(c))
  ) throw new BadRequestError("助教能力非法");
  if (role !== "assistant" && input.length) {
    throw new BadRequestError("只有助教可以配置教学能力");
  }
  return [...new Set(input)];
}

/** 班级人员目录按权限返回，学生只能读取自己的任职记录。 */
export async function listClassroomMembers(
  slug: string,
  classroomId: string,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId), db = getDb();
  const staff = access.managesDomain ||
    access.classMembership?.role === "coach" ||
    access.capabilities.has("progress:read") ||
    access.capabilities.has("assignments:manage") ||
    access.capabilities.has("students:manage");
  const rows = await db.select({
    membership: classroomMemberships,
    username: users.username,
    deleted_at: users.deleted_at,
    domain_status: domainMemberships.status,
  }).from(classroomMemberships).innerJoin(
    users,
    eq(users.id, classroomMemberships.user_id),
  )
    .innerJoin(
      domainMemberships,
      and(
        eq(domainMemberships.domain_id, classroomMemberships.domain_id),
        eq(domainMemberships.user_id, classroomMemberships.user_id),
      ),
    )
    .where(
      and(
        eq(classroomMemberships.classroom_id, classroomId),
        staff ? undefined : eq(classroomMemberships.user_id, actorId),
      ),
    )
    .orderBy(classroomMemberships.joined_at, classroomMemberships.id);
  const canManage = access.managesDomain ||
    access.classMembership?.role === "coach" ||
    access.capabilities.has("students:manage");
  const grants = canManage && rows.length
    ? await db.select().from(classroomAssistantGrants)
      .where(
        inArray(
          classroomAssistantGrants.membership_id,
          rows.map((r) => r.membership.id),
        ),
      )
    : [];
  return rows.map((row) => ({
    ...row.membership,
    username: row.deleted_at ? "已注销账号" : row.username,
    effective_active: row.membership.status === "active" &&
      row.domain_status === "active" && !row.deleted_at,
    ...(canManage
      ? {
        capabilities: grants.filter((g) =>
          g.membership_id === row.membership.id
        ).map((g) => g.capability),
      }
      : {}),
  }));
}

/** 新增、恢复或任命班级成员，固定助教授权与 revision 同一事务写入。 */
export async function setClassroomMember(
  slug: string,
  classroomId: string,
  actorId: string,
  userId: string,
  expectedRevision: number | null,
  input: { role: ClassroomRole; capabilities?: readonly AssistantCapability[] },
) {
  const capabilities = memberInput(input.role, input.capabilities ?? []);
  return await getDb().transaction(async (tx) => {
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCapability(access, "students:manage");
    assertClassroomRevision(access.classroom.revision, expectedRevision);
    const [existing] = await tx.select().from(classroomMemberships).where(and(
      eq(classroomMemberships.classroom_id, classroomId),
      eq(classroomMemberships.user_id, userId),
    ));
    const coach = access.managesDomain ||
      access.classMembership?.role === "coach";
    if (
      !coach &&
      (input.role !== "student" || existing && existing.role !== "student" ||
        actorId === userId)
    ) {
      throw new ForbiddenError(
        "助教只能管理学生，不能任命教学人员或修改自身权限",
        "CLASSROOM_PERMISSION_DENIED",
      );
    }
    if (
      userId === access.classroom.primary_coach_id && input.role !== "coach"
    ) {
      throw new ConflictError("请先交接班级，再调整主教练身份");
    }
    await assertActiveDomainStudent(tx, access.domain.id, userId);
    const now = new Date().toISOString();
    const [member] = await tx.insert(classroomMemberships).values({
      id: existing?.id ?? crypto.randomUUID(),
      domain_id: access.domain.id,
      classroom_id: classroomId,
      user_id: userId,
      role: input.role,
      joined_at: now,
      appointed_at: now,
    }).onConflictDoUpdate({
      target: [classroomMemberships.classroom_id, classroomMemberships.user_id],
      set: {
        role: input.role,
        status: "active",
        left_at: null,
        appointed_at: now,
        ...(existing?.status === "removed" ? { joined_at: now } : {}),
      },
    }).returning();
    await tx.delete(classroomAssistantGrants).where(
      eq(classroomAssistantGrants.membership_id, member.id),
    );
    await syncStudentAssignmentRecipients(
      tx,
      access.domain.id,
      classroomId,
      userId,
      input.role === "student",
      now,
    );
    if (capabilities.length) {
      await tx.insert(classroomAssistantGrants).values(
        capabilities.map((capability) => ({
          membership_id: member.id,
          capability,
          granted_by: actorId,
          granted_at: now,
        })),
      );
    }
    const [updated] = await tx.update(classrooms).set({
      revision: access.classroom.revision + 1,
      updated_at: now,
    }).where(eq(classrooms.id, classroomId)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "classroom.member",
      classroom_id: classroomId,
      user_id: userId,
      role: input.role,
      capabilities,
      revision: updated.revision,
    });
    return { member, capabilities, revision: updated.revision };
  });
}

/** 离班只结束当前关系，保留作业接收者和作者的稳定账号依据。 */
export async function removeClassroomMember(
  slug: string,
  classroomId: string,
  actorId: string,
  userId: string,
  expectedRevision: number | null,
) {
  return await getDb().transaction(async (tx) => {
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomRevision(access.classroom.revision, expectedRevision);
    const [member] = await tx.select().from(classroomMemberships).where(and(
      eq(classroomMemberships.classroom_id, classroomId),
      eq(classroomMemberships.user_id, userId),
    ));
    if (!member || member.status !== "active") {
      throw new NotFoundError("班级成员不存在");
    }
    if (userId !== actorId) {
      assertClassroomCapability(access, "students:manage");
    }
    if (
      !access.managesDomain && access.classMembership?.role !== "coach" &&
      userId !== actorId && member.role !== "student"
    ) throw new ForbiddenError("助教不能移除教学人员");
    if (access.classroom.primary_coach_id === userId) {
      throw new ConflictError("主教练必须先交接班级");
    }
    const now = new Date().toISOString();
    await tx.update(classroomMemberships).set({
      status: "removed",
      left_at: now,
    })
      .where(eq(classroomMemberships.id, member.id));
    await syncStudentAssignmentRecipients(
      tx,
      access.domain.id,
      classroomId,
      userId,
      false,
      now,
    );
    await tx.delete(classroomAssistantGrants).where(
      eq(classroomAssistantGrants.membership_id, member.id),
    );
    const [updated] = await tx.update(classrooms).set({
      revision: access.classroom.revision + 1,
      updated_at: now,
    }).where(eq(classrooms.id, classroomId)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "classroom.member_remove",
      classroom_id: classroomId,
      user_id: userId,
    });
    return { revision: updated.revision };
  });
}

/** 交接保留所有历史，原主教练仍为教练；离职时另行结束其任职。 */
export async function transferClassroom(
  slug: string,
  classroomId: string,
  actorId: string,
  targetId: string,
  expectedRevision: number | null,
) {
  return await getDb().transaction(async (tx) => {
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCoach(access);
    assertClassroomRevision(access.classroom.revision, expectedRevision);
    await assertActiveDomainStudent(tx, access.domain.id, targetId);
    const [target] = await tx.select().from(classroomMemberships).where(and(
      eq(classroomMemberships.classroom_id, classroomId),
      eq(classroomMemberships.user_id, targetId),
      eq(classroomMemberships.status, "active"),
    ));
    if (!target) throw new BadRequestError("接任者必须先加入本班");
    const now = new Date().toISOString();
    await tx.update(classroomMemberships).set({
      role: "coach",
      appointed_at: now,
    })
      .where(eq(classroomMemberships.id, target.id));
    await syncStudentAssignmentRecipients(
      tx,
      access.domain.id,
      classroomId,
      targetId,
      false,
      now,
    );
    await tx.delete(classroomAssistantGrants).where(
      eq(classroomAssistantGrants.membership_id, target.id),
    );
    const [updated] = await tx.update(classrooms).set({
      primary_coach_id: targetId,
      revision: access.classroom.revision + 1,
      updated_at: now,
    }).where(eq(classrooms.id, classroomId)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "classroom.transfer",
      classroom_id: classroomId,
      from: access.classroom.primary_coach_id,
      to: targetId,
    });
    return updated;
  });
}
