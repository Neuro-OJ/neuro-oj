<script setup lang="ts">
import type { DomainEditorContent, DomainOiRuntime } from '~/utils/domain-problem-editor';
import { domainEditorPayload } from '~/utils/domain-problem-editor';
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<
  { slug: string; reference: string; content: DomainEditorContent; revision: number; writable: boolean; dirty: boolean }
>();
const emit = defineEmits<
  { saved: [revision: number, content: DomainEditorContent]; state: [dirty: boolean, busy: boolean] }
>();
const api = useDomainProblemEditor(), capture = useWorkspaceActionScope(), { user } = useAuth();
const key = computed(() => workspaceCacheKey(props.slug, user.value?.id ?? null, 'oi-author-files', props.reference));
const { data, error, refresh } = await useAsyncData(key, () => api.oiFiles(props.slug, props.reference));
const pending = ref<Array<{ file: File; path: string }>>([]),
  removed = ref<string[]>([]),
  changes = ref<Record<string, string>>({});
const selectedPath = ref(''),
  text = ref(''),
  editable = ref(false),
  loading = ref(false),
  saving = ref(false),
  failure = ref('');
watch(
  () =>
    [
      pending.value.length > 0 || removed.value.length > 0 || Object.keys(changes.value).length > 0,
      saving.value,
    ] as const,
  ([dirty, busy]) => emit('state', dirty, busy),
  { immediate: true },
);
const available = computed(() => data.value?.data.files.filter((file) => !removed.value.includes(file.path)) ?? []);
function upload(event: Event) {
  for (const file of Array.from((event.target as HTMLInputElement).files ?? [])) {
    pending.value.push({ file, path: `testdata/${file.name}` });
  }
  (event.target as HTMLInputElement).value = '';
}
async function preview(path: string) {
  const scope = capture();
  loading.value = true;
  failure.value = '';
  editable.value = false;
  try {
    const response = await api.oiFile(scope.slug, props.reference, path);
    if (!scope.isCurrent()) return;
    selectedPath.value = path;
    text.value = changes.value[path] ?? response.data.text ?? '';
    editable.value = response.data.text !== null && !response.data.truncated;
    if (!editable.value) failure.value = '此文件为二进制或超过文本编辑上限，请上传替换';
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) loading.value = false;
  }
}
async function save() {
  if (saving.value || !props.writable || props.dirty) return;
  const scope = capture(), content = domainEditorPayload(props.content), body = new FormData();
  body.set(
    'metadata',
    JSON.stringify({
      content,
      changes: changes.value,
      removed: removed.value,
      upload_paths: pending.value.map((item) => item.path),
    }),
  );
  for (const item of pending.value) body.append('data_files', item.file);
  saving.value = true;
  failure.value = '';
  try {
    const response = await api.oiSave(scope.slug, props.reference, props.revision, body);
    if (!scope.isCurrent()) return;
    pending.value = [];
    removed.value = [];
    changes.value = {};
    emit('saved', response.data.draft_revision, content);
    await refresh();
  } catch (error) {
    if (scope.isCurrent()) failure.value = `${extractApiError(error).message}。本地文件修改保留。`;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
const pairPreview = ref<Array<{ input: string; output: string }>>([]);
function pair() {
  const paths = new Set([...available.value.map((item) => item.path), ...pending.value.map((item) => item.path)]);
  pairPreview.value = [...paths].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).filter((path) =>
    path.endsWith('.in')
  ).flatMap((input) => {
    const stem = input.slice(0, -3),
      output = paths.has(`${stem}.out`) ? `${stem}.out` : paths.has(`${stem}.ans`) ? `${stem}.ans` : null;
    return output ? [{ input, output }] : [];
  });
}
function applyPairs() {
  const runtime = props.content.runtime_config as DomainOiRuntime, task = runtime.subtasks[0];
  if (!task) return;
  const used = new Set(runtime.subtasks.flatMap((item) => item.cases.map((test) => test.input)));
  task.cases = task.cases.filter((item) => item.input || item.output);
  task.cases.push(
    ...pairPreview.value.filter((item) => !used.has(item.input)).map((item) => ({
      ...item,
      id: `case_${crypto.randomUUID()}`,
    })),
  );
  pairPreview.value = [];
}
</script>
<template>
  <section class="space-y-3">
    <h3 class="font-semibold">OI 数据文件</h3>
    <p
      class="text-xs text-text-muted">上传或替换输入、答案、checker 等文件；路径对应评测配置。文件操作会更新同一草稿，随后重新预检再发布。</p>
    <UAlert v-if="error" color="error" :title="extractApiError(error).message">
      <template #actions>
        <UButton @click="refresh()">重新读取文件</UButton>
      </template>
    </UAlert>
    <UAlert v-if="failure" color="error" :title="failure" />
    <UAlert v-if="dirty" color="info" title="请先保存当前内容配置，再提交文件修改" />
    <input type="file" multiple :disabled="!writable || saving" aria-label="选择 OI 数据文件" @change="upload" />
    <div v-for="(item, index) in pending" :key="index"
      class="flex flex-wrap items-center gap-3"><span class="text-sm">{{ item.file.name }}</span><UInput v-model="item.path" :disabled="!writable || saving" aria-label="目标数据文件路径" /><UButton variant="ghost" color="error" :disabled="!writable || saving" @click="pending.splice(index, 1)">取消上传</UButton></div>
    <div class="max-h-56 space-y-2 overflow-auto">
      <div v-for="item in available" :key="item.path"
        class="flex flex-wrap justify-between gap-3 text-sm"><UButton variant="ghost" class="font-mono" :loading="loading && selectedPath === item.path" @click="preview(item.path)">{{ item.path }}</UButton><span class="text-xs tabular-nums text-text-muted">{{ item.size }} 字节</span><UButton color="error" variant="ghost" :disabled="!writable || saving" @click="removed.push(item.path)">删除文件</UButton></div>
    </div>
    <ClientOnly v-if="selectedPath && editable">
      <p class="text-xs font-mono">{{ selectedPath }}</p>
      <MonacoEditor v-model="text" language="plaintext" :min-height="220" :disabled="!writable || saving"
        @update:model-value="value => changes[selectedPath] = value" />
    </ClientOnly>
    <div class="flex flex-wrap gap-3">
      <UButton :loading="saving"
        :disabled="!writable || dirty || (!pending.length && !removed.length && !Object.keys(changes).length)"
        @click="save">保存数据文件修改</UButton>
      <UButton variant="outline" :disabled="!writable || saving" @click="pair">输入／答案配对预览</UButton>
    </div>
    <UCard v-if="pairPreview.length">
      <p class="mb-2 text-sm">以下配对将补入第一个子任务；配置仍需保存。</p>
      <p v-for="item in pairPreview" :key="item.input"
        class="text-xs font-mono">{{ item.input }} → {{ item.output }}</p>
      <UButton class="mt-3" :disabled="!writable || saving" @click="applyPairs">应用配对</UButton>
    </UCard>
  </section>
</template>
