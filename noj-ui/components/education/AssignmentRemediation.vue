<script setup lang="ts">
import type { AssignmentDetail } from '~/utils/education';
import type { AssignmentRemediationPreview, RemediationSelectionInput } from '~/utils/education-remediation-preview';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; task: AssignmentDetail; writable: boolean; canReadProgress: boolean }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const open = ref(false), scope = ref<'on_time' | 'current'>('current');
const preview = ref<AssignmentRemediationPreview | null>(null),
  loading = ref(false),
  saving = ref(false),
  error = ref('');
let request = 0, submittedBody = '', idempotencyKey = crypto.randomUUID();
async function refresh() {
  if (!props.writable || !props.canReadProgress) return;
  const context = capture(), taskId = props.task.id, requestedScope = scope.value, sequence = ++request;
  loading.value = true;
  error.value = '';
  preview.value = null;
  try {
    const result = await education.remediationPreview(context.slug, taskId, requestedScope);
    if (!context.isCurrent() || taskId !== props.task.id || sequence !== request) return;
    preview.value = result.data;
  } catch (e) {
    if (context.isCurrent() && sequence === request) error.value = extractApiError(e).message;
  } finally {
    if (sequence === request) loading.value = false;
  }
}
async function prepare() {
  open.value = true;
  await refresh();
}
async function create(input: RemediationSelectionInput) {
  if (saving.value || !preview.value || !props.writable || !props.canReadProgress) return;
  const context = capture(), basis = preview.value, taskId = props.task.id;
  const body = { ...input, scope: basis.source.scope, preview_token: basis.preview_token };
  const signature = JSON.stringify(body);
  if (signature !== submittedBody) {
    submittedBody = signature;
    idempotencyKey = crypto.randomUUID();
  }
  saving.value = true;
  error.value = '';
  try {
    const result = await education.createRemediation(context.slug, taskId, basis.source.revision, idempotencyKey, body);
    if (!context.isCurrent() || taskId !== props.task.id) return;
    open.value = false;
    await navigateTo(workspacePath(context.slug, `assignments/${result.data.id}`));
  } catch (e) {
    if (context.isCurrent()) error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
watch(scope, () => {
  if (open.value) void refresh();
});
watch([() => props.slug, () => props.task.id], () => {
  ++request;
  open.value = false;
  preview.value = null;
});
</script>
<template>
  <div v-if="writable && canReadProgress && task.published_at">
    <UButton variant="outline" icon="i-lucide-users" @click="prepare">为全班未达标学生布置补题</UButton>
    <UModal v-model:open="open" title="全班补题候选预览">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm text-text-muted">根据整个班级的当前成绩生成候选，与矩阵页码和筛选无关。</p>
          <AdminFormField label="成绩依据">
            <USelect v-model="scope" :disabled="saving"
              :items="[{ label: '按时成绩', value: 'on_time' }, { label: '当前补做进度', value: 'current' }]"
              aria-label="补题成绩依据" />
          </AdminFormField>
          <UAlert v-if="error" color="error" :title="error" />
          <p v-if="loading" class="text-sm text-text-muted">正在读取全班候选…</p>
          <RemediationSelection v-if="preview" :preview="preview" :initial-title="`${task.title}（补题）`"
            :saving="saving" @create="create" @refresh="refresh" />
          <UButton v-else-if="!loading" variant="outline" @click="refresh">重新读取候选</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
