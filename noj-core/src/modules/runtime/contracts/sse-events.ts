/**
 * runtime 对 SSE 可重放事实的窄事务合同。
 *
 * `sse_events` 由 runtime 持有：它是 Last-Event-ID 重放与 Redis 扇出的事实来源。
 * 业务模块只能在**自己的业务事务**里调用本文件的函数登记事件；提交后再由
 * 调用方用返回的 id 发布 Redis 通知。
 *
 * 与旧 `shared/sse/sse-events.ts` 的区别：
 * - 只接受真实 `DbTx`，不接受 `Executor` 联合，也不回退默认根连接；
 * - 写入失败会抛错，不会"记一条日志就继续"；
 * - 分页重放与保留清理留在 shared 基础设施（读取侧），不进入业务门面。
 */
import { and, asc, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { DbTx } from "../../../shared/db/executor.ts";
import { sseEvents } from "../../../shared/db/schema.ts";

/** SSE 事件行（重放返回结构）。 */
export interface RuntimeSseEventRow {
  id: number;
  channel: string;
  payload: unknown;
  created_at: string;
}

/**
 * 在调用方事务内登记一条 SSE 事件，返回全局单调 id。
 *
 * 事件日志与事实变更必须使用同一个 `DbTx`：提交即代表"事实已发生且可重放"。
 * `createdAt` 显式传入便于重放与测试。
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

/** 批量登记同一负载到多个频道，返回各频道事件 id（按入参顺序）。 */
export async function recordSseEventsTx(
  tx: DbTx,
  channels: readonly string[],
  payload: unknown,
  createdAt = new Date().toISOString(),
): Promise<number[]> {
  const ids: number[] = [];
  for (const channel of channels) {
    ids.push(await recordSseEventTx(tx, channel, payload, createdAt));
  }
  return ids;
}

/**
 * 重放指定频道在 `afterId` 之后的事件（连接建立时补发）。
 *
 * 只读：读取侧不属于业务写能力，调用方是 HTTP/SSE 适配层。
 */
export async function replayRuntimeSseEvents(
  channels: readonly string[],
  afterId: number,
  limit = 200,
): Promise<RuntimeSseEventRow[]> {
  if (channels.length === 0) return [];
  const rows = await getDb().select().from(sseEvents).where(
    and(
      inArray(sseEvents.channel, [...channels]),
      gt(sseEvents.id, afterId),
    ),
  ).orderBy(asc(sseEvents.id)).limit(limit);
  return rows as RuntimeSseEventRow[];
}

/** 清理早于保留期的事件行；返回删除行数（保留任务使用）。 */
export async function cleanupRuntimeSseEvents(
  cutoffIso: string,
): Promise<number> {
  const result = await getDb().delete(sseEvents).where(
    lte(sseEvents.created_at, cutoffIso),
  );
  const r = result as unknown as {
    affectedRows?: number;
    rowCount?: number;
    count?: number;
  };
  return r.affectedRows ?? r.rowCount ?? r.count ?? 0;
}
