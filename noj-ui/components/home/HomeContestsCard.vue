<script setup lang="ts">
import { formatDateTime } from '~/utils/domain/submission/submissionFormat';
import { workspaceCacheKey, workspacePath } from '~/utils/domain/workspace/workspace';
import { DOMAIN_CONTEST_TYPES } from '~/utils/domain/contest/domain-contests';
import type { DomainContest } from '~/composables/useDomainContests';
import { extractApiError } from '~/utils/server/apiError';

type HomeContestsData = { data: DomainContest[] };
type HomeSectionError = { statusCode: number; data: { error: string; code?: string; request_id?: string } };
const props = defineProps<{ domainSlug: string; initialData?: HomeContestsData; initialError?: HomeSectionError }>();
const { user } = useAuth();
const api = useDomainContests();
const key = computed(() => workspaceCacheKey(props.domainSlug, user.value?.id ?? null, 'home-contests'));
const { data, error, status, refresh } = await useAsyncData(
  key,
  () => api.list(props.domainSlug, 1, { per_page: 3, sort: 'upcoming' }),
  { immediate: props.initialData === undefined && props.initialError === undefined },
);
const contests = computed(() => {
  const list = (data.value ?? props.initialData)?.data ?? [];
  const active = list.filter((item) => item.status === 'running' || item.status === 'pending');
  return (active.length ? active : list).slice(0, 3);
});
const activeError = computed(() => error.value ?? (data.value ? undefined : props.initialError));
</script>

<template>
  <section class="overflow-hidden rounded-lg border border-border bg-bg-panel" aria-label="近期比赛">
    <div class="flex flex-wrap items-center gap-2 border-b border-border bg-bg-sunken/50 px-3 py-1.5">
      <h2 class="mr-auto text-xs font-semibold text-text-secondary">近期比赛</h2>
      <NuxtLink
        :to="workspacePath(domainSlug, 'contests')"
        class="text-xs text-primary no-underline hover:underline"
      >
        全部比赛 →
      </NuxtLink>
    </div>
    <AsyncContent
      :status="activeError ? 'error' : contests.length ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="activeError ? extractApiError(activeError).message : undefined"
      empty-text="暂无近期比赛"
      @retry="refresh()"
    >
      <ul class="divide-y divide-border-subtle">
        <li v-for="contest in contests" :key="contest.id">
          <NuxtLink
            :to="workspacePath(domainSlug, `contests/${contest.id}`)"
            class="block px-3 py-2 text-[13px] no-underline hover:bg-bg-sunken/60"
          >
            <div class="flex items-center gap-2">
              <span
                class="inline-flex shrink-0 items-center gap-1 text-xs"
                :class="contest.status === 'running'
                  ? 'text-verdict-accepted'
                  : contest.status === 'pending'
                  ? 'text-primary'
                  : 'text-text-muted'"
              >
                <span
                  class="size-1.5 rounded-[1px] bg-current"
                  :class="contest.status === 'running' && 'animate-pulse'"
                />
                {{ { pending: '未开始', running: '进行中', ended: '已结束' }[contest.status] }}
              </span>
              <span class="min-w-0 flex-1 truncate font-medium text-text">{{ contest.title }}</span>
            </div>
            <div
              class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-text-muted">
              <span>{{ DOMAIN_CONTEST_TYPES.find((type) => type.value === contest.type)?.label }}</span>
              <span>{{ formatDateTime(contest.start_time) }}</span>
              <span>{{ contest.problem_count }} 题</span>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </AsyncContent>
  </section>
</template>
