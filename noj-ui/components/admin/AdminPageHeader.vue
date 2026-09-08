<script setup lang="ts">
/**
 * 统一管理页头：标题、描述、可选图标、面包屑占位与操作区。
 */
interface Props {
  title: string
  description?: string
  icon?: string
}

defineProps<Props>()
</script>

<template>
  <div class="flex items-start justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <slot name="breadcrumb">
        <span v-if="false" />
      </slot>
      <h1 class="text-22px font-bold text-text flex items-center gap-2">
        <UIcon v-if="icon" :name="icon" class="size-[22px] shrink-0" />
        {{ title }}
      </h1>
      <p v-if="description" class="text-sm text-text-secondary">
        {{ description }}
      </p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <slot name="actions" />
    </div>
  </div>
</template>
