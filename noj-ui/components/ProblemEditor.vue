<script setup lang="ts">
import { ArrowLeft, Save, Eye, Edit3 } from "@lucide/vue"
import SupportPackageUpload from "~/components/SupportPackageUpload.vue"

interface Props {
  mode: "create" | "edit"
  problemId?: string
  initialType?: "U" | "P"
}

const props = withDefaults(defineProps<Props>(), {
  initialType: "U",
})

const emit = defineEmits<{
  saved: [problemId: string]
}>()

const router = useRouter()
const { user } = useAuth()

const isAdmin = computed(() => user.value?.role === "admin")

// ── 表单数据 ──
const title = ref("")
const description = ref("")
const difficulty = ref("medium")
const judgeImage = ref("")
const judgeCommand = ref("")
const timeLimitMs = ref(5000)
const memoryLimitMb = ref(512)
const categoryIds = ref<string[]>([])
const problemType = ref(props.initialType)

// 编辑模式专用
const displayId = ref("")
const isEditMode = computed(() => props.mode === "edit")

// ── 支持包上传 ──
const hasSupportPackage = ref(false)

/** 用于 SupportPackageUpload 组件的实际 problemId（创建模式下保存后才赋值） */
const uploadProblemId = computed(() => isEditMode.value ? (props.problemId ?? null) : savedProblemId.value)
const savedProblemId = ref<string | null>(null)

// ── 分类选项 ──
const categories = ref<{ id: string; name: string }[]>([])

async function loadCategories() {
  try {
    const res = await $fetch<{ data: { id: string; name: string }[] }>("/api/v1/categories")
    categories.value = res.data
  } catch { /* 静默失败 */ }
}

// ── 评测镜像白名单 ──
interface JudgeImageOption {
  id: string
  image: string
  mode: string
  description: string
}

const judgeImages = ref<JudgeImageOption[]>([])
const judgeImagesLoading = ref(true)

async function loadJudgeImages() {
  judgeImagesLoading.value = true
  try {
    const res = await $fetch<{ data: JudgeImageOption[] }>("/api/v1/judge-images")
    judgeImages.value = res.data
  } catch {
    judgeImages.value = []
  } finally {
    judgeImagesLoading.value = false
  }
}

// ── 编辑模式：加载现有数据 ──
const pageLoading = ref(false)
const notFound = ref(false)
const loadError = ref("")

async function loadProblem() {
  if (!props.problemId) return
  pageLoading.value = true
  try {
    const res = await $fetch<{ data: {
      title: string; description: string; difficulty: string
      judge_image: string; judge_command: string
      time_limit_ms: number; memory_limit_mb: number
      display_id: string; type: string; number: number
      support_package_path: string | null
      has_support_package: boolean
      categories: { id: string }[]
    } }>(`/api/v1/problems/${props.problemId}`)
    const p = res.data
    displayId.value = p.display_id
    problemType.value = p.type as "U" | "P"
    title.value = p.title; description.value = p.description
    difficulty.value = p.difficulty
    judgeImage.value = p.judge_image; judgeCommand.value = p.judge_command
    timeLimitMs.value = p.time_limit_ms; memoryLimitMb.value = p.memory_limit_mb
    categoryIds.value = p.categories.map((c) => c.id)
    hasSupportPackage.value = p.has_support_package
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      notFound.value = true
    } else {
      loadError.value = err instanceof Error ? err.message : "加载题目失败"
    }
  } finally {
    pageLoading.value = false
  }
}

onMounted(() => {
  loadCategories()
  loadJudgeImages()
  if (isEditMode.value) loadProblem()
})

// ── 预览 ──
const previewMode = ref(false)

// ── 提交 ──
const saving = ref(false)
const saveError = ref("")
const fieldErrors = ref<Record<string, string>>({})

