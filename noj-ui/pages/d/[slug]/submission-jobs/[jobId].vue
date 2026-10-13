<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { DOMAIN_JOB_STATUS_LABELS, domainJobTerminal } from '~/utils/domain-submission-jobs';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug, domain, can } = useWorkspace(), { user } = useAuth();
const api = useDomainSubmissionJobs(), capture = useWorkspaceActionScope();
const id = computed(() => String(route.params.jobId)),
  page = ref(1),
  polls = ref(0),
  cancelling = ref(false),
  failure = ref('');
let pollDeadline = Date.now() + 120_000;
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'submission-job', id.value));
const job = await useAsyncData(key, () => api.detail(slug.value!, id.value));
const items = await useAsyncData(
  () => `${key.value}:items:${page.value}`,
  () => job.data.value ? api.items(slug.value!, id.value, page.value) : Promise.resolve(null),
);
const canCancel = computed(() =>
  job.data.value && !domainJobTerminal(job.data.value.data.status) && !job.data.value.data.cancel_requested &&
  domain.value?.status === 'active' && (job.data.value.data.actor_id === user.value?.id || can('submission:rejudge'))
);
async function refresh() {
  await job.refresh();
  if (!job.error.value) await items.refresh();
}
usePolling({
  intervalMs: computed(() =>
    job.data.value && !job.error.value && !domainJobTerminal(job.data.value.data.status) && polls.value < 60 &&
      Date.now() < pollDeadline
      ? 2000
      : null
  ),
  immediate: false,
  fetcher: async () => {
    polls.value++;
    await refresh();
  },
});
async function cancel() {
  if (cancelling.value || !canCancel.value) return;
  const context = capture(), jobId = id.value;
  cancelling.value = true;
  failure.value = '';
  try {
    await api.cancel(context.slug, jobId);
    if (context.isCurrent() && id.value === jobId) await refresh();
  } catch (e) {
    if (context.isCurrent()) failure.value = extractApiError(e).message;
  } finally {
    cancelling.value = false;
  }
}
watch(key, () => {
  pollDeadline = Date.now() + 120_000;
  polls.value = 0;
  page.value = 1;
  failure.value = '';
});
useSeoMeta({ title: '域内评测任务' });
</script>
<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <UButton :to="workspacePath(slug!, 'submissions')" variant="ghost" icon="i-lucide-arrow-left">本域提交</UButton>
      <UButton variant="outline" icon="i-lucide-refresh-cw" @click="refresh">刷新任务</UButton>
    </div>
    <AsyncContent
      :status="job.error.value ? 'error' : job.status.value === 'pending' ? 'loading' : job.data.value ? 'data' : 'empty'"
      :error="job.error.value ? extractApiError(job.error.value).message : undefined" @retry="refresh">
      <template v-if="job.data.value">
        <AdminPageHeader :title="job.data.value.data.kind === 'upgrade' ? '提交升级任务' : '提交重测任务'"
          :description="`使用域 ${slug}`" icon="i-lucide-workflow" />
        <p class="mt-3 break-all font-mono text-xs text-text-muted">{{ job.data.value.data.id }}</p>
        <div class="mt-3 flex flex-wrap gap-3 text-sm tabular-nums">
          <UBadge
            variant="subtle">{{ DOMAIN_JOB_STATUS_LABELS[job.data.value.data.status] ?? job.data.value.data.status }}</UBadge>
          <span>共 {{ job.data.value.data.total_items }} 项</span>
          <span v-for="(count, state) in job.data.value.data.counts"
            :key="state">{{ DOMAIN_JOB_STATUS_LABELS[state] ?? state }} {{ count }}</span>
        </div>
        <p
          class="mt-3 text-xs text-text-muted">自动刷新最多两分钟，到期可手动刷新。条目和计数以数据库事实为准；受理不代表已经评测完成。</p>
        <UAlert v-if="job.data.value.data.cancel_requested" class="mt-4" color="info"
          title="已请求取消尚未派发的条目，已受理评测仍会完成" />
        <UAlert v-if="failure" class="mt-4" color="error" :title="failure" />
        <UButton v-if="canCancel" class="mt-4" variant="outline" color="warning" :loading="cancelling"
          @click="cancel">取消未派发条目</UButton>
      </template>
    </AsyncContent>
    <AsyncContent
      :status="items.error.value ? 'error' : items.status.value === 'pending' ? 'loading' : items.data.value?.data.length ? 'data' : 'empty'"
      :error="items.error.value ? extractApiError(items.error.value).message : undefined" empty-text="没有任务条目"
      @retry="items.refresh()">
      <div class="space-y-3">
        <UCard v-for="item in items.data.value?.data" :key="item.id">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3
              class="font-medium tabular-nums">第 {{ item.ordinal + 1 }} 项 · {{ item.source_kind === 'objective' ? '客观回答' : '代码／产物提交' }}</h3>
            <UBadge variant="subtle">{{ DOMAIN_JOB_STATUS_LABELS[item.status] ?? item.status }}</UBadge>
          </div>
          <p class="mt-2 break-all text-xs text-text-muted">源提交 {{ item.source_id }} · 源题 {{ item.problem_id }}</p>
          <p
            class="mt-2 break-all font-mono text-xs text-text-muted">目标版本 {{ item.target_version_id ?? '版本未知' }}</p>
          <p v-if="item.reason_message" class="mt-2 text-sm text-text-secondary">{{ item.reason_message }}</p>
          <UButton class="mt-3" variant="outline"
            :to="workspacePath(slug!, `${item.source_kind === 'objective' ? 'objective-submissions' : 'submissions'}/${item.source_id}`)">查看原提交</UButton>
          <UButton v-if="item.result_submission_id" class="ml-2 mt-3" variant="outline"
            :to="workspacePath(slug!, `${item.source_kind === 'objective' ? 'objective-submissions' : 'submissions'}/${item.result_submission_id}`)">查看升级后的新提交</UButton>
        </UCard>
      </div>
    </AsyncContent>
    <UPagination v-if="items.data.value && items.data.value.pagination.total_pages > 1" v-model:page="page"
      :total="items.data.value.pagination.total" :items-per-page="20" />
  </div>
</template>
