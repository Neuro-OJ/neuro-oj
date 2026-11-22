<script setup lang="ts">
import { REPORT_CATEGORIES, type ReportCategory } from "~/utils/reportCategories"

const emit = defineEmits<{ close: [result: { category: ReportCategory; reason: string } | null] }>()

const open = defineModel<boolean>('open', { default: true })
// 默认选中第一个分类，满足"必选"
const category = ref<ReportCategory>(REPORT_CATEGORIES[0])
const reason = ref("")
const resolved = ref(false)

function resolve(result: { category: ReportCategory; reason: string } | null) {
  if (resolved.value) return
  resolved.value = true
  emit('close', result)
}

function confirm() {
  resolve({ category: category.value, reason: reason.value.trim() })
  open.value = false
}

function cancel() {
  resolve(null)
  open.value = false
}

// 任何关闭路径（Esc / X / backdrop）都以 null 结束，防止 Promise 悬挂
watch(open, (v) => {
  if (!v) resolve(null)
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="举报内容"
    :ui="{ content: 'bg-default flex flex-col divide-y-0 focus:outline-none', footer: 'flex justify-end gap-3 border-t border-default' }"
  >
    <template #body>
      <div class="space-y-4 py-2">
        <label class="block">
          <span class="mb-1 block text-xs text-text-secondary">举报分类 <span class="text-error-text">*</span></span>
          <USelect
            v-model="category"
            :items="[...REPORT_CATEGORIES]"
            class="w-full"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-text-secondary">举报理由（必填）</span>
          <textarea
            v-model="reason"
            class="min-h-20 w-full rounded border border-border px-3 py-2 text-sm"
            placeholder="请填写违规说明（最多 500 字）"
            maxlength="500"
          />
        </label>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="cancel">取消</UButton>
        <UButton color="primary" :disabled="!reason.trim()" @click="confirm">提交举报</UButton>
      </div>
    </template>
  </UModal>
</template>
