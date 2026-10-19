<script setup lang="ts">
import type { PostRow } from '~/composables/useCommunity';
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { communityApiPath } from '~/utils/community-workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';

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
</script>

<template>
  <section id="solutions" class="scroll-mt-24 rounded-xl border border-border bg-bg-panel p-5 sm:p-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 class="text-base font-semibold text-text">题解与讨论</h2>
        <p class="mt-1 text-sm text-text-secondary">查看本题的公开题解，或在通过后分享思路。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton v-if="user" :to="{ ...listTo, query: { ...listTo.query, compose: '1' } }" icon="i-lucide-book-open" size="sm">发布题解</UButton>
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
        <span class="flex items-center gap-3 text-xs text-text-muted"><UserIdentity :user="item.author" :domain="slug" size="sm" /><time :datetime="item.post.created_at">{{ formatDateTime(item.post.created_at) }}</time></span>
      </li>
    </ul>
    <p v-else class="mt-4 text-sm text-text-muted">暂无题解，欢迎分享你的解题思路。</p>
  </section>
</template>
