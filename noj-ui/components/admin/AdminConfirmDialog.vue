<script setup lang="ts">
/**
 * 统一确认弹窗。
 */
defineProps<{
  open: boolean
  title: string
  message: string
  confirmText?: string
  danger?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

function onOpenChange(val: boolean) {
  if (!val) emit("cancel")
}
</script>

<template>
  <UModal :model-value="open" @update:model-value="onOpenChange">
    <UCard :ui="{ body: 'p-5', footer: 'p-4' }" class="max-w-md w-full">
      <h3 class="text-base font-semibold text-text">{{ title }}</h3>
      <p class="mt-2 text-sm text-text-secondary whitespace-pre-line">{{ message }}</p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="outline" size="sm" @click="emit('cancel')">
            取消
          </UButton>
          <UButton :color="danger ? 'error' : 'primary'" size="sm" @click="emit('confirm')">
            {{ confirmText ?? "确认" }}
          </UButton>
        </div>
      </template>
    </UCard>
  </UModal>
</template>
