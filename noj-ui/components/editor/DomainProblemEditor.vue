<script setup lang="ts">
import type { ProblemDraftView, PublishPreflightReport } from '~/composables/useProblemVersions';
import type { DomainEditorContent, DomainOiRuntime } from '~/utils/domain-problem-editor';
import { domainEditorPayload, normalizeDomainEditorContent } from '~/utils/domain-problem-editor';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<
  { slug: string; reference: string; draft: ProblemDraftView; writable: boolean; canPublish: boolean }
>();
const emit = defineEmits<{ reload: [] }>();
const api = useDomainProblemEditor(), capture = useWorkspaceActionScope(), { dialog } = useDialog();
const form = ref(normalizeDomainEditorContent(props.draft.content));
const revision = ref(props.draft.revision), busy = ref(''), failure = ref(''), savedMessage = ref('');
const publishedVersion = ref<number | null>(null), report = ref<PublishPreflightReport | null>(null);
const saved = ref(JSON.stringify(domainEditorPayload(form.value)));
const dirty = computed(() => JSON.stringify(domainEditorPayload(form.value)) !== saved.value);
const fileDirty = ref(false),
  fileBusy = ref(false),
  questionEditing = ref(false),
  bundle = shallowRef<File | null>(null);
function fileState(dirty: boolean, busy: boolean) {
  fileDirty.value = dirty;
  fileBusy.value = busy;
}
function selectBundle(event: Event) {
  bundle.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}
