/**
 * SSE 流生命周期与公共骨架。
 *
 * 除了 30s 心跳、兜底超时与订阅清理外，本模块还持有一个窄范围的
 * {@link SseStreamScope}：关闭进程时先同步关闭所有已建立的长连接，再等待各流的
 * setup/清理真正结束，最后才允许关闭数据库。否则 SSE 长连接会让
 * `Deno.HttpServer.shutdown()` 永远等不到空闲，最终只能强制退出。
 *
 * 多副本约束：SSE 连接本身只存在于单个进程；scope 是进程内本地集合，
 * 不承担跨副本状态。每个 Core 副本必须关闭自己的 scope，客户端重连到其他副本。
 */

import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { getLogger } from "@logtape/logtape";
import { observability } from "../observability/registry.ts";

const logger = getLogger(["noj", "sse"]);

/** SSE 心跳间隔（30s，防止代理/中间件超时断连）。 */
const KEEPALIVE_INTERVAL_MS = 30_000;
/** SSE 兜底超时（5 分钟，防止 onAbort 不触发时泄漏定时器与订阅）。 */
const SAFETY_TIMEOUT_MS = 300_000;

/** 单条活跃流在 scope 中的句柄。 */
export interface SseStreamHandle {
  /** 同步关闭流并触发退订/计时器/metrics 清理；必须幂等。 */
  close(): void;
  /** 流回调（含 setup 与 finally 清理）完全结束时 resolve。 */
  done: Promise<void>;
}

/** 进程内 SSE 流注册表。 */
export interface SseStreamScope {
  /** scope 是否已进入关闭状态；关闭后新流会立即关闭。 */
  readonly closed: boolean;
  /** 登记一条活跃流；返回注销函数（幂等）。 */
  register(handle: SseStreamHandle): () => void;
  /** 同步关闭全部现有流；返回本次触发关闭的数量。重复调用幂等。 */
  closeAll(): number;
  /**
   * 等待所有已登记流（含 closeAll 后短暂注册的新流）完成收尾。
   *
   * 可能在 setup 仍执行异步读写时等待它结束；调用方必须给本 Promise 设置超时。
   */
  doneAll(): Promise<void>;
  /** 当前登记数量（诊断/测试用）。 */
  activeCount(): number;
}

/**
 * 创建一个 SSE 流 scope。
 *
 * 关闭后再 `register` 的流会立即 `close()`，但直到其回调 finally 执行完才从
 * 活跃集合移除，确保“关闭后新连接”也不会重新打开泄漏。
 */
export function createSseStreamScope(): SseStreamScope {
  let closed = false;
  const active = new Set<SseStreamHandle>();
  return {
    get closed() {
      return closed;
    },
    register(handle) {
      active.add(handle);
      if (closed) handle.close();
      return () => {
        active.delete(handle);
      };
    },
    closeAll() {
      if (closed) return 0;
      closed = true;
      const handles = [...active];
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // 单条流关闭失败不能阻断其余连接关闭。
        }
      }
      return handles.length;
    },
    async doneAll() {
      // 关闭后 register 的流会立即 close，但可能在 finally 前短暂加入集合；
      // 循环直到集合清空，避免漏等这些收尾。
      while (active.size > 0) {
        await Promise.allSettled([...active].map((handle) => handle.done));
      }
    },
    activeCount: () => active.size,
  };
}

/** 未经 Core 装配的独立路由使用本地缺省作用域；生产入口显式注入实例。 */
const defaultScope = createSseStreamScope();

/** 单条 SSE 流的操作上下文（提供给 setup 回调）。 */
export interface SseStreamContext {
  /** hono 流对象（用于 writeSSE 推送）。 */
  stream: SSEStreamingApi;
  /** 流是否已关闭。 */
  readonly closed: boolean;
  /**
   * 注册关闭时的清理回调（如 onEvent 的退订函数）。
   *
   * 可注册多个；若流已关闭，传入的回调会立即执行并捕获异常。
   */
  onUnsubscribe(fn: () => void): void;
  /** 主动关闭流（幂等；清理定时器并触发退订）。 */
  close(): void;
  /**
   * 在流生命周期内执行一个异步事件回调。
   *
   * - 流已关闭时拒绝启动（不执行 operation）；
   * - 已启动的回调会计入本流 `done`，关闭时不会在回调仍写库时提前释放依赖；
   * - 回调失败按 fail-closed 关闭流，并记录错误，不向调用方漏出未处理拒绝。
   */
  run(operation: () => Promise<void> | void): Promise<void>;
}

/** createSseStream 配置项。 */
export interface CreateSseStreamOptions {
  /**
   * 兜底超时（毫秒）；传 0 表示不启用。
   * 默认 5 分钟自动关闭，防止 onAbort 不触发时泄漏 setInterval + 订阅回调。
   */
  safetyTimeoutMs?: number;
  /** 显式指定流所属 scope；省略时读取上下文注入或进程默认 scope。 */
  scope?: SseStreamScope;
}

