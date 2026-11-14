<script setup lang="ts">
import { workspaceCacheKey, workspaceSolvePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
import { toDomainProblemView } from '~/utils/problemView';
import type { PublicProblemStats } from '~/utils/problemStats';
import { contestProtectionFromError } from '~/utils/contestProtection';
import type { ProblemKnowledgeView } from '~/utils/knowledge';

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
const selectedVersion = computed(() => typeof route.query.version_id === 'string' ? route.query.version_id : undefined);
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'problem', reference.value, selectedVersion.value ?? 'current'));
const { data, status, error, refresh } = await useAsyncData(key, () => api.detail(slug.value!, reference.value, selectedVersion.value));
const protection = contestProtectionFromError(error.value);
if (protection) throw createError({ statusCode: 403, statusMessage: '赛题正在保护中', data: { slug: slug.value, contests: protection } });
watch(error, (failure) => {
  const contests = contestProtectionFromError(failure);
  if (contests) showError({ statusCode: 403, statusMessage: '赛题正在保护中', data: { slug: slug.value, contests } });
});
// 知识点：非关键数据，404/功能关闭时静默隐藏（不影响做题页）。
const knowledge = useKnowledge();
const knowledgeView = ref<ProblemKnowledgeView | null>(null);
/** 校准难度档位（P2）：有 `difficulty` 时优先于出题人自报难度显示。 */
const calibratedTier = computed(() => knowledgeView.value?.difficulty?.tier ?? null);
watch(
  () => [slug.value, data.value?.reference.problem_id] as const,
  async ([currentSlug, problemId]) => {
    if (!currentSlug || !problemId) {
      knowledgeView.value = null;
      return;
    }
    try {
      knowledgeView.value = await knowledge.loadProblem(problemId);
    } catch {
      knowledgeView.value = null;
    }
  },
  { immediate: true },
);
const router = useRouter();
function selectVersion(version_id: string) { void router.push({ query: { ...route.query, version_id } }); }
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
const editorLabel = computed(() => data.value?.content.submission_mode === 'ui' ? '打开界面' : '开始编码');
const editTo = computed(() => data.value?.can_edit ? `/d/${slug.value}/editor/${data.value.reference.number}` : null);
watch([() => slug.value, () => reference.value, () => user.value?.id], () => {
  statementExpanded.value = true;
});
useSeoMeta({ title: () => data.value?.content.title ?? '题目' });
</script>

<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status === 'pending' ? 'loading' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data && problemView" class="space-y-5">
      <UAlert v-if="data.can_practice === false" title="当前为管理预览，普通练习与作业提交暂不可用。请从比赛入口正式参赛。" color="info" />
      <nav aria-label="题目导航" class="flex flex-wrap items-center gap-4 text-sm">
        <NuxtLink :to="`/d/${slug}/problems`" class="inline-flex items-center gap-1 text-text-secondary no-underline hover:text-primary"><UIcon name="i-lucide-arrow-left" class="size-3.5" />题库</NuxtLink>
        <a v-if="domain?.configuration.features.community && data.content.kind !== 'objective'" href="#solutions" class="text-text-secondary no-underline hover:text-primary">题解</a>
      </nav>
      <div class="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div class="min-w-0 space-y-6 lg:col-span-8">
          <KnowledgeTags v-if="data.reference.problem_id" :view="knowledgeView" :domain="slug ?? undefined" />
          <ProblemHeader :problem="problemView" :stats="publicStats" :show-owner="false" :calibrated-tier="calibratedTier">
            <template #actions>
              <DomainAddToTrainingMenu v-if="user && domain?.status === 'active' && (can('training:create') || can('training:write_any'))" :slug="slug!" :problem="data.reference" />
              <UButton v-if="!inlineAnswer && data.can_practice !== false" :to="solveTo" size="lg" :icon="data.content.submission_mode === 'ui' ? 'i-lucide-panels-top-left' : 'i-lucide-code-2'">{{ editorLabel }}</UButton>
              <UButton v-else-if="data.can_practice !== false" to="#answer" size="lg" icon="i-lucide-pencil-line">开始作答</UButton>
            </template>
          </ProblemHeader>
          <!-- 编辑器入口只在抬头保留一个（与题面工具条重复，见 #685）。 -->
          <ProblemStatement v-model:expanded="statementExpanded" :content="data.content.description" :edit-to="editTo">
            <template #toolbar>
              <DomainProblemVersionSelect :slug="slug!" :reference="reference" :selected="data.version_id" :version="data.version"
                :current="data.answer_version_id" :mode="data.effective_version_mode" :required="data.required_version_id" @select="selectVersion" />
            </template>
            <template #after-content><ProblemSamples :samples="data.content.samples" /></template>
          </ProblemStatement>
          <div v-if="inlineAnswer" id="answer" class="scroll-mt-24">
            <DomainProblemAnswer :key="`${slug}:${reference}:${user?.id}:${data.version_id}`" :slug="slug!" :problem="data" :assignment-origin="assignmentOrigin" @refresh="refresh()" />
          </div>
          <DomainProblemSolutions v-if="domain?.configuration.features.community && data.content.kind !== 'objective'"
            :key="`${slug}:${reference}:${user?.id}:solutions`" :slug="slug!" :problem-id="data.reference.problem_id" />
        </div>
        <aside class="min-w-0 space-y-6 lg:col-span-4">
          <ProblemMetaCard :problem="problemView" :stats="publicStats" :problems-to="`/d/${slug}/problems`" :calibrated-tier="calibratedTier" />
          <KnowledgeNextLink :problem-id="data.reference.problem_id" :user-key="user?.id ?? null" />
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
