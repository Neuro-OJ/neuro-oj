import type { MaybeRefOrGetter } from 'vue';
import type { ProblemSummaries } from '~/utils/problem-summaries';
import { workspaceCacheKey } from '~/utils/workspace';

/** 只补齐当前显示的题名；初始作业视图直接消费同一份 BFF 摘要。 */
export function useProblemSummaries(slug: MaybeRefOrGetter<string>, references: MaybeRefOrGetter<string[]>) {
  const { api } = useApi(), { user } = useAuth();
  const refs = computed(() => [...new Set(toValue(references))].slice(0, 20));
  return useViewAsyncData(
    'problemSummaries',
    () => workspaceCacheKey(toValue(slug), user.value?.id ?? null, 'problem-summaries', JSON.stringify(refs.value)),
    () =>
      refs.value.length
        ? api.get<ProblemSummaries>(`/api/bff/v1/domains/${encodeURIComponent(toValue(slug))}/problem-summaries`, {
          query: { reference: refs.value },
          silent: true,
        })
        : Promise.resolve({ items: [] }),
  );
}