/** 从 Hono context 读取可选的 app 级 scope 注入。 */
function scopedFromContext(c: Context): SseStreamScope | undefined {
  try {
    const get = (c as unknown as {
      get?: (key: string) => unknown;
    }).get;
    return get?.call(c, "sseStreamScope") as SseStreamScope | undefined;
  } catch {
    return undefined;
  }
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
  const scope = options.scope ?? scopedFromContext(c) ?? defaultScope;
  return streamSSE(c, async (stream) => {
    observability.add("noj_http_sse_connections", 1);
    let metricsReleased = false;
    const releaseMetrics = () => {
      if (metricsReleased) return;
      metricsReleased = true;
      observability.add("noj_http_sse_connections", -1);
    };

    let streamClosed = false;
    let resolveAbort: (() => void) | null = null;
    const unsubscribers: Array<() => void> = [];
    let unsubscribersRan = false;
    const runUnsubscribers = () => {
      if (unsubscribersRan) return;
      unsubscribersRan = true;
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // 退订失败不能阻断其余清理或关闭流程。
        }
      }
    };
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const operations = new Set<Promise<void>>();
    let setupFinished = false;
    let streamCloseSettled = false;
    let settleDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settleDone = resolve;
    });
    const settleDoneIfDrained = () => {
      if (setupFinished && operations.size === 0 && streamCloseSettled) {
        settleDone();
      }
    };

    const close = () => {
      if (streamClosed) return;
      streamClosed = true;
      if (safetyTimer !== undefined) clearTimeout(safetyTimer);
      if (keepAlive !== undefined) clearInterval(keepAlive);
      runUnsubscribers();
      releaseMetrics();
      resolveAbort?.();
      // 结束响应体；即使 setup 仍在异步读写，客户端也能收到 EOF，
      // server.shutdown() 不必等待一个永不返回的流。setup 的完成由 scope.done 等待。
      // 关闭 Promise 也必须被观察并计入 done，避免未处理拒绝或提前释放依赖。
      void Promise.resolve()
        .then(() => stream.close())
        .then(
          () => {
            streamCloseSettled = true;
            settleDoneIfDrained();
          },
          (error) => {
            logger.error("SSE 流关闭失败", { err: error });
            streamCloseSettled = true;
            settleDoneIfDrained();
          },
        );
    };

    const run = (
      operation: () => Promise<void> | void,
    ): Promise<void> => {
      // 关闭后拒绝启动新 operation：事件回调不得在收尾阶段重新写库。
      if (streamClosed) return Promise.resolve();
      const task = (async () => {
        try {
          await operation();
        } catch (error) {
          logger.error("SSE 事件回调失败，按 fail-closed 关闭流", {
            err: error,
          });
          close();
        }
      })();
      operations.add(task);
      void task.finally(() => {
        operations.delete(task);
        settleDoneIfDrained();
      });
      return task;
    };

    const unregister = scope.register({ close, done });
    // 只有 done（setup + 在途 run + stream.close 全部结束）后才从 scope 移除，
    // 否则 doneAll 看到 active=0 会提前返回，漏等仍在写库的事件回调。
    void done.then(() => unregister());

    try {
      // scope 在注册前已关闭（进程已进入关闭流程）：立即结束，不再 setup。
      if (scope.closed) {
        close();
        return;
      }

      // setup 之前注册 abort：客户端在初始异步读取/推送期间断开也能立即清理。
      stream.onAbort(() => {
        close();
      });
      if (stream.aborted || stream.closed) {
        close();
        return;
      }

      if (safetyTimeoutMs > 0) {
        safetyTimer = setTimeout(() => {
          close();
        }, safetyTimeoutMs);
      }

      // 30s 心跳保持连接（防止代理/中间件超时断连）
      keepAlive = setInterval(() => {
        if (streamClosed) return;
        stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
          close();
        });
      }, KEEPALIVE_INTERVAL_MS);

      const ctx: SseStreamContext = {
        stream,
        get closed() {
          return streamClosed;
        },
        onUnsubscribe(fn) {
          if (streamClosed) {
            // setup 在 close 之后才注册退订：立即清理，不能挂到永远不触发的列表。
            try {
              fn();
            } catch {
              // 清理回调自身失败不影响关闭。
            }
            return;
          }
          unsubscribers.push(fn);
        },
        close,
        run,
      };

      await setup(ctx);

      // 流已在 setup 内关闭（如终态立即推送）则不再挂起等待
      if (!streamClosed) {
        await new Promise<void>((resolve) => {
          resolveAbort = resolve;
          if (stream.aborted) close();
        });
      }
    } finally {
      // 正常完成时 close() 已在 onAbort/setup 中调用；异常路径兜底清理。
      try {
        close();
      } finally {
        setupFinished = true;
        settleDoneIfDrained();
      }
    }
  });
}
