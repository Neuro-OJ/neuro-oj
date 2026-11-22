<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug, domain, can } = useWorkspace(), { user } = useAuth(), api = useDomainProblemEditor();
const reference = computed(() => String(route.params.reference)), generation = ref(0);
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'problem-draft', reference.value));
const { data, status, error, refresh } = await useAsyncData(key, () => api.draft(slug.value!, reference.value));
async function reload() {
  await refresh();
  if (!error.value) generation.value++;
}
useSeoMeta({ title: '域题目草稿编辑' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="reload()">
    <DomainProblemEditor v-if="data" :key="`${key}:${generation}`" :slug="slug!" :reference="reference" :draft="data"
      :writable="domain?.status === 'active'" :can-publish="can('problem:publish')" @reload="reload" />
  </AsyncContent>
</template>
