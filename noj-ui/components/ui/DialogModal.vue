<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    title?: string
    message: string
    mode?: 'confirm' | 'alert' | 'prompt'
    danger?: boolean
    confirmText?: string
    cancelText?: string
    placeholder?: string
  }>(),
  {
    title: undefined,
    mode: 'confirm',
    danger: false,
    confirmText: '确认',
    cancelText: '取消',
    placeholder: undefined,
  },
)

const emit = defineEmits<{ close: [value: unknown]; 'after:leave': [] }>()
const open = defineModel<boolean>('open', { default: true })
const input = ref('')
const resolved = ref(false)

const modalTitle = computed(() => {
  if (props.title) return props.title
  return props.mode === 'confirm' ? '确认操作' : props.mode === 'prompt' ? '输入' : '提示'
})

function resolve(value: unknown) {
  if (resolved.value) return
  resolved.value = true
  emit('close', value)
}

// 任何关闭路径（Esc / X / backdrop / 按钮）都以默认结果 resolve，防止 Promise 悬挂
watch(open, (v) => {
  if (!v) resolve(props.mode === 'prompt' ? null : false)
})

function onConfirm() {
  resolve(props.mode === 'prompt' ? input.value : true)
}

function onCancel() {
  resolve(props.mode === 'prompt' ? null : false)
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="modalTitle"
    :description="message"
    :ui="{ content: 'bg-default flex flex-col divide-y-0 focus:outline-none', footer: 'flex justify-end gap-3 border-t border-default' }"
    @after:leave="$emit('after:leave')"
  >
    <template v-if="mode === 'prompt'" #body>
      <UInput v-model="input" :placeholder="placeholder" class="mt-1" @keyup.enter="onConfirm" />
    </template>

    <template #footer>
      <UButton v-if="mode !== 'alert'" color="neutral" variant="ghost" @click="onCancel">
        {{ cancelText }}
      </UButton>
      <UButton :color="danger ? 'error' : 'primary'" @click="onConfirm">
        {{ confirmText }}
      </UButton>
    </template>
  </UModal>
</template>
