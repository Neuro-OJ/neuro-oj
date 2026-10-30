<script setup lang="ts">
import type { SharedResourceOption } from '~/composables/useDomainResources';
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; kind: 'problem' | 'training' }>();
const emit = defineEmits<{ imported: [] }>();
const api = useDomainResources(),
  trainings = useDomainTrainings(),
  capture = useWorkspaceActionScope(),
  { user } = useAuth();
const page = ref(1),
  source = ref(''),
  keyword = ref(''),
  enteredSource = ref(''),
  enteredKeyword = ref(''),
  importing = ref(''),
  failure = ref('');
const { data, status, error, refresh } = await useAsyncData(
  () =>
    workspaceCacheKey(
      props.slug,
      user.value?.id ?? null,
      `shared-catalog:${props.kind}`,
      JSON.stringify([source.value, keyword.value]),
      String(page.value),
    ),
  () => api.discover(props.slug, props.kind, page.value, source.value, keyword.value),
);
function search() {
  page.value = 1;
  source.value = enteredSource.value.trim();
  keyword.value = enteredKeyword.value.trim();
}
async function importResource(item: SharedResourceOption) {
  if (importing.value) return;
  const scope = capture(), reference = props.kind === 'problem' ? item.reference!.qualified_ref : item.id!;
  importing.value = reference;
  failure.value = '';
  try {
    let copiedTraining: string | undefined;
    if (props.kind === 'problem') await api.importProblem(scope.slug, reference, item.version_id);
    else copiedTraining = (await trainings.import(scope.slug, reference)).data.training_id;
    if (!scope.isCurrent()) return;
    emit('imported');
    if (copiedTraining) await navigateTo(workspacePath(scope.slug, `trainings/${copiedTraining}`));
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) importing.value = '';
  }
}
</script>
<template>
  <section class="space-y-4">
    <h3 class="font-semibold">查找有权复制的{{ kind === 'problem' ? '题目' : '题单' }}</h3>
    <div class="flex flex-wrap gap-3">
      <UInput v-model="enteredSource" placeholder="来源域标识，留空表示所有来源" />
      <UInput v-model="enteredKeyword" placeholder="资源名称" class="grow" @keydown.enter.prevent="search" />
      <UButton type="button" variant="outline" @click="search">查找</UButton>
    </div>
    <UAlert v-if="failure" color="error" :title="failure" />
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="没有符合条件且具有源编辑权限的资源"
      @retry="refresh()">
      <div class="max-h-80 divide-y divide-border overflow-auto">
        <div v-for="item in data?.items" :key="item.reference?.problem_id ?? item.id"
          class="flex items-center justify-between gap-3 py-3 text-sm">
          <div><span v-if="item.reference" class="mr-2 font-mono">{{ item.reference.qualified_ref }}</span>{{ item.title }}<p v-if="kind === 'training'" class="mt-1 text-xs text-text-muted">来源 {{ item.source_domain_slug }}</p></div>
          <UButton type="button" size="sm" :loading="importing === (item.reference?.qualified_ref ?? item.id)"
            :disabled="!!importing" @click="importResource(item)">复制到本域</UButton>
        </div>
      </div>
      <PaginationNav :current-page="page" :total-pages="Math.ceil((data?.total ?? 0) / 20)"
        @page-change="page = $event" />
    </AsyncContent>
  </section>
</template>
