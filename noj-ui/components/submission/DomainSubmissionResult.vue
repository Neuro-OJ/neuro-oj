<script setup lang="ts">
import type { DomainSubmission } from '~/composables/useDomainSubmissions';
import { formatMemory, formatScore, formatTime, getStatusLabel } from '~/utils/submissionFormat';
const props = defineProps<{ submission: DomainSubmission }>();
const visible = computed(() => props.submission.result_visibility !== 'hidden');
</script>
<template>
  <div class="space-y-4">
    <UAlert v-if="!visible" color="info" title="提交已受理，比赛规定的结果暂未公开" />
    <UCard v-else>
      <h3 class="mb-3 font-semibold">评测结果</h3>
      <div class="flex flex-wrap gap-5 text-sm tabular-nums">
        <span>{{ submission.result ? getStatusLabel(submission.status ?? '', submission.result.status) : '等待正式结果' }}</span>
        <span v-if="submission.result?.score != null">{{ formatScore(submission.result.score) }} 分</span>
        <span v-if="submission.result?.time_ms != null">{{ formatTime(submission.result.time_ms) }}</span>
        <span v-if="submission.result?.memory_kb != null">{{ formatMemory(submission.result.memory_kb) }}</span>
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
