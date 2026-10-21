<script setup lang="ts">
import { workspaceCacheKey, workspacePath, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { BffEnvelope } from '~/utils/bff-view';
import type { TrainingView, TrainingViewItem } from '~/utils/domain-trainings';
import { useResourceRefresh } from '~/composables/useResourceRefresh';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute(), { slug, domain } = useWorkspace(), { user } = useAuth(), { api } = useApi();
const resources = useDomainResources(), capture = useWorkspaceActionScope();
const id = computed(() => String(route.params.trainingId));
const page = computed(() => Math.max(1, Number(route.query.page) || 1));
const importing = ref(''), failure = ref(''), sharingOpen = ref(false);
const resource = useResourceRefresh();
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'training-view', id.value, String(page.value)),
  (_app, { signal }) => api.get<BffEnvelope>(
    `/api/bff/v1/domains/${encodeURIComponent(slug.value!)}/trainings/${encodeURIComponent(id.value)}/overview`,
    { query: { page: page.value }, signal, silent: true },
  ).then((view) => view.sections.training?.data as unknown as { data: TrainingView }),
  {
    watch: [page, slug, id],
  },
);
const training = computed(() => data.value?.data.training);
const sharing = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'training-sharing', id.value, String(resource.generation.value)),
  () => sharingOpen.value && training.value?.can_share ? resources.sharing(slug.value!, 'training', id.value) : Promise.resolve(null),
  { watch: [sharingOpen, resource.generation] },
);
const solved = computed(() => data.value?.data.items.filter(item => item.progress === 'solved').length ?? 0);
const known = computed(() => data.value?.data.items.filter(item => item.progress != null).length ?? 0);
function progressLabel(item: TrainingViewItem) {
  if (!item.resource_available) return item.can_import ? '尚未引用' : '资源不可用';
  if (item.summary_error) return '信息暂不可用';
  if (!user.value) return '登录查看进度';
  return item.progress === 'solved' ? '已完成' : item.progress === 'attempted' ? '已尝试' : item.progress === 'unseen' ? '未作答' : '进度暂不可用';
}
function pageLink(value: number) {
  return { path: route.path, query: { ...route.query, page: value } };
}
async function importProblem(reference: string) {
  if (importing.value) return;
  const scope = capture();
  importing.value = reference;
  failure.value = '';
  try {
    await resources.importProblem(scope.slug, reference);
    if (scope.isCurrent()) await refresh();
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) importing.value = '';
  }
}
async function reloadSharing() {
  resource.begin();
  await sharing.refresh();
}
useSeoMeta({ title: () => training.value?.title ?? '题单' });
</script>
<template>
  <div class="space-y-6">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0">
        <NuxtLink :to="workspacePath(slug!, 'trainings')" class="mb-3 inline-flex items-center gap-1 text-sm text-text-secondary hover:text-primary"><UIcon name="i-lucide-arrow-left" class="size-4" />题单列表</NuxtLink>
        <h1 class="break-words text-2xl font-bold text-text">{{ training?.title ?? '题单' }}</h1>
        <p v-if="data" class="mt-2 text-sm text-text-secondary tabular-nums">共 {{ data.data.total }} 题<span v-if="training?.is_shared"> · 引用自 {{ training.source_domain_slug }}</span></p>
      </div>
      <UButton v-if="training?.can_edit && domain?.status === 'active'" :to="workspacePath(slug!, `trainings/${id}/edit`)" variant="outline">编辑题单</UButton>
    </header>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'" :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <div v-if="data && training" class="space-y-5">
        <section v-if="training.description" aria-label="题单说明" class="rounded border border-border bg-bg-panel p-5"><MarkdownRenderer :content="training.description" /></section>
        <section aria-labelledby="training-problems" class="overflow-hidden rounded border border-border bg-bg-panel">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-4">
            <h2 id="training-problems" class="font-semibold">题目</h2>
            <p v-if="user" class="text-sm text-text-secondary tabular-nums">本页已完成 {{ solved }} / {{ data.data.items.length }}<span v-if="known < data.data.items.length"> · {{ data.data.items.length - known }} 题进度未取得</span></p>
            <NuxtLink v-else :to="{ path: '/login', query: { redirect: route.fullPath } }" class="text-sm text-primary">登录查看个人进度</NuxtLink>
          </div>
          <UAlert v-if="failure" color="error" :title="failure" class="m-4" />
          <ol class="divide-y divide-border">
            <li v-for="item in data.data.items" :key="item.problem_id" class="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap">
              <span class="w-6 shrink-0 text-sm text-text-muted tabular-nums">{{ item.position + 1 }}</span>
              <div class="min-w-0 flex-1 basis-[65%]">
                <NuxtLink v-if="item.binding_id && item.resource_available" :to="workspaceProblemPath(slug!, item.display_ref)" class="block break-words font-medium text-text hover:text-primary">{{ item.title ?? `题目 ${item.display_ref}` }}</NuxtLink>
                <p v-else class="break-words font-medium">{{ item.title ?? `题目 ${item.display_ref}` }}</p>
                <p class="mt-1 text-xs text-text-secondary"><span class="font-mono">{{ item.display_ref }}</span><span v-if="item.kind"> · {{ item.kind === 'oi' ? 'OI 题' : item.kind === 'objective' ? '客观题' : 'AI 题' }}</span></p>
              </div>
              <span class="text-sm" :class="item.progress === 'solved' ? 'text-signal-deep' : 'text-text-secondary'">{{ progressLabel(item) }}</span>
              <UButton v-if="item.binding_id && item.resource_available" :to="workspaceProblemPath(slug!, item.display_ref)" variant="outline" class="ml-auto min-h-11 shrink-0">{{ item.progress === 'solved' ? '再次练习' : '继续作答' }}</UButton>
              <UButton v-else-if="domain?.status === 'active' && item.can_import" :loading="importing === item.qualified_ref" :disabled="!!importing" @click="importProblem(item.qualified_ref)">引用题目到当前域</UButton>
            </li>
          </ol>
          <p v-if="!data.data.items.length" class="px-4 py-10 text-center text-text-secondary">{{ data.data.total ? '本页没有题目，请返回上一页。' : '题单还没有题目。' }}</p>
          <nav v-if="data.data.total > 20" aria-label="题单分页" class="flex items-center justify-between gap-3 border-t border-border p-4">
            <UButton :to="pageLink(Math.max(1, page - 1))" :disabled="page <= 1" variant="outline">上一页</UButton>
            <span class="text-sm text-text-secondary tabular-nums">{{ page }} / {{ Math.ceil(data.data.total / 20) }}</span>
            <UButton :to="pageLink(page + 1)" :disabled="page * 20 >= data.data.total" variant="outline">下一页</UButton>
          </nav>
        </section>
        <section v-if="training.can_share" class="rounded border border-border bg-bg-panel p-4">
          <UButton variant="ghost" :aria-expanded="sharingOpen" @click="sharingOpen = !sharingOpen">{{ sharingOpen ? '收起共享设置' : '管理共享设置' }}</UButton>
          <div v-if="sharingOpen" class="mt-4 space-y-3">
            <UButton variant="outline" size="sm" @click="reloadSharing">重新读取共享政策</UButton>
            <UAlert v-if="sharing.error.value" color="error" :title="extractApiError(sharing.error.value).message" />
            <DomainSharingForm v-if="sharing.data.value" :key="`share:${id}:${resource.generation.value}`" :slug="slug!" kind="training" :reference="id" :initial="sharing.data.value.data" :writable="domain?.status === 'active'" />
          </div>
        </section>
      </div>
    </AsyncContent>
  </div>
</template>
