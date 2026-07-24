<script setup lang="ts">
interface Props {
  title: string
  description?: string
}

defineProps<Props>()
</script>

<template>
  <div class="flex items-start justify-between gap-3">
    <div class="flex flex-col gap-1">
      <h1 class="text-[22px] font-bold text-text">{{ title }}</h1>
      <p v-if="description" class="text-sm text-text-secondary">{{ description }}</p>
    </div>
    <slot name="actions" />
  </div>
</template>
