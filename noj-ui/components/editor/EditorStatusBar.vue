<script setup lang="ts">
const props = defineProps<{
  language: string
  cursor: { line: number; col: number }
  totalLines: number
  totalChars: number
}>()

const charsLabel = computed(() => {
  return `${props.totalChars.toLocaleString('zh-CN')} 字符`
})
</script>

<template>
  <div class="h-6 flex-shrink-0 bg-bg-dark-2 border-t border-bg-dark-3 flex items-center px-3 gap-4 text-[11px] text-text-muted font-mono">
    <span>{{ language }}</span>
    <span>Ln {{ cursor.line }}, Col {{ cursor.col }}</span>
    <span>{{ totalLines }} 行</span>
    <span>{{ charsLabel }}</span>
  </div>
</template>
