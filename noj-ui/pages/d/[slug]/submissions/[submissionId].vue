<script setup lang="ts">
import { workspaceCacheKey, workspacePath, workspaceProblemPath } from '~/utils/domain/workspace/workspace';
import { extractApiError } from '~/utils/server/apiError';
import { formatDateTime } from '~/utils/domain/submission/submissionFormat';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), workspace = useWorkspace(), { user } = useAuth(), api = useDomainSubmissions();
const slug = workspace.slug, can = workspace.can ?? (() => false);
const contestApi = useDomainContests();
const id = computed(() => String(route.params.submissionId));
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'submission', id.value));
const { data, status, error, refresh } = await useAsyncData(key, () => api.detail(slug.value!, id.value));
const contest = await useAsyncData(
  () => `${key.value}:contest-context`,
  () =>
    data.value?.data.contest_id ? contestApi.detail(slug.value!, data.value.data.contest_id) : Promise.resolve(null),
);
usePolling({
  intervalMs: computed(() =>
    data.value?.data.result_visibility === 'hidden' || ['pending', 'judging'].includes(data.value?.data.status ?? '') ||
      contest.data.value?.data.status === 'running'
      ? 2000
      : null
  ),
  immediate: false,
  fetcher: async () => {
    await Promise.all([refresh(), data.value?.data.contest_id ? contest.refresh() : Promise.resolve()]);
  },
});
useSeoMeta({ title: '空间提交详情' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-3">
      <header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-3">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 class="text-lg font-semibold leading-tight text-text">
            <span class="font-mono">{{ data.data.reference.display_ref }}</span> · 提交详情
          </h1>
          <p class="break-all font-mono text-xs tabular-nums text-text-muted">
            {{ data.data.id }} · {{ formatDateTime(data.data.created_at) }} · {{ slug }} ·
            {{ data.data.submitted_version == null ? '版本未知' : `V${data.data.submitted_version}` }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton :to="workspacePath(slug!, 'submissions')" size="xs" color="neutral" variant="ghost"
            icon="i-lucide-arrow-left">提交列表</UButton>
          <UButton v-if="data.data.resource_available"
            :to="workspaceProblemPath(slug!, data.data.reference.display_ref)"
            size="xs" color="neutral" variant="outline">返回题目</UButton>
          <UButton v-if="data.data.assignment_origin"
            :to="`/d/${slug}/assignments/${data.data.assignment_origin.assignment_id}`"
            size="xs" color="neutral" variant="outline">来源作业</UButton>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新结果"
            @click="refresh()" />
        </div>
      </header>
      <UAlert v-if="!data.data.resource_available" color="warning"
        title="源资源已不可用，保留已受理的原提交和授权成绩摘要" />
      <SubmissionResult :submission="data.data" :slug="slug!" :include-messages="can('submission:read_all')" />
      <ClientOnly>
        <div class="flex flex-wrap gap-2 empty:hidden">
          <SubmissionUpgradeAction :slug="slug!" :source="{ kind: 'submission', id: data.data.id }"
            :source-version="data.data.submitted_version_id"
            :eligible="data.data.user_id === user?.id && data.data.resource_available && data.data.result_visibility !== 'hidden' && data.data.is_latest === false && !['pending', 'judging'].includes(data.data.status ?? '') && (!data.data.contest_id || contest.data.value?.data.status === 'ended')" />
          <SubmissionUpgradeAction
            v-if="contest.data.value?.data.can_manage && contest.data.value.data.status === 'running'"
            :slug="slug!" :source="{ kind: 'submission', id: data.data.id }" context="source_contest"
            :source-version="data.data.submitted_version_id"
            :eligible="data.data.resource_available && data.data.is_latest === false && !['pending', 'judging'].includes(data.data.status ?? '') && (data.data.user_id === user?.id || can('submission:rejudge'))" />
          <SubmissionRejudgeAction :slug="slug!"
            :scope="{ type: 'selected', submissions: [{ kind: 'submission', id: data.data.id }] }"
            label="重测此提交"
            :eligible="data.data.resource_available && (!data.data.contest_id || !!contest.data.value?.data.can_manage) && can('submission:rejudge')" />
        </div>
      </ClientOnly>
      <section v-if="data.data.can_view_source !== false && data.data.code != null"
        class="overflow-hidden rounded-lg border border-border bg-bg-panel" aria-label="原提交代码">
        <h2
          class="border-b border-border bg-bg-sunken/60 px-3 py-1.5 text-xs font-medium text-text-muted">原提交代码</h2>
        <pre
          class="max-h-[40rem] overflow-auto whitespace-pre px-3 py-2 font-mono text-xs leading-5">{{ data.data.code }}</pre>
      </section>
    </div>
  </AsyncContent>
</template>
