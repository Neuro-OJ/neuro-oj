<script setup lang="ts">
import { workspaceCacheKey, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';
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
    data.value?.data.result_visibility === 'hidden' || ['pending', 'judging'].includes(data.value?.data.status ?? '') || contest.data.value?.data.status === 'running'
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
    <div v-if="data" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <UButton :to="workspacePath(slug!, 'submissions')" variant="ghost" icon="i-lucide-arrow-left">返回提交列表</UButton>
          <h2 class="text-xl font-semibold">{{ data.data.reference.display_ref }} · 提交详情</h2>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton v-if="data.data.resource_available" :to="workspaceProblemPath(slug!, data.data.reference.display_ref)"
            variant="outline">返回本域题目</UButton>
          <UButton v-if="data.data.assignment_origin" :to="`/d/${slug}/assignments/${data.data.assignment_origin.assignment_id}`" variant="outline">来源作业</UButton>
          <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新结果" @click="refresh()" />
        </div>
      </div>
      <p
        class="break-all text-xs text-text-muted tabular-nums">{{ data.data.id }} · {{ formatDateTime(data.data.created_at) }} · 使用域 {{ slug }} · {{ data.data.submitted_version == null ? '版本未知' : `V${data.data.submitted_version}` }}</p>
      <UAlert v-if="!data.data.resource_available" color="warning"
        title="源资源已不可用，保留已受理的原提交和授权成绩摘要" />
      <DomainSubmissionResult :submission="data.data" />
      <ClientOnly>
        <div class="flex flex-wrap gap-3">
          <DomainUpgradeAction :slug="slug!" :source="{ kind: 'submission', id: data.data.id }"
            :source-version="data.data.submitted_version_id"
            :eligible="data.data.user_id === user?.id && data.data.resource_available && data.data.result_visibility !== 'hidden' && data.data.is_latest === false && !['pending', 'judging'].includes(data.data.status ?? '') && (!data.data.contest_id || contest.data.value?.data.status === 'ended')" />
          <DomainUpgradeAction
            v-if="contest.data.value?.data.can_manage && contest.data.value.data.status === 'running'"
            :slug="slug!" :source="{ kind: 'submission', id: data.data.id }" context="source_contest"
            :source-version="data.data.submitted_version_id"
            :eligible="data.data.resource_available && data.data.is_latest === false && !['pending', 'judging'].includes(data.data.status ?? '') && (data.data.user_id === user?.id || can('submission:rejudge'))" />
          <DomainRejudgeAction :slug="slug!"
            :scope="{ type: 'selected', submissions: [{ kind: 'submission', id: data.data.id }] }"
            label="重测此提交"
            :eligible="data.data.resource_available && (!data.data.contest_id || !!contest.data.value?.data.can_manage) && can('submission:rejudge')" />
        </div>
      </ClientOnly>
      <UCard v-if="data.data.can_view_source !== false && data.data.code != null">
        <h3 class="mb-3 font-semibold">原提交代码</h3>
        <AnnotationCode v-if="data.data.resource_available" :slug="slug!" :submission-id="data.data.id" :code="data.data.code || undefined" :file-name="data.data.file_name" />
        <pre v-else class="max-h-[32rem] overflow-auto whitespace-pre font-mono text-xs">{{ data.data.code }}</pre>
      </UCard>
    </div>
  </AsyncContent>
</template>
