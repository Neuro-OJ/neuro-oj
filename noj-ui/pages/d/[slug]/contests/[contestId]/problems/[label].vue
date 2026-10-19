<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth();
const api = useDomainContestAnswers(), contestApi = useDomainContests();
const id = computed(() => String(route.params.contestId)), label = computed(() => String(route.params.label));
const codeLike = computed(() =>
  !data.value?.data.is_objective && !['artifact', 'prediction'].includes(data.value?.data.submission_mode ?? '')
);
const solveTo = computed(() =>
  `/d/${slug.value}/contests/${encodeURIComponent(id.value)}/solve/${encodeURIComponent(label.value)}`
);
const key = computed(() =>
  workspaceCacheKey(slug.value!, user.value?.id ?? null, 'contest-answer', id.value, label.value)
);
const { data, status, error, refresh } = await useAsyncData(key, () => api.problem(slug.value!, id.value, label.value));
const contest = await useAsyncData(() => `${key.value}:contest`, () => contestApi.detail(slug.value!, id.value));
usePolling({
  intervalMs: computed(() => contest.data.value?.data.status !== 'ended' ? 2000 : null),
  immediate: false,
  fetcher: () => contest.refresh(),
});
watch(() => [contest.data.value?.data.revision, contest.data.value?.data.status], (next, previous) => {
  if (previous[0] != null && (next[0] !== previous[0] || next[1] !== previous[1])) void refresh();
});
useSeoMeta({ title: () => data.value?.data.title ?? '比赛题目' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status==='pending' ? 'loading':'empty'"
    :error="error ? extractApiError(error).message:undefined" @retry="refresh()">
    <div v-if="data" class="space-y-5">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="mb-2 text-xs text-text-muted">{{ data.data.display_id }} · 比赛固定版本 V{{ data.data.version }}</p>
          <h1 class="break-words text-2xl font-bold text-text">{{ data.data.label }} · {{ data.data.title }}</h1>
        </div>
        <div class="flex gap-2">
          <UButton v-if="codeLike" :to="solveTo"
            icon="i-lucide-code-2">{{ data.data.submission_mode === 'ui' ? '打开作答界面' : '开始编码' }}</UButton>
          <UButton :to="`/d/${slug}/contests/${id}`" color="neutral" variant="outline">返回比赛</UButton>
        </div>
      </header>
      <article class="rounded border border-border bg-bg-panel p-5 shadow-card sm:p-7">
        <AnnotationSurface v-if="data.data.reference && data.data.version_id" :slug="slug!" :target="{ kind: 'problem', reference: data.data.reference.qualified_ref, version_id: data.data.version_id, contest_id: id, field: 'description' }">
          <MarkdownRenderer :content="data.data.description" />
        </AnnotationSurface>
        <MarkdownRenderer v-else :content="data.data.description" />
        <ProblemSamples :samples="data.data.samples ?? []" :annotation="data.data.reference && data.data.version_id ? { slug: slug!, reference: data.data.reference.qualified_ref, version_id: data.data.version_id, contest_id: id } : undefined" />
      </article>
      <UAlert v-if="contest.error.value" color="error" :title="extractApiError(contest.error.value).message" />
      <DomainContestAnswer v-if="!codeLike && data.data.version_id" :key="key" :slug="slug!" :contest-id="id"
        :problem="{...data.data,version_id:data.data.version_id}"
        :active="contest.data.value?.data.status==='running' && !!contest.data.value.data.is_registered"
        @refresh="refresh()" />
    </div>
  </AsyncContent>
</template>
