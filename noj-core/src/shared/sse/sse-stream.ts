import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

/** SSE 心跳间隔（30s，防止代理/中间件超时断连）。 */
const KEEPALIVE_INTERVAL_MS = 30_000;
/** SSE 兜底超时（5 分钟，防止 onAbort 不触发时泄漏定时器与订阅）。 */
const SAFETY_TIMEOUT_MS = 300_000;

/** 单条 SSE 流的操作上下文（提供给 setup 回调）。 */
export interface SseStreamContext {
  /** hono 流对象（用于 writeSSE 推送）。 */
  stream: SSEStreamingApi;
  /** 流是否已关闭。 */
  readonly closed: boolean;
  /** 注册关闭时的清理回调（如 onEvent 的退订函数）。 */
  onUnsubscribe(fn: () => void): void;
  /** 主动关闭流（幂等；清理定时器并触发退订）。 */
  close(): void;
}

/** createSseStream 配置项。 */
export interface CreateSseStreamOptions {
  /**
   * 兜底超时（毫秒）；传 0 表示不启用。
   * 默认 5 分钟自动关闭，防止 onAbort 不触发时泄漏 setInterval + 订阅回调。
   */
  safetyTimeoutMs?: number;
}

/**
 * SSE 端点公共骨架：30s 心跳 + 兜底超时 + 关闭清理 + onAbort 处理。
 *
 * `setup` 内完成事件订阅（`onUnsubscribe` 注册退订）与初始推送；
 * setup 返回后流保持打开，直到客户端断开 / 主动 `close()` / 兜底超时。
 * setup 内主动 `close()`（如终态立即推送）后不再挂起等待。
 */
export function createSseStream(
  c: Context,
  setup: (ctx: SseStreamContext) => Promise<void> | void,
  options: CreateSseStreamOptions = {},
): Response {
  const { safetyTimeoutMs = SAFETY_TIMEOUT_MS } = options;
  return streamSSE(c, async (stream) => {
    let streamClosed = false;
    let resolveAbort: (() => void) | null = null;
    // 先初始化为空函数，避免 setup 未注册退订时 close() 触发 TDZ/undefined 调用
    let unsub = () => {};

    let safetyTimer: ReturnType<typeof setTimeout> | undefined;
    if (safetyTimeoutMs > 0) {
      safetyTimer = setTimeout(() => {
        close();
      }, safetyTimeoutMs);
    }

    // 30s 心跳保持连接（防止代理/中间件超时断连）
    const keepAlive = setInterval(() => {
      if (streamClosed) return;
      stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
        close();
      });
    }, KEEPALIVE_INTERVAL_MS);

    function close() {
      if (streamClosed) return;
      streamClosed = true;
      if (safetyTimer !== undefined) clearTimeout(safetyTimer);
      clearInterval(keepAlive);
      unsub();
      if (resolveAbort) resolveAbort();
    }

    const ctx: SseStreamContext = {
      stream,
      get closed() {
        return streamClosed;
      },
      onUnsubscribe(fn) {
        unsub = fn;
      },
      close,
    };

    await setup(ctx);

    // 流已在 setup 内关闭（如终态立即推送）则不再挂起等待
    if (!streamClosed) {
      await new Promise<void>((resolve) => {
        resolveAbort = resolve;
        stream.onAbort(() => {
          close();
        });
      });
    }
  });
}
