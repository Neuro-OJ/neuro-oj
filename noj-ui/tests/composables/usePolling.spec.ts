import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePolling } from '~/composables/usePolling';

describe('usePolling', () => {
  beforeEach(() => {
    // happy-dom 默认可能将 document.hidden 置为 true，导致 usePolling 不启动
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('立即执行一次 fetcher', async () => {
    const fetcher = vi.fn(async () => {});
    usePolling({ intervalMs: 1000, fetcher, immediate: true });
    await nextTick();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('intervalMs 为 null 时不启动定时器', async () => {
    const fetcher = vi.fn(async () => {});
    usePolling({ intervalMs: ref<number | null>(null), fetcher, immediate: true });
    await nextTick();
    expect(fetcher).toHaveBeenCalledTimes(0);
  });

  it('stopWhen 满足后停止轮询', async () => {
    const fetcher = vi.fn(async () => {});
    let done = false;
    const { stop } = usePolling({
      intervalMs: 1000,
      fetcher,
      immediate: true,
      stopWhen: () => done,
    });
    done = true;
    await nextTick();
    stop();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
