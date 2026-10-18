import type { MaybeRefOrGetter } from 'vue';
import type { BffSectionName, BffSnapshot } from '~/utils/bff-view';
import { bffSnapshotMatches } from '~/utils/bff-view';

/** 供客户端计时器类组件读取初始模块，快照有效性随 URL/身份变化。 */
export function useViewSection<T>(section: BffSectionName) {
  const snapshot = useState<BffSnapshot | null>('bff:view', () => null);
  const actor = useState<{ id: string } | null>('auth:user', () => null);
  const route = useRouter().currentRoute;
  return computed(() =>
    bffSnapshotMatches(snapshot.value, route.value.fullPath, actor.value?.id ?? null)
      ? snapshot.value?.envelope.sections[section] as import('~/utils/bff-view').BffSection<T> | undefined
      : undefined
  );
}

/** 初始加载消费 BFF 模块；手动刷新与筛选变化仍读取原来的细粒度接口。 */
export function useViewAsyncData<T>(
  section: BffSectionName,
  key: MaybeRefOrGetter<string>,
  handler: () => Promise<T>,
  options: { watch?: import('vue').WatchSource[]; immediate?: boolean } = {},
) {
  const snapshot = useState<BffSnapshot | null>('bff:view', () => null);
  const actor = useState<{ id: string } | null>('auth:user', () => null);
  const route = useRouter().currentRoute;
  let initialError: unknown;
  let seededSnapshot: BffSnapshot | null = null;
  let seededKey: string | null = null;
  const pendingPath = useState<string | null>('bff:pending-path', () => null);
  return useAsyncData<T>(key, () => {
    if (pendingPath.value && pendingPath.value !== route.value.fullPath.split('#')[0]) {
      return Promise.reject(createError({ statusCode: 499, message: '视图已切换，取消旧页面读取' }));
    }
    if (initialError) {
      const error = initialError;
      initialError = undefined;
      return Promise.reject(error);
    }
    return handler();
  }, {
    ...options,
    getCachedData(cacheKey, app, context) {
      if (context.cause !== 'initial') return undefined;
      const valid = bffSnapshotMatches(snapshot.value, route.value.fullPath, actor.value?.id ?? null);
      if (valid && snapshot.value !== seededSnapshot) {
        seededSnapshot = snapshot.value;
        seededKey = cacheKey;
      }
      if (app.isHydrating && app.payload.data[cacheKey] !== undefined) return app.payload.data[cacheKey];
      // 同一快照只对应初始分页/筛选键，后续内部状态变化必须真正回源。
      if (!valid || seededKey !== cacheKey) return undefined;
      const seed = snapshot.value?.envelope.sections[section];
      if (!seed) return undefined;
      if (seed.error) {
        initialError = createError({ ...seed.error, message: seed.error.data.error });
        return undefined;
      }
      return seed.data as T;
    },
  });
}
