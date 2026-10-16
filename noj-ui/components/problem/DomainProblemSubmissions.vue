<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime, getStatusLabel } from '~/utils/submissionFormat';

const props = defineProps<{ slug: string; problemId: string }>();
const { user } = useAuth();
const api = useDomainSubmissions();
const historyTo = computed(() => ({
  path: workspacePath(props.slug, 'submissions'),
  query: { problem_id: props.problemId, username: user.value?.username ?? '' },
}));
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.slug, user.value?.id ?? null, 'problem-submissions', props.problemId),
  () => user.value
    ? api.list(props.slug, 1, { problem_id: props.problemId, username: user.value.username, per_page: 5 })
    : Promise.resolve(null),
);
</script>

<template>
  <section class="rounded-xl border border-border bg-bg-panel p-5">
    <div class="mb-3 flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold text-text">我的提交</h2>
      <NuxtLink v-if="user" :to="historyTo" class="text-xs text-primary no-underline hover:underline">全部提交</NuxtLink>
    </div>
    <p v-if="!user" class="text-sm text-text-secondary">登录后查看本题的提交记录。</p>
    <div v-else-if="error" class="space-y-2 text-sm text-text-secondary" role="alert">
      <p>{{ extractApiError(error).message }}</p>
      <UButton color="neutral" variant="link" size="xs" @click="refresh()">重新读取</UButton>
    </div>
    <p v-else-if="status === 'pending' && !data" class="text-sm text-text-muted" role="status">正在读取提交…</p>
    <ul v-else-if="data?.data.length" class="divide-y divide-border">
      <li v-for="submission in data.data" :key="`${submission.kind}:${submission.id}`" class="py-3 first:pt-0 last:pb-0">
        <NuxtLink :to="workspacePath(slug, `${submission.kind === 'objective' ? 'objective-submissions' : 'submissions'}/${submission.id}`)"
          class="flex items-center justify-between gap-3 text-sm text-text no-underline hover:text-primary">
          <span class="min-w-0 truncate font-mono text-xs">#{{ (submission.public_id || submission.id).slice(0, 8) }}</span>
          <span v-if="submission.result_visibility === 'hidden'" class="text-xs text-text-muted">结果暂不公开</span>
          <span v-else-if="submission.result?.score != null" class="shrink-0 font-semibold tabular-nums"
            :class="submission.result.score > 0 ? 'text-success-text' : 'text-error-text'">{{ (submission.result.score / 100).toFixed(1) }} 分</span>
          <span v-else class="text-xs text-text-muted">{{ getStatusLabel(submission.status ?? 'pending', submission.result?.status) }}</span>
        </NuxtLink>
        <time class="mt-1 block text-xs tabular-nums text-text-muted" :datetime="submission.created_at">{{ formatDateTime(submission.created_at) }}</time>
      </li>
    </ul>
    <p v-else class="text-sm text-text-secondary">你还没有提交过本题。</p>
  </section>
</template>
