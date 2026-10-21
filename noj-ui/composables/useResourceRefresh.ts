import { onScopeDispose, ref } from 'vue';

/** 资源刷新令牌：取消旧请求，并阻止晚到响应写入新的页面/资源状态。 */
export interface ResourceRefreshToken {
  generation: number;
  signal: AbortSignal;
}

export function useResourceRefresh() {
  const generation = ref(0);
  let controller: AbortController | null = null;

  function begin(): ResourceRefreshToken {
    controller?.abort('resource-refresh');
    controller = new AbortController();
    generation.value += 1;
    return { generation: generation.value, signal: controller.signal };
  }

  function isCurrent(token: ResourceRefreshToken): boolean {
    return generation.value === token.generation && controller?.signal === token.signal && !token.signal.aborted;
  }

  function invalidate(): void {
    controller?.abort('resource-invalidated');
    controller = null;
    generation.value += 1;
  }

  onScopeDispose(() => {
    controller?.abort('scope-disposed');
    controller = null;
  });

  return { generation, begin, isCurrent, invalidate };
}
