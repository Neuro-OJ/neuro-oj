<script setup lang="ts">
import type { DomainSelfTest } from '~/composables/useDomainSelfTests';
import { formatMemory, formatScore, formatTime } from '~/utils/submissionFormat';
const props = defineProps<{ record: DomainSelfTest }>();
interface CaseStream {
  case_id: string;
  status: string;
  stdout?: string;
  stderr?: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}
const oi = computed(() =>
  props.record.details?.oi as { compile_error?: string; subtasks?: Array<{ cases?: CaseStream[] }> } | undefined
);
const cases = computed(() =>
  props.record.resource_available ? oi.value?.subtasks?.flatMap((item) => item.cases ?? []) ?? [] : []
);
// 自测只包含公开样例与用户输入；正式完成后不能让最后一条进度覆盖最终判定。
const details = computed(() => oi.value
  ? { cases: cases.value.map(item => ({ ...item, visibility: 'visible' })) }
  : props.record.details);
const progress = computed(() => ['pending', 'judging'].includes(props.record.status) ? props.record.progress : null);
const statuses = {
  pending: '等待运行',
  judging: '运行中',
  finished: '自测完成',
  error: '运行失败',
  cancelled: '已取消',
};
</script>
<template>
  <div class="space-y-4">
    <p
      class="text-sm tabular-nums">{{ statuses[record.status] }}<span v-if="record.status === 'finished'"> · {{ formatScore(record.score) }} 分</span><span v-if="record.time_ms != null"> · {{ formatTime(record.time_ms) }}</span><span v-if="record.memory_kb != null"> · {{ formatMemory(record.memory_kb) }}</span></p>
    <UAlert v-if="!record.resource_available" color="warning" title="源资源不可用，只保留原自测和授权成绩摘要" />
    <template v-else>
      <SubmissionCaseResults :details="details" :progress="progress" />
      <UCard v-if="oi?.compile_error">
        <h3 class="mb-2 font-semibold">编译诊断</h3>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{{ oi.compile_error }}</pre>
      </UCard>
      <UCard v-for="item in cases.filter((entry) => entry.stdout != null || entry.stderr != null)" :key="item.case_id">
        <h3 class="mb-2 text-sm font-semibold">{{ item.case_id }} · {{ item.status }}</h3>
        <p class="mb-1 text-xs text-text-muted">实际输出 stdout</p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{{ item.stdout ?? '' }}</pre>
        <p v-if="item.stdout_truncated" class="mt-1 text-xs text-warning-text">实际输出已截断</p>
        <template v-if="item.stderr">
          <p class="mb-1 mt-3 text-xs text-text-muted">标准错误 stderr</p>
          <pre class="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{{ item.stderr }}</pre>
        </template>
        <p v-if="item.stderr_truncated" class="mt-1 text-xs text-warning-text">标准错误已截断</p>
      </UCard>
      <UCard v-if="record.output">
        <h3 class="mb-2 font-semibold">自测输出</h3>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{{ record.output }}</pre>
        <p v-if="record.output_truncated" class="mt-2 text-xs text-warning-text">输出已由服务端截断</p>
      </UCard>
    </template>
  </div>
</template>
