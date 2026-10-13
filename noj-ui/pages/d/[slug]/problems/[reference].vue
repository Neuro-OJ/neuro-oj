<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute();
const { slug } = useWorkspace();
const { user } = useAuth();
const api = useDomainProblems();
const reference = computed(() => String(route.params.reference));
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'problem', reference.value));
const { data, status, error, refresh } = await useAsyncData(key, () => api.detail(slug.value!, reference.value));
const showVersions = ref(false);
watch(() => [slug.value, reference.value, user.value?.id], () => {
  showVersions.value = false;
});
useSeoMeta({ title: () => data.value?.content.title ?? '题目' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-5">
      <div class="flex items-start justify-between gap-3">
        <h2
          class="text-xl font-semibold"><span class="font-mono text-primary">{{ data.reference.display_ref }}</span> {{ data.content.title }}</h2>
        <div class="flex items-center gap-2">
          <UBadge variant="subtle">V{{ data.version }}</UBadge>
          <UButton variant="ghost" color="neutral"
            @click="showVersions = !showVersions">{{ showVersions ? '收起沿革' : '版本沿革' }}</UButton>
        </div>
      </div>
      <UCard>
        <MarkdownRenderer :content="data.content.description" />
      </UCard>
      <UCard v-for="(sample, index) in data.content.samples" :key="index">
        <h3 class="mb-3 font-semibold">样例 {{ index + 1 }}</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <pre class="overflow-auto rounded bg-bg-sunken p-3">{{ sample.input }}</pre>
          <pre class="overflow-auto rounded bg-bg-sunken p-3">{{ sample.output }}</pre>
        </div>
      </UCard>
      <DomainProblemAnswer :key="`${slug}:${reference}:${user?.id}`" :slug="slug!" :problem="data"
        @refresh="refresh()" />
      <DomainProblemVersions v-if="showVersions" :key="`${slug}:${reference}:${user?.id}:versions`" :slug="slug!"
        :reference="reference" />
    </div>
  </AsyncContent>
</template>
