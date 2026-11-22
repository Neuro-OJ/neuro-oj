<script setup lang="ts">
import { problemUrl } from '~/utils/publicIdentifiers'

defineProps<{
  id: string
  displayId?: string
  title?: string
}>()
</script>

<template>
  <NuxtLink :to="problemUrl(id, displayId)" class="inline-flex flex-wrap items-baseline gap-x-2 text-primary no-underline hover:underline">
    <span v-if="displayId" class="font-mono text-xs">{{ displayId }}</span>
    <span>{{ title || '查看题目' }}</span>
  </NuxtLink>
</template>
