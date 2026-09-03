/**
 * SSE 路由共享辅助函数。
 *
 * 从 `src/routes/sse.ts` 抽取，供多个域 SSE 路由复用。
 */
import { onEvent } from "./event-bus.ts";
import { replaySseEvents } from "./sse-events.ts";

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
): void {
  onUnsubscribe(
    onEvent(channel, (_channel, message) => {
      if (closed()) return;
      const data = onMessage ? onMessage(message) : message;
      if (data === null) return;
      Promise.resolve(data).then((d) => {
        if (d === null || closed()) return;
        stream.writeSSE({ event, data: d }).catch(() => close());
      });
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
