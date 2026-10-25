<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const { api } = useApi(), { user } = useAuth();
interface Snapshot {
  total: number;
  full_score: number;
  not_full_score: number;
}
interface RecentSubmission {
  id: string;
  public_id: string | null;
  problem_id: string;
  status: string;
  created_at: string;
  problem: { title: string };
  result: { status: string; score: number; time_ms: number | null; memory_kb: number | null } | null;
}
type ActivityData = { data: { recent: RecentSubmission[]; total: Snapshot; today: Snapshot } };
const props = defineProps<{ domainSlug: string; initialData?: ActivityData }>();
const scope = computed(() => workspaceCacheKey(props.domainSlug, user.value?.id ?? null, 'latest-submissions'));
const { data, status, error, refresh } = await useViewAsyncData(
  'activity',
  scope,
  () =>
    api.get<ActivityData>(
      `/api/v1/domains/${props.domainSlug}/activity`,
      { silent: true },
    ),
  { immediate: !props.initialData },
);
const activity = computed(() => props.initialData ?? data.value);
const events = useEventSource({
  url: `/api/v1/domains/${props.domainSlug}/submissions/stats/events`,
  scopeKey: scope,
  onEvent: {
    'stats:updated': () => {
      void refresh();
    },
  },
  fetchFn: () => refresh(),
  fallbackIntervalMs: 10000,
});
</script>
<template>
  <section class="flex h-full min-h-64 flex-col rounded border border-border bg-bg-panel">
    <div class="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3.5">
      <UIcon name="i-lucide-clock" class="size-4 shrink-0 text-primary" />
      <h2 class="text-sm font-semibold text-text">最新评测</h2>
      <span class="size-1.5 rounded-full" :class="events.state.value === 'connected' ? 'bg-signal' : 'bg-text-muted'"
        :title="events.state.value === 'connected' ? '实时更新' : '定时刷新'" />
      <StatsToggle :today-stats="activity?.data.today ?? null" :total-stats="activity?.data.total ?? null" />
    </div>
    <div class="flex-1 p-3">
      <AsyncContent
        :status="error ? 'error' : activity?.data.recent.length ? 'data' : status === 'pending' ? 'loading' : 'empty'"
        :error="error ? extractApiError(error).message : undefined"
        :empty-text="user ? '你在此域还没有评测记录' : '暂无公开评测记录'" @retry="refresh()">
        <div class="space-y-2">
          <SubmissionCard v-for="submission in activity?.data.recent" :key="submission.id" :domain-slug="domainSlug"
            :submission="{...submission,public_id:submission.public_id ?? undefined}" />
        </div>
      </AsyncContent>
    </div>
    <NuxtLink :to="workspacePath(domainSlug,'submissions')"
      class="flex items-center justify-center gap-1 border-t border-border px-5 py-2.5 text-xs font-semibold text-primary no-underline hover:bg-primary-hover-bg">查看全部提交<UIcon name="i-lucide-arrow-right" class="size-3.5" /></NuxtLink>
  </section>
</template>
