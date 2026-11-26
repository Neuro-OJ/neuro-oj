<script setup lang="ts">
// Dense Workbench：页头只占一行——标题、说明、计数、操作，不放装饰图标方块。
// icon 保留为可选入参以兼容既有调用，但不再渲染。
defineProps<{ title: string; description?: string; icon?: string; count?: string }>();
</script>

<template>
  <header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-3">
    <div class="flex min-w-0 items-baseline gap-3">
      <h1 class="text-lg font-semibold leading-tight text-text">{{ title }}</h1>
      <p v-if="description" class="truncate text-xs text-text-muted">{{ description }}</p>
      <span v-if="count" class="font-mono text-xs tabular-nums text-text-muted">{{ count }}</span>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
