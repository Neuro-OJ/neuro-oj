/**
 * Problems CRUD 门面：createProblem / updateProblem / 题目删除事务步骤（PR 拆分 PR-3）。
 *
 * 物理拆分（纯搬移，对外导出集合与签名不变）：
 * - problem-create.ts：创建入口（createProblem / createProblemForActor /
 *   createDomainProblem / createDomainProblemForActor）与创建期输入校验
 * - problem-update.ts：更新入口（updateProblem / updateProblemForActor）、
 *   题型/运行时不可变规则、内容补丁合并
 * - problem-delete.ts：题目删除的 prepare / owned rows / finalize 各阶段
 *
 * 设计要点：
 * - 创建题目、初始草稿、标签、本域绑定及编号同事务
 * - updateProblem 拒绝已撤除的分类，题号保持不可变
 * - 题目删除的事务步骤由 problem-delete.ts 提供（prepareProblemDeletionTx /
 *   deleteProblemOwnedRowsTx / finalizeDeletedProblem），评测行的在途检查与删除经
 *   evaluations 的合同统一由 application 的 deleteProblemCommand 编排（P3 §3.3）
 */

export {
  createDomainProblem,
  createDomainProblemForActor,
  createProblem,
  createProblemForActor,
} from "./problem-create.ts";
export { updateProblem, updateProblemForActor } from "./problem-update.ts";
export {
  deleteProblemOwnedRowsTx,
  type DeleteProblemTxResult,
  finalizeDeletedProblem,
  prepareProblemDeletionTx,
} from "./problem-delete.ts";
export {
  assertProblemEditPermission,
  assertProblemEditPermissionForActor,
} from "./problem-edit-permission.ts";
export { mergeProblemContentPatch } from "./problem-content-patch.ts";
