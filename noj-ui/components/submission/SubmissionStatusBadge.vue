<template>
  <!-- Dense Workbench：结论 = 色块 + 彩色文字，不用胶囊底色 -->
  <span
    v-if="result"
    class="inline-flex w-fit items-center gap-1.5 justify-self-end whitespace-nowrap text-xs font-medium"
    :style="{ color }"
  ><span class="size-2 rounded-[1px]" :style="{ background: color }" />{{ label }}</span>
  <span
    v-else-if="queue_position != null"
    class="inline-flex w-fit items-center gap-1.5 justify-self-end whitespace-nowrap text-xs font-medium text-verdict-pending"
  ><span class="size-2 rounded-[1px] bg-current" />等待评测</span>
  <span
    v-else
    class="inline-flex w-fit items-center gap-1.5 justify-self-end whitespace-nowrap text-xs font-medium text-verdict-judging"
  ><span class="size-2 animate-pulse rounded-[1px] bg-current" />评测中</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { getStatusColor, getStatusLabel } from '~/utils/domain/submission/submissionFormat';

interface Props {
  /** 提交流 state（pending / judging / error） */
  status: string;
  /** 评测结果（null 表示正在评测中） */
  result: { status: string } | null;
  /** 排队位置（null 表示不在等待队列中） */
  queue_position?: number | null;
}

const props = defineProps<Props>();

const color = computed(() => getStatusColor(props.status, props.result?.status));
const label = computed(() => getStatusLabel(props.status, props.result?.status));
</script>
