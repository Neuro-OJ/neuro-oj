<script setup lang="ts">
/**
 * 通用管理筛选条。
 *
 * 用法：
 * ```vue
 * <AdminFilterBar @search="applyFilters" @reset="resetFilters">
 *   <UInput v-model="filters.keyword" />
 * </AdminFilterBar>
 * ```
 */
const modelValue = defineModel<Record<string, unknown>>("modelValue", { default: () => ({}) })

const emit = defineEmits<{
  search: []
  reset: []
}>()

function onReset() {
  modelValue.value = {}
  emit("reset")
}
</script>

<template>
  <div class="bg-white border border-border rounded-lg p-4">
    <div class="flex flex-wrap gap-3">
      <slot />
    </div>
    <div class="flex gap-2 mt-3">
      <UButton color="primary" size="sm" class="px-3.5 leading-none" @click="emit('search')">
        筛选
      </UButton>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        class="px-3.5 leading-none text-text-secondary border-border hover:border-text-secondary hover:text-text"
        @click="onReset"
      >
        重置
      </UButton>
    </div>
  </div>
</template>
