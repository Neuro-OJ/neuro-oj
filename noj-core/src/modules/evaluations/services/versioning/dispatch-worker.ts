/** 批量任务 worker 的轮询循环与启停（单进程一个句柄，多副本靠 SKIP LOCKED + lease）。 */

import { getLogger } from "@logtape/logtape";
import {
  type ManagedTask,
  startPeriodicTask,
} from "../../../../shared/runtime/managed-task.ts";
import { UpgradeQuotaDeferredError } from "./job-attempt.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  completeJobItem,
  requeueJobItem,
  scheduleDispatchRetryOrFail,
} from "./job-worker.ts";
import { refreshJobStatus } from "./rejudge-jobs.ts";
import { dispatchJobItem } from "./dispatch-item.ts";
import type { DispatchOutcome } from "./dispatch-types.ts";

const logger = getLogger(["noj", "submission"]);

/**
 * 执行一轮 worker：回收过期 lease → 领取 → 逐条派发 → 聚合任务状态。
 *
 * 返回本轮统计，便于测试与日志。
 */
export async function runSubmissionJobWorkerOnce(
  owner: string,
  options: { limit?: number } = {},
): Promise<{
  claimed: number;
  dispatched: number;
  skipped: number;
  failed: number;
  retry: number;
  deferred: number;
}> {
  const { claimJobItems, requeueExpiredLeases, findJobById } = await import(
    "./job-worker.ts"
  );
  await requeueExpiredLeases();
  const leaseOwner = `${owner}-${crypto.randomUUID()}`;
  const stats = {
    claimed: 0,
    dispatched: 0,
    skipped: 0,
    failed: 0,
    retry: 0,
    deferred: 0,
  };
  const touchedJobs = new Set<string>();
  // 一次只领取即将处理的条目，避免一批慢任务让后面的租约在开始前过期。
  const limit = Math.max(0, Math.min(options.limit ?? 100, 100));
  for (let index = 0; index < limit; index++) {
    const [item] = await claimJobItems(leaseOwner, { limit: 1 });
    if (!item) break;
    stats.claimed++;
    touchedJobs.add(item.job_id);
    let outcome: DispatchOutcome;
    try {
      const job = await findJobById(item.job_id);
      const requestContext = (job?.request as { context?: string } | null)
        ?.context;
      outcome = await dispatchJobItem(
        item,
        leaseOwner,
        job?.kind === "upgrade" ? "upgrade" : "rejudge",
        requestContext === "source_contest" ? "source_contest" : "practice",
      );
    } catch (err) {
      logger.error("批任务条目派发异常", { item_id: item.id, err });
      if (err instanceof AppError && err.code === "JOB_LEASE_LOST") {
        stats.deferred++;
        continue;
      }
      // #9：额度不足属"延期"（可重试、不计失败、不发新提交）
      if (err instanceof UpgradeQuotaDeferredError) {
        await requeueJobItem(
          item.id,
          Math.max(1, Math.ceil(err.retryAfterMs / 1000)),
          leaseOwner,
        );
        stats.deferred++;
        continue;
      }
      // #10：锁内复查发现的"源正在评测 / 源已删除"属 Handbook 固定分类的
      // **skipped**（可重试），不是配置/交付物错误，不能记 failed。
      if (
        err instanceof AppError &&
        (err.code === "SOURCE_JUDGING" || err.code === "SOURCE_DELETED")
      ) {
        await completeJobItem(item.id, {
          leaseOwner,
          status: "skipped",
          reasonCode: err.code,
          reasonMessage: err.message,
        });
        stats.skipped++;
        continue;
      }
      if (err instanceof AppError && err.statusCode < 500) {
        await completeJobItem(item.id, {
          leaseOwner,
          status: "failed",
          reasonCode: err.code,
          reasonMessage: err.message,
        });
        stats.failed++;
        continue;
      }
      await scheduleDispatchRetryOrFail(item.id, {
        leaseOwner,
        reasonCode: "DISPATCH_EXCEPTION",
        reasonMessage: err instanceof Error ? err.message : String(err),
      });
      outcome = "retry";
    }
    if (outcome === "dispatched") stats.dispatched++;
    else if (outcome === "skipped") stats.skipped++;
    else if (outcome === "failed") stats.failed++;
    else if (outcome === "retry") stats.retry++;
    else stats.deferred++;
  }
  for (const jobId of touchedJobs) {
    await refreshJobStatus(jobId);
  }
  return stats;
}

/** worker 轮询间隔（毫秒）。 */
export const SUBMISSION_JOB_WORKER_INTERVAL_MS = 3000;

/** worker 句柄（单进程一个；多副本靠 SKIP LOCKED 与 lease 协调，无共享内存依赖）。 */
let _jobWorkerTask: ManagedTask | null = null;

/**
 * 启动批量任务 worker（幂等）。
 *
 * 多副本安全：条目领取使用 `FOR UPDATE SKIP LOCKED` + lease，实例标识仅用于
 * 续租归属；进程内只保存定时器句柄，不保存任何业务状态。
 */
export function startSubmissionJobWorker(): ManagedTask {
  if (_jobWorkerTask !== null) return _jobWorkerTask;
  const owner = `noj-core-${crypto.randomUUID()}`;
  logger.info("批任务 worker 已启动", {
    interval_ms: SUBMISSION_JOB_WORKER_INTERVAL_MS,
  });
  const task = startPeriodicTask({
    name: "submission-job-worker",
    intervalMs: SUBMISSION_JOB_WORKER_INTERVAL_MS,
    run: () => runSubmissionJobWorkerOnce(owner).then(() => undefined),
    onError: (err) => logger.error("批任务 worker 执行失败", { err }),
  });
  _jobWorkerTask = task;
  // stop 后到 done 完成期间保留单例：此时重复 start 返回同一已停止句柄，
  // 不会出现两个 worker（旧实现立即置 null 会让关闭过程中的重启重叠领取）。
  void task.done.then(() => {
    if (_jobWorkerTask === task) _jobWorkerTask = null;
  });
  return task;
}

/**
 * 停止 worker（关闭流程用；`stop` 后仍应等待 `done`）。
 *
 * 不在这里立即清空单例：done 完成后由 `startSubmissionJobWorker` 的清理回调
 * 释放，避免 stop 与 start 之间出现重叠实例。
 */
export function stopSubmissionJobWorker(): void {
  _jobWorkerTask?.stop();
}
