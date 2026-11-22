<script setup lang="ts">
/**
 * 统一表单字段包装：label、必填标记、错误提示、帮助文案。
 */
defineProps<{
  label: string
  required?: boolean
  error?: string
  hint?: string
}>()
</script>

<template>
  <div class="flex flex-col gap-1">
    <label class="text-xs font-semibold text-text-secondary">
      {{ label }}
      <span v-if="required" class="text-error-text"> *</span>
    </label>
    <slot />
    <p v-if="hint" class="text-xs text-text-muted">{{ hint }}</p>
    <p v-if="error" class="text-xs text-error-text">{{ error }}</p>
  </div>
</template>
