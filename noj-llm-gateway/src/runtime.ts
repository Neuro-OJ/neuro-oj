/** Gateway 进程级受管任务原语。 */

import type { Db } from "./db.ts";
import type { RedisClient } from "./redis.ts";

export interface ManagedTask {
  name: string;
  /** 停止领取新工作；不得等待在途操作。 */
  stop(): void;
  /** 停止后等待全部在途操作完成。 */
  done: Promise<void>;
}

/**
 * 在 HTTP 监听前确认必需的 PostgreSQL/Redis 依赖确实可用。
 *
 * 组合根必须显式调用此检查；仅构造 postgres/ioredis 客户端并不能证明依赖已
 * 连通，尤其 ioredis 会在后台重试。失败返回稳定错误信息，避免带出连接串。
 */
export async function assertGatewayDependencies(
  db: Db,
  redis: RedisClient,
): Promise<void> {
  const [database, redisResult] = await Promise.allSettled([
    (async () => {
      const rows = await db`SELECT 1 AS ok` as unknown as Array<{
        ok?: unknown;
      }>;
      if (rows.length !== 1 || Number(rows[0]?.ok) !== 1) {
        throw new Error("unexpected_result");
      }
    })(),
    redis.ping(),
  ]);
  const failures: Error[] = [];
  if (database.status === "rejected") {
    failures.push(new Error("Gateway PostgreSQL 依赖不可用"));
  }
  if (redisResult.status === "rejected") {
    failures.push(new Error("Gateway Redis 依赖不可用"));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Gateway 必需依赖检查失败");
  }
}

/** 以逆序停止并等待一组 Gateway 后台任务。 */
export function createManagedTaskGroup(): {
  add(task: ManagedTask): ManagedTask;
  stopAll(): void;
  doneAll(): Promise<void>;
  names(): string[];
} {
  const tasks: ManagedTask[] = [];
  const stopErrors: unknown[] = [];
  let stopped = false;
  let donePromise: Promise<void> | null = null;

  return {
    add(task) {
      if (stopped) {
        task.stop();
        task.done.catch(() => {});
        throw new Error(`Gateway 任务组已停止，拒绝登记：${task.name}`);
      }
      tasks.push(task);
      task.done.catch(() => {});
      return task;
    },
    stopAll() {
      if (stopped) return;
      stopped = true;
      for (let i = tasks.length - 1; i >= 0; i--) {
        try {
          tasks[i]!.stop();
        } catch (error) {
          stopErrors.push(error);
        }
      }
    },
    doneAll() {
      if (donePromise) return donePromise;
      donePromise = (async () => {
        const results = await Promise.allSettled(
          tasks.map((task) => task.done),
        );
        const failures = [
          ...stopErrors,
          ...results.filter((result): result is PromiseRejectedResult =>
            result.status === "rejected"
          ).map((result) => result.reason),
        ];
        if (failures.length > 0) {
          throw new AggregateError(failures, "Gateway 后台任务未干净结束");
        }
      })();
      donePromise.catch(() => {});
      return donePromise;
    },
    names: () => tasks.map((task) => task.name),
  };
}
