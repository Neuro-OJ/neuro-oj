/**
 * 后台任务原语合同（P4）。
 *
 * 这些类型是 repository/worker/application handler 之间的唯一约定：
 * - `TaskPayload` 只放可恢复依据，不放秘密；
 * - handler 由 application 注入，runtime 不反向依赖业务模块；
 * - 领取/续租/完成/失败都以「token + 状态 + DB 时间」为条件，影响 0 行即视为
 *   租约已失效。
 */

/** 任务类型枚举；新增类型必须同时登记 handler。 */
export const TASK_TYPES = [
  "evaluation.dispatch",
  "search.index",
  "education.recompute",
  "storage.reclaim",
  "notification.email",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** 目标归属；不同目标分别登记，互不阻塞。 */
export const TASK_TARGET_KINDS = [
  "submission",
  "problem",
  "domain",
  "assignment",
  "storage_object",
] as const;

export type TaskTargetKind = (typeof TASK_TARGET_KINDS)[number];

/** 任务可恢复依据：只保存资源 ID、attempt ID、revision、分页游标等。 */
export interface TaskPayload {
  readonly [key: string]: unknown;
}

/** 入队输入。 */
export interface EnqueueTaskInput {
  readonly taskType: TaskType;
  readonly targetKind: TaskTargetKind;
  readonly targetId: string;
  /** 业务去重键；空串表示该目标同类型只保留一条活跃任务。 */
  readonly dedupeKey?: string;
  readonly payloadVersion?: number;
  readonly payload?: TaskPayload;
  /** 最早可领取时刻（ISO 8601）；缺省为当前时间。 */
  readonly availableAt?: string;
}

/** 入队结果：`created: false` 表示命中同去重键的既有任务。 */
export interface EnqueueTaskResult {
  readonly taskId: string;
  readonly created: boolean;
}

/** 领取到的任务（含租约 token）。 */
export interface ClaimedTask {
  readonly id: string;
  readonly taskType: TaskType;
  readonly targetKind: TaskTargetKind;
  readonly targetId: string;
  readonly dedupeKey: string;
  readonly payloadVersion: number;
  readonly payload: TaskPayload;
  readonly failureCount: number;
  readonly leaseToken: string;
  readonly leaseExpiry: string;
}

/** 任务健康快照（指标与运维读取）。 */
export interface TaskHealth {
  /** 可领取（pending 且已到 available_at）任务数。 */
  readonly ready: number;
  /** 租约中任务数。 */
  readonly leased: number;
  /** 终态失败任务数。 */
  readonly failed: number;
  /** 最老待领取任务的年龄（毫秒）；无待领取任务为 0。 */
  readonly oldestReadyAgeMs: number;
  /** 最早到期的租约剩余毫秒；无租约为 0。 */
  readonly nextLeaseExpiryMs: number;
}

/** 连续失败达到该次数转入终态 failed（交接文档 §4.2）。 */
export const TASK_MAX_FAILURES = 20;

/** 退避间隔上限：5 分钟。 */
export const TASK_MAX_BACKOFF_MS = 5 * 60 * 1000;

/** 默认租约时长：2 分钟（短任务；长任务必须显式续租）。 */
export const TASK_DEFAULT_LEASE_MS = 2 * 60 * 1000;

/** 默认每次领取上限。 */
export const TASK_DEFAULT_CLAIM_LIMIT = 10;

/**
 * 任务处理器。
 *
 * `signal` 在 worker 停止或租约丢失时 abort：handler 必须尽快释放资源并返回；
 * 抛错即视为失败，由 worker 记录并安排退避。
 */
export type TaskHandler = (
  task: ClaimedTask,
  signal: AbortSignal,
) => Promise<Record<string, unknown> | void>;

/** 按任务类型注册的 handler 集合；缺失类型必须在启动时显式失败。 */
export type TaskHandlerMap = Readonly<
  Record<TaskType, TaskHandler>
>;
