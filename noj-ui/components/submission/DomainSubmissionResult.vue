<script setup lang="ts">
import type { DomainSubmission } from '~/composables/useDomainSubmissions';
import { formatMemory, formatScore, formatTime, getResultDef, getStatusLabel } from '~/utils/submissionFormat';
interface OiSummary {
  verdict?: string;
  compile_error?: string;
  subtasks?: Array<{ id: string; score: number; max_score: number; verdict?: string; status?: string }>;
}
const props = defineProps<{ submission: DomainSubmission }>();
const visible = computed(() => props.submission.result_visibility !== 'hidden');
const oi = computed(() => (props.submission.result?.details as { oi?: OiSummary } | null)?.oi);
const verdict = computed(() => props.submission.result?.verdict ?? oi.value?.verdict);
const subtasks = computed(() =>
  visible.value && props.submission.resource_available && props.submission.result_visibility === 'cases'
    ? oi.value?.subtasks ?? []
    : []
);
</script>
<template>
  <div class="space-y-4">
    <UAlert v-if="!visible" color="info" title="提交已受理，比赛规定的结果暂未公开" />
    <div
      v-else
      class="rounded-lg border p-5 shadow-card transition-colors"
      :class="verdict === 'AC'
        ? 'border-signal/30 bg-signal/5'
        : verdict
        ? 'border-error-text/30 bg-error-text/5'
        : 'border-border bg-bg-panel'"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div
            class="flex size-11 shrink-0 items-center justify-center rounded-full text-xl"
            :class="verdict === 'AC'
              ? 'bg-signal/20 text-signal'
              : verdict
              ? 'bg-error-text/20 text-error-text'
              : 'bg-primary-bg text-primary animate-pulse'"
          >
            <UIcon
              :name="verdict === 'AC'
                ? 'i-lucide-check-circle-2'
                : verdict
                ? 'i-lucide-alert-circle'
                : 'i-lucide-clock'"
              class="size-6"
            />
          </div>
          <div>
            <h3
              class="text-xl font-bold tracking-tight"
              :class="verdict === 'AC' ? 'text-signal' : verdict ? 'text-error-text' : 'text-text'"
            >
              {{ verdict ? getResultDef(verdict).label : submission.result ? getStatusLabel(submission.status ?? '', submission.result.status) : '等待正式结果' }}
            </h3>
            <p class="text-xs text-text-muted mt-0.5">
              {{ verdict === 'AC' ? '所有测试点顺利通过' : verdict ? '部分测试用例未达成预期判定' : '评测排队中或正在沙箱执行' }}
            </p>
          </div>
        </div>

        <!-- 关键指标胶囊 -->
        <div class="flex flex-wrap items-center gap-2.5 text-xs tabular-nums">
          <div v-if="submission.result?.score != null" class="flex items-center gap-1.5 rounded-md border border-border bg-bg-panel px-3 py-1.5 font-semibold text-text shadow-xs">
            <span class="text-text-muted text-[11px]">得分</span>
            <span class="text-base text-primary font-bold">{{ formatScore(submission.result.score) }}</span>
            <span class="text-[11px] text-text-muted">分</span>
          </div>
          <div v-if="submission.result?.time_ms != null" class="flex items-center gap-1.5 rounded-md border border-border bg-bg-panel px-3 py-1.5 text-text-secondary shadow-xs">
            <UIcon name="i-lucide-clock" class="size-3.5 text-text-muted" />
            <span>{{ formatTime(submission.result.time_ms) }}</span>
          </div>
          <div v-if="submission.result?.memory_kb != null" class="flex items-center gap-1.5 rounded-md border border-border bg-bg-panel px-3 py-1.5 text-text-secondary shadow-xs">
            <UIcon name="i-lucide-cpu" class="size-3.5 text-text-muted" />
            <span>{{ formatMemory(submission.result.memory_kb) }}</span>
          </div>
        </div>
      </div>
    </div>
    <UCard v-if="visible && submission.resource_available && oi?.compile_error">
      <h3 class="mb-3 font-semibold text-error-text">编译诊断</h3>
      <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{{ oi.compile_error }}</pre>
    </UCard>
    <UCard v-if="subtasks.length">
      <h3 class="mb-3 font-semibold">子任务成绩</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm" aria-label="子任务成绩">
          <thead class="text-left text-text-muted"><tr><th class="pb-2">子任务</th><th class="pb-2">判定</th><th class="pb-2 text-right">得分</th></tr></thead>
          <tbody><tr v-for="subtask in subtasks" :key="subtask.id" class="border-t border-border"><td class="py-2 font-mono">{{ subtask.id }}</td><td class="py-2">{{ getResultDef(subtask.verdict ?? subtask.status).label }}</td><td class="py-2 text-right tabular-nums">{{ formatScore(subtask.score) }} / {{ formatScore(subtask.max_score) }}</td></tr></tbody>
        </table>
      </div>
    </UCard>
    <SubmissionCaseResults v-if="visible && submission.resource_available && submission.result_visibility === 'cases'"
      :details="submission.result?.details" />
    <UCard
      v-if="visible && submission.resource_available && submission.result_visibility === 'cases' && submission.result?.output">
      <h3 class="mb-3 font-semibold">评测输出</h3>
      <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{{ submission.result.output }}</pre>
    </UCard>
    <UCard v-if="visible && submission.attempts?.length">
      <h3 class="mb-3 font-semibold">评测沿革</h3>
      <ul class="space-y-2 text-sm tabular-nums">
        <li v-for="attempt in submission.attempts"
          :key="attempt.attempt_id">#{{ attempt.sequence }} · {{ attempt.version == null ? '版本未知' : `V${attempt.version}` }} · {{ attempt.state }} · {{ attempt.result_kind === 'graded' ? `${formatScore(attempt.score)} 分` : attempt.result_kind === 'platform_error' ? '平台失败' : '等待正式结果' }}</li>
      </ul>
    </UCard>
  </div>
</template>
