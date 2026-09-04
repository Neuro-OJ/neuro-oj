/**
 * SSE 事件日志读写辅助。
 *
 * 所有 SSE 频道共享 `sse_events` 表，全局单调 `id` 作为 Last-Event-ID。
 * 事件在状态变更处写入，随后发布 Redis Pub/Sub 通知。
 */
import { and, asc, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { sseEvents } from "../db/schema.ts";
import { logger } from "../base/logging.ts";

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
 * 写入一条 SSE 事件，返回全局事件 id。
 * 调用方应在状态变更落库后、发布 Redis 通知前调用。
 */
export async function recordSseEvent(
  channel: string,
  payload: unknown,
): Promise<number> {
  const db = getDb();
  const rows = await db.insert(sseEvents).values({
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

let _sseRetentionStarted = false;

/**
 * 启动 SSE 事件保留清理任务（幂等）。
 * 启动时立即执行一次，之后每 24 小时执行一次。
 */
export function startSseEventRetentionTask(): void {
  if (_sseRetentionStarted) return;
  _sseRetentionStarted = true;

  const runOnce = (): void => {
    cleanupOldSseEvents()
      .then((n) => {
        if (n > 0) {
          logger.info("SSE 事件保留清理完成", {
            removed: n,
            retention_days: SSE_EVENT_RETENTION_DAYS,
          });
        }
      })
      .catch((err) => logger.error("SSE 事件保留清理失败", { err }));
  };

  runOnce();
  setInterval(runOnce, 86400 * 1000);
  logger.info("SSE 事件保留任务已启动", {
    retention_days: SSE_EVENT_RETENTION_DAYS,
  });
}
