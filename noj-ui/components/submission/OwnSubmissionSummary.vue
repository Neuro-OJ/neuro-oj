<script setup lang="ts">
import type { OwnSubmissionHistory } from '~/utils/own-submissions';
import { formatMemory, formatScore, formatTime } from '~/utils/submissionFormat';
defineProps<{ entry: OwnSubmissionHistory }>();
</script>
<template>
  <UAlert v-if="entry.result_visibility === 'hidden'" color="info" title="提交已受理，比赛规定的结果暂未公开" />
  <UAlert v-else-if="entry.result?.status === 'error'" color="warning" title="平台评测失败，等待处理" />
  <div v-else class="flex flex-wrap items-center gap-4 text-sm tabular-nums">
    <span v-if="entry.is_valid && entry.is_accepted" class="text-success-text">已通过</span>
    <span v-else-if="entry.result?.verdict">{{ entry.result.verdict }}</span>
    <span
      v-else>{{ ['pending', 'judging'].includes(entry.status) ? '评测中' : entry.result ? '已有结果' : '等待正式结果' }}</span>
    <span v-if="entry.result?.score != null">{{ formatScore(entry.result.score) }} 分</span>
    <span v-if="entry.result?.time_ms != null">{{ formatTime(entry.result.time_ms) }}</span>
    <span v-if="entry.result?.memory_kb != null">{{ formatMemory(entry.result.memory_kb) }}</span>
    <span v-if="entry.is_valid === false" class="text-xs text-text-muted">未计入当前域有效成绩</span>
  </div>
</template>
