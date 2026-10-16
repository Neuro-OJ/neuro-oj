<!-- 队列行（正在评测 / 排队中 / 最近完成 三个分区共用）。 -->
<script setup lang="ts">
import { computed } from "vue"
import { formatDateTime, formatScore, getLanguageLabel } from "~/utils/submissionFormat"
import { publicUrl } from "~/utils/publicIdentifiers"

interface QueueItemShape {
  id: string
  public_id?: string
  problem_id: string
  problem_title: string
  language: string
  submitted_by: string
  submitted_at: string
  domain_id?: string
  domain_slug?: string
  kind?: 'submission' | 'self_test'
  resource_pool?: 'oi-wasm' | 'oi-native' | 'ai'
  waiting_reason?: 'pool_full' | 'user_busy' | 'memory'
  judge_started_at?: string | null
  judge_finished_at?: string | null
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

const waitingLabels = { pool_full: '资源池已满', user_busy: '等待用户槽位', memory: '等待内存预算' }

function elapsed(): string {
  if (!props.item.judge_started_at) return "--"
  const ms = props.now - new Date(props.item.judge_started_at).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function shortId(val: string): string {
  if (!val) return ''
  return val.length > 12 ? `${val.slice(0, 8)}…` : val
}

const problemDisplay = computed(() => {
  const title = props.item.problem_title?.trim()
  const id = props.item.problem_id?.trim()
  if (!title) return id || ''
  if (!id || id.includes('-') || id.length > 16) {
    return title
  }
  return `${id} ${title}`
})
</script>

<template>
  <div class="flex items-center gap-3 px-4 py-2.5 text-13px border-b border-border last:border-b-0 hover:bg-bg-page">
    <NuxtLink v-if="item.kind !== 'self_test'"
      :to="item.domain_slug ? `/d/${item.domain_slug}/submissions/${item.public_id || item.id}` : publicUrl('submission', item.public_id || item.id)"
      :title="`完整提交编号: ${item.public_id || item.id}`"
      class="text-blue-700 no-underline font-mono whitespace-nowrap min-w-[70px] hover:underline">
      #{{ shortId(item.public_id || item.id) }}
    </NuxtLink>
    <span v-else class="inline-flex items-center gap-1 font-mono whitespace-nowrap min-w-[70px] text-purple-700" :title="`完整自测号: ${item.public_id || item.id}`">
      <UIcon name="i-lucide-flask-conical" class="size-3.5" />
      #{{ shortId(item.public_id || item.id) }}
    </span>
    <UBadge v-if="item.domain_slug" color="neutral" variant="subtle" size="xs">@{{ item.domain_slug }}</UBadge>
    <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text" :title="problemDisplay">{{ problemDisplay }}</span>
    <UBadge v-if="item.resource_pool" color="neutral" variant="outline" size="sm">{{ item.resource_pool }}</UBadge>
    <UBadge v-if="item.waiting_reason" color="warning" variant="subtle" size="sm">{{ waitingLabels[item.waiting_reason] }}</UBadge>
    <span v-if="item.kind === 'self_test'" class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700">自测</span>
    <span class="text-text-secondary min-w-[70px] text-center text-xs">{{ getLanguageLabel(item.language) }}</span>
    <span class="text-text-secondary min-w-[60px]">{{ item.submitted_by }}</span>
    <span class="text-text-muted text-xs min-w-[100px]">{{ formatDateTime(item.submitted_at) }}</span>
    <span v-if="showElapsed" class="inline-flex items-center gap-[3px] text-blue-700 text-xs min-w-[70px]"><UIcon name="i-lucide-clock" class="size-3.5" /> {{ elapsed() }}</span>
    <span v-if="showScore" :class="['font-semibold min-w-[60px] text-right', item.status === 'error' || (item.score !== null && item.score === 0) ? 'text-red-600' : '']">
      {{ formatScore(item.score) }} 分
    </span>
  </div>
</template>
