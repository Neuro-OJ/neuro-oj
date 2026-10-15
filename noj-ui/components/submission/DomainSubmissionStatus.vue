<script setup lang="ts">
import type { DomainSubmission } from '~/composables/useDomainSubmissions';
import { formatScore, getResultDef, getStatusLabel } from '~/utils/submissionFormat';
const props = defineProps<{ submission: DomainSubmission }>();
const hidden = computed(() => props.submission.result_visibility === 'hidden');
const verdict = computed(() =>
  props.submission.result?.verdict ??
    (props.submission.result?.details as { oi?: { verdict?: string } } | null)?.oi?.verdict
);
</script>
<template>
  <span class="inline-flex flex-wrap items-center gap-2 text-xs tabular-nums">
    <UBadge v-if="hidden" color="neutral" variant="subtle">已受理</UBadge>
    <template v-else>
      <span
        :class="verdict==='AC' ? 'font-medium text-success-text' : verdict || submission.status==='error' ? 'text-error-text' : 'text-text-secondary'">{{ verdict ? getResultDef(verdict).label : getStatusLabel(submission.status ?? 'pending', submission.result?.status) }}</span>
      <span v-if="submission.result?.score!=null"
        class="font-mono text-text-secondary">{{ formatScore(submission.result.score) }} 分</span>
    </template>
  </span>
</template>
