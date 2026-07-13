<script setup lang="ts">
import { BookOpen, History, Settings } from '@lucide/vue'

type Tab = 'description' | 'history' | 'settings'

defineProps<{ active: Tab }>()
defineEmits<{ select: [value: Tab] }>()

interface Item {
  key: Tab
  label: string
  icon: typeof BookOpen
}

const items: Item[] = [
  { key: 'description', label: '题目描述', icon: BookOpen },
  { key: 'history', label: '提交历史', icon: History },
  { key: 'settings', label: '设置', icon: Settings },
]
</script>

<template>
  <aside class="w-12 flex-shrink-0 bg-bg-page border-r border-border flex flex-col items-center py-2 gap-1">
    <button
      v-for="item in items"
      :key="item.key"
      :title="item.label"
      :aria-label="item.label"
      :aria-pressed="active === item.key"
      class="relative w-12 h-12 flex items-center justify-center rounded-md transition-colors duration-100 hover:bg-white"
      :class="active === item.key ? 'text-primary bg-white' : 'text-text-secondary'"
      @click="$emit('select', item.key)"
    >
      <span
        v-if="active === item.key"
        class="absolute left-0 top-2 bottom-2 w-0.5 bg-primary rounded-r"
      />
      <component :is="item.icon" :size="20" />
    </button>
  </aside>
</template>
