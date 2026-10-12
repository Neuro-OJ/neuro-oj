<script setup lang="ts">
/**
 * 统一管理详情抽屉：以右侧滑入抽屉 (Slideover) 形式展示详情 key-value。
 */
export interface AdminDetailItem {
  label: string
  value: unknown
}

const props = defineProps<{
  open: boolean
  title: string
  items?: AdminDetailItem[]
  widthClass?: string
}>()

const emit = defineEmits<{
  close: []
  "update:open": [val: boolean]
}>()

function onOpenChange(val: boolean) {
  emit("update:open", val)
  if (!val) emit("close")
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value, null, 2)
  return String(value)
}
</script>

<template>
  <USlideover
    :open="open"
    :title="title"
    side="right"
    :ui="{
      content: widthClass ?? 'sm:max-w-lg',
      header: 'px-5 py-4 border-b border-border bg-bg-page/40',
      body: 'p-5 overflow-y-auto flex-1',
      footer: 'px-5 py-3 border-t border-border bg-bg-page/30 flex justify-end',
    }"
    @update:open="onOpenChange"
  >
    <template #title>
      <div class="flex items-center gap-2 text-base font-bold text-text">
        <UIcon name="i-lucide-info" class="size-4.5 text-primary" />
        <span>{{ title }}</span>
      </div>
    </template>

    <template #body>
      <dl v-if="items && items.length > 0" class="divide-y divide-border/60">
        <div v-for="item in items" :key="item.label" class="py-3 flex flex-col sm:flex-row sm:gap-4 gap-1">
          <dt class="w-28 shrink-0 text-xs font-semibold text-text-muted">{{ item.label }}</dt>
          <dd class="text-xs text-text break-all flex-1 tabular-nums font-mono whitespace-pre-wrap">{{ formatValue(item.value) }}</dd>
        </div>
      </dl>
      <slot />
    </template>

    <template #footer>
      <UButton color="neutral" variant="outline" size="sm" @click="onOpenChange(false)">
        关闭
      </UButton>
    </template>
  </USlideover>
</template>
