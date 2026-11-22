<script setup lang="ts">
type Tab = 'description' | 'history' | 'settings' | 'self-test'

const props = withDefaults(defineProps<{
  active: Tab
  showSelfTest?: boolean
}>(), {
  showSelfTest: false,
})
defineEmits<{ select: [value: Tab] }>()

interface Item {
  key: Tab
  label: string
  icon: string
}

const items = computed<Item[]>(() => [
  { key: 'description', label: '题目描述', icon: 'i-lucide-book-open' },
  { key: 'history', label: '提交历史', icon: 'i-lucide-history' },
  ...(props.showSelfTest
    ? [{ key: 'self-test' as const, label: '自测', icon: 'i-lucide-flask-conical' }]
    : []),
  { key: 'settings', label: '设置', icon: 'i-lucide-settings' },
])
</script>

<template>
  <aside class="w-12 flex-shrink-0 bg-white border-r border-border flex flex-col items-center py-2 gap-1">
    <button
      v-for="item in items"
      :key="item.key"
      :title="item.label"
      :aria-label="item.label"
      :aria-pressed="active === item.key"
      class="relative w-12 h-12 flex items-center justify-center rounded-md transition-colors duration-100 hover:bg-bg-page"
      :class="active === item.key ? 'text-primary bg-bg-page' : 'text-text-secondary'"
      @click="$emit('select', item.key)"
    >
      <span
        v-if="active === item.key"
        class="absolute left-0 top-2 bottom-2 w-0.5 bg-signal rounded-r"
      />
      <UIcon :name="item.icon" class="size-5" />
    </button>
  </aside>
</template>
