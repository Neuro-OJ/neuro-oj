<script setup lang="ts">
import { newDomainEditorContent } from '~/utils/domain-problem-editor';
import type { DomainAiRuntime, DomainEditorContent } from '~/utils/domain-problem-editor';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, can, domain } = useWorkspace(), api = useDomainProblemEditor(), capture = useWorkspaceActionScope();
const { user } = useAuth();
const images = await useAsyncData(() => `instance-judge-images:${user.value?.id}`, () => api.images());
const evaluatorImage = ref(''), solutionImage = ref('');
const imageItems = (kind: string) =>
  images.data.value?.data.filter((item) => item.kind === kind).map((item) => item.image) ?? [];
const title = ref(''),
  description = ref(''),
  kind = ref<DomainEditorContent['kind']>('oi'),
  visibility = ref<'public' | 'private'>('private');
const submissionMode = ref<'code' | 'artifact'>('code'), saving = ref(false), failure = ref('');
const writable = computed(() =>
  domain.value?.status === 'active' && (can('problem:write_own') || can('problem:write_any'))
);
async function create() {
  if (!writable.value || saving.value || (kind.value === 'ai' && (!evaluatorImage.value || !solutionImage.value))) {
    return;
  }
  const scope = capture(), content = newDomainEditorContent(kind.value);
  content.title = title.value;
  content.description = description.value;
  if (kind.value === 'ai') {
    content.submission_mode = submissionMode.value;
    const runtime = content.runtime_config as DomainAiRuntime;
    runtime.evaluator.image = evaluatorImage.value;
    runtime.solution.image = solutionImage.value;
  }
  saving.value = true;
  failure.value = '';
  try {
    const response = await api.create(scope.slug, content, visibility.value);
    if (scope.isCurrent()) await navigateTo(`/d/${scope.slug}/editor/${response.number}`);
  } catch (error) {
    if (scope.isCurrent()) failure.value = extractApiError(error).message;
  } finally {
    if (scope.isCurrent()) saving.value = false;
  }
}
useSeoMeta({ title: '创建本域题目' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="创建本域题目" description="先创建共享草稿，再配置内容、测试数据和评测并发布。题号自动分配。"
      icon="i-lucide-file-plus-2" />
    <UAlert v-if="!writable" color="warning" title="没有当前域创建题目的能力，或当前域只允许读取" />
    <UCard v-else>
      <form class="space-y-4" @submit.prevent="create">
        <AdminFormField label="题型">
          <USelect v-model="kind"
            :items="[{ label: 'OI 编程题', value: 'oi' }, { label: 'AI 代码／LLM／产物题', value: 'ai' }, { label: '客观题', value: 'objective' }]" />
        </AdminFormField>
        <AdminFormField v-if="kind === 'ai'" label="提交方式">
          <USelect v-model="submissionMode"
            :items="[{ label: '代码', value: 'code' }, { label: '产物 ZIP', value: 'artifact' }]" />
        </AdminFormField>
        <div v-if="kind === 'ai'" class="space-y-3">
          <UAlert v-if="images.error.value" color="error" :title="extractApiError(images.error.value).message">
            <template #actions>
              <UButton @click="images.refresh()">重新读取许可镜像</UButton>
            </template>
          </UAlert>
          <div class="grid gap-4 sm:grid-cols-2">
            <AdminFormField label="Evaluator 镜像" required>
              <USelect v-model="evaluatorImage" :items="imageItems('evaluator')" placeholder="选择实例许可镜像" />
            </AdminFormField>
            <AdminFormField label="Solution 镜像" required>
              <USelect v-model="solutionImage" :items="imageItems('solution')" placeholder="选择实例许可镜像" />
            </AdminFormField>
          </div>
          <p class="text-xs text-text-muted">先选择初始评测环境，创建后继续配置支持文件、预算和资源限制。</p>
        </div>
        <AdminFormField label="题目标题" required>
          <UInput v-model="title" class="w-full" required />
        </AdminFormField>
        <AdminFormField label="题面">
          <MarkdownEditor v-model="description" />
        </AdminFormField>
        <AdminFormField label="展示范围">
          <USelect v-model="visibility"
            :items="[{ label: '域成员', value: 'private' }, { label: '域内公开题库', value: 'public' }]" />
        </AdminFormField>
        <UAlert v-if="failure" color="error" :title="failure" />
        <UButton type="submit" :loading="saving"
          :disabled="!title.trim() || (kind === 'ai' && (!evaluatorImage || !solutionImage))">创建草稿并继续编辑</UButton>
      </form>
    </UCard>
  </div>
</template>
