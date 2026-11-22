/**
 * SSE 可重放事实的窄事务写入合同。
 *
 * `sse_events` 是 Last-Event-ID 重放与 Redis 扇出的事实来源。业务模块只能在
 * **自己的业务事务**里调用本文件登记事件；提交后再由调用方用返回的 id 发布
 * Redis 通知。
 *
 * 与 `sse-events.ts` 中同名函数的区别：
 * - 只接受真实 `DbTx`，不接受 `Executor` 联合，也不回退默认根连接；
 * - 写入失败会抛错，不会"记一条日志就继续"。
 * 分页重放与保留清理只在 `sse-events.ts`（读取侧）实现。
 */
import type { DbTx } from "../db/executor.ts";
import { sseEvents } from "../db/schema.ts";

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
