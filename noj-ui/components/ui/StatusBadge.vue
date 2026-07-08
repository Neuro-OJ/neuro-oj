<script setup lang="ts">
import { CheckCircle2, AlertCircle, Circle } from "@lucide/vue"

interface Props {
  status: 'solved' | 'attempted' | 'not_started'
}

defineProps<Props>()

const config: Record<string, { icon: any; label: string; class: string }> = {
  solved: {
    icon: CheckCircle2,
    label: '已解决',
    class: 'text-green-600',
  },
  attempted: {
    icon: AlertCircle,
    label: '尝试过',
    class: 'text-yellow-600',
  },
  not_started: {
    icon: Circle,
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
    <component :is="config[status]?.icon" :size="14" aria-hidden="true" />
    <span v-if="status !== 'not_started'">{{ config[status]?.label }}</span>
    <span v-else class="sr-only">{{ config[status]?.label }}</span>
  </span>
</template>
