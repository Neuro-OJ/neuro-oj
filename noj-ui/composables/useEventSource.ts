import { ref, watch, onUnmounted, type Ref } from "vue";

/**
 * EventSource 连接状态。
 *
 * - `connecting`: 正在建立 SSE 连接（超时计时器运行中）
 * - `connected`: SSE 连接正常，事件通过 EventSource 推送
 * - `fallback`: SSE 不可用，自动降级到轮询模式
 * - `disabled`: 被禁用（enabled = false）
 */
type EventSourceState = "connecting" | "connected" | "fallback" | "disabled";

/**
 * useEventSource 选项。
 */
export interface UseEventSourceOptions {
  /** SSE 端点路径（同源），如 `/api/v1/submissions/{id}/events` */
  url: string | Ref<string>;
  /** 事件类型到回调的映射 */
  onEvent?: Record<string, (data: unknown) => void>;
  /** 收到任何事件时的通用回调 (event, data) */
  onMessage?: (event: string, data: unknown) => void;
  /** 是否启用 SSE（默认 true） */
  enabled?: Ref<boolean>;
  /** Fallback 轮询间隔（ms），SSE 不可用时降级到此间隔 */
  fallbackIntervalMs?: number;
  /** Fallback 轮询函数，SSE 不可用时代替 EventSource 获取数据 */
  fetchFn?: () => Promise<void>;
}

/**
 * 通用 EventSource composable。
 *
 * 优先使用 SSE 接收实时推送，不可用时自动降级到轮询 fallback。
 * 提供状态 ref，供组件展示连接状态或调试信息。
 *
 * 降级触发条件：
 * 1. 浏览器不支持 EventSource
 * 2. 10 秒内未收到 open 事件（连接超时）
 * 3. onerror 事件触发（网络断开 / 服务端下线）
 *
 * @example
 * ```ts
 * useEventSource({
 *   url: "/api/v1/submissions/xxx/events",
 *   onEvent: {
 *     "submission:updated": (data) => { ... },
 *   },
 *   fetchFn: pollSubmission,
 *   fallbackIntervalMs: 1500,
 * });
 * ```
 */
export function useEventSource(options: UseEventSourceOptions) {
  const state = ref<EventSourceState>("disabled");

  let eventSource: EventSource | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let connectTimeout: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const urlRef = typeof options.url === "string"
    ? ref(options.url)
    : options.url;

  const enabled = options.enabled ?? ref(true);
  const onEvent = options.onEvent ?? {};
  const onMessage = options.onMessage;
  const fallbackIntervalMs = options.fallbackIntervalMs ?? 3000;
  const fetchFn = options.fetchFn;

  /**
   * SSR 阶段不启动任何 SSE 或 EventSource 操作。
   * EventSource 是浏览器 API，服务器端不可用。
   * 客户端水合后 watch enabled 变化自动执行 connect/startFallback。
   */
  const isClient = import.meta.client;

  /**
   * 关闭 EventSource 连接并清理超时计时器。
   */
  function closeEventSource() {
    if (connectTimeout) {
      clearTimeout(connectTimeout);
      connectTimeout = null;
    }
    if (eventSource) {
      eventSource.onopen = null;
      eventSource.onerror = null;
      eventSource.close();
      eventSource = null;
    }
  }

  /**
   * 停止 fallback 轮询。
   */
  function stopFallback() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  }

  /**
   * 启动 fallback 轮询，并安排 SSE 重试。
   */
  function startFallback() {
    stopFallback();
    state.value = "fallback";

    // 立即执行一次
    if (fetchFn) {
      fetchFn();
    }

    // 定时执行
    if (fallbackIntervalMs > 0) {
      fallbackTimer = setInterval(() => {
        if (fetchFn) {
          fetchFn();
        }
      }, fallbackIntervalMs);
    }

    // 30 秒后重试 SSE 连接（仅客户端）
    if (isClient) {
      retryTimer = setTimeout(() => {
        if (state.value === "fallback" && enabled.value) {
          connect();
        }
      }, 30_000);
    }
  }

  /**
   * 启动 SSE 连接（仅客户端执行）。
   */
  function connect() {
    if (!isClient) return;

    // 先清理旧连接
    closeEventSource();
    stopFallback();

    const url = typeof urlRef.value === "string" ? urlRef.value : "";
    if (!url) return;

    // 检查浏览器是否支持 EventSource
    if (typeof EventSource === "undefined") {
      console.warn("useEventSource: 浏览器不支持 EventSource，降级到轮询");
      startFallback();
      return;
    }

    state.value = "connecting";

    try {
      eventSource = new EventSource(url);
    } catch {
      console.warn("useEventSource: EventSource 创建失败，降级到轮询");
      startFallback();
      return;
    }

    // 连接超时：10 秒未收到 open 事件则降级
    connectTimeout = setTimeout(() => {
      if (state.value === "connecting") {
        console.warn("useEventSource: 连接超时（10s），降级到轮询");
        closeEventSource();
        startFallback();
      }
    }, 10_000);

    // 连接成功
    eventSource.onopen = () => {
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      state.value = "connected";
    };

    // 错误处理：降级到 fallback
    eventSource.onerror = () => {
      if (state.value === "connected" || state.value === "connecting") {
        console.warn("useEventSource: 连接出错，降级到轮询");
        closeEventSource();
        startFallback();
      }
    };

    // 注册事件监听
    for (const [event, callback] of Object.entries(onEvent)) {
      eventSource.addEventListener(event, ((e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          callback(data);
        } catch {
          callback(e.data);
        }
      }) as EventListener);
    }

    // 通用消息监听
    if (onMessage) {
      eventSource.onmessage = ((e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onMessage("message", data);
        } catch {
          onMessage("message", e.data);
        }
      }) as unknown as (this: EventSource, ev: MessageEvent) => void;
    }
  }

  /**
   * 断开连接并停止所有定时器。
   */
  function disconnect() {
    closeEventSource();
    stopFallback();
    state.value = "disabled";
  }

  // 监听 enabled 和 url 变化（SSR 阶段不连接，客户端水合后自动执行）
  watch(
    [enabled, urlRef],
    ([isEnabled]) => {
      if (isClient && isEnabled) {
        connect();
      } else if (!isEnabled) {
        disconnect();
      }
    },
    { immediate: true },
  );

  // 组件卸载时清理
  onUnmounted(() => {
    disconnect();
  });

  return {
    /** 当前连接状态 */
    state,
  };
}
