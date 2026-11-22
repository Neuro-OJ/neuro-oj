/**
 * 竞赛访问校验（**薄适配器**）。
 *
 * 2026-11-02 rc/v0.11 审计「政策所有权分散」：本文件与
 * `access/contest-policy.ts` 各有一份同名 `verifyContestAccess`，其中
 * “比赛结束后，题目又被另一场未结束的保密比赛保护”的规则**只**在 access 版
 * 实现，于是同一份数据在两个入口给出不同结论，显著抬高审计成本，并且已经造成
 * 实际缺陷（审计 F4 的答疑授权分叉）。
 *
 * 现在这里只做两件事：
 * 1. 把 `userId | null` 适配成 access 的唯一写入/读取身份 `AccessActor`；
 * 2. 把 access 的结论映射成 catalog 侧既有的 `ContestAccessInfo` DTO。
 *
 * **不要**在本文件重新实现任何窗口、成员、保密或版本判定：规则只有一处。
 */
import type { DbTx, Executor } from "../../../shared/db/executor.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import {
  guestActor,
  userActorFromAuthenticatedId,
} from "../../access/contracts/actor.ts";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../../shared/base/errors.ts";
import { verifyContestAccess as verifyContestAccessPolicy } from "../../access/contest-policy.ts";
import type { ContestAccessInfo } from "../contracts/read.ts";

/**
 * 校验指定用户对竞赛内题目的访问权限。
 *
 * 规则（全部由 `access/contest-policy.ts` 决定）：
 * - 题目必须属于该竞赛；
 * - 用户必须是该域成员（或平台管理员）且是参赛者；
 * - 竞赛处于 running，或已 ended 且题目**没有**被另一场未结束的保密比赛保护。
 *
 * 竞赛不存在、跨域、非成员、非参赛者一律 fail-closed 返回 `allowed: false`。
 */
export async function verifyContestAccess(
  userId: string | null,
  contestId: string,
  problemId: string,
  options: { domainId?: string; executor?: Executor } = {},
): Promise<ContestAccessInfo> {
  const actor = userId === null
    ? guestActor()
    : userActorFromAuthenticatedId(userId);
  let policy: Awaited<ReturnType<typeof verifyContestAccessPolicy>>;
  try {
    policy = await verifyContestAccessPolicy(actor, contestId, problemId, {
      // 旧语义：未显式传域名时按默认域 `main` 固定（不能退化成"任意域"）。
      // access 版把"缺省"理解为"不限定域"，两者必须在这里对齐。
      domainId: options.domainId ?? DEFAULT_DOMAIN_ID,
      // 兼容期：旧调用方可能传根连接（`Executor`）。两者都提供 select/execute，
      // 且本路径不申请事务锁，因此运行时等价；待 `Executor` 别名删除时一并收紧。
      executor: options.executor as DbTx | undefined,
    });
  } catch (error) {
    // 与旧实现一致的 fail-closed：域不存在、域政策拒绝、账号不可用都按"不可访问"
    // 返回，而不是把内部错误抛给调用方（调用方据此决定 403/404 话术）。
    if (
      error instanceof NotFoundError || error instanceof ForbiddenError ||
      error instanceof UnauthorizedError
    ) {
      return { contestId, allowed: false, running: false };
    }
    throw error;
  }
  return {
    contestId: policy.contestId,
    allowed: policy.allowed,
    running: policy.running,
    type: policy.type,
    organizer: policy.organizer === true,
    pinnedVersionId: policy.pinnedVersionId ?? null,
  };
}
