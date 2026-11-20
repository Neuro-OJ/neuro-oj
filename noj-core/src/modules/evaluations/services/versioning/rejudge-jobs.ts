/**
 * 批任务受理（Handbook §2.10、§4.3、§5.7 前半）。
 *
 * 管理员重测与用户升级共用 `submission_jobs` / `submission_job_items` 两张表，
 * 本模块实现**受理**（把请求变成固定的条目集合）与任务读取，worker 负责派发。
 *
 * 受理语义：
 * - `Idempotency-Key` 与 actor 绑定：同键同请求返回原任务，同键不同请求 → 409；
 * - **受理时同时固定提交集合**：之后产生的新提交不进入本批任务；
 * - `submitted` 用不可变提交时版本；未知历史版本 → 条目 `skipped`
 *   （`LEGACY_VERSION_UNKNOWN`），不整批拒绝；
 * - `latest` / `specified` 在受理事务中解析并固定到条目
 *   （`target_version_id` + `target_version_ref`）；
 * - 界面"全部用 V3"展开成逐题映射后，任一题没有该版本 → **整次受理 400**，
 *   不产生任务、不改策略；
 * - `policy_changes` 必须显式列出作用域与预期 revision，且只能作用于任务包含的
 *   题目/竞赛；校验全部通过后才应用策略并建任务；
 * - 手动所选上限 500；整题/整场无总量上限（后台分批）。
 *
 * 本文件为门面（barrel），实现按职责拆在同目录：
 * - `rejudge-types.ts`：公共类型、读模型与常量；
 * - `rejudge-common.ts`：错误构造、条目分批写入、计数与任务终态推导；
 * - `rejudge-hash.ts`：载荷规范化与幂等哈希；
 * - `rejudge-accept.ts`：请求校验、条目计划与受理事务；
 * - `rejudge-retry.ts`：重试任务；
 * - `rejudge-query.ts`：任务与条目读取。
 */

export {
  type AcceptJobResult,
  JOB_ITEM_INSERT_BATCH,
  type JobItemView,
  type JobSourceKind,
  type JobView,
  MAX_JOB_ITEMS_PER_CLAIM,
  MAX_SELECTED_SUBMISSIONS,
  type PolicyChangeRequest,
  type RejudgeRequest,
  type RejudgeScope,
  type RejudgeTarget,
} from "./rejudge-types.ts";
export {
  countItemsByStatus,
  idempotencyConflict,
  insertJobItemsBatched,
  missingTargetVersion,
  refreshJobStatus,
} from "./rejudge-common.ts";
export {
  hashCanonical,
  hashRequest,
  hashRetryRequest,
} from "./rejudge-hash.ts";
export {
  acceptRejudgeJob,
  normalizeRejudgeRequest,
  planItems,
} from "./rejudge-accept.ts";
export { retryRejudgeJob } from "./rejudge-retry.ts";
export { getRejudgeJob, listRejudgeJobItems } from "./rejudge-query.ts";
