<script setup lang="ts">
interface Props {
  status: 'solved' | 'attempted' | 'not_started'
}

defineProps<Props>()

const config: Record<string, { icon: string; label: string; class: string }> = {
  solved: {
    icon: 'i-lucide-circle-check',
    label: '已解决',
    class: 'text-green-600',
  },
  attempted: {
    icon: 'i-lucide-circle-alert',
    label: '尝试过',
    class: 'text-yellow-600',
  },
  not_started: {
    icon: 'i-lucide-circle',
    label: '未开始',
    class: 'text-text-muted',
  },
}
</script>

<template>
  <span
    class="inline-flex items-center gap-1 text-xs font-medium"
    :class="config[status]?.class"
  >
    <UIcon :name="config[status]?.icon" class="size-3.5" aria-hidden="true" />
    <span v-if="status !== 'not_started'">{{ config[status]?.label }}</span>
    <span v-else class="sr-only">{{ config[status]?.label }}</span>
  </span>
</template>
