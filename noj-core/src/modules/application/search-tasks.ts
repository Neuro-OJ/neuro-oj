/**
 * 搜索索引任务的可靠登记（P4）。
 *
 * 替换旧的「提交后 LPUSH 失败只记日志」路径：
 * - **业务事务内**登记一条 `search.index` 任务（与业务事实一起提交或回滚）；
 * - handler 从最新数据库事实构造索引，因此任务乱序、重复执行都收敛到同一结果；
 * - 删除任务在源已不存在时仍可幂等清理索引；
 * - 任务 worker 按固定间隔轮询领取，不依赖 Redis；任务事实始终在 PostgreSQL。
 *
 * 业务写入已在事务外提交的调用方使用 {@link enqueueSearchIndexTask}，它在提交后
 * 用根连接登记任务，取代原 Redis `noj:search:index` 列表（#698 N1）。
 *
 * 本文件只依赖 runtime 的任务合同与 shared 的事件类型，不反向依赖 read-models 服务。
 */
import { getLogger } from "@logtape/logtape";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import type { DbRoot, DbTx } from "../../shared/db/executor.ts";
import { backgroundTasks } from "../../shared/db/schema.ts";
import {
  type ManagedTask,
  startPeriodicTask,
} from "../../shared/runtime/managed-task.ts";
import type { SearchEntityType } from "../../shared/search-events.ts";
import {
  type EnqueueTaskInput,
  type EnqueueTaskResult,
  type TaskTargetKind,
} from "../runtime/tasks/contracts.ts";
import { enqueueTaskTx } from "../runtime/tasks/repository.ts";

const logger = getLogger(["noj", "application", "search-tasks"]);

/** 搜索实体类型 → 任务目标种类。 */
const TARGET_KIND_BY_ENTITY: Record<SearchEntityType, TaskTargetKind> = {
  problem: "problem",
  user: "domain",
  community_post: "problem",
  community_comment: "problem",
  contest: "problem",
  submission: "submission",
  message: "domain",
  announcement: "domain",
};

/** 索引动作；同一业务事件的重复登记合并，不同事件分别持久化。 */
export type SearchIndexTaskAction = "upsert" | "delete";

/**
 * 在业务事务内登记搜索索引任务。
 *
 * 去重键绑定不可变事件/版本 ID：重试同一事实可合并，后续版本不能被旧的
 * succeeded 或 leased 任务吞掉。handler 仍从最新事实构建索引。
 */
export async function enqueueSearchIndexTaskTx(
  tx: DbTx,
  entityType: SearchEntityType,
  entityId: string,
  action: SearchIndexTaskAction,
  eventId: string,
): Promise<EnqueueTaskResult> {
  if (!eventId.trim()) throw new TypeError("搜索任务需要不可变事件标识");
  const input: EnqueueTaskInput = {
    taskType: "search.index",
    targetKind: TARGET_KIND_BY_ENTITY[entityType],
    targetId: entityId,
    dedupeKey: `${entityType}:${action}:${eventId}`,
    payload: { entity_type: entityType, entity_id: entityId, action },
  };
  return await enqueueTaskTx(tx, input);
}

/**
 * 在业务写入提交后登记搜索索引任务（无外层事务的调用方使用）。
 *
 * 每次调用生成独立事件 ID，不与已在执行的任务合并：handler 读最新事实，
 * 即使前一条任务已读到旧值，本次登记也能保证最终收敛。
 *
 * 调用方处在业务事务中时必须传入该事务：内部 `transaction` 会成为 savepoint，
 * 任务随外层事务一起提交，worker 不会在业务提交前读到旧事实。
 *
 * 登记失败只记错误日志、不抛出（仅回滚本 savepoint）：业务写入通常已提交，
 * 向调用方报错会误导客户端重试；索引可由 `search reindex` 对账。
 *
 * @param entityType 实体类型
 * @param entityId 实体 ID
 * @param action 索引动作
 * @param db 执行连接：根连接，或调用方正在进行的业务事务
 */
export async function enqueueSearchIndexTask(
  entityType: SearchEntityType,
  entityId: string,
  action: SearchIndexTaskAction,
  db: DbRoot | DbTx = getDb(),
): Promise<void> {
  try {
    await db.transaction((tx) =>
      enqueueSearchIndexTaskTx(
        tx,
        entityType,
        entityId,
        action,
        crypto.randomUUID(),
      )
    );
  } catch (err) {
    logger.error("登记搜索索引任务失败，索引可能落后", {
      entity_type: entityType,
      entity_id: entityId,
      action,
      err,
    });
  }
}

/** 已成功的搜索索引任务保留天数。 */
export const SEARCH_TASK_RETENTION_DAYS = 7;

const SEARCH_TASK_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 删除早于保留期的已成功搜索索引任务。
 *
 * 只清理 `search.index`：它的去重键是一次性事件 ID，删除后不会让旧事实被重新
 * 登记；其他任务类型的去重键承载业务幂等语义，不在此清理。失败任务保留供排查。
 *
 * @param retentionDays 保留天数
 * @param db 执行连接，默认根连接
 * @returns 删除行数
 */
export async function cleanupSucceededSearchTasks(
  retentionDays = SEARCH_TASK_RETENTION_DAYS,
  db: DbRoot = getDb(),
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000)
    .toISOString();
  const rows = await db.delete(backgroundTasks).where(and(
    eq(backgroundTasks.task_type, "search.index"),
    eq(backgroundTasks.status, "succeeded"),
    lt(backgroundTasks.finished_at, cutoff),
  )).returning({ id: backgroundTasks.id });
  return rows.length;
}

/**
 * 启动搜索索引任务保留清理：启动时执行一次，之后每 24 小时执行一次。
 *
 * @returns 可停止、可等待的后台任务句柄
 */
export function startSearchTaskRetentionTask(): ManagedTask {
  return startPeriodicTask({
    name: "search-task-retention",
    intervalMs: SEARCH_TASK_RETENTION_INTERVAL_MS,
    runImmediately: true,
    run: async () => {
      const removed = await cleanupSucceededSearchTasks();
      if (removed > 0) {
        logger.info("搜索索引任务保留清理完成", {
          removed,
          retention_days: SEARCH_TASK_RETENTION_DAYS,
        });
      }
    },
    onError: (err) => logger.error("搜索索引任务保留清理失败", { err }),
  });
}
