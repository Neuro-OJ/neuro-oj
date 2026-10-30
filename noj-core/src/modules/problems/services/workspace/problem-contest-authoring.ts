import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import type { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";

/** 草稿编辑始终由域角色控制；报名不会改变题目维护权限。 */
export function problemAuthoringRestrictionSql(
  _workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  _problemId: string | AnyColumn | SQL,
): SQL {
  return sql`false`;
}

/** 保留调用合同，赛题保护仅限制作答内容与提交，不替代管理授权。 */
export function problemAuthoringRestrictedByContest(
  _workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  _problemId: string,
  _executor: Executor,
): Promise<boolean> {
  return Promise.resolve(false);
}

/** 调用者须先完成域编辑权限检查，比赛报名不增加第二套编辑隔离。 */
export function assertProblemAuthoringOutsideParticipation(
  _workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  _problemId: string,
  _executor: Executor,
): Promise<void> {
  return Promise.resolve();
}
