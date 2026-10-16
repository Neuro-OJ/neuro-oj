<script setup lang="ts">
defineProps<{ title: string; description?: string; icon: string; count?: string }>();
</script>

<template>
  <header class="flex flex-wrap items-center justify-between gap-4">
    <div class="flex min-w-0 items-center gap-3">
      <div class="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary-bg text-primary">
        <UIcon :name="icon" class="size-5" />
      </div>
      <div class="min-w-0">
        <h1 class="text-2xl font-bold leading-tight text-text">{{ title }}</h1>
        <p v-if="description" class="mt-1 text-xs leading-relaxed text-text-muted">{{ description }}</p>
      </div>
    </div>
    <div v-if="count || $slots.actions" class="flex flex-wrap items-center gap-2.5">
      <span v-if="count" class="rounded-md border border-border bg-bg-sunken px-2.5 py-1 text-xs tabular-nums text-text-muted">{{ count }}</span>
      <slot name="actions" />
    </div>
  </header>
</template>
