import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  contestParticipants,
  contests,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
} from "../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../access/contracts/cross-module/workspace_services_access.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { assertActiveInstanceAccount } from "../../access/contracts/cross-module/identity_services_security_account-access.ts";
import type {
  ContestType,
  CreateContestInput,
  UpdateContestInput,
} from "../types/contests.ts";
import {
  createContest,
  getContest,
  registerForContest,
  updateContest,
} from "./contests.ts";
import { loadDomainContest } from "./domain-access.ts";
import { resolveDomainContestProblems } from "./domain-problems.ts";

/** 显式域比赛列表在计数及分页前过滤其他域和未获授权的邀请赛。 */
export async function listDomainContests(
  slug: string,
  actorId: string | null,
  query: { page: number; perPage: number; type?: ContestType },
) {
  const db = getDb(), workspace = await loadWorkspace(slug, actorId);
  const manager = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("contest:manage");
  const visible = and(
    eq(contests.domain_id, workspace.domain.id),
    query.type ? eq(contests.type, query.type) : undefined,
    manager ? undefined : or(
      eq(contests.is_public, true),
      actorId
        ? sql`EXISTS (SELECT 1 FROM contest_participants cp WHERE cp.contest_id = ${contests.id} AND cp.user_id = ${actorId})`
        : undefined,
      actorId && workspace.context.domainPermissions.has("contest:manage_own")
        ? eq(contests.created_by, actorId)
        : undefined,
    ),
  );
  const [[total], rows] = await Promise.all([
    db.select({ total: count() }).from(contests).where(visible),
    db.select({ id: contests.id, revision: contests.revision }).from(contests)
      .where(visible).orderBy(desc(contests.start_time), contests.id).limit(
        query.perPage,
      ).offset((query.page - 1) * query.perPage),
  ]);
  return {
    total: total.total,
    data: await Promise.all(
      rows.map(async (row) => ({
        ...await getContest(row.id, actorId ?? undefined),
        domain_id: workspace.domain.id,
        revision: row.revision,
      })),
    ),
  };
}

/** 比赛详情返回使用域，不暴露密码哈希或其他域身份。 */
export async function getDomainContest(
  slug: string,
  reference: string,
  actorId: string | null,
) {
  const access = await loadDomainContest(slug, reference, actorId);
  return {
    ...await getContest(access.contest.id, actorId ?? undefined),
    domain_id: access.domain.id,
    revision: access.contest.revision,
    can_manage: access.organizer,
  };
}

/** 创建比赛与域题库授权校验同事务；资源编辑者可组织本域比赛。 */
export async function createDomainContest(
  slug: string,
  actorId: string,
  input: CreateContestInput,
) {
  return await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: "share",
    });
    assertWorkspacePermission(workspace.context, "contest:create");
    if (!Array.isArray(input.problems) || !input.problems.length) {
      throw new BadRequestError("比赛至少需要一道题目");
    }
    const selected = await resolveDomainContestProblems(
      tx,
      workspace.domain.id,
      input.problems.map((item) => item.problem_id),
      input.type,
    );
    const created = await createContest(
      { ...input, kind: input.kind ?? "public", affect_global_ranking: false },
      actorId,
      true,
      {
        executor: tx,
        domainId: workspace.domain.id,
        versions: selected.versions,
        bindings: selected.bindingIds,
      },
    );
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: "contest.create",
      contest_id: created.id,
      type: created.type,
    });
    return {
      ...created,
      domain_id: workspace.domain.id,
      revision: 0,
      can_manage: true,
    };
  });
}

/** 草稿修改带 revision；开赛后不可改变赛制、题目集合、受理窗口或封榜规则。 */
export async function updateDomainContest(
  slug: string,
  reference: string,
  actorId: string,
  revision: number | null,
  input: UpdateContestInput,
) {
  return await getDb().transaction(async (tx) => {
    const access = await loadDomainContest(slug, reference, actorId, {
      executor: tx,
      write: true,
      manage: true,
    });
    if (revision === null) {
      throw new AppError(
        "需要 If-Match 比赛 revision",
        428,
        "REVISION_REQUIRED",
      );
    }
    const type = input.type ?? access.contest.type as ContestType;
    const selected = input.problems
      ? await resolveDomainContestProblems(
        tx,
        access.domain.id,
        input.problems.map((p) => p.problem_id),
        type,
      )
      : null;
    const [current] = await tx.select().from(contests).where(
      eq(contests.id, access.contest.id),
    ).for("update");
    if (current.revision !== revision) {
      throw new ConflictError("比赛已修改，请重新读取");
    }
    if (
      Date.now() >= Date.parse(current.start_time) &&
      [
        input.type,
        input.config,
        input.problems,
        input.start_time,
        input.end_time,
        input.freeze_start_time,
        input.freeze_duration_seconds,
      ].some((v) => v !== undefined)
    ) {
      throw new ConflictError("开赛后不能修改赛制、题目、受理窗口或封榜规则");
    }
    const updated = await updateContest(
      current.id,
      { ...input, affect_global_ranking: false },
      true,
      {
        executor: tx,
        domainId: access.domain.id,
        versions: selected?.versions,
        bindings: selected?.bindingIds,
      },
    );
    await tx.update(contests).set({ revision: current.revision + 1 }).where(
      eq(contests.id, current.id),
    );
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "contest.update",
      contest_id: current.id,
      revision: current.revision + 1,
    });
    return {
      ...updated,
      domain_id: access.domain.id,
      revision: current.revision + 1,
      can_manage: true,
    };
  });
}

