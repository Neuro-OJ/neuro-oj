import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { publicUserSummary } from "../../../shared/identity/user-summary.ts";
import {
  classroomAssistantGrants,
  classroomMemberships,
  classrooms,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import { workspaceAudit } from "../../workspace/index.ts";
import { assertActiveDomainStudent } from "./classrooms.ts";
import { syncStudentAssignmentRecipients } from "./assignment-recipients.ts";
import {
  assertClassroomCapability,
  assertClassroomCoach,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";

/** 班级人员目录按权限返回，学生只能读取自己的任职记录。 */
export async function listClassroomMembers(
  slug: string,
  classroomId: string,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId), db = getDb();
  const staff = access.managesDomain;
  const rows = await db.select({
    membership: classroomMemberships,
    username: users.username,
    avatar_url: users.avatar_url,
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
        eq(classroomMemberships.role, "student"),
        staff ? undefined : eq(classroomMemberships.user_id, actorId),
      ),
    )
    .orderBy(classroomMemberships.joined_at, classroomMemberships.id);
  return rows.map((row) => ({
    ...row.membership,
    username: row.deleted_at ? "已注销账号" : row.username,
    avatar_url: row.deleted_at ? null : row.avatar_url,
    user: publicUserSummary({ id: row.membership.user_id, username: row.username, avatar_url: row.avatar_url, deleted_at: row.deleted_at }),
    effective_active: row.membership.status === "active" &&
      row.domain_status === "active" && !row.deleted_at,
  }));
}

/** 新增或恢复学生归属，与班级 revision 在同一事务写入。 */
export async function setClassroomMember(
  slug: string,
  classroomId: string,
  actorId: string,
  userId: string,
  expectedRevision: number | null,
  input: Record<string, unknown> = {},
) {
  if ("role" in input || "capabilities" in input) {
    throw new BadRequestError("班级只管理学生归属，教学权限请在域成员中设置");
  }
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
      role: "student",
      joined_at: now,
      appointed_at: now,
    }).onConflictDoUpdate({
      target: [classroomMemberships.classroom_id, classroomMemberships.user_id],
      set: {
        role: "student",
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
      true,
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
      role: "student",
      revision: updated.revision,
    });
    return { member, revision: updated.revision };
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

/** 更换班级联系人只更新展示信息，不任命域教练或改变学生归属。 */
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
    const now = new Date().toISOString();
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
