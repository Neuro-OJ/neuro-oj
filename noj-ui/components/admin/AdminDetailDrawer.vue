<script setup lang="ts">
/**
 * 统一详情抽屉/弹层：以 key-value 列表展示详情。
 */
import type { PropType } from "vue"

export interface AdminDetailItem {
  label: string
  value: unknown
}

defineProps<{
  open: boolean
  title: string
  items: AdminDetailItem[]
}>()

const emit = defineEmits<{
  close: []
}>()

function onOpenChange(val: boolean) {
  if (!val) emit("close")
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
</script>

<template>
  <UModal :model-value="open" @update:model-value="onOpenChange">
    <UCard :ui="{ body: 'p-5', footer: 'p-4' }" class="max-w-lg w-full">
      <template #header>
        <h3 class="text-base font-semibold text-text">{{ title }}</h3>
      </template>
      <dl class="divide-y divide-border">
        <div v-for="item in items" :key="item.label" class="py-2.5 flex gap-4">
          <dt class="w-32 shrink-0 text-sm text-text-muted">{{ item.label }}</dt>
          <dd class="text-sm text-text break-all">{{ formatValue(item.value) }}</dd>
        </div>
        <slot />
      </dl>
      <template #footer>
        <div class="flex justify-end">
          <UButton color="neutral" variant="outline" size="sm" @click="emit('close')">
            关闭
          </UButton>
        </div>
      </template>
    </UCard>
  </UModal>
</template>
