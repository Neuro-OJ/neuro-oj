<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { teachingTrainingId } from '~/utils/education';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
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
useSeoMeta({ title: '域题单' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="题单" description="浏览本域题单与获授权的公开引用">
      <template #actions>
        <UButton v-if="domain?.status === 'active' && can('training:create')"
          :to="workspacePath(slug!, 'trainings/new')" icon="i-lucide-plus">创建题单</UButton>
      </template>
    </AdminPageHeader>
    <UCard v-if="domain?.status === 'active' && can('training:import')">
      <h3 class="mb-3 font-semibold">引用公开题单</h3>
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
          <DomainSharedCatalog :slug="slug!" kind="training" @imported="refresh()" />
        </ClientOnly>
      </div>
    </UCard>
    <div class="flex gap-2">
      <UInput v-model="entered" placeholder="搜索题单名称" class="grow" @keydown.enter.prevent="search" />
      <UButton variant="outline" @click="search">搜索</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <div class="grid gap-4 sm:grid-cols-2">
        <UCard v-for="item in data?.items" :key="item.id">
          <h3 class="font-semibold">{{ item.title }}</h3>
          <p
            class="mt-2 text-xs text-text-muted">{{ item.is_shared ? `引用自 ${item.source_domain_slug}` : '本域题单' }} · {{ { private: '作者／管理者', unlisted: '持有链接', public: '公开展示' }[item.visibility] }}</p>
          <UButton class="mt-3" variant="outline" :to="workspacePath(slug!, `trainings/${item.id}`)">查看题单</UButton>
        </UCard>
      </div>
      <PaginationNav :current-page="page" :total-pages="Math.ceil((data?.total ?? 0) / 20)"
        @page-change="page = $event" />
    </AsyncContent>
  </div>
</template>
