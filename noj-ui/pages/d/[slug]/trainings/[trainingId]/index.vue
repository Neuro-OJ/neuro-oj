<script setup lang="ts">
import { workspaceCacheKey, workspacePath, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute(),
  { slug, domain } = useWorkspace(),
  { user } = useAuth(),
  api = useDomainTrainings(),
  resources = useDomainResources(),
  capture = useWorkspaceActionScope();
const id = computed(() => String(route.params.trainingId)), importing = ref(''), failure = ref(''), generation = ref(0);
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'training-detail', id.value),
  () => api.detail(slug.value!, id.value),
);
const sharing = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'training-sharing', id.value, String(generation.value)),
  () => data.value?.data.can_share ? resources.sharing(slug.value!, 'training', id.value) : Promise.resolve(null),
);
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
  generation.value++;
  await sharing.refresh();
}
useSeoMeta({ title: () => data.value?.data.title ?? '域题单' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader :title="data?.data.title ?? '题单'">
      <template #actions>
        <UButton :to="workspacePath(slug!, 'trainings')" variant="outline">题单列表</UButton>
        <UButton v-if="data?.data.can_edit && domain?.status === 'active'"
          :to="workspacePath(slug!, `trainings/${id}/edit`)" variant="outline">编辑题单</UButton>
      </template>
    </AdminPageHeader>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <template v-if="data">
        <UCard>
          <p v-if="data.data.is_shared"
            class="mb-3 text-xs text-text-muted">引用自 {{ data.data.source_domain_slug }}；当前使用域 {{ slug }}，题目集合随源题单更新。</p>
          <MarkdownRenderer :content="data.data.description" />
        </UCard>
        <UAlert v-if="failure" color="error" :title="failure" />
        <UCard v-for="item in data.data.items" :key="item.problem_id">
          <div
            class="flex flex-wrap items-center justify-between gap-3"><span class="font-mono">{{ item.position + 1 }}. {{ item.display_ref }}</span><UButton v-if="item.binding_id && item.resource_available" :to="workspaceProblemPath(slug!, item.display_ref)" variant="outline">在当前域作答</UButton><UButton v-else-if="domain?.status === 'active' && item.can_import" :loading="importing === item.qualified_ref" :disabled="!!importing" @click="importProblem(item.qualified_ref)">引用题目到当前域</UButton><span v-else class="text-xs text-text-muted">当前无法在本域作答，请联系域资源管理者</span></div>
        </UCard>
        <UCard v-if="data.data.can_share" class="space-y-3">
          <UButton variant="outline" size="sm" @click="reloadSharing">重新读取共享政策</UButton>
          <UAlert v-if="sharing.error.value" color="error" :title="extractApiError(sharing.error.value).message" />
          <DomainSharingForm v-if="sharing.data.value" :key="`share:${id}:${generation}`" :slug="slug!" kind="training"
            :reference="id" :initial="sharing.data.value.data" :writable="domain?.status === 'active'" />
        </UCard>
      </template>
    </AsyncContent>
  </div>
</template>
