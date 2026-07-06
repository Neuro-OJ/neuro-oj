<script setup lang="ts">
interface Props {
  displayId: string
  type: string
}

defineProps<Props>()
</script>

<template>
  <span
    class="font-mono text-xs font-semibold px-1.5 py-0.5 rounded"
    :class="type === 'U'
      ? 'bg-blue-100 text-blue-700'
      : 'bg-purple-100 text-purple-700'"
  >
    {{ displayId }}
  </span>
</template>
