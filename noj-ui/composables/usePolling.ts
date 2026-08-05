/**
 * 通用轮询 composable。
 *
 * 为后台动态数据页面提供自动刷新能力：
 * - intervalMs 支持响应式动态变化（MaybeRefOrGetter），变为 null 时停止轮询
 * - 页面隐藏（visibilitychange）时暂停，恢复可见后继续
 * - 防重入：上一轮 fetcher 未完成则跳过本轮
 * - onUnmounted 自动清理定时器
 *
 * 用法：
 * ```ts
 * const interval = ref<number | null>(5000)
 * usePolling({
 *   intervalMs: interval,
 *   fetcher: async () => { await loadData() },  // 内部自行静默，不置 loading
 * })
 * // interval.value = 10000  → 即时切换间隔
 * // interval.value = null   → 关闭轮询
 * ```
 */
import { type MaybeRefOrGetter, onUnmounted, toValue, watch } from 'vue';

export interface PollingOptions {
  /** 轮询间隔（ms）；null = 关闭。支持响应式源，变化即时生效 */
  intervalMs: MaybeRefOrGetter<number | null>;
  /** 每次轮询执行的回调（静默刷新，勿置 loading） */
  fetcher: () => Promise<void> | void;
  /** 是否立即执行一次 fetcher（默认 true） */
  immediate?: boolean;
  /** 返回 true 时自动停止轮询（如提交列表全部终态） */
  stopWhen?: () => boolean;
  /** 外部暂停开关（如登录态未就绪） */
  active?: MaybeRefOrGetter<boolean>;
}

export function usePolling(options: PollingOptions) {
  const { fetcher, stopWhen, immediate = true } = options;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const isPolling = ref(false);

  /** 单次执行（防重入：上一轮未完成则跳过） */
  async function tick() {
    if (inFlight) return; // 防重入
    inFlight = true;
    try {
      await fetcher();
    } catch {
      // 轮询为静默刷新：错误不逸出（避免 unhandled rejection），下次轮询重试
    } finally {
      inFlight = false;
    }
    // 终态条件满足时自动停止
    if (stopWhen?.()) {
      stop();
    }
  }

  function start() {
    // 服务端禁止定时器（Nuxt 检查）：SSR 渲染时不启动，仅客户端轮询
    if (!import.meta.client) return;
    const ms = toValue(options.intervalMs);
    const active = toValue(options.active) !== false;
    // 页面隐藏时不启动（恢复可见由 visibilitychange 触发）
    if (timer || !active || ms == null) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    isPolling.value = true;
    if (immediate) void tick();
    timer = setInterval(() => void tick(), ms);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isPolling.value = false;
  }

  // 间隔 / 激活状态变化时重置定时器
  watch(
    () => [toValue(options.intervalMs), toValue(options.active)] as const,
    () => {
      stop();
      start();
    },
  );

  // 页面隐藏时暂停，恢复可见后继续（后台 tab 的 setInterval 会被浏览器节流，显式暂停更干净）
  function onVisibilityChange() {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  onUnmounted(() => {
    stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  });

  start();

  return { start, stop, isPolling };
}
