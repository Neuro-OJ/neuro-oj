<template>
  <div class="relative mb-7">
    <label :for="id" class="block text-sm font-semibold text-text mb-1">{{ label }}</label>
    <div class="relative flex items-center">
      <span v-if="$slots.icon" class="absolute left-[10px] text-text-muted pointer-events-none flex items-center">
        <slot name="icon" />
      </span>
      <input
        :id="id"
        :value="modelValue"
        :type="type"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :disabled="disabled"
        class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
        :class="{ 'pl-9': $slots.icon }"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @focus="$emit('focus')"
      />
    </div>
    <Transition name="drop">
      <div v-if="error" class="absolute top-[calc(100%+4px)] left-0 right-0 flex items-center justify-between gap-1 text-[13px] text-red-700">
        <span>{{ error }}</span>
        <X :size="14" />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { X } from "@lucide/vue"

defineProps<{
  id: string
  label: string
  modelValue: string
  type?: string
  placeholder: string
  autocomplete: string
  disabled: boolean
  error?: string
}>()

defineEmits<{
  "update:modelValue": [value: string]
  focus: []
}>()
</script>
