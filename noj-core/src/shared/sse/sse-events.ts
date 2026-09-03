/**
 * SSE 事件日志读写辅助。
 *
 * 所有 SSE 频道共享 `sse_events` 表，全局单调 `id` 作为 Last-Event-ID。
 * 事件在状态变更处写入，随后发布 Redis Pub/Sub 通知。
 */
import { and, asc, gt, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { sseEvents } from "../db/schema.ts";

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
