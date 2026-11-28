<script setup lang="ts">
import { workspaceCacheKey, workspacePath, workspaceProblemPath } from '~/utils/domain/workspace/workspace';
import { extractApiError } from '~/utils/server/apiError';

const props = defineProps<{ domainSlug: string }>();
const { user } = useAuth();
const api = useDomainProblems();
const key = computed(() => workspaceCacheKey(props.domainSlug, user.value?.id ?? null, 'home-problems'));
const { data, error, status, refresh } = await useAsyncData(
  key,
  () => api.list(props.domainSlug, 1, '', {}),
);
const problems = computed(() => (data.value?.items ?? []).slice(0, 3));
</script>

<template>
  <section class="overflow-hidden rounded-lg border border-border bg-bg-panel" aria-label="推荐题目">
    <div class="flex flex-wrap items-center gap-2 border-b border-border bg-bg-sunken/50 px-3 py-1.5">
      <h2 class="mr-auto text-xs font-semibold text-text-secondary">推荐题目</h2>
      <NuxtLink
        :to="workspacePath(domainSlug, 'problems')"
        class="text-xs text-primary no-underline hover:underline"
      >
        全部题目 →
      </NuxtLink>
    </div>
    <AsyncContent
      :status="error ? 'error' : problems.length ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined"
      empty-text="暂无公开题目"
      @retry="refresh()"
    >
      <ul class="divide-y divide-border-subtle">
        <li v-for="problem in problems" :key="problem.reference.display_ref">
          <NuxtLink
            :to="workspaceProblemPath(domainSlug, problem.reference.display_ref)"
            class="flex items-center gap-2.5 px-3 py-2 text-[13px] no-underline hover:bg-bg-sunken/60"
          >
            <span class="shrink-0 font-mono text-xs tabular-nums text-text-secondary">
              {{ problem.reference.display_ref }}
            </span>
            <span class="min-w-0 flex-1 truncate font-medium text-text">{{ problem.title }}</span>
            <span class="shrink-0 font-mono text-[11px] text-text-muted">
              {{ { oi: 'OI', ai: 'AI', objective: '客观' }[problem.kind] }}
            </span>
            <ProblemDifficultyBadge v-if="problem.difficulty" :difficulty="problem.difficulty" />
            <span
              v-if="problem.valid_submissions"
              class="hidden shrink-0 font-mono text-xs tabular-nums text-text-muted sm:inline"
            >
              {{ ((problem.accepted_submissions ?? 0) * 100 / problem.valid_submissions).toFixed(1) }}%
            </span>
          </NuxtLink>
        </li>
      </ul>
    </AsyncContent>
  </section>
</template>
