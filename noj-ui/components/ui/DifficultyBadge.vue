<script setup lang="ts">
interface Props {
  /**
   * 难度等级。已知值：easy / medium / hard。
   * 未知值会显示兜底 neutral 色 + 原文。
   */
  difficulty: string
}

defineProps<Props>()

const config: Record<string, { label: string; color: 'success' | 'warning' | 'error' }> = {
  easy: { label: '简单', color: 'success' },
  medium: { label: '中等', color: 'warning' },
  hard: { label: '困难', color: 'error' },
}
</script>

<template>
  <UBadge size="sm" variant="subtle" :color="config[difficulty]?.color ?? 'neutral'" class="shrink-0 justify-self-end">
    {{ config[difficulty]?.label ?? difficulty }}
  </UBadge>
</template>
