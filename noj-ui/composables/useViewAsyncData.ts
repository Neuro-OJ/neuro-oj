import type { MaybeRefOrGetter } from 'vue';

/**
 * 历史名称的兼容别名：页面数据现在由调用方自己的 useAsyncData 持有，
 * 这里不再读取或写入全局 BFF 快照。
 */
export function useViewAsyncData<T>(
  _section: string,
  key: MaybeRefOrGetter<string>,
  handler: () => Promise<T>,
  options: { watch?: import('vue').WatchSource[]; immediate?: boolean } = {},
) {
  return useAsyncData<T>(key, handler, options);
}
