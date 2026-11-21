<script setup lang="ts">
/**
 * 刷新控制条：轮询间隔选择 + 手动刷新按钮 + 最近刷新时间。
 *
 * 纯 UI 组件：轮询逻辑由页面经 usePolling 管理，
 * 间隔通过 v-model:interval 双向绑定（number | null，null = 关闭）。
 */
interface IntervalOption {
  label: string
  value: number | null
}

/** 覆盖各页面默认间隔（提交 3s / 仪表盘 5s / 其余 30s） */
const INTERVAL_OPTIONS: IntervalOption[] = [
  { label: "关闭", value: null },
  { label: "3 秒", value: 3000 },
  { label: "5 秒", value: 5000 },
  { label: "10 秒", value: 10000 },
  { label: "30 秒", value: 30000 },
  { label: "1 分钟", value: 60000 },
]

const interval = defineModel<number | null>("interval", { default: null })

defineProps<{
  /** 最近一次成功刷新时间 */
  lastRefresh: Date | null
  /** 手动刷新进行中（按钮旋转动画） */
  refreshing?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

// ─── 最近刷新时间（相对当前时间，100ms 精度刷新，单位 s/m/h 简写）────
// setInterval 仅客户端可用：放入 onMounted（Nuxt 禁止服务端定时器）
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  nowTimer = setInterval(() => { now.value = Date.now() }, 100)
})
onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer)
})

/** 精确到小数点后一位（整数补 0），如 1s → 1.0s；分钟/小时同理 */
function formatRelativeTime(d: Date): string {
  const diff = Math.max(0, now.value - d.getTime())
  if (diff < 60_000) return `${(diff / 1_000).toFixed(1)}s`
  if (diff < 3_600_000) return `${(diff / 60_000).toFixed(1)}m`
  return `${(diff / 3_600_000).toFixed(1)}h`
}
</script>

<template>
  <div class="flex items-center gap-2 flex-wrap">
    <USelect
      v-model="interval"
      :items="INTERVAL_OPTIONS"
      size="sm"
      class="w-[130px]"
      aria-label="自动刷新间隔"
    />
    <UButton
      color="neutral"
      variant="outline"
      size="sm"
      class="text-text-secondary bg-white border-border hover:border-text-secondary"
      :disabled="refreshing"
      @click="emit('refresh')"
    >
      <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': refreshing }" class="size-4" />
      {{ refreshing ? "刷新中..." : "刷新" }}
    </UButton>
    <span v-if="lastRefresh" class="text-xs text-text-muted" :title="lastRefresh.toLocaleString('zh-CN')">
      最近刷新：{{ formatRelativeTime(lastRefresh) }}
    </span>
  </div>
</template>
