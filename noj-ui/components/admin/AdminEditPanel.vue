<script setup lang="ts">
/**
 * 通用编辑抽屉：基于 USlideover，支持右侧滑出、乐观锁版本展示与冲突操作。
 *
 * 用法：
 * ```vue
 * <AdminEditPanel
 *   :open="editOpen"
 *   title="编辑标签"
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
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    widthClass?: string
    version?: string
    conflict?: boolean
    loading?: boolean
    saveText?: string
  }>(),
  {
    widthClass: "sm:max-w-xl",
    version: undefined,
    conflict: false,
    loading: false,
    saveText: "保存变更",
  },
)

const emit = defineEmits<{
  close: []
  "update:open": [val: boolean]
  save: []
  "conflict-refresh": []
  "conflict-discard": []
}>()

function onOpenChange(val: boolean) {
  emit("update:open", val)
  if (!val) emit("close")
}
</script>

<template>
  <USlideover
    :open="open"
    :title="title"
    side="right"
    :ui="{
      content: widthClass,
      header: 'px-5 py-4 border-b border-border bg-bg-page/40',
      body: 'p-5 overflow-y-auto flex-1 flex flex-col gap-4',
      footer: 'px-5 py-3 border-t border-border bg-bg-page/30 flex items-center justify-between',
    }"
    @update:open="onOpenChange"
  >
    <template #title>
      <div class="flex items-center gap-2 text-base font-bold text-text">
        <UIcon name="i-lucide-edit-3" class="size-4.5 text-primary" />
        <span>{{ title }}</span>
        <span v-if="version" class="text-xs text-text-muted font-mono bg-bg-page px-1.5 py-0.5 rounded border border-border">
          v:{{ version.slice(0, 8) }}
        </span>
      </div>
    </template>

    <template #body>
      <!-- 乐观锁冲突告警 -->
      <div v-if="conflict" class="rounded-lg bg-amber-50 border border-amber-200 p-3.5 text-xs text-amber-900 flex flex-col gap-2">
        <div class="flex items-center gap-1.5 font-semibold">
          <UIcon name="i-lucide-alert-triangle" class="size-4 text-amber-600" />
          <span>检测到并发修改冲突</span>
        </div>
        <p class="text-amber-800 leading-relaxed">
          该内容已被其他管理员修改。你可以刷新获取最新版本并合并，或放弃当前本地修改。
        </p>
        <div class="flex gap-2 mt-1">
          <UButton color="neutral" variant="outline" size="xs" @click="emit('conflict-refresh')">
            刷新并合并
          </UButton>
          <UButton color="error" variant="ghost" size="xs" @click="emit('conflict-discard')">
            放弃当前修改
          </UButton>
        </div>
      </div>

      <!-- 表单插槽主体 -->
      <slot />
    </template>

    <template #footer>
      <slot name="footer">
        <div class="flex items-center justify-between w-full">
          <UButton color="neutral" variant="ghost" size="sm" @click="onOpenChange(false)">
            取消
          </UButton>
          <div class="flex items-center gap-2">
            <UButton color="primary" size="sm" :loading="loading" @click="emit('save')">
              {{ saveText }}
            </UButton>
          </div>
        </div>
      </slot>
    </template>
  </USlideover>
</template>
