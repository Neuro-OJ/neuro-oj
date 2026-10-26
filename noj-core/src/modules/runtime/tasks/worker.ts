/**
 * 后台任务 worker（P4）。
 *
 * 语义固定：
 * - 返回 `ManagedTask`：`stop()` 后不再领取新任务，`done` 等待当前 handler 完成；
 * - 每次领取一批，逐条串行执行（避免同一 worker 内并发放大资源占用）；
 * - handler 抛错 → `failTaskTx` 记失败并安排退避；token 已失效则只记日志；
 * - 关闭时向在途 handler 发 abort 信号，等待其返回后再标记失败/完成；
 * - 不使用进程内可变状态保存任务事实，全部以数据库为准。
 */
import { getLogger } from "@logtape/logtape";
import { getDb } from "../../../shared/db/connection.ts";
import type { DbRoot } from "../../../shared/db/executor.ts";
import type { ManagedTask } from "../../../shared/runtime/managed-task.ts";
import {
  type ClaimedTask,
  isTaskRescheduleResult,
  TASK_DEFAULT_CLAIM_LIMIT,
  TASK_DEFAULT_LEASE_MS,
  TASK_TYPES,
  type TaskHandlerMap,
} from "./contracts.ts";
import {
  claimTasks,
  completeTaskTx,
  failTaskTx,
  renewTaskLease,
  rescheduleTaskTx,
} from "./repository.ts";

const logger = getLogger(["noj", "runtime", "tasks"]);

/** worker 启动参数。 */
export interface StartTaskWorkerOptions {
  /** 稳定的 worker 标识（实例名 + 序号）；只用于租约诊断。 */
  readonly workerId: string;
  /** 按任务类型注册的 handler；缺失类型在启动时显式失败。 */
  readonly handlers: TaskHandlerMap;
  /** 轮询间隔；无任务时等待该时长。 */
  readonly pollIntervalMs?: number;
  /** 每次领取上限。 */
  readonly claimLimit?: number;
  /** 租约时长。 */
  readonly leaseDurationMs?: number;
  /** 是否在启动后立即轮询一次（测试可关）。 */
  readonly runImmediately?: boolean;
  /** 根连接；缺省使用全局连接。 */
  readonly db?: DbRoot;
}

/** 默认轮询间隔：1 秒。 */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * 启动后台任务 worker。
 *
 * @returns `ManagedTask`；`stop()` 幂等，`done` 在最后一次 handler 结束后 resolve。
 */
export function startTaskWorker(
  options: StartTaskWorkerOptions,
): ManagedTask {
  const db = options.db ?? getDb();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const claimLimit = options.claimLimit ?? TASK_DEFAULT_CLAIM_LIMIT;
  const leaseDurationMs = options.leaseDurationMs ?? TASK_DEFAULT_LEASE_MS;

  // 启动前校验 handler 覆盖：缺类型必须显式失败，不能静默跳过任务。
  for (const taskType of TASK_TYPES) {
    const handler = options.handlers[taskType];
    if (typeof handler !== "function") {
      throw new TypeError(`任务类型 ${taskType} 的 handler 不是函数`);
    }
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const inflight = new Set<Promise<void>>();
  const abortControllers = new Set<AbortController>();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        wake = undefined;
        timer = undefined;
        resolve();
      }, ms);
    });

  const interruptSleep = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    wake?.();
    wake = undefined;
  };

  /** 执行单条任务；handler 抛错即记失败。 */
  const runTask = async (task: ClaimedTask): Promise<void> => {
    const handler = options.handlers[task.taskType];
    if (!handler) {
      // 类型未知：直接失败并保留错误，不无限重试（注册表是启动期约定）。
      await db.transaction((tx) =>
        failTaskTx(
          tx,
          task.id,
          task.leaseToken,
          `未注册的任务类型：${task.taskType}`,
        )
      );
      logger.error("任务类型未注册", { task_id: task.id, type: task.taskType });
      return;
    }
    const controller = new AbortController();
    abortControllers.add(controller);
    try {
      // 长任务在开始前续租一次，避免刚领取就接近过期。
      const renewed = await renewTaskLease(
        task.id,
        task.leaseToken,
        leaseDurationMs,
        db,
      );
      if (renewed === null) {
        logger.warn("任务租约已失效，跳过执行", { task_id: task.id });
        return;
      }
      const result = await handler(task, controller.signal);
      if (isTaskRescheduleResult(result)) {
        const rescheduled = await db.transaction((tx) =>
          rescheduleTaskTx(tx, task.id, task.leaseToken, result)
        );
        if (!rescheduled) {
          logger.warn("任务重新调度时租约已失效", { task_id: task.id });
        }
        return;
      }
      const completed = await db.transaction((tx) =>
        completeTaskTx(
          tx,
          task.id,
          task.leaseToken,
          result && !isTaskRescheduleResult(result) ? result : {},
        )
      );
      if (!completed) {
        // handler 已完成但租约已被回收：任务会被其他 worker 重做，这里只记录。
        logger.warn("任务完成时租约已失效", { task_id: task.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await db.transaction((tx) =>
        failTaskTx(tx, task.id, task.leaseToken, message)
      ).catch((txError) => {
        logger.error("记录任务失败时出错", { task_id: task.id, err: txError });
        return { recorded: false, terminal: false };
      });
      if (!outcome.recorded) {
        logger.warn("任务失败时租约已失效", { task_id: task.id });
      } else if (outcome.terminal) {
        logger.error("任务连续失败已达上限，转入终态", {
          task_id: task.id,
          type: task.taskType,
        });
      }
    } finally {
      abortControllers.delete(controller);
    }
  };

  /** 单轮：领取 → 串行执行。 */
  const pollOnce = async (): Promise<void> => {
    const tasks = await claimTasks(
      options.workerId,
      claimLimit,
      leaseDurationMs,
      db,
    );
    for (const task of tasks) {
      if (stopped) break;
      const promise = runTask(task);
      inflight.add(promise);
      try {
        await promise;
      } finally {
        inflight.delete(promise);
      }
    }
  };

  const loop = async (): Promise<void> => {
    // `runImmediately: false` 时先等待一个轮询周期，便于测试控制时序。
    if (options.runImmediately === false) await sleep(pollIntervalMs);
    while (!stopped) {
      try {
        await pollOnce();
      } catch (error) {
        logger.error("任务轮询失败", { err: error });
      }
      if (stopped) break;
      await sleep(pollIntervalMs);
    }
  };

  const done = loop().finally(() => {
    interruptSleep();
  });

  return {
    name: "background-task-worker",
    stop(): void {
      if (stopped) return;
      stopped = true;
      interruptSleep();
      // 向在途 handler 发取消信号：它们应尽快释放资源并返回。
      for (const controller of abortControllers) controller.abort();
    },
    done,
  };
}
