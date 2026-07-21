/**
 * Problems 公共入口（PR 拆分 PR-3 barrel）。
 *
 * 物理拆分（避免单文件 1268 行怪兽）：
 * - problems-types.ts：响应 DTO（ProblemResponse / ProblemListResponse /
 *   AdminProblemList*） + validateRuntimeConfig
 * - problems-list.ts：listProblems / listAllProblems / getProblem /
 *   getProblemByTypeAndNumber + attachCategories
 * - problems-categories.ts：syncProblemCategories
 * - problems-crud.ts：createProblem / updateProblem / deleteProblem
 * - problems-export.ts：buildExportPayload / importProblems
 *
 * 本文件仅 re-export 以保持向后兼容（routes/admin.ts、routes/problems.ts、
 * tests/services/problems.test.ts、tests/routes/problems.test.ts 等既有
 * import 路径不变）。
 *
 * 新代码建议直接从对应子模块 import，避免通过 barrel。
 */

export {
  createProblem,
  deleteProblem,
  updateProblem,
} from "./problems-crud.ts";

export {
  getProblem,
  getProblemByTypeAndNumber,
  listAllProblems,
  listProblems,
} from "./problems-list.ts";

export { syncProblemCategories } from "./problems-categories.ts";

export { buildExportPayload, importProblems } from "./problems-export.ts";

export { validateRuntimeConfig } from "./problems-types.ts";

export type {
  AdminProblemListItem,
  AdminProblemListResponse,
  ProblemListResponse,
  ProblemResponse,
} from "./problems-types.ts";
