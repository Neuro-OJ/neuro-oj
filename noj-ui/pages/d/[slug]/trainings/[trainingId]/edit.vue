<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(),
  { slug, domain } = useWorkspace(),
  { user } = useAuth(),
  api = useDomainTrainings(),
  { dialog } = useDialog();
const id = computed(() => String(route.params.trainingId)), generation = ref(0);
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'training-edit', id.value),
  () => api.detail(slug.value!, id.value),
);
async function reload() {
  if (!await dialog.confirm('重新读取会替换未保存的题单内容，是否继续？')) return;
  await refresh();
  if (!error.value) generation.value++;
}
useSeoMeta({ title: '编辑域题单' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="编辑题单">
      <template #actions>
        <UButton variant="outline" @click="reload">重新读取</UButton>
        <UButton :to="workspacePath(slug!, `trainings/${id}`)" variant="outline">返回题单</UButton>
      </template>
    </AdminPageHeader>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <ClientOnly v-if="data?.data.can_edit && domain?.status === 'active'">
        <DomainTrainingEditor :key="`${id}:${generation}`" :slug="slug!" :initial="data.data"
          @saved="saved => navigateTo(workspacePath(slug!, `trainings/${saved}`))" />
      </ClientOnly>
      <UAlert v-else color="warning" title="只能编辑当前域获授权源题单，引用题单内容由来源域管理" />
    </AsyncContent>
  </div>
</template>
