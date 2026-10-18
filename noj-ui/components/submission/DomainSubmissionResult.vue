<script setup lang="ts">
import type { DomainSubmission } from '~/composables/useDomainSubmissions';
import { formatMemory, formatScore, formatTime, getResultDef } from '~/utils/submissionFormat';
interface OiSummary {
  verdict?: string;
  compile_error?: string;
  subtasks?: Array<{ id: string; score: number; max_score: number; verdict?: string; status?: string }>;
}
const props = defineProps<{ submission: DomainSubmission }>();
const visible = computed(() => props.submission.result_visibility !== 'hidden');
const oi = computed(() => (props.submission.result?.details as { oi?: OiSummary } | null)?.oi);
const verdict = computed(() => props.submission.result?.verdict ?? oi.value?.verdict);
const summary = computed(() => {
  const submission = props.submission, state = submission.status ?? submission.result?.status;
  const platformFailure = state === 'error' || submission.result?.status === 'error' || submission.attempts?.at(-1)?.result_kind === 'platform_error';
  if (platformFailure) return { label: '平台评测失败', description: '评测服务未能完成本次评测，不代表答案错误。请查看诊断，必要时联系管理员。', tone: 'error', icon: 'i-lucide-triangle-alert', pending: false };
  if (state === 'pending' || state === 'queued') return { label: '等待评测', description: '提交已受理，正在等待评测资源。', tone: 'neutral', icon: 'i-lucide-clock', pending: true };
  if (state === 'judging' || state === 'running') return { label: '正在评测', description: '评测正在进行，完成后将显示正式结果。', tone: 'neutral', icon: 'i-lucide-loader-2', pending: true };
  if (verdict.value) return { label: getResultDef(verdict.value).label, description: verdict.value === 'AC' ? '所有测试点顺利通过' : verdict.value === 'CE' ? '编译未通过，请查看下方编译诊断并修改代码。' : '本次正式判定未通过，可结合评测详情继续修改。', tone: verdict.value === 'AC' ? 'success' : 'error', icon: verdict.value === 'AC' ? 'i-lucide-check-circle-2' : 'i-lucide-alert-circle', pending: false };
  if (state === 'finished' || submission.result) return { label: '评测完成', description: submission.kind === 'objective' ? '本次客观题已完成评分。得分与是否满足作业要求分别计算。' : '本次评测已完成。请结合得分和评测详情查看结果。', tone: 'neutral', icon: 'i-lucide-check-circle-2', pending: false };
  return { label: '等待正式结果', description: '当前尚无可展示的正式评测结果。', tone: 'neutral', icon: 'i-lucide-clock', pending: false };
});
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
      :class="summary.tone === 'success' ? 'border-signal/30 bg-signal/5' : summary.tone === 'error' ? 'border-error-text/30 bg-error-text/5' : 'border-border bg-bg-panel'"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div
            class="flex size-11 shrink-0 items-center justify-center rounded-full text-xl"
            :class="summary.tone === 'success' ? 'bg-signal/20 text-signal-deep' : summary.tone === 'error' ? 'bg-error-text/10 text-error-text' : 'bg-primary-bg text-primary'"
          >
            <UIcon :name="summary.icon" class="size-6" :class="{ 'animate-pulse': summary.pending }" />
          </div>
          <div>
            <h3
              class="text-xl font-bold tracking-tight"
              :class="summary.tone === 'success' ? 'text-signal-deep' : summary.tone === 'error' ? 'text-error-text' : 'text-text'"
            >
              {{ summary.label }}
            </h3>
            <p class="text-xs text-text-muted mt-0.5">
              {{ summary.description }}
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
