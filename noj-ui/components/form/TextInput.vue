<script setup lang="ts">
const model = defineModel<string>({ required: true })

withDefaults(
  defineProps<{
    id: string
    label: string
    type?: string
    placeholder: string
    autocomplete: string
    disabled: boolean
    error?: string
  }>(),
  {
    type: 'text',
    error: undefined,
  },
)

const emit = defineEmits<{ focus: [] }>()
</script>

<template>
  <UField :label="label" :error="error">
    <UInput
      v-model="model"
      :type="type"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :disabled="disabled"
      class="w-full"
      :ui="{ base: 'w-full' }"
      @focus="emit('focus')"
    >
      <template v-if="$slots.icon" #leading>
        <slot name="icon" />
      </template>
    </UInput>
  </UField>
</template>
