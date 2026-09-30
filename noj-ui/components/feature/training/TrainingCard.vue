<script setup lang="ts">
import type { Training } from '~/composables/useTrainings'
import { publicUrl } from '~/utils/publicIdentifiers'

defineProps<{ training: Training }>()
</script>

<template>
  <NuxtLink
    :to="publicUrl('training', training.public_id || training.id)"
    class="group flex min-h-44 flex-col rounded-xl border border-border bg-white p-5 text-text no-underline shadow-sm transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-card"
  >
    <div class="flex items-start justify-between gap-3">
      <h2 class="line-clamp-2 text-lg font-bold transition-colors group-hover:text-primary">
        {{ training.title }}
      </h2>
      <span
        v-if="training.is_pinned"
        class="rounded-full bg-warning-bg px-2.5 py-1 text-xs font-semibold text-warning-text"
      >
        置顶
      </span>
    </div>
    <p class="mt-2 line-clamp-2 text-sm leading-6 text-text-secondary">
      {{ training.description || '暂无简介' }}
    </p>
    <div class="mt-auto flex items-center gap-4 border-t border-border pt-3 text-xs text-text-secondary">
      <span>{{ training.problem_count }} 题</span>
      <span v-if="training.visibility === 'private'" class="ml-auto">私有</span>
      <span v-else-if="training.visibility === 'unlisted'" class="ml-auto">链接可见</span>
      <span v-else class="ml-auto">公开</span>
    </div>
  </NuxtLink>
</template>
