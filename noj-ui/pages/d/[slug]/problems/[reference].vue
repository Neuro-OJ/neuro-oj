<script setup lang="ts">
import { workspaceCacheKey, workspaceSolvePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
import { toDomainProblemView } from '~/utils/problemView';
import type { PublicProblemStats } from '~/utils/problemStats';

definePageMeta({ layout: 'workspace', middleware: 'workspace-context', workspaceWidth: 'problem', breadcrumbWidth: '1280px' });
const route = useRoute();
const { slug, domain, can } = useWorkspace();
const { user } = useAuth();
const api = useDomainProblems();
const reference = computed(() => String(route.params.reference));
const assignmentOrigin = computed<AssignmentSubmissionOrigin | undefined>(() => {
  const { assignment_id, assignment_item_id } = route.query;
  return typeof assignment_id === 'string' && typeof assignment_item_id === 'string'
    ? { assignment_id, assignment_item_id } : undefined;
});
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'problem', reference.value));
const { data, status, error, refresh } = await useAsyncData(key, () => api.detail(slug.value!, reference.value));
const showVersions = ref(false);
const statementExpanded = ref(true);
const problemView = computed(() => data.value ? toDomainProblemView(data.value) : null);
const publicStats = computed<PublicProblemStats | null>(() => {
  const stats = data.value?.statistics;
  return stats ? {
    attempt_count: stats.submit_count,
    submit_count: stats.valid_submissions,
    accepted_count: stats.accepted_submissions,
    acceptance_rate: stats.valid_submissions ? stats.accepted_submissions / stats.valid_submissions : null,
    suppressed_reason: null,
  } : null;
});
const inlineAnswer = computed(() => data.value?.content.kind === 'objective' || ['artifact', 'prediction'].includes(data.value?.content.submission_mode ?? ''));
const solveTo = computed(() => data.value ? { path: workspaceSolvePath(slug.value!, data.value.reference.display_ref), query: route.query } : undefined);
const passRequirement = computed(() => data.value?.content.kind === 'oi'
  ? '正式判定为 AC 才算通过' : data.value?.content.kind === 'objective' ? '满分才算通过' : '按当前有效正分规则判定是否通过');
const editorLabel = computed(() => data.value?.content.submission_mode === 'ui' ? '打开界面' : '开始编码');
const editTo = computed(() => data.value?.can_edit && !data.value.reference.is_shared ? `/d/${slug.value}/editor/${data.value.reference.number}` : null);
watch([() => slug.value, () => reference.value, () => user.value?.id], () => {
  showVersions.value = false;
  statementExpanded.value = true;
});
useSeoMeta({ title: () => data.value?.content.title ?? '题目' });
</script>

<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status === 'pending' ? 'loading' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data && problemView" class="space-y-5">
      <nav aria-label="题目导航" class="flex flex-wrap items-center gap-4 text-sm">
        <NuxtLink :to="`/d/${slug}/problems`" class="text-text-secondary no-underline hover:text-primary">题库</NuxtLink>
        <a href="#statement" class="text-text-secondary no-underline hover:text-primary">题面</a>
        <a v-if="domain?.configuration.features.community && data.content.kind !== 'objective'" href="#solutions" class="text-text-secondary no-underline hover:text-primary">题解</a>
      </nav>
      <div class="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div class="min-w-0 space-y-6 lg:col-span-8">
          <ProblemHeader :problem="problemView" :stats="publicStats" :show-owner="false">
            <template #actions>
              <DomainAddToTrainingMenu v-if="user && domain?.status === 'active' && (can('training:create') || can('training:write_own') || can('training:write_any'))" :slug="slug!" :problem="data.reference" />
              <UButton v-if="!inlineAnswer" :to="solveTo" size="lg" :icon="data.content.submission_mode === 'ui' ? 'i-lucide-panels-top-left' : 'i-lucide-code-2'">{{ editorLabel }}</UButton>
              <UButton v-else to="#answer" size="lg" icon="i-lucide-pencil-line">开始作答</UButton>
            </template>
          </ProblemHeader>
          <div class="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-panel px-4 py-3 text-sm">
            <span class="text-text-secondary">作答版本</span>
            <UBadge color="primary" variant="subtle">v{{ data.version }}</UBadge>
            <span class="text-text-muted">{{ data.effective_version_mode === 'exact' ? '题库已固定此版本' : '跟随当前题库版本' }} · {{ passRequirement }}</span>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-panel px-4 py-3 text-sm">
            <div class="min-w-0">
              <span class="text-text-secondary">版本策略</span>
              <span class="ml-2 text-text">{{ data.effective_version_mode === 'exact' ? `仅 v${data.version} 的正式判定有效` : '任一有效版本' }}</span>
              <span class="ml-3 text-xs text-text-muted">提交会记录当前作答版本。</span>
            </div>
            <UButton color="neutral" variant="outline" size="sm" :aria-expanded="showVersions" aria-controls="problem-versions" @click="showVersions = !showVersions">{{ showVersions ? '收起沿革' : '版本沿革' }}</UButton>
          </div>
          <DomainProblemVersions v-if="showVersions" id="problem-versions" :key="`${slug}:${reference}:${user?.id}:versions`" :slug="slug!" :reference="reference" />
          <ProblemStatement v-model:expanded="statementExpanded" :content="data.content.description"
            :annotation="{ slug: slug!, target: { kind: 'problem', reference, version_id: data.version_id, field: 'description' } }"
            :editor-to="!inlineAnswer ? solveTo : null" :editor-label="editorLabel"
            :editor-icon="data.content.submission_mode === 'ui' ? 'i-lucide-panels-top-left' : 'i-lucide-code-2'" :edit-to="editTo">
            <template #after-content><ProblemSamples :samples="data.content.samples" :annotation="{ slug: slug!, reference, version_id: data.version_id }" /></template>
          </ProblemStatement>
          <div v-if="inlineAnswer" id="answer" class="scroll-mt-24">
            <DomainProblemAnswer :key="`${slug}:${reference}:${user?.id}`" :slug="slug!" :problem="data" :assignment-origin="assignmentOrigin" @refresh="refresh()" />
          </div>
          <DomainProblemSolutions v-if="domain?.configuration.features.community && data.content.kind !== 'objective'"
            :key="`${slug}:${reference}:${user?.id}:solutions`" :slug="slug!" :problem-id="data.reference.problem_id" />
        </div>
        <aside class="min-w-0 space-y-6 lg:col-span-4">
          <ProblemMetaCard :problem="problemView" :stats="publicStats" :problems-to="`/d/${slug}/problems`" />
          <DomainProblemSubmissions :key="`${slug}:${reference}:${user?.id}:submissions`" :slug="slug!" :problem-id="data.reference.problem_id" />
          <UButton v-if="assignmentOrigin" :to="`/d/${slug}/assignments/${assignmentOrigin.assignment_id}`" color="neutral" variant="outline" class="w-full justify-center" icon="i-lucide-arrow-left">返回作业</UButton>
          <ClientOnly>
            <DomainRejudgeAction :slug="slug!" :scope="{type:'problem',problem_id:data.reference.problem_id}"
              :label="`重测本域此题提交（${data.reference.display_ref}）`" :eligible="true"
              :answer-version="{problemId:data.reference.problem_id,id:data.version_id,version:data.version}" />
          </ClientOnly>
        </aside>
      </div>
    </div>
  </AsyncContent>
</template>
