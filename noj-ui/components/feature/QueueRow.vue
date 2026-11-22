<!-- 队列行（正在评测 / 排队中 / 最近完成 三个分区共用）。 -->
<script setup lang="ts">
import { computed } from "vue"
import { formatDateTime, formatScore, getLanguageLabel } from "~/utils/submissionFormat"
import { publicUrl } from "~/utils/publicIdentifiers"
import { useToast } from "~/composables/useToast"

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

const { toast } = useToast()

const fullId = computed(() => props.item.public_id || props.item.id)

async function copyId(id: string) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(id)
      toast.success('已复制完整编号')
    } else {
      toast.error('当前浏览器不支持自动复制，请在详情查看完整编号')
    }
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

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
  <div class="border-b border-border last:border-b-0 hover:bg-bg-page px-3 sm:px-4 py-2.5 text-13px">
    <!-- 桌面端单行呈现 (sm 及以上) -->
    <div class="hidden sm:flex items-center gap-3">
      <div class="flex items-center gap-1 shrink-0">
        <NuxtLink
          v-if="item.kind !== 'self_test'"
          :to="item.domain_slug ? `/d/${item.domain_slug}/submissions/${fullId}` : publicUrl('submission', fullId)"
          :title="`完整提交编号: ${fullId}`"
          class="text-blue-700 no-underline font-mono whitespace-nowrap min-w-[70px] hover:underline"
        >
          #{{ shortId(fullId) }}
        </NuxtLink>
        <span
          v-else
          class="inline-flex items-center gap-1 font-mono whitespace-nowrap min-w-[70px] text-purple-700"
          :title="`完整自测号: ${fullId}`"
        >
          <UIcon name="i-lucide-flask-conical" class="size-3.5" />
          #{{ shortId(fullId) }}
        </span>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-copy"
          class="size-5 p-0 opacity-60 hover:opacity-100"
          aria-label="复制完整编号"
          :title="`复制完整编号: ${fullId}`"
          @click.stop="copyId(fullId)"
        />
      </div>
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

    <!-- 移动端多行有主次呈现 (sm 以下，不撑宽视口) -->
    <div class="sm:hidden space-y-1.5">
      <!-- 顶行：编号、复制、域、自测标签、耗时/得分/等待原因 -->
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-1 min-w-0">
          <NuxtLink
            v-if="item.kind !== 'self_test'"
            :to="item.domain_slug ? `/d/${item.domain_slug}/submissions/${fullId}` : publicUrl('submission', fullId)"
            :title="`完整提交编号: ${fullId}`"
            class="text-blue-700 no-underline font-mono text-xs whitespace-nowrap hover:underline font-semibold"
          >
            #{{ shortId(fullId) }}
          </NuxtLink>
          <span
            v-else
            class="inline-flex items-center gap-1 font-mono text-xs whitespace-nowrap text-purple-700 font-semibold"
            :title="`完整自测号: ${fullId}`"
          >
            <UIcon name="i-lucide-flask-conical" class="size-3.5" />
            #{{ shortId(fullId) }}
          </span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-copy"
            class="size-5 p-0 opacity-70 hover:opacity-100"
            aria-label="复制完整编号"
            :title="`复制完整编号: ${fullId}`"
            @click.stop="copyId(fullId)"
          />
          <UBadge v-if="item.domain_slug" color="neutral" variant="subtle" size="xs">@{{ item.domain_slug }}</UBadge>
          <span v-if="item.kind === 'self_test'" class="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700">自测</span>
        </div>

        <div class="shrink-0 flex items-center gap-1.5 text-xs">
          <span v-if="showElapsed" class="inline-flex items-center gap-[3px] text-blue-700 font-medium">
            <UIcon name="i-lucide-clock" class="size-3" /> {{ elapsed() }}
          </span>
          <span v-if="showScore" :class="['font-semibold', item.status === 'error' || (item.score !== null && item.score === 0) ? 'text-red-600' : 'text-text']">
            {{ formatScore(item.score) }} 分
          </span>
          <UBadge v-if="item.waiting_reason" color="warning" variant="subtle" size="xs">{{ waitingLabels[item.waiting_reason] }}</UBadge>
        </div>
      </div>

      <!-- 主行：题目 -->
      <div class="font-medium text-text text-sm truncate" :title="problemDisplay">
        {{ problemDisplay }}
      </div>

      <!-- 次行：用户、语言、资源池、时间 -->
      <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-text-secondary">
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-user" class="size-3 text-text-muted" />
          {{ item.submitted_by }}
        </span>
        <span class="text-text-muted">·</span>
        <span>{{ getLanguageLabel(item.language) }}</span>
        <template v-if="item.resource_pool">
          <span class="text-text-muted">·</span>
          <UBadge color="neutral" variant="outline" size="xs">{{ item.resource_pool }}</UBadge>
        </template>
        <span class="ml-auto text-text-muted tabular-nums">{{ formatDateTime(item.submitted_at) }}</span>
      </div>
    </div>
  </div>
</template>
