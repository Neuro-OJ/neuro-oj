<script setup lang="ts">
import type { DomainJobSource } from '~/utils/domain-submission-jobs';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{
  slug: string;
  source: DomainJobSource;
  eligible: boolean;
  context?: 'practice' | 'source_contest';
  sourceVersion?: string | null;
}>();
const { can, domain } = useWorkspace(), api = useDomainSubmissionJobs(), capture = useWorkspaceActionScope();
const open = ref(false), saving = ref(false), failure = ref(''), key = ref(crypto.randomUUID());
const allowed = computed(() => props.eligible && can('submission:create') && domain.value?.status === 'active');
async function create() {
  if (saving.value || !allowed.value) return;
  const scope = capture(), source = { ...props.source };
  saving.value = true;
  failure.value = '';
  try {
    const result = await api.create(scope.slug, {
      kind: 'upgrade',
      submissions: [source],
      context: props.context ?? 'practice',
    }, key.value);
    if (!scope.isCurrent() || source.id !== props.source.id) return;
    open.value = false;
    await navigateTo(workspacePath(scope.slug, `submission-jobs/${result.data.job_id}`));
  } catch (e) {
    if (scope.isCurrent()) failure.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
watch(() => [props.slug, props.source.id, props.source.kind, props.context], () => {
  open.value = false;
  failure.value = '';
  key.value = crypto.randomUUID();
});
</script>
<template>
  <div v-if="allowed">
    <UButton variant="outline" icon="i-lucide-git-pull-request-arrow"
      @click="open = true">{{ context === 'source_contest' ? '升级参赛提交' : '升级为当前作答版' }}</UButton>
    <UModal v-model:open="open" title="创建升级任务">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm text-text-secondary">使用域 {{ slug }}，源提交 {{ source.id }}。</p>
          <p v-if="sourceVersion" class="break-all text-xs text-text-muted">原版本 {{ sourceVersion }}</p>
          <p
            class="text-sm text-text-secondary">保留原提交和原内容，按本域当前作答版本创建新的提交；版本与来源由服务端固定到任务条目。</p>
          <p v-if="context === 'source_contest'"
            class="text-sm text-text-secondary">新提交保留原比赛归属，需要组织权限、有效受理窗口和比赛固定版本一致。</p>
          <p v-else class="text-sm text-text-secondary">新提交作为当前域个人练习，不计入原比赛。</p>
          <UAlert v-if="failure" color="error" :title="failure" />
          <UButton :loading="saving" @click="create">确认创建升级任务</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