function validate(): boolean {
  const errors: Record<string, string> = {}
  if (!title.value.trim()) errors.title = "请输入题目标题"
  if (!description.value.trim()) errors.description = "请输入题目描述"
  if (!judgeImage.value.trim()) {
    if (judgeImages.value.length > 0) {
      errors.judge_image = "请选择评测镜像"
    } else {
      errors.judge_image = "暂无可用评测镜像，请联系管理员"
    }
  }
  if (!judgeCommand.value.trim()) errors.judge_command = "请输入评测命令"
  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

async function handleSubmit() {
  if (!validate()) return
  saving.value = true
  saveError.value = ""
  try {
    if (isEditMode.value) {
      await $fetch(`/api/v1/problems/${props.problemId}`, {
        method: "PUT",
        body: {
          title: title.value.trim(), description: description.value.trim(),
          difficulty: difficulty.value,
          judge_image: judgeImage.value.trim(), judge_command: judgeCommand.value.trim(),
          time_limit_ms: timeLimitMs.value > 0 ? timeLimitMs.value : 5000,
          memory_limit_mb: memoryLimitMb.value > 0 ? memoryLimitMb.value : 512,
          category_ids: categoryIds.value,
        },
      })
      emit("saved", props.problemId!)
    } else {
      const res = await $fetch<{ data: { id: string } }>("/api/v1/problems", {
        method: "POST",
        body: {
          title: title.value.trim(), description: description.value.trim(),
          difficulty: difficulty.value,
          judge_image: judgeImage.value.trim(), judge_command: judgeCommand.value.trim(),
          time_limit_ms: timeLimitMs.value > 0 ? timeLimitMs.value : 5000,
          memory_limit_mb: memoryLimitMb.value > 0 ? memoryLimitMb.value : 512,
          category_ids: categoryIds.value,
          type: problemType.value,
        },
      })
      savedProblemId.value = res.data.id
      emit("saved", res.data.id)
    }
  } catch (err: unknown) {
    saveError.value = err instanceof Error ? err.message : "保存失败"
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- 编辑模式：未找到 -->
  <div v-if="notFound" class="text-center py-12 text-text-secondary text-base">
    题目不存在
  </div>

  <!-- 编辑模式：加载中 -->
  <div v-else-if="isEditMode && pageLoading" class="text-center py-12 text-text-secondary text-base">
    加载中...
  </div>

  <!-- 编辑模式：加载失败 -->
  <div v-else-if="isEditMode && loadError" class="text-center py-12 text-text-secondary text-base">
    {{ loadError }}
  </div>

  <!-- 正常表单 -->
  <div v-else class="bg-white border border-border rounded-xl overflow-hidden">
    <div v-if="saveError" class="mx-6 mt-4 px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{{ saveError }}</div>

    <!-- 基本信息 -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <h2 class="text-sm font-semibold text-text mb-0">基本信息</h2>
      <div class="grid grid-cols-2 gap-3.5 mt-3">
        <!-- 编辑模式：只读题号和类型 -->
        <template v-if="isEditMode">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-semibold text-text">题号</label>
            <span class="px-3 py-2 text-sm border border-border rounded-md bg-gray-50 text-text-secondary cursor-default">{{ displayId }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-semibold text-text">类型</label>
            <span class="px-3 py-2 text-sm border border-border rounded-md bg-gray-50 text-text-secondary cursor-default">{{ problemType === 'U' ? '用户题库（U）' : '主题库（P）' }}</span>
          </div>
        </template>

        <!-- 创建模式：类型选择 -->
        <template v-else>
          <div class="flex flex-col gap-1">
            <label class="text-xs font-semibold text-text">题目类型</label>
            <select v-model="problemType" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white">
              <option v-if="isAdmin" value="P">主题库（P）</option>
              <option value="U">用户题库（U）</option>
            </select>
          </div>
        </template>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">标题 <span class="text-red-600">*</span></label>
          <input v-model="title" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white" placeholder="题目标题" />
          <p v-if="fieldErrors.title" class="text-xs text-red-600">{{ fieldErrors.title }}</p>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">难度</label>
          <select v-model="difficulty" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white">
            <option value="easy">简单</option>
            <option value="medium">中等</option>
            <option value="hard">困难</option>
          </select>
        </div>

        <div class="flex flex-col gap-1 col-span-2">
          <label class="text-xs font-semibold text-text">分类</label>
          <div class="flex flex-wrap gap-2">
            <label v-for="cat in categories" :key="cat.id" class="flex items-center gap-1 text-xs text-text cursor-pointer">
              <input v-model="categoryIds" type="checkbox" :value="cat.id" class="accent-primary" />
              {{ cat.name }}
            </label>
            <span v-if="categories.length === 0" class="text-xs text-text-muted">暂无分类</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 题目描述 -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm font-semibold text-text mb-0">题目描述 <span class="text-red-600">*</span></h2>
        <button class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-text-secondary bg-transparent border border-border rounded-md cursor-pointer transition-colors hover:border-text-secondary hover:text-text" @click="previewMode = !previewMode">
          <Eye v-if="!previewMode" :size="14" />
          <Edit3 v-else :size="14" />
          {{ previewMode ? "编辑" : "预览" }}
        </button>
      </div>
      <p v-if="fieldErrors.description" class="text-xs text-red-600 mb-2">{{ fieldErrors.description }}</p>

      <textarea
        v-if="!previewMode"
        v-model="description"
        class="w-full px-3 py-3 text-sm font-mono leading-relaxed border border-border rounded-md outline-none resize-y min-h-[200px] box-border transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)]"
        placeholder="支持 Markdown 格式的题目描述..."
        rows="12"
      />
      <div v-else class="px-3 py-3 border border-border rounded-md min-h-[200px]">
        <MarkdownRenderer v-if="description.trim()" :content="description" />
        <p v-else class="text-xs text-text-muted">暂无内容</p>
      </div>
    </section>

    <!-- 评测配置 -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <h2 class="text-sm font-semibold text-text mb-3">评测配置</h2>
      <div class="grid grid-cols-2 gap-3.5">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">评测镜像 <span class="text-red-600">*</span></label>
          <select v-model="judgeImage" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white" :disabled="judgeImagesLoading || judgeImages.length === 0">
            <option v-if="judgeImagesLoading" value="" disabled>加载中...</option>
            <option v-else-if="judgeImages.length === 0" value="" disabled>暂无可用镜像，请联系管理员</option>
            <option v-for="ji in judgeImages" :key="ji.id" :value="ji.image">
              {{ ji.image }}{{ ji.description ? ` — ${ji.description}` : '' }}
            </option>
          </select>
          <p v-if="judgeImages.length === 0 && !judgeImagesLoading" class="text-xs text-amber-600">白名单未配置，需管理员在后台添加评测镜像</p>
          <p v-if="fieldErrors.judge_image" class="text-xs text-red-600">{{ fieldErrors.judge_image }}</p>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">评测命令 <span class="text-red-600">*</span></label>
          <input v-model="judgeCommand" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white" placeholder="如：python3 /tmp/evaluate.py" />
          <p v-if="fieldErrors.judge_command" class="text-xs text-red-600">{{ fieldErrors.judge_command }}</p>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">时间限制 (ms)</label>
          <input v-model.number="timeLimitMs" type="number" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" min="100" max="30000" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">内存限制 (MB)</label>
          <input v-model.number="memoryLimitMb" type="number" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" min="16" max="4096" />
        </div>
      </div>
    </section>

    <!-- 题目支持包 -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <SupportPackageUpload
        :problem-id="uploadProblemId"
        :has-package="hasSupportPackage"
        :disabled="!uploadProblemId"
        @package-changed="(val) => hasSupportPackage = val"
      />
    </section>

    <!-- 提交按钮 -->
    <div class="flex gap-2.5 justify-end px-6 py-4">
      <button class="btn btn-primary inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-lg border border-transparent bg-primary text-white cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-dark hover:border-primary-dark" :disabled="saving" @click="handleSubmit">
        <Save :size="16" />
        {{ saving ? (isEditMode ? "保存中..." : "创建中...") : (isEditMode ? "保存修改" : "创建题目") }}
      </button>
    </div>
  </div>
</template>
