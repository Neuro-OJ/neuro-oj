<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context', problemWorkspace: true, breadcrumbWidth: '100rem' });
const route = useRoute();
const { slug } = useWorkspace();
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
const passRequirement = computed(() => data.value?.content.kind === 'oi'
  ? '正式判定为 AC 才算通过'
  : data.value?.content.kind === 'objective' ? '满分才算通过' : '按当前有效正分规则判定是否通过');
watch(() => [slug.value, reference.value, user.value?.id], () => {
  showVersions.value = false;
});
useSeoMeta({ title: () => data.value?.content.title ?? '题目' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status === 'pending' ? 'loading' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <h2
          class="min-w-0 break-words text-xl font-semibold"><span class="font-mono text-primary">{{ data.reference.display_ref }}</span> {{ data.content.title }}</h2>
        <div class="flex flex-wrap items-center gap-2">
          <UBadge variant="subtle">V{{ data.version }}</UBadge>
          <UButton variant="ghost" color="neutral"
            @click="showVersions = !showVersions">{{ showVersions ? '收起沿革' : '版本沿革' }}</UButton>
          <UButton v-if="data.can_edit && !data.reference.is_shared" :to="`/d/${slug}/editor/${data.reference.number}`"
            variant="outline">编辑草稿</UButton>
          <UButton v-if="user"
            :to="{ path: `/d/${slug}/${data.content.kind === 'objective' ? 'objective-submissions' : 'submissions'}`, query: { problem_id: data.reference.problem_id } }"
            variant="outline">本人作答历史</UButton>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-secondary">
        <UBadge variant="subtle">{{ { oi: 'OI 题', ai: 'AI 题', objective: '客观题' }[data.content.kind] }}</UBadge>
        <DifficultyBadge v-if="data.difficulty" :difficulty="data.difficulty" />
        <span>通过要求：{{ passRequirement }}</span>
        <span v-if="data.limits" class="tabular-nums">{{ data.limits.time_limit_ms }} ms · {{ data.limits.memory_limit_mb }} MiB</span>
        <NuxtLink :to="{ path: `/d/${slug}/community`, query: { type: 'solution', problem_id: data.reference.problem_id } }"
          class="text-primary hover:underline">查看题解</NuxtLink>
      </div>
      <div v-if="data.statistics" class="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums text-text-muted">
        <span>本域提交 {{ data.statistics.submit_count }}</span>
        <span>有效评测 {{ data.statistics.valid_submissions }}</span>
        <span>正式通过 {{ data.statistics.accepted_submissions }}</span>
        <span v-if="data.statistics.progress">本人状态：{{ { solved: '已通过', attempted: '已尝试', unseen: '未开始' }[data.statistics.progress] }}</span>
        <span>成绩口径：{{ data.effective_version_mode === 'exact' ? `仅 V${data.version}` : '任一有效版本' }}</span>
      </div>
      <DomainProblemWorkspace>
        <template #statement>
      <UCard>
        <MarkdownRenderer :content="data.content.description" />
      </UCard>
      <ClientOnly>
        <DomainRejudgeAction :slug="slug!" :scope="{ type: 'problem', problem_id: data.reference.problem_id }"
          :label="`重测本域此题提交（${data.reference.display_ref}）`" :eligible="true"
          :answer-version="{ problemId: data.reference.problem_id, id: data.version_id, version: data.version }" />
      </ClientOnly>
      <UCard v-for="(sample, index) in data.content.samples" :key="index">
        <h3 class="mb-3 font-semibold">样例 {{ index + 1 }}</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <pre class="overflow-auto rounded bg-bg-sunken p-3">{{ sample.input }}</pre>
          <pre class="overflow-auto rounded bg-bg-sunken p-3">{{ sample.output }}</pre>
        </div>
        <MarkdownRenderer v-if="sample.explanation" class="mt-3" :content="sample.explanation" />
      </UCard>
        </template>
        <template #answer>
      <DomainProblemAnswer :key="`${slug}:${reference}:${user?.id}`" :slug="slug!" :problem="data"
        :assignment-origin="assignmentOrigin"
        @refresh="refresh()" />
        </template>
      </DomainProblemWorkspace>
      <UButton v-if="assignmentOrigin" :to="`/d/${slug}/assignments/${assignmentOrigin.assignment_id}`" variant="outline">返回作业</UButton>
      <DomainProblemVersions v-if="showVersions" :key="`${slug}:${reference}:${user?.id}:versions`" :slug="slug!"
        :reference="reference" />
    </div>
  </AsyncContent>
</template>
