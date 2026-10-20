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
import { loadWorkspace } from "../access/policy.ts";
import { assertWorkspacePermission } from "../access/policy.ts";
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

export async function registerForContestCommand(
  actor: UserActor,
  contestId: string,
  password: string | undefined,
  options: ContestCommandOptions,
): Promise<void> {
  await requireContestPermission(
    actor,
    options.domainSlug,
    "contest:participate",
  );
  return registerForContest(contestId, actor.userId, password);
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

/** 注册指定工作空间的竞赛；邀请码仍由 contests 本地服务校验。 */
export function registerDomainContestCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  password: string | undefined,
): ReturnType<typeof registerForDomainContest> {
  return registerForDomainContest(slug, reference, actor.userId, password);
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
