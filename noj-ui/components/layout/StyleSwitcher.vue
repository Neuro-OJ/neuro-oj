<script setup lang="ts">
import { UI_STYLES } from '~/utils/ui-styles';

/** 右下角风格切换器：用于并排比较几套视觉方案，选择写入 cookie。 */
const style = useUiStyle();
const open = ref(true);
</script>

<template>
  <div
    class="fixed right-4 bottom-4 z-[120] flex items-center gap-1 rounded-lg border border-border bg-bg-panel/90 p-1 text-xs shadow-dropdown backdrop-blur-md"
    role="group" aria-label="界面风格">
    <button type="button" class="px-1.5 text-text-muted hover:text-text" :aria-expanded="open"
      :aria-label="open ? '收起风格切换' : '展开风格切换'" @click="open = !open">
      <UIcon name="i-lucide-palette" class="size-3.5 align-middle" />
    </button>
    <template v-if="open">
      <button v-for="item in UI_STYLES" :key="item.value" type="button"
        class="rounded-md px-2 py-1 transition-colors"
        :class="style === item.value ? 'bg-primary text-[var(--ui-text-inverted,#fff)] font-medium' : 'text-text-secondary hover:bg-bg-sunken hover:text-text'"
        :aria-pressed="style === item.value" @click="style = item.value">
        {{ item.label }}
      </button>
    </template>
  </div>
</template>
