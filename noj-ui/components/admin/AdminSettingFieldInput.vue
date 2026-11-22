<script setup lang="ts">
import { computed } from 'vue';

export type SettingType = 'boolean' | 'string' | 'text' | 'integer';
export type SettingSource = 'db' | 'env' | 'default';
export type SettingScope = 'runtime' | 'bootstrap';

export interface SystemSetting {
  key: string;
  type: SettingType;
  effective_value: unknown;
  raw_value: string;
  source: SettingSource;
  scope: SettingScope;
  is_secret: boolean;
  description: string;
  updated_at: string | null;
  updated_by: string | null;
  category: string;
  min?: number;
  max?: number;
  needsRestart?: boolean;
  db_orphaned?: boolean;
  env_key?: string;
  env_present?: boolean;
  db_present?: boolean;
  conflict?: boolean;
}

const props = defineProps<{
  setting: SystemSetting;
  modelValue: unknown;
  disabled?: boolean;
  templateId: 'desktop' | 'mobile';
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', val: unknown): void;
  (e: 'editSecret'): void;
}>();

const ariaDescribedby = computed(() => {
  const helpId = `${props.setting.key}-help-${props.templateId}`;
  if (props.error) {
    return `${helpId} ${props.setting.key}-error-${props.templateId}`;
  }
  return helpId;
});
</script>

<template>
  <div class="w-full">
    <!-- boolean: USwitch -->
    <div v-if="setting.type === 'boolean'" class="inline-flex items-center gap-2">
      <USwitch
        :id="`setting-input-${setting.key}-${templateId}`"
        :model-value="Boolean(modelValue)"
        :disabled="disabled"
        color="primary"
        :aria-label="`${setting.description} (${setting.key})`"
        :aria-describedby="ariaDescribedby"
        @update:model-value="emit('update:modelValue', $event)"
      />
      <span class="text-xs font-mono tabular-nums text-text-secondary">
        {{ modelValue ? 'true' : 'false' }}
      </span>
    </div>

    <!-- string: UInput -->
    <div v-else-if="setting.type === 'string'" class="flex items-center gap-2">
      <template v-if="setting.is_secret">
        <UInput
          :id="`setting-input-${setting.key}-${templateId}`"
          :model-value="modelValue === null ? '' : String(modelValue)"
          :disabled="disabled || modelValue === null"
          :placeholder="modelValue === null ? '•••••••• 点击「编辑」以修改' : ''"
          :aria-label="`${setting.description} (${setting.key})`"
          :aria-describedby="ariaDescribedby"
          class="w-full font-mono text-xs"
          @update:model-value="emit('update:modelValue', $event)"
        />
        <UButton
          v-if="modelValue === null"
          size="xs"
          color="primary"
          variant="outline"
          :disabled="disabled"
          :aria-label="`编辑敏感字段 ${setting.description}`"
          @click="emit('editSecret')"
        >
          编辑
        </UButton>
      </template>
      <UInput
        v-else
        :id="`setting-input-${setting.key}-${templateId}`"
        :model-value="modelValue === null || modelValue === undefined ? '' : String(modelValue)"
        :disabled="disabled"
        :aria-label="`${setting.description} (${setting.key})`"
        :aria-describedby="ariaDescribedby"
        class="w-full font-mono text-xs"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>

    <!-- text: UTextarea -->
    <div v-else-if="setting.type === 'text'">
      <UTextarea
        :id="`setting-input-${setting.key}-${templateId}`"
        :model-value="modelValue === null || modelValue === undefined ? '' : String(modelValue)"
        :rows="2"
        :maxlength="1000"
        :disabled="disabled"
        :aria-label="`${setting.description} (${setting.key})`"
        :aria-describedby="ariaDescribedby"
        class="w-full text-xs font-mono"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>

    <!-- integer: UInput (number) -->
    <div v-else-if="setting.type === 'integer'">
      <UInput
        :id="`setting-input-${setting.key}-${templateId}`"
        :model-value="modelValue === null || modelValue === undefined ? '' : String(modelValue)"
        type="number"
        step="1"
        :min="setting.min"
        :max="setting.max"
        :disabled="disabled"
        :aria-label="`${setting.description} (${setting.key})`"
        :aria-describedby="ariaDescribedby"
        class="w-full font-mono text-xs"
        @update:model-value="emit('update:modelValue', $event === '' ? null : Number($event))"
      />
    </div>
  </div>
</template>
