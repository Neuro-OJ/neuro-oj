<script setup lang="ts">
/**
 * 通用编辑面板：基于 UModal，支持乐观锁版本展示与冲突操作。
 *
 * 用法：
 * ```vue
 * <AdminEditPanel
 *   :open="editOpen"
 *   title="编辑题目"
 *   :version="editingVersion"
 *   :conflict="conflict"
 *   @close="editOpen = false"
 *   @save="save"
 *   @conflict-refresh="refreshAndMerge"
 *   @conflict-discard="discardEdit"
 * >
 *   <form>...</form>
 * </AdminEditPanel>
 * ```
 */
defineProps<{
  open: boolean
  title: string
  width?: string
  version?: string
  conflict?: boolean
}>()

const emit = defineEmits<{
  close: []
  save: []
  "conflict-refresh": []
  "conflict-discard": []
}>()

function onOpenChange(val: boolean) {
  if (!val) emit("close")
}
</script>

<template>
  <UModal :model-value="open" @update:model-value="onOpenChange">
    <UCard
      :ui="{ body: 'p-5 sm:p-6', footer: 'p-4 sm:p-5' }"
      class="w-full"
      :class="width ?? 'max-w-lg'"
    >
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold text-text">{{ title }}</h3>
          <span v-if="version" class="text-xs text-text-muted font-mono">
            版本：{{ version.slice(0, 8) }}
          </span>
        </div>
      </template>

      <div v-if="conflict" class="mb-4 rounded-lg bg-warning-text/10 border border-warning-text/30 px-4 py-3 text-sm text-warning-text">
        内容已被其他管理员修改。你可以刷新到最新版本并合并当前修改，或放弃编辑。
      </div>

      <slot />

      <template #footer>
        <div class="flex justify-end gap-2">
          <template v-if="conflict">
            <UButton color="primary" size="sm" @click="emit('conflict-refresh')">
              刷新并覆盖
            </UButton>
            <UButton color="neutral" variant="outline" size="sm" @click="emit('conflict-discard')">
              放弃编辑
            </UButton>
          </template>
          <template v-else>
            <UButton color="neutral" variant="outline" size="sm" @click="emit('close')">
              取消
            </UButton>
            <UButton color="primary" size="sm" @click="emit('save')">
              保存
            </UButton>
          </template>
          <slot name="footer" />
        </div>
      </template>
    </UCard>
  </UModal>
</template>
