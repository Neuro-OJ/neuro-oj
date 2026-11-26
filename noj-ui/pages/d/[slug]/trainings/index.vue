<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/domain/workspace/workspace';
import { teachingTrainingId } from '~/utils/domain/education/education';
import { extractApiError } from '~/utils/server/apiError';
definePageMeta({
  layout: 'workspace',
  middleware: 'workspace-context',
  workspaceWidth: 'library',
  breadcrumbWidth: '1008px',
});
const { slug, domain, can } = useWorkspace(),
  { user } = useAuth(),
  api = useDomainTrainings(),
  capture = useWorkspaceActionScope();
const page = ref(1),
  entered = ref(''),
  keyword = ref(''),
  trainingLink = ref(''),
  importing = ref(false),
  failure = ref('');
const { data, error, status, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'training-list', String(page.value), keyword.value),
  () => api.list(slug.value!, page.value, keyword.value),
);
function search() {
  page.value = 1;
  keyword.value = entered.value.trim();
}
async function importTraining() {
  if (importing.value || !trainingLink.value.trim()) return;
  const scope = capture();
  importing.value = true;
  failure.value = '';
  try {
    const id = teachingTrainingId(trainingLink.value);
    await api.import(scope.slug, id);
    if (scope.isCurrent()) await navigateTo(workspacePath(scope.slug, `trainings/${id}`));
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) importing.value = false;
  }
}
useSeoMeta({ title: '题单' });
</script>
<template>
  <div class="space-y-3">
    <LibraryPageHeader title="题单" description="按专题整理题目，循序完成训练"
      :count="data ? `${data.total} 份` : undefined">
      <template #actions>
        <UButton v-if="domain?.status === 'active' && can('training:create')"
          :to="workspacePath(slug!, 'trainings/new')" size="xs" icon="i-lucide-plus">创建题单</UButton>
      </template>
    </LibraryPageHeader>
    <details v-if="domain?.status === 'active' && can('training:import')"
      class="rounded-lg border border-border bg-bg-panel">
      <summary class="cursor-pointer px-3 py-2 text-[13px] font-medium text-text-secondary">引用公开题单</summary>
      <div class="border-t border-border p-4">
        <p
          class="mb-3 text-xs text-text-muted">粘贴来源域题单链接。引用不会复制内容，也不自动授予其中题目的作答权限；资源管理者可逐题建立当前域引用。</p>
        <div class="flex gap-2">
          <UInput v-model="trainingLink" placeholder="/d/main/trainings/…" class="grow"
            @keydown.enter.prevent="importTraining" />
          <UButton :loading="importing" :disabled="!trainingLink.trim()" @click="importTraining">引用到本域</UButton>
        </div>
        <UAlert v-if="failure" class="mt-3" color="error" :title="failure" />
        <div class="mt-5 border-t border-border pt-5">
          <ClientOnly>
            <AdminCopyCatalog :slug="slug!" kind="training" @imported="refresh()" />
          </ClientOnly>
        </div>
      </div>
    </details>
    <form class="flex max-w-md gap-2" @submit.prevent="search">
      <UInput v-model="entered" size="xs" icon="i-lucide-search" placeholder="搜索题单名称" aria-label="搜索题单名称"
        class="min-w-0 grow" />
      <UButton type="submit" size="xs" color="neutral" variant="outline">搜索</UButton>
    </form>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <div class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-bg-panel">
        <NuxtLink v-for="item in data?.items" :key="item.id" :to="workspacePath(slug!, `trainings/${item.id}`)"
          class="group grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] items-center gap-4 px-3 py-1.5 text-[13px] text-text no-underline hover:bg-bg-sunken/50">
          <h2 class="truncate text-[13px] font-medium group-hover:text-primary">{{ item.title }}</h2>
          <span class="truncate text-xs text-text-muted">{{ item.description || '暂无简介' }}</span>
          <span class="font-mono text-xs"
            :class="item.state === 'published' ? 'text-text-secondary' : 'text-verdict-limit'">
            {{ item.state === 'published' ? '已发布' : '草稿' }}
          </span>
        </NuxtLink>
      </div>
      <PaginationNav :current-page="page" :total-pages="Math.ceil((data?.total ?? 0) / 20)"
        @page-change="page = $event" />
    </AsyncContent>
  </div>
</template>
