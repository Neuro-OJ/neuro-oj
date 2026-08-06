<script setup lang="ts">
/**
 * 评测实时耗时（仅客户端）。
 *
 * 独立组件使 100ms 定时器只重渲染这一个文本节点，
 * 避免整个提交列表每 100ms 全量重渲染导致 CPU 打满。
 */
const props = defineProps<{ startTime: string }>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, 100)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function formatTimeMs(ms: number): string {
  if (ms < 1000) return ms + "ms"
  return (ms / 1000).toFixed(3) + "s"
}

const elapsed = computed(() => {
  const ms = Math.max(0, now.value - new Date(props.startTime).getTime())
  return formatTimeMs(ms)
})
</script>

<template>
  <span class="font-mono tabular-nums text-blue-500">{{ elapsed }}</span>
</template>
