<script setup lang="ts">
import type { DomainSubmission } from '~/composables/useDomainSubmissions';
import { formatScore, getResultDef, getStatusLabel } from '~/utils/submissionFormat';
const props = defineProps<{ submission: DomainSubmission }>();
const hidden = computed(() => props.submission.result_visibility === 'hidden');
const verdict = computed(() =>
  props.submission.result?.verdict ??
    (props.submission.result?.details as { oi?: { verdict?: string } } | null)?.oi?.verdict
);
const isError = computed(() =>
  props.submission.status === 'error' || props.submission.result?.status === 'error'
);
const statusText = computed(() => {
  if (isError.value) return '平台评测失败';
  if (verdict.value) return getResultDef(verdict.value).label;
  if (props.submission.status === 'submitted') return '已受理';
  return getStatusLabel(props.submission.status ?? 'pending', props.submission.result?.status);
});
</script>
<template>
  <span class="inline-flex flex-wrap items-center gap-2 text-xs tabular-nums">
    <UBadge v-if="hidden" color="neutral" variant="subtle">已受理</UBadge>
    <template v-else>
      <span
        :class="verdict === 'AC' ? 'font-medium text-success-text' : verdict || isError ? 'text-error-text' : 'text-text-secondary'">
        {{ statusText }}
      </span>
      <span v-if="!isError && submission.result?.score != null"
        class="font-mono text-text-secondary">{{ formatScore(submission.result.score) }} 分</span>
    </template>
  </span>
</template>
