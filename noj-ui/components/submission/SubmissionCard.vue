<template>
  <!-- Dense Workbench：一条提交 = 一行：编号 · 题目 · 结论 · 用时/内存 · 时间 -->
  <NuxtLink
    :to="domainSlug ? workspacePath(domainSlug, `submissions/${submission.public_id || submission.id}`) : publicUrl('submission', submission.public_id || submission.id)"
    class="group grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-[13px] no-underline transition-colors hover:bg-bg-sunken/60 sm:grid-cols-[72px_minmax(0,1fr)_auto_150px_64px]"
  >
    <span
      class="truncate font-mono text-[11px] text-text-muted">#{{ submission.public_id || submission.id.slice(0, 8) }}</span>
    <span class="truncate text-text group-hover:text-primary">{{ submission.problem.title }}</span>
    <SubmissionStatusBadge
      :status="submission.status"
      :result="submission.result"
      :queue-position="submission.queue_position"
    />
    <span class="hidden items-center justify-end gap-px font-mono text-[11px] tabular-nums sm:flex">
      <template v-if="submission.result">
        <template v-if="hasRuntimeConfig">
          <span
            :class="getUsageColor(submission.result.time_ms, submission.problem.runtime_config!.evaluator!.time_limit_ms)">{{ formatTimeMs(submission.result.time_ms) }}</span>
          <span class="mx-1 text-border-strong">|</span>
          <span
            :class="getUsageColor(submission.result.memory_kb, memoryLimitKb)">{{ formatMemory(submission.result.memory_kb) }}</span>
        </template>
        <template v-else>
          <span class="text-text-muted">{{ formatTimeMs(submission.result.time_ms) }}</span>
          <span class="mx-1 text-border-strong">|</span>
          <span class="text-text-muted">{{ formatMemory(submission.result.memory_kb) }}</span>
        </template>
      </template>
      <span v-else-if="submission.queue_position != null"
        class="text-text-muted">排队 #{{ submission.queue_position }}</span>
      <span v-else
        class="text-primary"><LiveElapsed :start-time="submission.judge_started_at ?? submission.created_at" /></span>
    </span>
    <span
      class="hidden text-right font-mono text-[11px] tabular-nums text-text-muted sm:block">{{ formatTime(submission.created_at) }}</span>
  </NuxtLink>
</template>

<script setup lang="ts">
import { workspacePath } from '~/utils/domain/workspace/workspace';
import { computed } from 'vue';
import { publicUrl } from '~/utils/publicIdentifiers';

interface Submission {
  id: string;
  public_id?: string;
  problem_id: string;
  problem: {
    title: string;
    runtime_config?: { evaluator?: { time_limit_ms?: number; memory_limit_mb?: number } } | null;
  };
  status: string;
  created_at: string;
  judge_started_at?: string | null;
  judge_finished_at?: string | null;
  queue_position?: number | null;
  queue_length?: number | null;
  result: {
    status: string;
    score: number;
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
}

interface Props {
  submission: Submission;
  domainSlug?: string;
}

const props = defineProps<Props>();

/** runtime_config 是否可用 */
const hasRuntimeConfig = computed(() =>
  !!props.submission.problem.runtime_config?.evaluator?.time_limit_ms &&
  !!props.submission.problem.runtime_config?.evaluator?.memory_limit_mb
);

/** 内存上限换算为 KB（用于百分比计算）；null/0 时返回 0（灰色） */
const memoryLimitKb = computed(() => (props.submission.problem.runtime_config?.evaluator?.memory_limit_mb ?? 0) * 1024);

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTimeMs(ms: number | null | undefined): string {
  if (ms == null) return '?';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(3) + 's';
}

function formatMemory(kb: number | null | undefined): string {
  if (kb == null) return '?';
  if (kb >= 1024) return (kb / 1024).toFixed(1) + 'MB';
  return kb + 'KB';
}

/**
 * 用量颜色：used/max 比例
 * - max 缺失或 ≤ 0 → 灰色（无限制信息）
 * - used ≥ max → 红色（超标）
 * - used/max ≥ 0.9 → 黄色（接近上限）
 * - 其他 → 灰色（正常）
 */
function getUsageColor(used: number | null | undefined, max: number | null | undefined): string {
  if (used == null || !max || max <= 0) return 'text-text-muted';
  if (used >= max) return 'text-error-text';
  if (used / max >= 0.9) return 'text-warning-text';
  return 'text-text-muted';
}
</script>
