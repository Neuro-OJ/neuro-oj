import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  classroomJoinRequests,
  classroomMemberships,
  classrooms,
  domains,
  users,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { assertActiveInstanceAccount } from "../../identity/index.ts";
import {
  assertDomainFeatureEnabled,
  getInstanceResourcePolicy,
  loadWorkspace,
  workspaceAudit,
} from "../../workspace/index.ts";
import {
  assertClassroomCapability,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";
import { assertActiveDomainStudent } from "./classrooms.ts";
import { joinInvitedClassroom } from "./invitations.ts";
import { educationOperation } from "./operations.ts";

async function joinTarget(
  slug: string,
  classroomId: string,
  actorId: string,
  executor: Executor,
  write = false,
) {
  const workspace = await loadWorkspace(slug, actorId, {
    executor,
    write,
    lock: write ? "share" : false,
  });
  if (!workspace.membership && !workspace.platformAdmin) {
    throw new ForbiddenError("请先加入此空间，再申请班级");
  }
  const query = executor.select().from(classrooms).where(
    and(
      eq(classrooms.id, classroomId),
      eq(classrooms.domain_id, workspace.domain.id),
    ),
  );
  const [classroom] = write ? await query.for("update") : await query;
  if (!classroom) throw new NotFoundError("班级不存在");
  if (write) {
    await assertDomainFeatureEnabled(workspace.domain, "classroom", {
      executor,
      disabledCode: "CLASSROOM_READ_ONLY",
    });
  }
  const enabled = write ||
    workspace.domain.configuration.features.classroom === true &&
      (await getInstanceResourcePolicy(executor)).modules.classroom;
  const canApply = classroom.status === "active" &&
    workspace.domain.status === "active" &&
    enabled;
  if (write && !canApply) {
    throw new AppError("班级当前不接受加入申请", 403, "CLASSROOM_READ_ONLY");
  }
  return { ...workspace, classroom, canApply };
}

/** 申请链接只展示班级名称和本人申请，不开放同学名单、成绩或教学内容。 */
export async function readClassroomJoin(
  slug: string,
  classroomId: string,
  actorId: string,
) {
  const access = await joinTarget(slug, classroomId, actorId, getDb());
  const [member] = await getDb().select().from(classroomMemberships).where(and(
    eq(classroomMemberships.classroom_id, classroomId),
    eq(classroomMemberships.user_id, actorId),
  ));
  const [request] = await getDb().select().from(classroomJoinRequests).where(
    and(
      eq(classroomJoinRequests.classroom_id, classroomId),
      eq(classroomJoinRequests.user_id, actorId),
    ),
  )
    .orderBy(
      desc(classroomJoinRequests.created_at),
      desc(classroomJoinRequests.id),
    ).limit(1);
  return {
    classroom_id: classroomId,
    name: access.classroom.name,
    status: access.classroom.status,
    domain_slug: access.domain.slug,
    is_member: member?.status === "active",
    can_apply: access.canApply && member?.status !== "active" &&
      (!member || member.role === "student") && request?.status !== "pending",
    request: request ?? null,
  };
}

/** 已是本域成员的账号可以申请学生身份，不能借申请重建教学人员权限。 */
export async function requestClassroomJoin(
  slug: string,
  classroomId: string,
  actorId: string,
  reason: string,
) {
  if (typeof reason !== "string" || reason.length > 2000) {
    throw new BadRequestError("申请理由需要不超过 2000 字符");
  }
  return await getDb().transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, actorId))
      .for("no key update");
    const access = await joinTarget(slug, classroomId, actorId, tx, true);
    const [member] = await tx.select().from(classroomMemberships).where(and(
      eq(classroomMemberships.classroom_id, classroomId),
      eq(classroomMemberships.user_id, actorId),
    ));
    if (member?.status === "active") throw new ConflictError("你已是此班成员");
    if (member && member.role !== "student") {
      throw new ConflictError("原教学人员身份需要由教练调整");
    }
    const [pending] = await tx.select().from(classroomJoinRequests).where(and(
      eq(classroomJoinRequests.classroom_id, classroomId),
      eq(classroomJoinRequests.user_id, actorId),
      eq(classroomJoinRequests.status, "pending"),
    ));
    if (pending) return pending;
    const [request] = await tx.insert(classroomJoinRequests).values({
      id: crypto.randomUUID(),
      domain_id: access.domain.id,
      classroom_id: classroomId,
      user_id: actorId,
      reason: reason.trim(),
      created_at: new Date().toISOString(),
    }).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "classroom.join.request",
      classroom_id: classroomId,
      request_id: request.id,
    });
    return request;
  });
}