async function importBundle() {
  if (!bundle.value || busy.value || fileBusy.value || !props.writable) return;
  const scope = capture();
  if (
    !await dialog.confirm('题包将替换服务器草稿内容和支持文件。当前未保存修改会被替换；已发布版本保持不变。', {
      title: '导入题包到草稿',
    }) || !scope.isCurrent()
  ) return;
  const body = new FormData();
  body.set('file', bundle.value);
  busy.value = 'import';
  failure.value = '';
  try {
    await api.importBundle(scope.slug, props.reference, revision.value, body);
    if (!scope.isCurrent()) return;
    emit('reload');
  } catch (error) {
    if (scope.isCurrent()) {
      failure.value = `${extractApiError(error).message}。当前输入已保留。`;
      busy.value = '';
    }
  }
}
const oiRuntime = computed({
  get: () => form.value.runtime_config as DomainOiRuntime,
  set: (value: DomainOiRuntime) => {
    form.value.runtime_config = value;
  },
});
const questions = computed({
  get: () => form.value.questions ?? [],
  set: (value) => {
    form.value.questions = value;
  },
});
function filesSaved(nextRevision: number, content: DomainEditorContent) {
  revision.value = nextRevision;
  saved.value = JSON.stringify(content);
  report.value = null;
  savedMessage.value = '数据文件已保存，请重新预检';
}
watch(form, () => {
  report.value = null;
  savedMessage.value = '';
}, { deep: true });
async function save() {
  if (!props.writable || busy.value || fileBusy.value || questionEditing.value) return;
  const scope = capture(), reference = props.reference, content = domainEditorPayload(form.value);
  busy.value = 'save';
  failure.value = '';
  try {
    const response = await api.save(scope.slug, reference, content, revision.value);
    if (!scope.isCurrent() || props.reference !== reference) return;
    revision.value = response.revision;
    saved.value = JSON.stringify(content);
    report.value = null;
    savedMessage.value = '草稿已保存，作答版本尚未改变';
  } catch (error) {
    if (scope.isCurrent()) failure.value = `${extractApiError(error).message}。当前输入已保留。`;
  } finally {
    if (scope.isCurrent()) busy.value = '';
  }
}
async function preflight() {
  if (busy.value || fileBusy.value || dirty.value || fileDirty.value || questionEditing.value || !props.canPublish) {
    return;
  }
  const scope = capture(), reference = props.reference;
  busy.value = 'preflight';
  failure.value = '';
  try {
    const response = await api.preflight(scope.slug, reference, revision.value);
    if (scope.isCurrent() && props.reference === reference) report.value = response;
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) busy.value = '';
  }
}
const changeNote = ref('');
async function publish() {
  if (
    busy.value || fileBusy.value || dirty.value || fileDirty.value || questionEditing.value || !report.value?.ready ||
    report.value.revision !== revision.value || !props.canPublish
  ) return;
  const scope = capture(), reference = props.reference;
  if (
    !await dialog.confirm('发布这份已保存草稿为新的不可变版本？已有版本和提交会保留。', { title: '发布题目版本' }) ||
    !scope.isCurrent()
  ) return;
  busy.value = 'publish';
  failure.value = '';
  try {
    const response = await api.publish(scope.slug, reference, revision.value, changeNote.value);
    if (!scope.isCurrent() || props.reference !== reference) return;
    revision.value = response.draft_revision;
    publishedVersion.value = response.version;
    report.value = null;
    savedMessage.value = response.unchanged ? `内容未变化，仍为 V${response.version}` : `已发布 V${response.version}`;
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) busy.value = '';
  }
}
async function reload() {
  if (
    !(dirty.value || fileDirty.value || questionEditing.value) ||
    await dialog.confirm('重新读取服务器草稿？未保存的表单和文件修改将被替换。', { title: '重新读取草稿' })
  ) emit('reload');
}
onBeforeRouteLeave(async () =>
  !(dirty.value || fileDirty.value || questionEditing.value) ||
  await dialog.confirm('离开编辑器？当前表单或文件修改尚未保存。', { title: '未保存的草稿修改' })
);
</script>
<template>
  <div class="space-y-5">
    <div class="flex flex-wrap justify-between gap-3">
      <h2 class="text-xl font-semibold">{{ reference }} · 编辑草稿</h2>
      <div class="flex gap-2">
        <UButton variant="outline" :disabled="!!busy" @click="reload">重新读取</UButton>
        <UButton v-if="draft.base_version_id || publishedVersion" :to="`/d/${slug}/problems/${reference}`"
          variant="outline">查看作答题面</UButton>
      </div>
    </div>
    <UAlert v-if="failure" color="error" :title="failure" />
    <UAlert v-if="savedMessage" color="success" :title="savedMessage" />
    <UAlert v-if="!writable" color="warning" title="当前域只可读取，无法写入草稿或发布" />
    <UCard v-if="writable">
      <h3 class="font-semibold mb-2">从题包恢复草稿</h3>
      <p
        class="text-xs text-text-muted mb-3">上传题包 ZIP，恢复题面、评测配置和支持文件。导入后重新检查内容、预检并显式发布。</p>
      <div class="flex flex-wrap items-center gap-3">
        <input type="file" accept=".zip,application/zip" aria-label="选择题包 ZIP" :disabled="!!busy || fileBusy"
          @change="selectBundle" />
        <UButton variant="outline" :loading="busy === 'import'" :disabled="!bundle || !!busy || fileBusy"
          @click="importBundle">导入到草稿</UButton>
      </div>
    </UCard>
    <fieldset :disabled="!!busy || !writable" class="space-y-5">
      <UCard>
        <AdminFormField label="题目标题" required>
          <UInput v-model="form.title" class="w-full" />
        </AdminFormField>
        <AdminFormField label="题面" class="mt-4">
          <MarkdownEditor v-model="form.description" />
        </AdminFormField>
        <div class="mt-4">
          <ProblemSampleEditor v-model="form.samples" v-model:statement="form.description" />
        </div>
      </UCard>
      <UCard v-if="form.kind === 'objective'">
        <DomainObjectiveQuestions v-model="questions" @editing="questionEditing = $event" />
        <p v-if="questionEditing"
          class="mt-3 text-xs text-text-muted">请先保存或取消正在编辑的小题，再保存整份草稿。</p>
      </UCard>
      <UCard v-else-if="form.kind === 'oi'">
        <DomainOiRuntime v-model="oiRuntime" />
        <div class="mt-5 border-t border-border pt-5">
          <DomainOiFiles :slug="slug" :reference="reference" :content="form" :revision="revision"
            :writable="writable && !busy" :dirty="dirty" @saved="filesSaved" @state="fileState" />
        </div>
      </UCard>
      <UCard v-else>
        <DomainAiRuntime v-model="form" :published="!!draft.base_version_id || publishedVersion !== null" />
      </UCard>
    </fieldset>
    <div
      class="flex flex-wrap items-center gap-3"><UButton :loading="busy === 'save'" :disabled="!writable || !!busy || fileBusy || questionEditing || !form.title.trim()" @click="save">保存草稿</UButton><UButton v-if="canPublish" variant="outline" :loading="busy === 'preflight'" :disabled="!writable || !!busy || fileBusy || dirty || fileDirty || questionEditing" @click="preflight">发布预检</UButton><span class="text-xs text-text-muted">{{ dirty || fileDirty || questionEditing ? '有未保存修改' : '草稿已保存' }}</span></div>
    <UCard v-if="report" class="space-y-3">
      <h3 class="font-semibold">发布预检</h3>
      <UAlert :color="report.ready ? 'success' : 'warning'"
        :title="report.ready ? '草稿已通过发布预检' : '请处理以下问题后重新预检'" />
      <ul class="space-y-2 text-sm">
        <li v-for="issue in report.errors" :key="`${issue.code}:${issue.path}`"
          class="text-error-text">{{ issue.message }} {{ issue.path ?? '' }}</li>
        <li v-for="issue in report.warnings" :key="`${issue.code}:${issue.path}`"
          class="text-warning-text">{{ issue.message }} {{ issue.path ?? '' }}</li>
      </ul>
      <p class="text-xs text-text-muted">{{ report.files.length }} 个文件引用；预检后继续修改需要重新保存并检查。</p>
      <UTextarea v-model="changeNote" aria-label="版本发布说明" placeholder="向维护者和作答者说明本次变化" />
      <UButton :loading="busy === 'publish'"
        :disabled="!report.ready || !writable || !!busy || fileBusy || dirty || fileDirty || questionEditing"
        @click="publish">发布版本</UButton>
    </UCard>
  </div>
</template>
