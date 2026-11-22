/**
 * Problems read-model composition.
 *
 * 题目业务提供资源与授权事实；提交聚合属于 read-model/application 组合层，
 * 因而由这里读取统一提交投影并返回题库需要的最小摘要，避免 problems 业务
 * 反向依赖 query 服务。
 */
import {
  getProblemSubmissionSummaries,
  type ProblemSubmissionSummary,
  type SubmissionQueryScope,
} from "../../access/submission-policy.ts";
export type { ProblemSubmissionSummary } from "../../access/submission-policy.ts";

/** 组合当前有效提交投影，供题库列表/详情显示进度和统计。 */
export function getDomainProblemSummaries(
  scope: SubmissionQueryScope,
  problemIds: string[],
  actorId: string | null,
): Promise<ProblemSubmissionSummary[]> {
  return getProblemSubmissionSummaries(scope, problemIds, actorId);
}
