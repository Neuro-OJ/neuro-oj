<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import type {DomainCodeProblem} from '~/utils/domain-problems';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace-editor', middleware: ['auth', 'workspace-context'], ssr: false });
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


const model=computed<DomainCodeProblem|null>(()=>{
  const p=data.value?.data;
  if(!p?.version_id || !p.reference) return null;
  return {
    reference:p.reference,version_id:p.version_id,version:p.version!,supported_languages:p.supported_languages,
    difficulty:p.difficulty,limits:p.limits,
    content:{kind:p.judge_type==='oi'?'oi':'ai',title:p.title,description:p.description,samples:p.samples??[],submission_mode:p.submission_mode},
  };
});
const backUrl=computed(()=>`/d/${slug.value}/contests/${encodeURIComponent(id.value)}/problems/${encodeURIComponent(label.value)}`);
const active=computed(()=>contest.data.value?.data.status==='running' && !!contest.data.value.data.is_registered);
</script>
<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status==='pending' ? 'loading':'empty'" :error="error ? extractApiError(error).message:undefined" @retry="refresh()">
    <template v-if="data && model">
      <div v-if="data.data.is_objective || ['artifact','prediction'].includes(data.data.submission_mode)" class="flex min-h-dvh items-center justify-center"><UButton :to="backUrl">返回比赛题目页作答</UButton></div>
      <div v-else-if="data.data.submission_mode==='ui'" class="mx-auto max-w-[1440px] space-y-4 p-4">
        <div class="flex items-center justify-between gap-3"><h1 class="text-xl font-semibold">{{ data.data.label }} · {{ data.data.title }}</h1><UButton :to="backUrl" color="neutral" variant="outline">返回赛题</UButton></div>
        <DomainContestAnswer :key="key" :slug="slug!" :contest-id="id" :problem="{...data.data,version_id:model.version_id}" :active="active" @refresh="refresh()" />
      </div>
      <DomainCodeWorkspace v-else :key="key" :slug="slug!" :problem="model" :back-url="backUrl"
        :contest="{id,label,title:contest.data.value?.data.title ?? '比赛',active}" @refresh="refresh()" />
    </template>
  </AsyncContent>
</template>
