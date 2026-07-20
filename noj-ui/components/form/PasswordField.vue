<template>
  <div class="relative mb-7">
    <label :for="id" class="block text-sm font-semibold text-text mb-1">
      {{ label }}
      <span v-if="required" class="text-red-600">*</span>
    </label>
    <div class="relative flex items-center">
      <Lock class="absolute left-[10px] text-text-muted pointer-events-none" :size="18" />
      <input
        :id="id"
        :value="modelValue"
        :type="visible ? 'text' : 'password'"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :disabled="disabled"
        class="w-full px-3 py-2 pl-9 border-[1.5px] border-border rounded-md text-sm text-text bg-white outline-none transition-[border-color] duration-200 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @focus="$emit('focus')"
      />
      <button
        type="button"
        class="absolute right-3 bg-transparent border-0 text-text-muted cursor-pointer p-0 flex items-center hover:text-text-secondary"
        @click="visible = !visible"
        tabindex="-1"
      >
        <span class="flex items-center justify-center w-[18px] h-[18px]">
          <Transition name="icon" mode="out-in">
            <EyeOff v-if="!visible" :size="18" key="off" />
            <Eye v-else :size="18" key="on" />
          </Transition>
        </span>
      </button>
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
import { Lock, Eye, EyeOff, X } from "@lucide/vue"

const props = defineProps<{
  id: string
  label: string
  modelValue: string
  placeholder: string
  autocomplete: string
  disabled: boolean
  required?: boolean
  error?: string
}>()

defineEmits<{
  "update:modelValue": [value: string]
  focus: []
}>()

const visible = ref(false)
</script>
