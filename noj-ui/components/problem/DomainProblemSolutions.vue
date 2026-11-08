<script setup lang="ts">
import type { PostRow } from '~/composables/useCommunity';
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { communityApiPath } from '~/utils/community-workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';
import { canPublishSolution, needsAcceptedCheck, type SolutionConfig } from '~/utils/solutionEligibility';

const props = defineProps<{ slug: string; problemId: string }>();
const { user } = useAuth();
const { api } = useApi();
const listTo = computed(() => ({ path: workspacePath(props.slug, 'community'), query: { type: 'solution', problem_id: props.problemId } }));
const { data, error, status, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.slug, user.value?.id ?? null, 'problem-solutions', props.problemId),
  () => api.get<{ data: PostRow[] }>(communityApiPath(props.slug, 'posts'), {
    query: { type: 'solution', problem_id: props.problemId, limit: 5 }, silent: true,
  }),
);
// 发布资格只影响按钮显隐，放到客户端读取，不阻塞题面首屏；失败时按不可发布处理。
const { data: eligibility } = useAsyncData(
  () => workspaceCacheKey(props.slug, user.value?.id ?? null, 'problem-solution-eligibility', props.problemId),
  async () => {
    if (!user.value) return null;
    const config = (await api.get<{ data: SolutionConfig }>(communityApiPath(props.slug, 'config'), { silent: true })).data;
    if (!needsAcceptedCheck(config)) return { config, accepted: null };
    const result = await api.get<{ data: { accepted: boolean } }>(communityApiPath(props.slug, 'solutions/eligibility'), {
      query: { problem_id: props.problemId }, silent: true,
    });
    return { config, accepted: result.data.accepted };
  },
  { server: false, lazy: true },
);
const canPublish = computed(() =>
  canPublishSolution(eligibility.value?.config ?? null, eligibility.value?.accepted ?? null));
/** 仅因尚未通过而不能发布时提示一次，其它原因（只读、赛时静默等）不在这里解释。 */
const waitingForAccepted = computed(() => {
  const value = eligibility.value;
  return !!value && needsAcceptedCheck(value.config) && value.accepted === false &&
    canPublishSolution(value.config, true);
});
</script>

<template>
  <section id="solutions" class="scroll-mt-24 rounded-xl border border-border bg-bg-panel p-5 sm:p-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 class="text-base font-semibold text-text">题解</h2>
        <p class="mt-1 text-sm text-text-secondary">
          查看本题的公开题解<template v-if="waitingForAccepted">；<span class="text-warning-text">通过本题后可发布题解</span></template>。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton v-if="canPublish" :to="{ ...listTo, query: { ...listTo.query, compose: '1' } }" icon="i-lucide-book-open" size="sm">发布题解</UButton>
        <UButton :to="listTo" variant="outline" size="sm">查看全部</UButton>
      </div>
    </div>
    <div v-if="error" class="mt-4 flex flex-wrap items-center gap-3 text-sm text-text-muted" role="alert">
      <p>{{ extractApiError(error).message }}</p>
      <UButton variant="link" size="xs" @click="refresh()">重新读取</UButton>
    </div>
    <p v-else-if="status === 'pending' && !data" class="mt-4 text-sm text-text-muted" role="status">正在读取题解…</p>
    <ul v-else-if="data?.data.length" class="mt-4 divide-y divide-border">
      <li v-for="item in data.data" :key="item.post.id" class="flex flex-wrap items-center justify-between gap-2 py-3 last:pb-0">
        <NuxtLink :to="workspacePath(slug, `community/posts/${item.post.public_id || item.post.id}`)"
          class="flex min-w-0 items-center gap-2 text-sm text-text no-underline hover:text-primary">
          <UIcon name="i-lucide-file-text" class="size-4 shrink-0 text-text-muted" />
          <span class="break-words">{{ item.post.title }}</span>
        </NuxtLink>
        <span class="flex items-center gap-3 text-xs text-text-muted"><UserIdentity :user="item.author" size="sm" :show-avatar="false" /><time :datetime="item.post.created_at">{{ formatDateTime(item.post.created_at) }}</time></span>
      </li>
    </ul>
    <p v-else class="mt-4 text-sm text-text-muted">暂无题解，欢迎分享你的解题思路。</p>
  </section>
</template>
