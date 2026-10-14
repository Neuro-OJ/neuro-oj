<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth();
const api = useDomainContestAnswers(), contestApi = useDomainContests();
const id = computed(() => String(route.params.contestId)), label = computed(() => String(route.params.label));
const key = computed(() =>
  workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest-answer', id.value, label.value)
);
const { data, status, error, refresh } = await useAsyncData(key, () => api.problem(slug.value!, id.value, label.value));
const contest = await useAsyncData(() => `${key.value}:contest`, () => contestApi.detail(slug.value!, id.value));
usePolling({ intervalMs: computed(() => contest.data.value?.data.status !== 'ended' ? 2000 : null), immediate: false, fetcher: () => contest.refresh() });
watch(() => [contest.data.value?.data.revision, contest.data.value?.data.status], (next, previous) => {
  if (previous[0] != null && (next[0] !== previous[0] || next[1] !== previous[1])) void refresh();
});
useSeoMeta({ title: () => data.value?.data.title ?? '比赛题目' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-5">
      <div class="flex flex-wrap justify-between gap-3">
        <h2 class="text-xl font-semibold">{{ data.data.label }} · {{ data.data.title }}</h2>
        <UButton :to="`/d/${slug}/contests/${id}`" variant="outline">返回比赛</UButton>
      </div>
      <p class="text-xs text-text-muted">{{ data.data.display_id }} · 固定版本 V{{ data.data.version }}</p>
      <UCard>
        <MarkdownRenderer :content="data.data.description" />
      </UCard>
      <UAlert v-if="contest.error.value" color="error" :title="extractApiError(contest.error.value).message" />
      <DomainContestAnswer v-if="data.data.version_id" :key="`${key}`" :slug="slug!" :contest-id="id"
        :problem="{ ...data.data, version_id: data.data.version_id }"
        :active="contest.data.value?.data.status === 'running' && !!contest.data.value.data.is_registered"
        @refresh="refresh()" />
    </div>
  </AsyncContent>
</template>
