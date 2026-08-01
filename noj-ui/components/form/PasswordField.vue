<script setup lang="ts">
const model = defineModel<string>({ required: true })

withDefaults(
  defineProps<{
    id: string
    label: string
    placeholder: string
    autocomplete: string
    disabled: boolean
    required?: boolean
    error?: string
  }>(),
  {
    required: false,
    error: undefined,
  },
)

const emit = defineEmits<{ focus: [] }>()

const visible = ref(false)
</script>

<template>
  <UField :label="label" :error="error" :required="required">
    <UInput
      v-model="model"
      :type="visible ? 'text' : 'password'"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :disabled="disabled"
      class="w-full"
      :ui="{ base: 'w-full' }"
      @focus="emit('focus')"
    >
      <template #leading>
        <UIcon name="i-lucide-lock" class="size-4" />
      </template>
      <template #trailing>
        <button
          type="button"
          tabindex="-1"
          class="flex cursor-pointer items-center text-text-muted hover:text-text-secondary"
          :aria-label="visible ? '隐藏密码' : '显示密码'"
          @click="visible = !visible"
        >
          <UIcon :name="visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" class="size-4" />
        </button>
      </template>
    </UInput>
  </UField>
</template>
