import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  classroomMemberships,
  classrooms,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import {
  type ClassroomRole,
  type TeachingCapability,
} from "../../../shared/education-types.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { assertActiveDomainStudent } from "./classrooms.ts";
import { syncStudentAssignmentRecipients } from "./assignment-recipients.ts";
import {
  assertClassroomCapability,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";

function memberInput(
  role: ClassroomRole,
  input: readonly TeachingCapability[],
) {
  if (role !== "student" || input.length) {
    throw new BadRequestError("班级仅支持学生成员；请在域设置中任命教练");
  }
  return [];
}

/** 班级人员目录按权限返回，当前学生可读取有效同班同学。 */
export async function listClassroomMembers(
  slug: string,
  classroomId: string,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId), db = getDb();
  const staff = access.managesDomain ||
    access.capabilities.has("progress:read") ||
    access.capabilities.has("submissions:read") ||
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
        staff ? undefined : and(
          eq(classroomMemberships.status, "active"),
          eq(domainMemberships.status, "active"),
          eq(classroomMemberships.role, "student"),
          sql`${users.deleted_at} IS NULL`,
        ),
      ),
    )
    .orderBy(classroomMemberships.joined_at, classroomMemberships.id);
  return rows.map((row) => ({
    ...row.membership,
    username: row.deleted_at ? "已注销账号" : row.username,
    effective_active: row.membership.status === "active" &&
      row.domain_status === "active" && !row.deleted_at,
  }));
}

/** 新增或恢复本域学生成员，与班级 revision 同一事务写入。 */
export async function setClassroomMember(
  slug: string,
  classroomId: string,
  actorId: string,
  userId: string,
  expectedRevision: number | null,
  input: { role: ClassroomRole; capabilities?: readonly TeachingCapability[] },
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
    await syncStudentAssignmentRecipients(
      tx,
      access.domain.id,
      classroomId,
      userId,
      input.role === "student",
      now,
    );
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
