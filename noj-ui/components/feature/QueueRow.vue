<!-- 队列行（正在评测 / 排队中 / 最近完成 三个分区共用）。 -->
<script setup lang="ts">
import { formatDateTime, formatScore, getLanguageLabel } from "~/utils/submissionFormat"

interface QueueItemShape {
  id: string
  problem_id: string
  problem_title: string
  language: string
  submitted_by: string
  submitted_at: string
  judge_started_at?: string | null
  status?: string
  score?: number | null
}

interface Props {
  item: QueueItemShape
  /** 实时时钟（毫秒时间戳），用于计算 elapsed */
  now: number
  /** 是否显示 elapsed 列（正在评测区） */
  showElapsed?: boolean
  /** 是否显示得分列（最近完成区） */
  showScore?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showElapsed: false,
  showScore: false,
})

function elapsed(): string {
  if (!props.item.judge_started_at) return "--"
  const ms = props.now - new Date(props.item.judge_started_at).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}
</script>

<template>
  <div class="flex items-center gap-3 px-4 py-2.5 text-13px border-b border-border last:border-b-0 hover:bg-bg-page">
    <NuxtLink :to="`/submissions/${item.id}`" class="text-blue-700 no-underline font-mono whitespace-nowrap min-w-[80px] hover:underline">#{{ item.id.slice(0, 8) }}</NuxtLink>
    <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text">{{ item.problem_id }} {{ item.problem_title }}</span>
    <span class="text-text-secondary min-w-[70px] text-center text-xs">{{ getLanguageLabel(item.language) }}</span>
    <span class="text-text-secondary min-w-[60px]">{{ item.submitted_by }}</span>
    <span class="text-text-muted text-xs min-w-[100px]">{{ formatDateTime(item.submitted_at) }}</span>
    <span v-if="showElapsed" class="inline-flex items-center gap-[3px] text-blue-700 text-xs min-w-[70px]"><UIcon name="i-lucide-clock" class="size-3.5" /> {{ elapsed() }}</span>
    <span v-if="showScore" :class="['font-semibold min-w-[60px] text-right', item.status === 'error' || (item.score !== null && item.score === 0) ? 'text-red-600' : '']">
      {{ formatScore(item.score) }} 分
    </span>
  </div>
</template>
