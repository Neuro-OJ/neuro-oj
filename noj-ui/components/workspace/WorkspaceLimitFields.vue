<script setup lang="ts">
import { WORKSPACE_LIMIT_FIELDS } from '~/utils/instance-governance';
import type { WorkspaceLimits } from '~/utils/workspace';
const model = defineModel<WorkspaceLimits>({ required: true });
defineProps<{ caps?: WorkspaceLimits; effective?: WorkspaceLimits; disabled?: boolean }>();
</script>
<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <div v-for="field in WORKSPACE_LIMIT_FIELDS" :key="field.key" class="space-y-2">
      <UCheckbox :model-value="model[field.key] === null" :label="`${field.label}：不额外限制`" :disabled="disabled"
        @update:model-value="model[field.key] = $event ? null : (effective?.[field.key] ?? 0)" />
      <div v-if="model[field.key] !== null" class="flex items-center gap-2">
        <UInputNumber v-model="model[field.key]" :min="0" :max="field.max" :disabled="disabled"
          :aria-label="`${field.label}上限`" />
        <span class="text-xs text-text-muted">{{ field.unit }}</span>
      </div>
      <p v-if="caps" class="text-xs text-text-muted tabular-nums">实例上限：{{ caps[field.key] ?? '不额外限制' }}</p>
      <p v-if="effective"
        class="text-xs text-text-muted tabular-nums">当前有效上限：{{ effective[field.key] ?? '不限制' }}</p>
    </div>
  </div>
</template>
