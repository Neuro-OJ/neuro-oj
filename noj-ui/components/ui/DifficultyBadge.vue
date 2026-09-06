<script setup lang="ts">
interface Props {
  /**
   * 难度等级。已知值：easy / medium / hard。
   * 未知值会显示兜底 neutral 色 + 原文。
   */
  difficulty: string
}

defineProps<Props>()
const { isEnglish } = useI18n()

const config: Record<string, { label: string; color: 'success' | 'warning' | 'error' }> = {
  easy: { label: '简单', color: 'success' },
  medium: { label: '中等', color: 'warning' },
  hard: { label: '困难', color: 'error' },
}
const labels = computed<Record<string, string>>(() => isEnglish.value
  ? { easy: 'Easy', medium: 'Medium', hard: 'Hard' }
  : { easy: '简单', medium: '中等', hard: '困难' })
</script>

<template>
  <UBadge size="sm" variant="subtle" :color="config[difficulty]?.color ?? 'neutral'" class="shrink-0 justify-self-end">
    {{ labels[difficulty] ?? config[difficulty]?.label ?? difficulty }}
  </UBadge>
</template>
