<script setup lang="ts">
import { workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });
const api = useDomainProblems(), { user } = useAuth();
const page = ref(1), keyword = ref('');
const { data, status, error, refresh } = await useAsyncData(
  () => `admin-main-problems:${user.value?.id}:${page.value}:${keyword.value}`,
  () => api.list('main', page.value, keyword.value),
);
watch(keyword, () => {
  page.value = 1;
});
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="默认域题库治理"
      description="当前目标固定为 main。资源的编辑、发布、共享及下架在域管理页面执行。">
      <template #actions>
        <UButton to="/d/main/problems/new" icon="i-lucide-plus">在 main 创建题目</UButton>
        <UButton to="/d/main/problem-bindings" variant="outline">资源与共享管理</UButton>
        <UButton to="/d/main/problem-drafts" variant="outline">未发布草稿</UButton>
      </template>
    </AdminPageHeader>
    <UInput v-model="keyword" icon="i-lucide-search" aria-label="搜索默认域题目" placeholder="搜索标题或题号"
      class="w-full" />
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="默认域暂无可浏览题目" @retry="refresh()">
      <div class="space-y-3">
        <UCard v-for="problem in data?.items" :key="problem.binding_id">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                class="font-medium"><span class="mr-2 font-mono text-primary">{{ problem.reference.display_ref }}</span>{{ problem.title }}</h2>
              <p
                class="mt-1 text-xs text-text-muted">V{{ problem.version }} · {{ { oi: 'OI 编程题', ai: 'AI 代码／LLM／产物题', objective: '客观题' }[problem.kind] }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton :to="workspaceProblemPath('main', problem.reference.display_ref)"
                variant="outline">域内详情与重测</UButton>
              <UButton v-if="!problem.reference.is_shared" :to="`/d/main/editor/${problem.reference.number}`"
                variant="outline">编辑与发布</UButton>
            </div>
          </div>
        </UCard>
      </div>
    </AsyncContent>
    <UPagination v-if="data && data.total > 30" v-model:page="page" :total="data.total" :items-per-page="30" />
  </div>
</template>
