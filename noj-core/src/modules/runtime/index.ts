/** runtime 基础合同入口；不导出业务模块实现。 */
export {
  cleanupRuntimeSseEvents,
  recordSseEventsTx,
  recordSseEventTx,
  replayRuntimeSseEvents,
} from "./contracts/sse-events.ts";
export type { RuntimeSseEventRow } from "./contracts/sse-events.ts";
export { createSystemActor } from "./system-actors.ts";
// 迁移期：供 src/features/knowledge 使用（掌握度任务 handler 登记与常量对齐）。
export {
  enqueueKnowledgeMasteryTaskTx,
  KNOWLEDGE_MASTERY_TARGET_KIND,
  KNOWLEDGE_MASTERY_TASK_TYPE,
} from "./knowledge-mastery-task.ts";
export {
  TASK_DEFAULT_CLAIM_LIMIT,
  TASK_DEFAULT_LEASE_MS,
  TASK_MAX_BACKOFF_MS,
  TASK_MAX_FAILURES,
  TASK_TARGET_KINDS,
  TASK_TYPES,
} from "./tasks/contracts.ts";
export type {
  ClaimedTask,
  EnqueueTaskInput,
  EnqueueTaskResult,
  TaskHandler,
  TaskHandlerMap,
  TaskHealth,
  TaskPayload,
  TaskRescheduleResult,
  TaskTargetKind,
  TaskType,
} from "./tasks/contracts.ts";
export { isTaskRescheduleResult } from "./tasks/contracts.ts";
export {
  _resetBackgroundTasksForTest,
  claimTasks,
  completeTaskTx,
  enqueueTaskTx,
  failTaskTx,
  getTaskById,
  insertPendingTask,
  isLeaseActive,
  listTasks,
  readTaskHealth,
  renewTaskLease,
  requeueFailedTaskTx,
  rescheduleTaskTx,
} from "./tasks/repository.ts";
export {
  computeRetryDecision,
  isBackoffCapped,
  isTerminalFailure,
  RETRY_BASE_BACKOFF_MS,
  RETRY_MAX_BACKOFF_MS,
  RETRY_MAX_FAILURES,
} from "./tasks/retry-policy.ts";
export type { RetryDecision } from "./tasks/retry-policy.ts";
export { startTaskWorker } from "./tasks/worker.ts";
export type { StartTaskWorkerOptions } from "./tasks/worker.ts";
export { registerRuntimeObservability } from "./observability.ts";
