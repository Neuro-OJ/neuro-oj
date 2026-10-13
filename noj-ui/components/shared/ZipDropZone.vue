<script setup lang="ts">
/**
 * zip 拖拽/点击选择区（题目包导入与支持包上传共用）。
 *
 * 只负责"拿到一个 .zip 文件"：扩展名不对时就地提示，不发请求；
 * 禁用 / 处理中时点击与拖拽投放都不生效（否则拖拽会绕过 disabled）。
 */
import { validateZipFileName } from "~/utils/bundleImport"

interface Props {
  disabled?: boolean
  busy?: boolean
  /** 禁用时的说明文案。 */
  disabledHint?: string
  /** 处理中的说明文案。 */
  busyHint?: string
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  busy: false,
  disabledHint: "",
  busyHint: "上传中...",
})

const emit = defineEmits<{ file: [file: File] }>()

const fileInput = ref<HTMLInputElement | null>(null)
const isDragOver = ref(false)
const localError = ref("")

const inactive = computed(() => props.disabled || props.busy)

function pick(file: File | undefined) {
  if (!file) return
  const error = validateZipFileName(file.name)
  localError.value = error ?? ""
  if (!error) emit("file", file)
}

function onClick() {
  if (!inactive.value) fileInput.value?.click()
}

function onFileSelect(e: Event) {
  const target = e.target as HTMLInputElement
  pick(target.files?.[0])
  // 重置 input，允许重复选择同一文件
  target.value = ""
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (!inactive.value) isDragOver.value = true
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  if (inactive.value) return
  pick(e.dataTransfer?.files?.[0])
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div
      data-testid="zip-drop-zone"
      class="relative flex flex-col items-center justify-center gap-2 px-4 py-6 border-2 border-dashed rounded-lg transition-colors"
      :class="[
        isDragOver
          ? 'border-signal bg-primary-bg cursor-pointer'
          : inactive
            ? 'border-border bg-gray-50 cursor-not-allowed'
            : 'border-border cursor-pointer hover:border-primary hover:bg-primary-bg',
      ]"
      @dragover="onDragOver"
      @dragleave="isDragOver = false"
      @drop="onDrop"
      @click="onClick"
    >
      <UIcon v-if="busy" name="i-lucide-loader-circle" class="size-6 text-primary animate-spin" />
      <UIcon v-else name="i-lucide-upload" class="size-6 text-text-secondary" />

      <p v-if="busy" class="text-xs text-text-secondary">{{ busyHint }}</p>
      <p v-else-if="disabled" class="text-xs text-text-muted text-center">{{ disabledHint }}</p>
      <template v-else>
        <p class="text-xs text-text-secondary text-center">
          <span class="text-primary font-semibold">点击选择</span> 或将 zip 文件拖拽到此区域
        </p>
        <p class="text-xs text-text-muted">仅支持 .zip 格式</p>
      </template>

      <input
        ref="fileInput"
        type="file"
        accept=".zip"
        class="hidden"
        :disabled="inactive"
        @change="onFileSelect"
      />
    </div>
    <p v-if="localError" class="flex items-center gap-1.5 text-xs text-red-600">
      <UIcon name="i-lucide-alert-circle" class="size-3" />
      {{ localError }}
    </p>
  </div>
</template>