/** 管理目录按当前成员管理能力读取，账号注销保留申请历史及已注销显示。 */
export async function listClassroomJoinRequests(
  slug: string,
  classroomId: string,
  actorId: string,
  options: { page?: number; status?: "pending" | "approved" | "rejected" } = {},
) {
  const access = await loadClassroom(slug, classroomId, actorId);
  assertClassroomCapability(access, "students:manage");
  const page = options.page ?? 1, status = options.status ?? "pending";
  if (
    !Number.isSafeInteger(page) || page < 1 || page > 100000 ||
    !["pending", "approved", "rejected"].includes(status)
  ) throw new BadRequestError("申请分页或状态错误");
  const where = and(
    eq(classroomJoinRequests.domain_id, access.domain.id),
    eq(classroomJoinRequests.classroom_id, classroomId),
    eq(classroomJoinRequests.status, status),
  );
  const db = getDb(),
    [total] = await db.select({ count: count() }).from(classroomJoinRequests)
      .where(where);
  const rows = await db.select({
    request: classroomJoinRequests,
    username: users.username,
    deleted_at: users.deleted_at,
  })
    .from(classroomJoinRequests).innerJoin(
      users,
      eq(users.id, classroomJoinRequests.user_id),
    ).where(where)
    .orderBy(asc(classroomJoinRequests.created_at), classroomJoinRequests.id)
    .limit(50).offset((page - 1) * 50);
  return {
    page,
    per_page: 50,
    total: total.count,
    data: rows.map((r) => ({
      ...r.request,
      username: r.deleted_at ? "已注销账号" : r.username,
    })),
  };
}

/** 审核使用原班级 revision 和幂等键；批准只加入学生，不提升域角色或教学人员。 */
export async function reviewClassroomJoin(
  slug: string,
  classroomId: string,
  requestId: string,
  actorId: string,
  revision: number | null,
  key: string,
  decision: "approve" | "reject",
) {
  if (!["approve", "reject"].includes(decision)) {
    throw new BadRequestError("审核决定非法");
  }
  return await getDb().transaction(async (tx) => {
    const [request] = await tx.select({ request: classroomJoinRequests }).from(
      classroomJoinRequests,
    )
      .innerJoin(domains, eq(domains.id, classroomJoinRequests.domain_id))
      .where(
        and(
          eq(domains.slug, slug),
          eq(classroomJoinRequests.classroom_id, classroomId),
          eq(classroomJoinRequests.id, requestId),
        ),
      );
    if (!request) throw new NotFoundError("申请不存在");
    await tx.select({ id: users.id }).from(users).where(
      inArray(users.id, [actorId, request.request.user_id]),
    ).orderBy(users.id).for("no key update");
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCapability(access, "students:manage");
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "classroom.join.review",
      key,
      { classroomId, requestId, revision, decision },
      async () => {
        assertClassroomRevision(access.classroom.revision, revision);
        const [current] = await tx.select().from(classroomJoinRequests).where(
          eq(classroomJoinRequests.id, requestId),
        ).for("update");
        if (current.status !== "pending") throw new ConflictError("申请已处理");
        if (decision === "approve") {
          await assertActiveInstanceAccount(current.user_id, tx);
          await assertActiveDomainStudent(
            tx,
            access.domain.id,
            current.user_id,
          );
          const [member] = await tx.select().from(classroomMemberships).where(
            and(
              eq(classroomMemberships.classroom_id, classroomId),
              eq(classroomMemberships.user_id, current.user_id),
            ),
          );
          if (member && member.role !== "student") {
            throw new ConflictError("教学人员身份需要单独调整");
          }
          await joinInvitedClassroom(
            tx,
            access.domain.id,
            classroomId,
            current.user_id,
          );
        }
        const [reviewed] = await tx.update(classroomJoinRequests).set({
          status: decision === "approve" ? "approved" : "rejected",
          reviewed_by: actorId,
          reviewed_at: new Date().toISOString(),
        }).where(eq(classroomJoinRequests.id, requestId)).returning();
        await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
          operation: "classroom.join.review",
          classroom_id: classroomId,
          request_id: requestId,
          decision,
        });
        return reviewed;
      },
    );
  });
}