/** 邀请码只能加入本域比赛，不能把未入域账号提升为域成员。 */
export async function registerForDomainContest(
  slug: string,
  reference: string,
  actorId: string,
  password?: string,
) {
  await getDb().transaction(async (tx) => {
    const access = await loadDomainContest(slug, reference, actorId, {
      executor: tx,
      write: true,
      lock: true,
      joining: true,
    });
    assertWorkspacePermission(access.context, "contest:participate");
    await registerForContest(access.contest.id, actorId, password, tx);
  });
}

/** 组织者批量加入只接受当前活跃域成员，不创建账号或暗中加入其他域。 */
export async function addDomainContestParticipants(
  slug: string,
  reference: string,
  actorId: string,
  userIds: string[],
) {
  if (
    !Array.isArray(userIds) || !userIds.length || userIds.length > 500 ||
    userIds.some((id) => typeof id !== "string" || !id)
  ) throw new BadRequestError("请选择 1–500 名域成员");
  return await getDb().transaction(async (tx) => {
    const access = await loadDomainContest(slug, reference, actorId, {
      executor: tx,
      write: true,
      manage: true,
      lock: true,
    });
    const ids = [...new Set(userIds)];
    const members = await tx.select({ id: users.id }).from(domainMemberships)
      .innerJoin(users, eq(users.id, domainMemberships.user_id)).where(and(
        eq(domainMemberships.domain_id, access.domain.id),
        eq(domainMemberships.status, "active"),
        inArray(users.id, ids),
      ));
    if (members.length !== ids.length) {
      throw new BadRequestError("名单包含非当前域成员或停用账号");
    }
    for (const member of members) {
      await assertActiveInstanceAccount(member.id, tx);
    }
    if (Date.now() >= Date.parse(access.contest.end_time)) {
      throw new ForbiddenError("比赛已结束，无法添加参赛者");
    }
    const inserted = await tx.insert(contestParticipants).values(
      ids.map((id) => ({
        contest_id: access.contest.id,
        user_id: id,
        registered_at: new Date().toISOString(),
      })),
    ).onConflictDoNothing().returning({ id: contestParticipants.user_id });
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "contest.add_participants",
      contest_id: access.contest.id,
      user_ids: ids,
    });
    return inserted.length;
  });
}

/** 管理成员列表仅在组织端开放。 */
export async function listDomainContestParticipants(
  slug: string,
  reference: string,
  actorId: string,
) {
  const access = await loadDomainContest(slug, reference, actorId, {
    manage: true,
  });
  return await getDb().select({
    user_id: users.id,
    username: users.username,
    avatar_url: users.avatar_url,
    registered_at: contestParticipants.registered_at,
  }).from(contestParticipants)
    .innerJoin(users, eq(users.id, contestParticipants.user_id)).where(
      eq(contestParticipants.contest_id, access.contest.id),
    ).orderBy(contestParticipants.registered_at, users.id);
}

/** 移除参赛关系保留历史提交、正式成绩与审计。 */
export async function removeDomainContestParticipant(
  slug: string,
  reference: string,
  actorId: string,
  userId: string,
) {
  await getDb().transaction(async (tx) => {
    const access = await loadDomainContest(slug, reference, actorId, {
      executor: tx,
      write: true,
      manage: true,
      lock: true,
    });
    await tx.delete(contestParticipants).where(
      and(
        eq(contestParticipants.contest_id, access.contest.id),
        eq(contestParticipants.user_id, userId),
      ),
    );
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "contest.remove_participant",
      contest_id: access.contest.id,
      user_id: userId,
    });
  });
}
