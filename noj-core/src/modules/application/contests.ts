/** contests 应用编排入口。 */
import {
  addParticipants,
  createContest,
  deleteContest,
  registerForContest,
  removeParticipant,
  updateContest,
} from "../contests/services/contests.ts";
import {
  addDomainContestParticipants,
  createDomainContest,
  registerForDomainContest,
  removeDomainContestParticipant,
  updateDomainContest,
} from "../contests/services/domain-contests.ts";
import type {
  ContestResponse,
  CreateContestInput,
  UpdateContestInput,
} from "../contests/types/contests.ts";
import { assertWorkspacePermission, loadWorkspace } from "../access/policy.ts";
import type { UserActor } from "../access/contracts/actor.ts";

export interface ContestCommandOptions {
  readonly domainSlug: string;
}

async function requireContestPermission(
  actor: UserActor,
  domainSlug: string,
  permission: "contest:create" | "contest:manage" | "contest:participate",
) {
  const access = await loadWorkspace(domainSlug, actor, { write: true });
  assertWorkspacePermission(access.context, permission);
  return access;
}

/** 创建竞赛；是否公开由当前 access 权限决定，不读取客户端 role。 */
export async function createContestCommand(
  actor: UserActor,
  input: CreateContestInput,
  options: ContestCommandOptions,
): Promise<ContestResponse> {
  const access = await requireContestPermission(
    actor,
    options.domainSlug,
    "contest:create",
  );
  return createContest(input, actor.userId, access.platformAdmin, {
    domainId: access.context.domainId,
  });
}

export async function updateContestCommand(
  actor: UserActor,
  contestId: string,
  input: UpdateContestInput,
  options: ContestCommandOptions,
): Promise<ContestResponse> {
  const access = await requireContestPermission(
    actor,
    options.domainSlug,
    "contest:manage",
  );
  return updateContest(contestId, input, access.platformAdmin, {
    domainId: access.context.domainId,
  });
}

export async function deleteContestCommand(
  actor: UserActor,
  contestId: string,
  options: ContestCommandOptions,
): Promise<void> {
  await requireContestPermission(actor, options.domainSlug, "contest:manage");
  return deleteContest(contestId);
}

/**
 * 默认域别名入口：登录用户自助报名公开竞赛。
 *
 * 与 `registerForDomainContestCommand` 的区别是**不做域成员资格断言**：
 * 旧 `/api/v1/contests/:id/register` 的既有语义是"任意已认证用户可报名公开竞赛"，
 * 路由中间件已经把竞赛限定在默认域，并只接受该域可见的竞赛。域内报名（
 * `/api/v1/domains/:slug/contests/:ref/register`）仍要求 `contest:participate`。
 *
 * 该别名将在 P8 退役；在此之前保持基线行为，不能借迁移收紧成 403。
 */
export function registerForContestCommand(
  actor: UserActor,
  contestId: string,
  _options: ContestCommandOptions,
): Promise<void> {
  return registerForContest(contestId, actor.userId);
}

export async function addContestParticipantsCommand(
  actor: UserActor,
  contestId: string,
  userIds: string[],
  options: ContestCommandOptions,
): Promise<number> {
  await requireContestPermission(actor, options.domainSlug, "contest:manage");
  return addParticipants(contestId, userIds);
}

export async function removeContestParticipantCommand(
  actor: UserActor,
  contestId: string,
  userId: string,
  options: ContestCommandOptions,
): Promise<void> {
  await requireContestPermission(actor, options.domainSlug, "contest:manage");
  return removeParticipant(contestId, userId);
}

/** 创建指定工作空间的竞赛；工作空间授权与题目固定版本由本地事务校验。 */
export function createDomainContestCommand(
  actor: UserActor,
  slug: string,
  input: CreateContestInput,
): ReturnType<typeof createDomainContest> {
  return createDomainContest(slug, actor.userId, input);
}

/** 更新指定工作空间的竞赛；revision 是业务不变量，调用者不得省略。 */
export function updateDomainContestCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  revision: number | null,
  input: UpdateContestInput,
): ReturnType<typeof updateDomainContest> {
  return updateDomainContest(slug, reference, actor.userId, revision, input);
}

/** 注册指定工作空间的竞赛；报名只由域访问权决定，不再有密码/邀请码。 */
export function registerDomainContestCommand(
  actor: UserActor,
  slug: string,
  reference: string,
): ReturnType<typeof registerForDomainContest> {
  return registerForDomainContest(slug, reference, actor.userId);
}

/** 批量加入指定工作空间的参赛者。 */
export function addDomainContestParticipantsCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  userIds: string[],
): ReturnType<typeof addDomainContestParticipants> {
  return addDomainContestParticipants(slug, reference, actor.userId, userIds);
}

/** 移除指定工作空间的参赛者。 */
export function removeDomainContestParticipantCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  userId: string,
): ReturnType<typeof removeDomainContestParticipant> {
  return removeDomainContestParticipant(slug, reference, actor.userId, userId);
}
