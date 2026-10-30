<script setup lang="ts">
import { workspaceCacheKey, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, domain, can } = useWorkspace(),
  { user } = useAuth(),
  api = useDomainResources(),
  capture = useWorkspaceActionScope(),
  { dialog } = useDialog();
const page = ref(1),
  entered = ref(''),
  keyword = ref(''),
  source = ref(''),
  importing = ref(false),
  failure = ref(''),
  selectedId = ref<string | null>(null),
  generation = ref(0);
const { data, error, status, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'problem-bindings', String(page.value), keyword.value),
  () => api.bindings(slug.value!, page.value, keyword.value),
);
const selected = computed(() => data.value?.items.find((item) => item.binding_id === selectedId.value));
function search() {
  page.value = 1;
  selectedId.value = null;
  keyword.value = entered.value.trim();
}
async function reload() {
  if (!await dialog.confirm('重新读取会替换当前未保存的题库配置，是否继续？')) return;
  await refresh();
  generation.value++;
}
async function imported() {
  if (importing.value || !source.value.trim()) return;
  const scope = capture();
  importing.value = true;
  failure.value = '';
  try {
    await api.importProblem(scope.slug, source.value.trim());
    if (scope.isCurrent()) {
      source.value = '';
      await refresh();
    }
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) importing.value = false;
  }
}
useSeoMeta({ title: '域题库资源管理' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="题库资源管理" description="本域统一题库；跨域复用生成独立题目与发布版本">
      <template #actions>
        <UButton variant="outline" @click="reload">重新读取</UButton>
        <UButton :to="`/d/${slug}/problems`" variant="outline">浏览题库</UButton>
      </template>
    </AdminPageHeader>
    <UCard v-if="domain?.status === 'active' && (can('problem:import') || can('problem:create'))">
      <h3 class="mb-3 font-semibold">复制其他域题目</h3>
      <p
        class="mb-3 text-xs text-text-muted">填写来源题号，例如 main:1001。需具有源题编辑权限和目标域创建、发布权限。复制生成独立身份，后续内容、成绩与配置各自管理。</p>
      <div class="flex gap-2">
        <UInput v-model="source" placeholder="main:1001" class="grow" @keydown.enter.prevent="imported" />
        <UButton :loading="importing" :disabled="!source.trim()" @click="imported">复制到本域</UButton>
      </div>
      <UAlert v-if="failure" class="mt-3" color="error" :title="failure" />
      <div class="mt-5 border-t border-border pt-5">
        <ClientOnly>
          <DomainSharedCatalog :slug="slug!" kind="problem" @imported="refresh()" />
        </ClientOnly>
      </div>
    </UCard>
    <div class="flex gap-2">
      <UInput v-model="entered" placeholder="搜索资源名称" class="grow" @keydown.enter.prevent="search" />
      <UButton variant="outline" @click="search">搜索</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)]">
        <div>
          <UCard v-for="item in data?.items" :key="item.binding_id" class="mb-3">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3
                  class="font-semibold"><span class="mr-2 font-mono">{{ item.reference.display_ref }}</span>{{ item.title ?? '源资源不可用' }}</h3>
                <p
                  class="mt-2 text-xs text-text-muted">{{ item.kind === 'owned' ? '本域源题' : `来源 ${item.reference.source_domain_slug}` }} · {{ item.effective_version_mode }} · {{ item.disabled_at ? '已下架' : item.resource_available ? '可用' : '资源不可用' }}</p>
              </div>
              <UButton variant="outline" size="sm" @click="selectedId = item.binding_id">配置</UButton>
            </div>
            <UButton v-if="item.resource_available" class="mt-3" variant="ghost" size="sm"
              :to="workspaceProblemPath(slug!, item.reference.display_ref)">本域作答</UButton>
          </UCard>
          <PaginationNav :current-page="page" :total-pages="Math.ceil((data?.total ?? 0) / 20)"
            @page-change="page = $event" />
        </div>
        <UCard v-if="selected" :key="`${selected.binding_id}:${selected.revision}:${generation}`" class="space-y-5">
          <h2 class="font-semibold">{{ selected.reference.display_ref }} · 本域配置</h2>
          <UButton v-if="selected.can_edit && selected.kind === 'owned'"
            :to="`/d/${slug}/editor/${selected.reference.number}`" variant="outline">编辑源题草稿</UButton>
          <ClientOnly>
            <DomainProblemBindingEditor :slug="slug!" :initial="selected" :writable="domain?.status === 'active'"
              :can-policy="selected.can_manage_policy" @saved="refresh()" />
          </ClientOnly>
        </UCard>
        <p v-else class="text-sm text-text-muted">选择一道题目管理版本策略和上下架状态。</p>
      </div>
    </AsyncContent>
  </div>
</template>
