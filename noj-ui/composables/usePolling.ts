/**
 * 通用轮询组合函数。
 * 按指定间隔轮询一个异步函数，当满足结束条件时自动停止。
 */
export function usePolling(
  fetcher: () => Promise<void>,
  options?: {
    /** 轮询间隔（毫秒），默认 2000。 */
    intervalMs?: number;
    /** 停止条件——返回 true 时停止轮询。 */
    stopWhen?: () => boolean;
    /** 是否在挂载后立即执行一次，默认 true。 */
    immediate?: boolean;
  },
) {
  const { intervalMs = 2000, stopWhen, immediate = true } = options ?? {};

  const isPolling = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce() {
    try {
      await fetcher();
    } catch {
      // 轮询失败静默处理
    }
  }

  function start() {
    if (timer) return;
    isPolling.value = true;

    if (immediate) {
      pollOnce();
    }

    timer = setInterval(async () => {
      await pollOnce();

      // 检查停止条件
      if (stopWhen?.()) {
        stop();
      }
    }, intervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isPolling.value = false;
  }

  onMounted(() => {
    start();
  });

  onUnmounted(() => {
    stop();
  });

  return {
    isPolling,
    start,
    stop,
  };
}
