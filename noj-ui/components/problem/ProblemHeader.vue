<script setup lang="ts">
import type { ProblemView } from '~/utils/domain/problem/problemView';
import { problemJudgeTypeLabel } from '~/utils/domain/problem/problemView';
import { defaultProblemLabel } from '~/utils/domain/workspace/default-workspace';
import { formatAcceptanceRate } from '~/utils/domain/submission/submissionFormat';
import { formatMemoryLimit, formatTimeLimit } from '~/utils/domain/problem/problemView';
import type { PublicProblemStats } from '~/utils/domain/problem/problemStats';

/**
 * 题目头部标识区（#511）：编号胶囊 + 类型/客观题徽章 + 标题 + 作者 +
 * 右对齐统计条（提交数/通过数/时间限制/内存限制）+ 右上角操作插槽。
 *
 * 由独立题目页与竞赛做题页共用，消除第二份题面实现与第二套硬编码难度色。
 */
const props = withDefaults(
  defineProps<{
    problem: ProblemView;
    /** 公开统计；null 表示未加载或接口不可用（不渲染对应数值项）。 */
    stats?: PublicProblemStats | null;
    /** 竞赛进行中时后端抑制统计，显示占位而非空白。 */
    suppressedReason?: 'running_contest' | null;
    showOwner?: boolean;
    /** 是否在 Header 中展示题目类型、评测后端及通过统计（独立详情页已由右栏承载时传 false 去重）。 */
    showStats?: boolean;
    /**
     * 知识图谱的校准难度档位（P2）：有值时优先于出题人自报难度显示，
     * 没有时沿用原显示，保证关闭知识图谱后行为不变。
     */
    calibratedTier?: 'easy' | 'medium' | 'hard' | null;
  }>(),
  {
    showStats: true,
  },
);

/**
 * 插槽：
 * - `leading`：编号胶囊之前的上下文（如竞赛页「返回竞赛」与题号）；
 * - `titleSuffix`：标题右侧补充（如竞赛名）；
 * - `actions`：右上角主操作按钮。
 */
defineSlots<{
  leading?: () => unknown;
  titleSuffix?: () => unknown;
  actions?: () => unknown;
}>();

/** 统计条是否整体不可用（赛期抑制）。 */
const suppressed = computed(
  () => props.suppressedReason === 'running_contest' || props.stats?.suppressed_reason === 'running_contest',
);
</script>

<template>
  <header
    class="flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
    <div class="min-w-0 flex-1">
      <div class="mb-1 flex flex-wrap items-center gap-2">
        <slot name="leading" />
        <span
          class="inline-flex items-center font-mono text-xs text-text-muted"
        >
          {{ defaultProblemLabel(problem.display_id) }}
        </span>
        <span
          v-if="showStats && problemJudgeTypeLabel(problem)"
          class="inline-flex items-center font-mono text-xs text-text-secondary"
        >
          {{ problemJudgeTypeLabel(problem) }}
        </span>
        <span
          v-if="showStats && !problem.is_objective && problem.judge_backend"
          class="inline-flex items-center font-mono text-xs text-text-muted"
          aria-label="评测后端"
        >
          {{ problem.judge_backend }}
        </span>
        <!--
          难度徽章（#511 评审修正）：早先难度只在独立页右栏的 ProblemMetaCard 渲染，
          而竞赛做题页不挂载该卡片，导致**竞赛页难度彻底消失**（相对重构前是回归）。
          放入头部后两种来源都可见，难度色仍只走 DifficultyBadge 一处。
        -->
        <ProblemDifficultyBadge
          v-if="calibratedTier || problem.difficulty"
          :difficulty="calibratedTier ?? problem.difficulty"
          :title="calibratedTier ? '校准难度（依据本站作答数据）' : undefined"
        />
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold text-text">{{ problem.title }}</h1>
        <slot name="titleSuffix" />
      </div>
      <UserIdentity
        v-if="showOwner !== false && problem.owner_username"
        :user="{ id: problem.owner_id ?? '', username: problem.owner_username, avatar_url: problem.owner_avatar_url }"
        size="sm"
        class="mt-2"
      />
    </div>

    <!-- 窄屏纵向堆叠：统计条单独成行，避免把标题列挤到逐字换行。 -->
    <div class="flex w-full flex-col items-start gap-2 sm:w-auto sm:items-end">
      <div class="flex flex-wrap items-center gap-2 sm:justify-end">
        <slot name="actions" />
      </div>
      <dl class="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-text-secondary sm:justify-end">
        <template v-if="showStats && suppressed">
          <div class="flex items-center gap-1">
            <span>竞赛进行中，暂不显示通过率</span>
          </div>
        </template>
        <template v-else-if="showStats">
          <div v-if="stats" class="flex items-center gap-1">
            <dt class="sr-only">提交数</dt>
            <dd class="tabular-nums">{{ stats.submit_count ?? '—' }} 次提交</dd>
          </div>
          <div v-if="stats" class="flex items-center gap-1">
            <dt class="sr-only">通过数</dt>
            <dd class="tabular-nums">{{ stats.accepted_count ?? '—' }} 次通过</dd>
          </div>
          <div v-if="stats" class="flex items-center gap-1">
            <dt class="sr-only">通过率</dt>
            <dd class="tabular-nums">{{ formatAcceptanceRate(stats.acceptance_rate) }}</dd>
          </div>
        </template>
        <div v-if="!problem.is_objective && problem.time_limit_ms != null" class="flex items-center gap-1">
          <dt class="sr-only">时间限制</dt>
          <dd class="tabular-nums">{{ formatTimeLimit(problem.time_limit_ms) }}</dd>
        </div>
        <div v-if="!problem.is_objective && problem.memory_limit_mb != null" class="flex items-center gap-1">
          <dt class="sr-only">内存限制</dt>
          <dd class="tabular-nums">{{ formatMemoryLimit(problem.memory_limit_mb) }}</dd>
        </div>
        <div v-if="problem.is_objective" class="flex items-center gap-1">
          <span>服务端即时判定</span>
        </div>
      </dl>
    </div>
  </header>
</template>
