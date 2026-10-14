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
    <UCard v-else>
      <h3 class="mb-3 font-semibold">评测结果</h3>
      <div class="flex flex-wrap gap-5 text-sm tabular-nums">
        <span :class="verdict === 'AC' ? 'font-semibold text-success-text' : verdict ? 'font-semibold text-error-text' : ''">{{ verdict ? getResultDef(verdict).label : submission.result ? getStatusLabel(submission.status ?? '', submission.result.status) : '等待正式结果' }}</span>
        <span v-if="submission.result?.score != null">{{ formatScore(submission.result.score) }} 分</span>
        <span v-if="submission.result?.time_ms != null">评测耗时 {{ formatTime(submission.result.time_ms) }}</span>
        <span v-if="submission.result?.memory_kb != null">{{ formatMemory(submission.result.memory_kb) }}</span>
      </div>
    </UCard>
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
