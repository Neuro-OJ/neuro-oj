<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { formatDateTime } from '~/utils/submissionFormat';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(),
  { slug } = useWorkspace(),
  { user } = useAuth(),
  api = useDomainObjectiveHistory(),
  page = ref(1);
const problemId = computed(() => typeof route.query.problem_id === 'string' ? route.query.problem_id : undefined);
const { data, status, error, refresh } = await useAsyncData(
  () =>
    workspaceCacheKey(
      slug.value!,
      user.value?.id ?? null,
      'objective-history',
      String(page.value),
      problemId.value ?? null,
    ),
  () => api.list(slug.value!, page.value, problemId.value),
);
watch(problemId, () => {
  page.value = 1;
});
useSeoMeta({ title: '我的域内客观题历史' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="我的客观题历史" description="本人在当前域的原回答及获准公开的结果摘要">
      <template #actions>
        <UButton :to="workspacePath(slug!, 'submissions')" variant="outline">代码／产物提交</UButton>
        <UButton to="/my/submissions" variant="outline">全部域本人历史</UButton>
        <UButton variant="outline" @click="refresh()">刷新</UButton>
      </template>
    </AdminPageHeader>
    <p v-if="problemId"
      class="text-sm text-text-muted">当前按题目筛选。<NuxtLink :to="workspacePath(slug!, 'objective-submissions')" class="text-primary">查看本域全部客观题历史</NuxtLink></p>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <UCard v-for="entry in data?.data" :key="entry.id" class="mb-3">
        <NuxtLink :to="workspacePath(slug!, `objective-submissions/${entry.id}`)"
          class="font-semibold text-primary"><span class="mr-2 font-mono">{{ entry.reference.display_ref }}</span>{{ entry.problem.title }}</NuxtLink>
        <p
          class="my-3 text-xs text-text-muted">{{ formatDateTime(entry.created_at) }}{{ entry.contest_id ? ' · 比赛提交' : '' }}{{ !entry.resource_available ? ' · 资源不可用' : '' }}</p>
        <OwnSubmissionSummary :entry="entry" />
      </UCard>
      <PaginationNav :current-page="page" :total-pages="Math.ceil((data?.total ?? 0) / 30)"
        @page-change="page = $event" />
    </AsyncContent>
  </div>
</template>
