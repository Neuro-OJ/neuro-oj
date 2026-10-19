<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';

const props = defineProps<{ slug: string; submissionId: string; code?: string | null; fileName?: string | null }>();
const api = useAnnotationsApi(), { user } = useAuth();
const expanded = ref(!!props.code), file = ref(props.code ? props.fileName ?? 'solution' : '');
const start = ref(1), end = ref(1), surface = ref<{ annotateRange: (value: { block_id: string; start: number; end: number }) => void } | null>(null);
const key = computed(() => workspaceCacheKey(props.slug, user.value?.id ?? null, 'annotation-code', props.submissionId));
const files = await useAsyncData(() => `${key.value}:files:${expanded.value}`, () => expanded.value && !props.code
  ? api.files(props.slug, props.submissionId) : Promise.resolve(null));
watch(files.data, (value) => { if (value?.data.submission_id === props.submissionId && !value.data.files.some(f => f.file_name === file.value)) file.value = value.data.files[0]?.file_name ?? ''; });
const source = await useAsyncData(() => `${key.value}:file:${file.value}:${expanded.value}`, () => expanded.value && file.value && !props.code
  ? api.source(props.slug, { kind: 'submission', submission_id: props.submissionId, file_name: file.value }) : Promise.resolve(null));
const text = computed(() => props.code ?? (!source.error.value && source.data.value?.data.target.kind === 'submission' && source.data.value.data.target.file_name === file.value ? source.data.value.data.blocks[0]?.text : undefined));
const lines = computed(() => (text.value ?? '').replace(/\r\n|\r/g, '\n').split('\n'));
const target = computed(() => ({ kind: 'submission' as const, submission_id: props.submissionId, file_name: file.value }));
function annotateLines() {
  if (!Number.isSafeInteger(start.value) || !Number.isSafeInteger(end.value) || start.value < 1 || end.value < start.value || end.value > lines.value.length) return;
  const from = start.value === 1 ? 0 : lines.value.slice(0, start.value - 1).join('\n').length + 1;
  const to = lines.value.slice(0, end.value).join('\n').length;
  surface.value?.annotateRange({ block_id: 'file', start: from, end: to });
}
watch([() => props.slug, () => props.submissionId, () => user.value?.id], () => { expanded.value = !!props.code; file.value = props.code ? props.fileName ?? 'solution' : ''; start.value = end.value = 1; });
watch(file, () => { start.value = end.value = 1; });
</script>
<template>
  <section class="min-w-0 space-y-3" aria-label="提交文件与批注">
    <UButton v-if="!expanded" variant="outline" icon="i-lucide-files" @click="expanded = true">查看提交文件并批注</UButton>
    <template v-else>
      <UAlert v-if="files.error.value || source.error.value" color="error" :title="extractApiError(files.error.value || source.error.value).message"><template #actions><UButton variant="outline" @click="files.refresh(); source.refresh()">重新读取</UButton></template></UAlert>
      <USelect v-if="files.data.value?.data.files.length" v-model="file" :items="files.data.value.data.files.map(f => ({ value: f.file_name, label: f.file_name }))" aria-label="提交文件" class="w-full" />
      <p v-if="(files.status.value === 'pending' || source.status.value === 'pending') && text === undefined" role="status" class="text-sm text-text-muted">正在读取授权的提交文件…</p>
      <AnnotationSurface v-if="file && text !== undefined" :key="`${key}:${file}`" ref="surface" :slug="slug" :target="target">
        <pre class="max-h-[32rem] select-text overflow-auto rounded border border-border bg-bg-sunken p-3 font-mono text-xs leading-relaxed">{{ text }}</pre>
        <form class="mt-3 flex flex-wrap items-center gap-2" @submit.prevent="annotateLines">
          <span class="text-xs text-text-muted tabular-nums">共 {{ lines.length }} 行</span>
          <UInput v-model.number="start" type="number" :min="1" :max="lines.length" aria-label="批注起始行" class="w-24" />
          <span class="text-xs text-text-muted">至</span>
          <UInput v-model.number="end" type="number" :min="start" :max="lines.length" aria-label="批注结束行" class="w-24" />
          <UButton type="submit" variant="outline" size="sm" :disabled="start < 1 || end < start || end > lines.length">批注选中行</UButton>
        </form>
      </AnnotationSurface>
      <p v-else-if="files.data.value && !files.data.value.data.files.length" class="text-sm text-text-muted">没有可在线预览的文本文件。支持 UTF-8 源码与不超过 64 MiB 的 ZIP 产物，单文件不超过 1 MiB。</p>
    </template>
  </section>
</template>
