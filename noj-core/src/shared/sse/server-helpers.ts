/**
 * SSE 路由共享辅助函数。
 *
 * 从 `src/routes/sse.ts` 抽取，供多个域 SSE 路由复用。
 */
import { onEvent } from "./event-bus.ts";
import { replaySseEvents } from "./sse-events.ts";

/**
 * SSE 流上下文中的异步工作作用域。
 *
 * runtime 会把它实现到 {@link SseStreamContext} 上：关闭前已开始的工作会被
 * 追踪并在流 done 前等待；关闭后不再开始新工作；失败会关闭流并被观察。
 * 这里单独声明窄接口，避免路由依赖 runtime 的实现细节。
 */
export interface SseRunContext {
  run(operation: () => Promise<void> | void): Promise<void>;
}

/** 从 Last-Event-ID 头或 afterSeq 查询参数解析游标。 */
export function lastEventId(
  c: {
    req: {
      header(key: string): string | undefined;
      query(key: string): string | undefined;
    };
  },
): number {
  const raw = c.req.header("last-event-id") ?? c.req.query("afterSeq") ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 订阅事件通道并转发到 SSE 流。
 *
 * @param onUnsubscribe createSseStream 提供的取消订阅注册函数
 * @param channel 事件通道
 * @param event SSE 事件名
 * @param stream SSE 写入器
 * @param closed 是否已关闭（返回 true 时停止转发）
 * @param close 关闭流函数
 * @param onMessage 可选的消息转换；返回 null 表示丢弃该消息
 * @param run 可选的流级异步工作作用域；提供时整段转换与写入都在其内执行
 */
export function subscribeToChannel(
  onUnsubscribe: (fn: () => void) => void,
  channel: string,
  event: string,
  // deno-lint-ignore no-explicit-any
  stream: any,
  closed: () => boolean,
  close: () => void,
  onMessage?: (message: string) => string | null | Promise<string | null>,
  run?: SseRunContext["run"],
): void {
  onUnsubscribe(
    onEvent(channel, (_channel, message) => {
      if (closed()) return;
      const deliver = async (): Promise<void> => {
        // onMessage 内的权限查询/DB 读取与 writeSSE 同属一次异步工作：
        // 由 run 追踪，拒绝也会被 run（或旧路径的 catch）观察到并关闭流。
        const data = onMessage ? await onMessage(message) : message;
        if (data === null || closed()) return;
        await stream.writeSSE({ event, data });
      };
      if (run) {
        try {
          // runtime 的 run 正常情况下会自行关流并观察失败；此 catch 只兜住
          // run 自身意外拒绝，避免 unhandled rejection。
          void run(deliver).catch(() => close());
        } catch {
          close();
        }
      } else {
        void deliver().catch(() => close());
      }
    }),
  );
}

/**
 * 重放缺失事件到 SSE 流。
 *
 * @param c Hono 上下文（用于 Last-Event-ID）
 * @param stream SSE 写入器
 * @param closed 是否已关闭
 * @param channels 事件通道列表
 * @param event SSE 事件名
 * @param transform 可选的重放转换；返回 null 表示跳过该事件
 */
export async function replayToStream(
  c: Parameters<typeof lastEventId>[0],
  // deno-lint-ignore no-explicit-any
  stream: any,
  closed: () => boolean,
  channels: string[],
  event: string,
  transform?: (payload: object, seq: number) => object | string | null,
): Promise<void> {
  const after = lastEventId(c);
  const missed = await replaySseEvents(channels, after, 200);
  for (const ev of missed) {
    if (closed()) return;
    const data = transform
      ? transform(ev.payload as object, ev.id)
      : { ...(ev.payload as object), seq: ev.id };
    if (data === null) continue;
    await stream.writeSSE({
      event,
      id: String(ev.id),
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  }
}
