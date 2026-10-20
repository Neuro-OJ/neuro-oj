/**
 * contests 对外兼容的只读合同。
 *
 * 保密、准入与固定版本策略的唯一实现位于 access/contest-policy.ts：这些
 * 查询只读取共享 schema 事实，不属于 contests 业务服务。此处保留窄合同和旧
 * 的 userId 适配，以便尚未迁移的评测/旧路由逐步切换；problems 业务不得再依赖
 * 此兼容入口，应直接依赖 access 政策。
 */
import {
  guestActor,
  userActorFromAuthenticatedId,
} from "../../access/contracts/actor.ts";
import {
  filterProblemsInRunningContest,
  getContestPolicySnapshot,
  isProblemInRunningContest,
  isProblemInUnendedPublicContest,
  loadPublicContestSecrecy,
  resolveContestId,
  runningWindowCondition,
  unendedPublicContestForProblem,
  verifyContestAccess as verifyContestAccessWithActor,
} from "../../access/contest-policy.ts";
export {
  filterProblemsInRunningContest,
  getContestPolicySnapshot,
  isProblemInRunningContest,
  isProblemInUnendedPublicContest,
  loadPublicContestSecrecy,
  resolveContestId,
  runningWindowCondition,
  unendedPublicContestForProblem,
};
export type {
  ContestAccessInfo,
  ContestPolicySnapshot,
  ContestSecrecyPolicy,
  ContestType,
  PublicContestSecrecyRef,
} from "../../access/contest-policy.ts";

/** 旧调用方适配：新的业务写路径必须在边界处构造明确 UserActor。 */
export async function verifyContestAccess(
  userId: string | null,
  contestId: string,
  problemId: string,
  options: { domainId?: string } = {},
) {
  return await verifyContestAccessWithActor(
    userId === null ? guestActor() : userActorFromAuthenticatedId(userId),
    contestId,
    problemId,
    options,
  );
}
