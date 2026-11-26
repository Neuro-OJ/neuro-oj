<script setup lang="ts">
import type { ProblemView } from '~/utils/domain/problem/problemView';
import { problemJudgeTypeLabel } from '~/utils/domain/problem/problemView';
import { formatAcceptanceRate } from '~/utils/domain/submission/submissionFormat';
import type { PublicProblemStats } from '~/utils/domain/problem/problemStats';

/**
 * 题目信息卡片（右栏）：类型 / 后端 / 提供者 / 通过率（带进度条）/ 标签。
 * 题号、难度与时空限制已由左侧 ProblemHeader 展示，此处不重复，保持高信噪比。
 */
const props = withDefaults(
  defineProps<{
    problem: ProblemView;
    stats?: PublicProblemStats | null;
    problemsTo?: string;
    calibratedTier?: 'easy' | 'medium' | 'hard' | null;
  }>(),
  { problemsTo: '/problems' },
);

const router = useRouter();

const problemTags = computed(() => props.problem.tags.filter((t) => t.kind === 'problem'));
const algorithmTags = computed(() => props.problem.tags.filter((t) => t.kind === 'algorithm'));

const acceptanceText = computed(() => {
  const stats = props.stats;
  if (!stats) return null;
  if (stats.suppressed_reason === 'running_contest') return '竞赛进行中，暂不显示';
  if (stats.submit_count === 0) return '暂无通过记录';
  return `${formatAcceptanceRate(stats.acceptance_rate)} · ${stats.accepted_count}/${stats.submit_count}`;
});

const acceptancePercent = computed(() => {
  const rate = props.stats?.acceptance_rate;
  if (rate == null || props.stats?.suppressed_reason === 'running_contest') return null;
  return Math.max(0, Math.min(100, Math.round(rate * 100)));
});
</script>

<template>
  <section class="rounded-lg border border-border bg-bg-panel p-3.5">
    <h2 class="mb-2 text-xs font-semibold text-text-secondary">题目信息</h2>
    <dl class="space-y-1.5 text-[13px]">
      <div v-if="problemJudgeTypeLabel(problem)" class="flex items-center justify-between gap-3">
        <dt class="text-text-muted">题目类型</dt>
        <dd class="font-medium text-text">{{ problemJudgeTypeLabel(problem) }}</dd>
      </div>
      <div v-if="problem.is_objective || problem.judge_backend" class="flex items-center justify-between gap-3">
        <dt class="text-text-muted">评测后端</dt>
        <dd class="font-mono text-xs text-text">{{ problem.is_objective ? '即时判定' : problem.judge_backend }}</dd>
      </div>
      <div v-if="calibratedTier" class="flex items-center justify-between gap-3">
        <dt class="text-text-muted">难度<span class="ml-1 text-xs text-text-muted">校准</span></dt>
        <dd>
          <ProblemDifficultyBadge :difficulty="calibratedTier" />
        </dd>
      </div>
      <div v-if="problem.owner_username" class="flex items-center justify-between gap-3">
        <dt class="text-text-muted">提供者</dt>
        <dd class="min-w-0">
          <UserIdentity
            :user="{ id: problem.owner_id ?? '', username: problem.owner_username, avatar_url: problem.owner_avatar_url }"
            size="sm"
            :show-avatar="false"
          />
        </dd>
      </div>
      <div class="space-y-1.5">
        <div class="flex items-center justify-between gap-3">
          <dt class="text-text-muted">通过率</dt>
          <dd class="tabular-nums text-text">{{ acceptanceText ?? '—' }}</dd>
        </div>
        <div v-if="acceptancePercent !== null" class="h-1 w-full overflow-hidden bg-bg-sunken" aria-hidden="true">
          <div class="h-full bg-signal" :style="{ width: `${acceptancePercent}%` }" />
        </div>
      </div>
    </dl>

    <div v-if="problemTags.length || algorithmTags.length || problem.has_hidden_algorithm_tags"
      class="mt-3 border-t border-border pt-2.5">
      <h3 class="mb-2 text-xs font-semibold text-text-secondary">标签</h3>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="t in problemTags"
          :key="t.id"
          type="button"
          class="inline-flex cursor-pointer items-center rounded-[4px] bg-bg-sunken px-1.5 text-[11px] leading-5 text-text-secondary transition-colors hover:bg-primary-bg hover:text-primary"
          @click="router.push({ path: problemsTo, query: { tag: t.id } })"
        >
          {{ t.name }}
        </button>
        <span
          v-for="t in algorithmTags"
          :key="t.id"
          class="inline-flex items-center rounded-[4px] bg-verdict-accepted-bg px-1.5 text-[11px] leading-5 text-signal-deep"
        >
          {{ t.name }}
        </span>
        <span
          v-if="problem.has_hidden_algorithm_tags"
          class="inline-flex cursor-default items-center gap-1 rounded-[4px] bg-bg-sunken px-1.5 text-[11px] leading-5 text-text-muted"
          title="通过本题后可查看算法标签"
        >
          <UIcon name="i-lucide-lock" class="size-3" />
          算法标签 · 通过后显示
        </span>
      </div>
    </div>
  </section>
</template>
