<script setup lang="ts">
import { workspaceCacheKey, workspaceSolvePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const route = useRoute();
const { slug, domain } = useWorkspace();
const { user } = useAuth();
const api = useDomainProblems();
const reference = computed(() => String(route.params.reference));
const assignmentOrigin = computed<AssignmentSubmissionOrigin | undefined>(() => {
  const { assignment_id, assignment_item_id } = route.query;
  return typeof assignment_id === 'string' && typeof assignment_item_id === 'string'
    ? { assignment_id, assignment_item_id }
    : undefined;
});
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'problem', reference.value));
const { data, status, error, refresh } = await useAsyncData(key, () => api.detail(slug.value!, reference.value));
const showVersions = ref(false);
const inlineAnswer = computed(() =>
  data.value?.content.kind === 'objective' ||
  ['artifact', 'prediction'].includes(data.value?.content.submission_mode ?? '')
);
const solveTo = computed(() =>
  data.value
    ? { path: workspaceSolvePath(slug.value!, data.value.reference.display_ref), query: route.query }
    : undefined
);
const passRequirement = computed(() =>
  data.value?.content.kind === 'oi'
    ? '正式判定为 AC 才算通过'
    : data.value?.content.kind === 'objective'
    ? '满分才算通过'
    : '按当前有效正分规则判定是否通过'
);
watch([() => slug.value, () => reference.value, () => user.value?.id], () => {
  showVersions.value = false;
});
useSeoMeta({ title: () => data.value?.content.title ?? '题目' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status === 'pending' ? 'loading' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-5">
      <header class="space-y-3">
        <div class="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span class="font-mono text-primary">{{ data.reference.display_ref }}</span>
          <span
            class="rounded border border-border px-1.5 py-0.5">{{ {oi:'OI 题',ai:'AI 题',objective:'客观题'}[data.content.kind] }}</span>
          <DifficultyBadge v-if="data.difficulty" :difficulty="data.difficulty" />
          <span>V{{ data.version }}</span>
        </div>
        <h1 class="break-words text-2xl font-bold leading-snug text-text">{{ data.content.title }}</h1>
        <UButton v-if="!inlineAnswer" :to="solveTo" class="lg:hidden"
          icon="i-lucide-code-2">{{ data.content.submission_mode === 'ui' ? '打开作答界面' : '开始编码' }}</UButton>
      </header>
      <div class="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_260px] items-start">
        <div class="min-w-0 space-y-5">
          <article class="rounded-lg border border-border bg-bg-panel p-5 shadow-card sm:p-7">
            <MarkdownRenderer :content="data.content.description" />
            <ProblemSamples :samples="data.content.samples" />
          </article>
          <DomainProblemAnswer v-if="inlineAnswer" :key="`${slug}:${reference}:${user?.id}`" :slug="slug!"
            :problem="data" :assignment-origin="assignmentOrigin" @refresh="refresh()" />
          <DomainProblemVersions v-if="showVersions" :key="`${slug}:${reference}:${user?.id}:versions`" :slug="slug!"
            :reference="reference" />
        </div>
        <aside class="space-y-4 lg:sticky lg:top-20">
          <div class="space-y-3 rounded-lg border border-border bg-bg-panel p-4 shadow-card">
            <UButton v-if="!inlineAnswer" :to="solveTo" size="lg" color="primary" class="w-full justify-center shadow-xs"
              icon="i-lucide-code-2">{{ data.content.submission_mode === 'ui' ? '打开作答界面' : '开始编码' }}</UButton>
            <UButton v-if="user"
              :to="{path:`/d/${slug}/${data.content.kind==='objective'?'objective-submissions':'submissions'}`,query:{problem_id:data.reference.problem_id}}"
              class="w-full justify-center" color="neutral" variant="outline">本人作答历史</UButton>
            <UButton v-if="domain?.configuration.features.community"
              :to="{path:`/d/${slug}/community`,query:{type:'solution',problem_id:data.reference.problem_id}}"
              class="w-full justify-center" color="neutral" variant="outline">查看题解</UButton>
            <UButton color="neutral" variant="ghost" class="w-full justify-center"
              @click="showVersions=!showVersions">{{ showVersions ? '收起沿革' : '版本沿革' }}</UButton>
            <UButton v-if="data.can_edit && !data.reference.is_shared"
              :to="`/d/${slug}/editor/${data.reference.number}`" color="neutral" variant="ghost"
              class="w-full justify-center">编辑草稿</UButton>
          </div>
          <div class="rounded border border-border bg-bg-panel p-4 text-sm">
            <h2 class="mb-3 font-semibold text-text">题目信息</h2>
            <dl class="grid grid-cols-2 gap-y-3 text-xs tabular-nums">
              <dt class="text-text-muted">时间限制</dt>
              <dd>{{ data.limits ? data.limits.time_limit_ms + ' ms' : '—' }}</dd>
              <dt class="text-text-muted">内存限制</dt>
              <dd>{{ data.limits ? data.limits.memory_limit_mb + ' MB' : '—' }}</dd>
              <dt class="text-text-muted">本域提交</dt>
              <dd>{{ data.statistics?.submit_count ?? 0 }}</dd>
              <dt class="text-text-muted">有效评测</dt>
              <dd>{{ data.statistics?.valid_submissions ?? 0 }}</dd>
              <dt class="text-text-muted">正式通过</dt>
              <dd>{{ data.statistics?.accepted_submissions ?? 0 }}</dd>
              <dt class="text-text-muted">我的进度</dt>
              <dd>{{ data.statistics?.progress ? { solved: '已通过', attempted: '已尝试', unseen: '未开始' }[data.statistics.progress] : '—' }}</dd>
            </dl>
            <p
              class="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-text-muted">{{ passRequirement }}。成绩口径：{{ data.effective_version_mode === 'exact' ? `仅 V${data.version}` : '任一有效版本' }}。</p>
          </div>
          <UButton v-if="assignmentOrigin" :to="`/d/${slug}/assignments/${assignmentOrigin.assignment_id}`"
            color="neutral" variant="outline" class="w-full justify-center"
            icon="i-lucide-arrow-left">返回作业</UButton>
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
