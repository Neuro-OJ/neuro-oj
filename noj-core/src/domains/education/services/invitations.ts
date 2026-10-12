import { and, eq } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  classroomAssistantGrants,
  classroomMemberships,
  classrooms,
  domainInvitations,
} from "../../../shared/db/schema.ts";
import { ConflictError, NotFoundError } from "../../../shared/base/errors.ts";
import {
  createDomainInvitation,
  revokeDomainInvitation,
  workspaceAudit,
} from "../../workspace/index.ts";
import { assertClassroomCapability, loadClassroom } from "./access.ts";

/** 单次班级邀请复用账号和域邀请流程，不能直接创建平台账号。 */
export async function createClassroomInvitation(
  slug: string,
  classroomId: string,
  actorId: string,
  email: string,
) {
  return await createDomainInvitation(slug, actorId, email, { classroomId });
}

/** 班级邀请目录不返回令牌或哈希；教练只管理此班邀请。 */
export async function listClassroomInvitations(
  slug: string,
  classroomId: string,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId);
  assertClassroomCapability(access, "students:manage");
  return await getDb().select({
    id: domainInvitations.id,
    email: domainInvitations.email,
    expires_at: domainInvitations.expires_at,
    used_at: domainInvitations.used_at,
    revoked_at: domainInvitations.revoked_at,
    created_at: domainInvitations.created_at,
  }).from(domainInvitations).where(
    and(
      eq(domainInvitations.domain_id, access.domain.id),
      eq(domainInvitations.classroom_id, classroomId),
    ),
  ).orderBy(domainInvitations.created_at).limit(100);
}

/** 班级撤销复用 Domain 事务，旧链接不会移除已经加入的学生。 */
export async function revokeClassroomInvitation(
  slug: string,
  classroomId: string,
  actorId: string,
  invitationId: string,
) {
  return await revokeDomainInvitation(slug, actorId, invitationId, {
    classroomId,
  });
}

/** 邀请预览和消费重新验证当前任职、能力、班级状态和教学模块。 */
export async function assertClassroomInvitationIssuer(
  slug: string,
  classroomId: string,
  issuerId: string,
  executor: Executor,
) {
  const access = await loadClassroom(slug, classroomId, issuerId, {
    executor,
    write: true,
  });
  assertClassroomCapability(access, "students:manage");
  return access.classroom;
}

/** 调用方已锁定账号、Domain 和班级，并原子加入 Domain 基础成员。 */
export async function joinInvitedClassroom(
  executor: Executor,
  domainId: string,
  classroomId: string,
  userId: string,
) {
  const [classroom] = await executor.select().from(classrooms).where(and(
    eq(classrooms.id, classroomId),
    eq(classrooms.domain_id, domainId),
  )).for("update");
  if (!classroom || classroom.status !== "active") {
    throw new NotFoundError("班级邀请已失效");
  }
  const [existing] = await executor.select().from(classroomMemberships).where(
    and(
      eq(classroomMemberships.classroom_id, classroomId),
      eq(classroomMemberships.user_id, userId),
    ),
  );
  if (existing?.status === "active") return;
  if (classroom.primary_coach_id === userId) {
    throw new ConflictError("请先处理主教练交接，再通过学生邀请加入");
  }
  const now = new Date().toISOString();
  const [member] = await executor.insert(classroomMemberships).values({
    id: existing?.id ?? crypto.randomUUID(),
    domain_id: domainId,
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
      joined_at: now,
      appointed_at: now,
    },
  }).returning();
  await executor.delete(classroomAssistantGrants).where(
    eq(classroomAssistantGrants.membership_id, member.id),
  );
  await executor.update(classrooms).set({
    revision: classroom.revision + 1,
    updated_at: now,
  })
    .where(eq(classrooms.id, classroom.id));
  await workspaceAudit(executor, userId, domainId, "domain.update", {
    operation: "classroom.invite_accept",
    classroom_id: classroomId,
  });
}
