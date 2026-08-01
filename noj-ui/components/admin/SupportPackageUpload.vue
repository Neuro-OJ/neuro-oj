<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'

const { api } = useApi()
interface Props {
  problemId: string | null
  hasPackage: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
})

const emit = defineEmits<{
  "package-changed": [hasPackage: boolean]
}>()

// ── 上传状态 ──
const uploading = ref(false)
const uploadError = ref("")
const showGuide = ref(false)

// ── 拖拽状态 ──
const isDragOver = ref(false)

// ── 文件选择 ──
const fileInput = ref<HTMLInputElement | null>(null)

function triggerFileSelect() {
  if (props.disabled || uploading.value) return
  fileInput.value?.click()
}

function onFileSelect(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) handleFile(file)
  // 重置 input，允许重复选择同一文件
  target.value = ""
}

// ── 拖拽事件 ──
function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (!props.disabled && !uploading.value) isDragOver.value = true
}

function onDragLeave() {
  isDragOver.value = false
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) handleFile(file)
}

// ── 文件处理 ──
function handleFile(file: File) {
  // 前端验证：仅 .zip
  if (!file.name.toLowerCase().endsWith(".zip")) {
    uploadError.value = "仅支持 .zip 格式文件"
    return
  }

  uploadError.value = ""
  doUpload(file)
}

async function doUpload(file: File) {
  if (!props.problemId) return

  uploading.value = true
  uploadError.value = ""
  try {
    // 统一题目包导入端点（problem-bundle-import）：manifest.number 仅管理员
    // 生效——按 (type, number) 匹配既有题目则更新（未命中则新建）；普通用户
    // 提供 number 会被 400 拒绝，上传仅创建新题（题号自动分配）。
    const formData = new FormData()
    formData.append("file", file)

    await api.post(`/api/v1/problems/import-bundle`, formData)

    emit("package-changed", true)
  } catch (err: unknown) {
    uploadError.value = extractApiError(err).message
  } finally {
    uploading.value = false
  }
}

// ── 删除 ──
const deleting = ref(false)
const { dialog } = useDialog()

async function handleDelete() {
  if (!props.problemId || deleting.value) return

  const confirmed = await dialog.confirm(
    "确定要删除此题目的支持包吗？此操作不可撤销。",
    { title: "删除支持包", danger: true },
  )
  if (!confirmed) return

  deleting.value = true
  uploadError.value = ""
  try {
    await api.delete(`/api/v1/problems/${props.problemId}/support-package`)
    emit("package-changed", false)
  } catch (err: unknown) {
    uploadError.value = extractApiError(err).message
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 标题 -->
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-text">题目支持包</h3>
      <button
        class="inline-flex items-center gap-1 text-xs text-text-secondary bg-transparent border-none cursor-pointer transition-colors hover:text-text"
        @click="showGuide = !showGuide"
      >
        {{ showGuide ? '收起' : '展开' }}文件结构说明
        <UIcon name="i-lucide-chevron-down" class="size-3.5" v-if="!showGuide"/>
        <UIcon name="i-lucide-chevron-up" class="size-3.5" v-else/>
      </button>
    </div>

    <!-- 文件结构引导 -->
    <Transition name="fade">
      <div v-if="showGuide" class="px-3 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
        <p class="font-semibold mb-1">统一题目包 zip 文件结构：</p>
        <pre class="font-mono leading-relaxed whitespace-pre-wrap">├── problem.json      # 必需：题目 manifest（含 title / runtime_config，可选 number）
├── statement.md      # 可选：题面 Markdown（与 manifest.description 二选一）
├── evaluate.py       # 必需：评测脚本（必须位于根目录）
├── visible.jsonl     # 可选：公开测试用例
├── hidden.jsonl      # 可选：隐藏测试用例
└── ...               # 其他 evaluate.py 需要的文件</pre>
        <div class="mt-1.5 text-blue-700">
          <p>• <strong>problem.json</strong> 与 <strong>evaluate.py</strong> 必须位于 zip 根目录</p>
          <p>• 上传将创建新题（题号自动分配）；管理员在 manifest 中提供 <code>number</code> 时按 (type, number) 幂等更新既有题目，普通用户提供 <code>number</code> 会被拒绝</p>
          <p>• <code>submission_sample.py</code> 等参考实现<strong>不要</strong>放入包中（打包时自动排除）</p>
          <p>• 上传后系统会剥离 problem.json / statement.md，仅存储纯净评测包</p>
        </div>
      </div>
    </Transition>

    <!-- 错误提示 -->
    <p v-if="uploadError" class="flex items-center gap-1.5 text-xs text-red-600">
      <UIcon name="i-lucide-alert-circle" class="size-3" />
      {{ uploadError }}
    </p>

    <!-- 已有支持包：显示状态 + 替换/删除 -->
    <div v-if="hasPackage && !uploading" class="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-border rounded-md">
      <UIcon name="i-lucide-file-archive" class="text-text-secondary shrink-0 size-4" />
      <span class="text-xs text-text flex-1">支持包已上传</span>
      <label
        class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-primary bg-transparent border border-primary rounded cursor-pointer transition-colors hover:bg-primary-bg"
        :class="{ 'opacity-50 pointer-events-none': disabled || uploading }"
      >
        <UIcon name="i-lucide-upload" class="size-3" />
        替换
        <input ref="fileInput" type="file" accept=".zip" class="hidden" @change="onFileSelect" />
      </label>
      <button
        class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-red-600 bg-transparent border border-red-200 rounded cursor-pointer transition-colors hover:bg-red-50"
        :disabled="deleting"
        @click="handleDelete"
      >
        <UIcon name="i-lucide-trash-2" class="size-3" />
        {{ deleting ? "删除中..." : "删除" }}
      </button>
    </div>

    <!-- 无支持包：上传区域 -->
    <div v-else>
      <!-- 拖拽上传区 -->
      <div
        class="relative flex flex-col items-center justify-center gap-2 px-4 py-6 border-2 border-dashed rounded-lg transition-colors cursor-pointer"
        :class="[
          isDragOver
            ? 'border-primary bg-primary-bg'
            : disabled || uploading
              ? 'border-border bg-gray-50 cursor-not-allowed'
              : 'border-border hover:border-primary hover:bg-primary-bg',
        ]"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
        @click="triggerFileSelect"
      >
        <UIcon name="i-lucide-upload" class="text-text-secondary size-6" v-if="!uploading"/>
        <div v-else class="animate-spin">
          <svg class="size-6 text-primary" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>

        <template v-if="disabled">
          <p class="text-xs text-text-muted text-center">请先保存题目后再上传支持包</p>
        </template>
        <template v-else-if="uploading">
          <p class="text-xs text-text-secondary">上传中...</p>
        </template>
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
          :disabled="disabled || uploading"
          @change="onFileSelect"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
