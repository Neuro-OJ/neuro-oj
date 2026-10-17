<script setup lang="ts">
import { extractApiError } from '~/utils/apiError'
import { validateZipFileName } from '~/utils/bundleImport'

const { api } = useApi()
interface Props {
  problemId: string | null
  hasPackage: boolean
  draftRevision: number | null
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

// ── 「替换」按钮的文件选择（首次上传走 ZipDropZone） ──
function onReplaceSelect(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  // 重置 input，允许重复选择同一文件
  target.value = ""
  if (!file) return
  const error = validateZipFileName(file.name)
  if (error) {
    uploadError.value = error
    return
  }
  void doUpload(file)
}

/** UUID 判定：只有 UUID 才能与导入响应里的 `data.id` 直接比对。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 解析目标题目的内部 UUID。
 *
 * 组件收到的 `problemId` 可能是题号/display_id（编辑器路由参数），而导入响应里的
 * `data.id` 一律是 UUID；直接比对会误报。先解析出内部 UUID，再校验导入结果的
 * 归属（缺陷 #55：绝不能让上传悄悄创建另一道题）。
 */
async function resolveTargetProblemId(problemId: string): Promise<string> {
  if (UUID_RE.test(problemId)) return problemId
  const res = await api.get<{ data: { id: string } }>(
    `/api/v1/problems/${encodeURIComponent(problemId)}`,
    { silent: true },
  )
  if (!res.data?.id) throw new Error("未返回题目 ID")
  return res.data.id
}

async function doUpload(file: File) {
  // 缺陷 #55：必须携带明确的目标题目与草稿 revision。缺任一项都不能走通用
  // 导入端点——普通用户路径会**新建一道题**，管理员路径则依赖包内题号匹配，
  // 而组件随后仍向原编辑器报告「上传成功」。
  if (!props.problemId) {
    uploadError.value = "缺少目标题目，已取消上传（支持包必须绑定到当前编辑的题目）"
    return
  }
  if (props.draftRevision == null) {
    uploadError.value = "缺少草稿 revision，请先保存草稿后再上传支持包"
    return
  }

  uploading.value = true
  uploadError.value = ""
  try {
    const targetId = await resolveTargetProblemId(props.problemId)

    const formData = new FormData()
    formData.append("file", file)
    // 目标题目 + 期望 revision：同时放 body 与 `If-Match`，服务端据此做乐观锁，
    // 并把包写入**该题**的共享草稿，而不是创建另一道题。
    formData.append("problem_id", targetId)
    formData.append("expected_revision", String(props.draftRevision))

    const res = await api.post<{
      data: { id?: string; display_id?: string; draft_revision?: number; revision?: number }
    }>(`/api/v1/problems/import-bundle`, formData, {
      headers: { "If-Match": String(props.draftRevision) },
    })

    // 校验包身份：导入结果必须是当前题目。若服务端走了创建路径（生成了另一个
    // 题目 ID），这里必须报错而不是向上报告成功——否则编辑器显示「已上传」而
    // 玩家的包里其实多出一道新题。
    const resultId = res.data?.id
    if (!resultId || resultId !== targetId) {
      uploadError.value = `导入结果不属于当前题目（目标 ${targetId}，返回 ${
        resultId ?? "无题目标识"
      }），已阻止创建另一道题；请确认包内 manifest 的题型与当前题目一致`
      return
    }

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
  if (props.draftRevision == null) {
    uploadError.value = "缺少草稿 revision，请先保存草稿后再删除支持包"
    return
  }

  const confirmed = await dialog.confirm(
    "确定要删除此题目的支持包吗？此操作不可撤销。",
    { title: "删除支持包", danger: true },
  )
  if (!confirmed) return

  deleting.value = true
  uploadError.value = ""
  try {
    await api.delete(`/api/v1/problems/${props.problemId}/support-package`, { headers: { "If-Match": String(props.draftRevision) } })
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
          <p>• 上传会<strong>绑定到当前编辑的题目</strong>（携带草稿 revision 乐观锁，冲突返回 409/428），不会创建新题；包内 manifest 的题型须与当前题目一致，题号由目标题目决定</p>
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
        class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-primary bg-transparent border border-signal rounded cursor-pointer transition-colors hover:bg-primary-bg"
        :class="{ 'opacity-50 pointer-events-none': disabled || uploading }"
      >
        <UIcon name="i-lucide-upload" class="size-3" />
        替换
        <input type="file" accept=".zip" class="hidden" :disabled="disabled || uploading" @change="onReplaceSelect" />
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
    <ZipDropZone
      v-else
      :disabled="disabled"
      :busy="uploading"
      disabled-hint="创建题目后即可在编辑页上传支持包"
      @file="doUpload"
    />
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
