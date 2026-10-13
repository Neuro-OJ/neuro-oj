import { getDefaultDomainProblemByNumber, getProblem } from "../index.ts";
import type { ProblemViewer } from "../index.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { DEFAULT_DOMAIN_ID } from "../../workspace/index.ts";

/** 旧无域入口只定位默认域；历史 P 数字链接转换为数字，U 入口拒绝。 */
export async function resolveProblem(id: string, viewer?: ProblemViewer) {
  if (/^[Uu][0-9]+$/.test(id)) throw new NotFoundError("旧用户题入口已取消");
  const match = /^(?:[Pp])?([1-9][0-9]*)$/.exec(id);
  if (match) {
    return await getDefaultDomainProblemByNumber(Number(match[1]), viewer);
  }
  const problem = await getProblem(id, viewer);
  if (problem.domain_id !== DEFAULT_DOMAIN_ID) {
    throw new NotFoundError("题目不在默认工作空间");
  }
  return problem;
}

/** 默认域的人类可读题号解析为稳定 ID；不可定位时返回 null。 */
export async function resolveProblemIdOrNull(
  reference: string,
): Promise<string | null> {
  try {
    return (await resolveProblem(reference)).id;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** 默认域兼容入口的稳定 ID 解析，不接受其他域资源 ID。 */
export async function resolveProblemIdOrThrow(
  reference: string,
): Promise<string> {
  return (await resolveProblem(reference)).id;
}
