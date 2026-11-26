<script setup lang="ts">
interface Props {
  /**
   * 难度等级。已知值：easy / medium / hard。
   * 未知值会显示兜底 neutral 色 + 原文。
   */
  difficulty: string;
}

defineProps<Props>();

// Dense Workbench：难度用三格刻度 + 彩色文字表达，不用填色徽章。
const config: Record<string, { label: string; level: number; cls: string }> = {
  easy: { label: '简单', level: 1, cls: 'text-diff-easy' },
  medium: { label: '中等', level: 2, cls: 'text-diff-medium' },
  hard: { label: '困难', level: 3, cls: 'text-diff-hard' },
};
</script>

<template>
  <span class="inline-flex shrink-0 items-center gap-1.5 justify-self-end whitespace-nowrap text-xs font-medium"
    :class="config[difficulty]?.cls ?? 'text-text-muted'">
    <span v-if="config[difficulty]" class="inline-flex items-end gap-px" aria-hidden="true">
      <span v-for="i in 3" :key="i" class="w-[3px] rounded-[1px]" :class="[i <= config[difficulty]!.level ? 'bg-current' : 'bg-border-strong', ['h-1.5','h-2','h-2.5'][i-1]]" />
    </span>
    {{ config[difficulty]?.label ?? difficulty }}
  </span>
</template>
