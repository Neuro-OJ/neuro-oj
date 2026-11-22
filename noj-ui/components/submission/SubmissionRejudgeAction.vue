<script setup lang="ts">
import type { DomainJobScope, DomainJobTarget } from '~/utils/domain-submission-jobs';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{
  slug: string;
  scope: DomainJobScope;
  label: string;
  eligible: boolean;
  answerVersion?: { problemId: string; id: string; version: number };
}>();
const { can, domain } = useWorkspace(), api = useDomainSubmissionJobs(), capture = useWorkspaceActionScope();
const open = ref(false), mode = ref<'submitted' | 'latest' | 'answer'>('submitted');
const saving = ref(false), failure = ref('');
const answer = ref<typeof props.answerVersion>();
let signature = '', key = crypto.randomUUID();
const allowed = computed(() => props.eligible && can('submission:rejudge') && domain.value?.status === 'active');
function prepare() {
  mode.value = 'submitted';
  answer.value = props.answerVersion ? { ...props.answerVersion } : undefined;
  open.value = true;
}
async function create() {
  if (saving.value || !allowed.value) return;
  const scope = capture();
  const target: DomainJobTarget = mode.value === 'answer' && answer.value
    ? { mode: 'specified', versions: { [answer.value.problemId]: answer.value.id } }
    : { mode: mode.value === 'latest' ? 'latest' : 'submitted' };
  const input = { kind: 'rejudge' as const, scope: props.scope, target, policy_changes: [] };
  const nextSignature = JSON.stringify(input);
  if (signature !== nextSignature) {
    signature = nextSignature;
    key = crypto.randomUUID();
  }
  saving.value = true;
  failure.value = '';
  try {
    const result = await api.create(scope.slug, input, key);
    if (!scope.isCurrent()) return;
    open.value = false;
    await navigateTo(workspacePath(scope.slug, `submission-jobs/${result.data.job_id}`));
  } catch (e) {
    if (scope.isCurrent()) failure.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
watch(() => [props.slug, JSON.stringify(props.scope)], () => {
  open.value = false;
  failure.value = '';
});
</script>
<template>
  <div v-if="allowed">
    <UButton variant="outline" icon="i-lucide-refresh-ccw" @click="prepare">{{ label }}</UButton>
    <UModal v-model:open="open" title="创建重测任务">
      <template #body>
        <div class="space-y-4">
          <p
            class="text-sm text-text-secondary">{{ label }} · 仅使用域 {{ slug }} 内符合范围的提交。受理时固定条目集合，后续新提交不会自动加入。</p>
          <AdminFormField label="重测版本">
            <USelect v-model="mode" :disabled="saving" aria-label="域重测目标版本"
              :items="[{ label: '各提交原版本', value: 'submitted' }, { label: '源题最新发布版（受理时固定）', value: 'latest' }, ...(answer ? [{ label: `本页所见作答版 V${answer.version}`, value: 'answer' }] : [])]" />
          </AdminFormField>
          <p
            class="text-sm text-text-muted">重测不修改原代码和提交时间。作业进度跟随有效结果变化；已发布正式比赛快照需重新发布才改变。</p>
          <UAlert v-if="failure" color="error" :title="failure" />
          <UButton :loading="saving" @click="create">确认受理重测任务</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
