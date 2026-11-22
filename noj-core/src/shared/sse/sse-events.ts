/**
 * SSE 事件日志读写辅助。
 *
 * 所有 SSE 频道共享 `sse_events` 表，全局单调 `id` 作为 Last-Event-ID。
 * 事件在状态变更处写入，随后发布 Redis Pub/Sub 通知。
 */
import { and, asc, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import type { DbTx, Executor } from "../db/executor.ts";
import { sseEvents } from "../db/schema.ts";
import { getLogger } from "@logtape/logtape";
import {
  type ManagedTask,
  startPeriodicTask,
} from "../runtime/managed-task.ts";

const logger = getLogger(["noj", "sse"]);

/** SSE 事件默认保留天数。 */
export const SSE_EVENT_RETENTION_DAYS = 7;

/** SSE 事件行。 */
export interface SseEventRow {
  id: number;
  channel: string;
  payload: unknown;
  created_at: string;
}

/**
 * 在调用方持有的业务事务内登记 SSE 事件。
 *
 * `sse_events` 属于 runtime 事件基础设施；业务模块只通过这个窄能力写入，
 * 不能直接依赖其 schema。事件日志与事实变更必须使用同一个 DbTx，提交后再由
 * `publishSseEventAfterTx` 做 Redis 扇出。
 */
export async function recordSseEventTx(
  tx: DbTx,
  channel: string,
  payload: unknown,
  createdAt = new Date().toISOString(),
): Promise<number> {
  const rows = await tx.insert(sseEvents).values({
    channel,
    payload,
    created_at: createdAt,
  }).returning({ id: sseEvents.id });
  return rows[0].id;
}

/**
 * 写入一条 SSE 事件，返回全局事件 id。
 * 调用方应在状态变更落库后、发布 Redis 通知前调用。
 */
export async function recordSseEvent(
  channel: string,
  payload: unknown,
  executor: Executor = getDb(),
): Promise<number> {
  const rows = await executor.insert(sseEvents).values({
    channel,
    payload,
    created_at: new Date().toISOString(),
  }).returning({ id: sseEvents.id });
  return rows[0].id;
}

/**
 * 重放指定频道在 `afterId` 之后的事件。
 * 用于 SSE 连接建立时补发缺失事件。
 */
export async function replaySseEvents(
  channels: string[],
  afterId: number,
  limit = 200,
): Promise<SseEventRow[]> {
  if (channels.length === 0) return [];
  const db = getDb();
  const rows = await db.select().from(sseEvents).where(
    and(
      inArray(sseEvents.channel, channels),
      gt(sseEvents.id, afterId),
    ),
  ).orderBy(asc(sseEvents.id)).limit(limit);
  return rows;
}

/**
 * 清理超过保留天数的 SSE 事件，返回删除行数。
 * 保留策略默认 7 天；超过保留期的客户端以 REST 全量校准。
 */
export async function cleanupOldSseEvents(
  retentionDays = SSE_EVENT_RETENTION_DAYS,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(
    Date.now() - retentionDays * 86400 * 1000,
  ).toISOString();
  const db = getDb();
  const result = await db.delete(sseEvents).where(
    lte(sseEvents.created_at, cutoff),
  );
  const r = result as unknown as {
    affectedRows?: number;
    rowCount?: number;
    count?: number;
  };
  return r.affectedRows ?? r.rowCount ?? r.count ?? 0;
}

/** 当前保留任务句柄（幂等启动；关闭流程统一停止并等待在途清理）。 */
let _sseRetentionTask: ManagedTask | null = null;

/** SSE 事件保留任务的轮询间隔：24 小时。 */
const SSE_RETENTION_INTERVAL_MS = 86_400_000;

/**
 * 启动 SSE 事件保留清理任务（幂等）。
 *
 * 启动时立即执行一次，之后每 24 小时执行一次。返回统一后台任务句柄（P2a），
 * 关闭时先停止定时器再等待在途清理，避免数据库关闭后仍有写入。
 *
 * @returns 可停止、可等待的保留任务句柄
 */
export function startSseEventRetentionTask(): ManagedTask {
  if (_sseRetentionTask !== null) return _sseRetentionTask;
  const task = startPeriodicTask({
    name: "sse-event-retention",
    intervalMs: SSE_RETENTION_INTERVAL_MS,
    runImmediately: true,
    run: async () => {
      const removed = await cleanupOldSseEvents();
      if (removed > 0) {
        logger.info("SSE 事件保留清理完成", {
          removed,
          retention_days: SSE_EVENT_RETENTION_DAYS,
        });
      }
    },
    onError: (err) => logger.error("SSE 事件保留清理失败", { err }),
  });
  _sseRetentionTask = task;
  // stop 后到 done 完成期间保留单例，防止关闭过程中重复启动清理任务。
  void task.done.then(() => {
    if (_sseRetentionTask === task) _sseRetentionTask = null;
  });
  logger.info("SSE 事件保留任务已启动", {
    retention_days: SSE_EVENT_RETENTION_DAYS,
  });
  return task;
}

/** 测试用：停止当前保留任务（不等待在途清理完成）。 */
export function _resetSseEventRetentionForTest(): void {
  _sseRetentionTask?.stop();
}
