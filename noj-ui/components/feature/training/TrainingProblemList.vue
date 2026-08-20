<script setup lang="ts">
import type { TrainingProblem } from '~/composables/useTrainings'

defineProps<{ problems: TrainingProblem[] }>()
</script>

<template>
  <ol class="divide-y divide-border rounded-xl border border-border bg-white">
    <li
      v-for="(problem, index) in problems"
      :key="problem.problem_id"
      class="flex items-center gap-4 px-5 py-3"
    >
      <span class="w-8 text-center text-sm text-text-secondary">{{ index + 1 }}</span>
      <span
        class="flex size-6 items-center justify-center rounded-full text-xs"
        :class="problem.accepted ? 'bg-success-bg text-success-text' : 'bg-gray-100 text-text-muted'"
      >
        {{ problem.accepted ? '✓' : '' }}
      </span>
      <NuxtLink
        :to="`/problems/${problem.display_id}`"
        class="flex-1 font-medium hover:text-primary"
      >
        {{ problem.display_id }} · {{ problem.title }}
      </NuxtLink>
      <span class="text-xs text-text-secondary">{{ problem.difficulty }}</span>
    </li>
  </ol>
</template>
