<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { educationCacheKey } from '~/utils/education';
import type { LineAnnotation } from '~/utils/education';
const props = defineProps<{ slug: string; classroomId: string; submissionId: string; canAnnotate: boolean }>();
const education = useEducationApi();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const file = ref(''), page = ref(1), body = ref(''), start = ref(1), end = ref(1), saving = ref(false);
const operationKey = ref(crypto.randomUUID());
const capture = useWorkspaceActionScope();
const { dialog } = useDialog();
const editing = ref<LineAnnotation | null>(null), editBody = ref(''), mutationError = ref('');
const key = computed(() =>
  educationCacheKey(props.slug, actor.value?.id ?? null, props.classroomId, props.submissionId)
);
const files = await useAsyncData(
  () => `${key.value}:files`,
  () => education.files(props.slug, props.classroomId, props.submissionId),
);
const annotations = await useAsyncData(
  () => `${key.value}:annotations:${page.value}`,
  () => education.annotations(props.slug, props.classroomId, props.submissionId, page.value),
);
const text = await useAsyncData(
  () => `${key.value}:text:${file.value}`,
  () =>
    file.value ? education.text(props.slug, props.classroomId, props.submissionId, file.value) : Promise.resolve(null),
);
const fileOptions = computed(() =>
  files.data.value?.data.submission_id === props.submissionId
    ? files.data.value.data.files.map((f) => ({ label: f.file_name, value: f.file_name }))
    : []
);
watch(fileOptions, (options) => {
  if (!options.some((o) => o.value === file.value)) file.value = options[0]?.value ?? '';
}, { immediate: true });
watch([() => props.slug, () => props.classroomId, () => props.submissionId, () => actor.value?.id], () => {
  file.value = '';
  body.value = '';
  page.value = 1;
  operationKey.value = crypto.randomUUID();
  editing.value = null;
  editBody.value = mutationError.value = '';
});
watch([file, start, end, body], () => {
  operationKey.value = crypto.randomUUID();
});
const currentText = computed(() =>
  text.data.value?.data.submission_id === props.submissionId && text.data.value.data.file_name === file.value
    ? text.data.value.data
    : null
);
const comments = computed(() =>
  annotations.data.value?.data.data.filter((n) =>
    n.submission_id === props.submissionId && n.file_name === file.value
  ) ?? []
);
function edit(note: LineAnnotation) {
  editing.value = note;
  editBody.value = note.body;
  mutationError.value = '';
}
async function update(note: LineAnnotation, withdraw = false) {
  if (saving.value || !props.canAnnotate) return;
  const scope = capture(), id = props.submissionId, classroom = props.classroomId;
  if (withdraw && !await dialog.confirm('撤回这条批注？已保存的作者和修改记录仍会保留。', { title: '撤回行批注' })) {
    return;
  }
  if (!scope.isCurrent()) return;
  saving.value = true;
  mutationError.value = '';
  try {
    await education.updateAnnotation(
      scope.slug,
      classroom,
      id,
      note.id,
      note.revision,
      withdraw ? { withdraw: true } : { body: editBody.value },
    );
    if (!scope.isCurrent() || props.submissionId !== id || props.classroomId !== classroom) return;
    editing.value = null;
    await annotations.refresh();
  } catch (error) {
    if (scope.isCurrent() && props.submissionId === id) mutationError.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent() && props.submissionId === id) saving.value = false;
  }
}
async function annotate() {
  if (!currentText.value || saving.value) return;
  const scope = capture(), id = props.submissionId, classroom = props.classroomId;
  saving.value = true;
  try {
    await education.annotate(scope.slug, classroom, id, {
      file_name: currentText.value.file_name,
      source_hash: currentText.value.source_hash,
      start_line: Number(start.value),
      end_line: Number(end.value),
      body: body.value,
    }, operationKey.value);
    if (!scope.isCurrent() || props.submissionId !== id || props.classroomId !== classroom) return;
    body.value = '';
    operationKey.value = crypto.randomUUID();
    await annotations.refresh();
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <div class="space-y-4">
    <p class="break-all text-xs text-text-muted">原提交 {{ submissionId }} · 批注保留在这份代码上</p>
    <AsyncContent
      :status="files.error.value ? 'error' : files.status.value === 'pending' ? 'loading' : fileOptions.length ? 'data' : 'empty'"
      :error="files.error.value ? extractApiError(files.error.value).message : undefined"
      empty-text="没有可在线预览的文本文件" @retry="files.refresh()">
      <USelect v-model="file" :items="fileOptions" class="w-full" aria-label="预览文件" />
      <UAlert v-if="text.error.value" class="mt-3" color="error" :title="extractApiError(text.error.value).message" />
      <ol v-if="currentText"
        class="mt-3 max-h-96 overflow-auto rounded border border-border bg-bg-sunken p-3 font-mono text-xs"
        aria-label="原提交代码">
        <li v-for="(line, i) in currentText.text.split(/\r\n|\r|\n/)" :key="i" class="flex gap-3">
          <span class="w-8 shrink-0 select-none text-right text-text-muted tabular-nums">{{ i + 1 }}</span><span class="whitespace-pre">{{ line || ' ' }}</span>
        </li>
      </ol>
    </AsyncContent>
    <UAlert v-if="annotations.error.value" color="error" :title="extractApiError(annotations.error.value).message" />
    <UAlert v-if="mutationError" color="error" :title="mutationError" />
    <article v-for="note in comments" :key="note.id" class="rounded border border-border p-3">
      <p class="mb-2 text-xs text-text-muted">{{ note.author_name }} · {{ note.start_line }}–{{ note.end_line }} 行</p>
      <form v-if="editing?.id === note.id" class="space-y-3" @submit.prevent="update(note)">
        <UTextarea v-model="editBody" class="w-full" :maxlength="30000" aria-label="修改行批注正文" />
        <div class="flex gap-2">
          <UButton type="submit" :loading="saving" :disabled="!editBody.trim()">保存修改</UButton>
          <UButton variant="ghost" :disabled="saving" @click="editing = null">取消</UButton>
        </div>
      </form>
      <p v-else class="whitespace-pre-wrap text-sm">{{ note.body }}</p>
      <div v-if="canAnnotate && note.author_id === actor?.id && editing?.id !== note.id" class="mt-2 flex gap-2">
        <UButton size="xs" variant="ghost" :disabled="saving" @click="edit(note)">修改</UButton>
        <UButton size="xs" color="error" variant="ghost" :disabled="saving" @click="update(note, true)">撤回</UButton>
      </div>
      <p v-if="currentText && note.source_hash !== currentText.source_hash"
        class="mt-2 text-xs text-warning-text">此批注对应另一份文件内容，请按原提交依据核对。</p>
    </article>
    <div v-if="(annotations.data.value?.data.total ?? 0) > 50" class="flex items-center gap-3">
      <UButton :disabled="page <= 1" variant="outline" @click="page--">上一页</UButton><span class="text-sm tabular-nums">{{ page }}</span>
      <UButton :disabled="page * 50 >= (annotations.data.value?.data.total ?? 0)" variant="outline" @click="page++">下一页</UButton>
    </div>
    <form v-if="canAnnotate && currentText" class="space-y-3" @submit.prevent="annotate">
      <div class="flex gap-3">
        <AdminFormField label="起始行">
          <UInput v-model="start" type="number" :min="1" :max="currentText.line_count" aria-label="批注起始行" />
        </AdminFormField>
        <AdminFormField label="结束行">
          <UInput v-model="end" type="number" :min="start" :max="currentText.line_count" aria-label="批注结束行" />
        </AdminFormField>
      </div>
      <UTextarea v-model="body" class="w-full" :maxlength="30000" placeholder="针对这份代码留下反馈"
        aria-label="行批注正文" />
      <UButton type="submit" :loading="saving" :disabled="!body.trim()">保存行批注</UButton>
    </form>
  </div>
</template>
