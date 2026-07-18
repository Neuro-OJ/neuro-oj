<script setup lang="ts">
import { ArrowLeft, Save, Eye, Edit3 } from "@lucide/vue"
import SupportPackageUpload from "../admin/SupportPackageUpload.vue"

interface RuntimeConfigPayload {
  evaluator: {
    image: string
    command: string
    time_limit_ms: number
    memory_limit_mb: number
  }
  solution: {
    image: string
    entry: string
    call_timeout_ms: number
    memory_limit_mb: number
  }
}

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

// 支持包上传
const hasSupportPackage = ref(false)

/** 用于 SupportPackageUpload 组件的实际 problemId（创建模式下保存后才赋值） */
const uploadProblemId = computed(() =>
  isEditMode.value ? (props.problemId ?? null) : savedProblemId.value,
)
const savedProblemId = ref<string | null>(null)

// 评测镜像白名单（含 kind）
const judgeImages = ref<{ image: string; kind?: string }[]>([])
const judgeImagesLoading = ref(false)

async function loadJudgeImages() {
  judgeImagesLoading.value = true
  try {
    const res = await $fetch<{ data: { image: string; kind?: string }[] }>(
      "/api/v1/judge-images",
    )
    judgeImages.value = res.data ?? []
  } catch {
    // 静默失败
  } finally {
    judgeImagesLoading.value = false
  }
}

/** 按 kind 过滤的镜像列表（dual-container-judge §5） */
const evaluatorImages = computed(() =>
  judgeImages.value.filter((ji) => (ji.kind ?? "evaluator") === "evaluator"),
)
const solutionImages = computed(() =>
  judgeImages.value.filter((ji) => ji.kind === "solution"),
)

// ── 双容器 Runtime 配置（仅 admin） ──
const dualMode = ref(false)  // 是否启用双容器模式
const evaluatorImage = ref("")
const evaluatorCommand = ref("python3 /workspace/evaluate.py")
const evaluatorTimeLimitMs = ref(5000)
const evaluatorMemoryLimitMb = ref(512)
const solutionImage = ref("")
const solutionEntry = ref("solution.py")
const solutionCallTimeoutMs = ref(1000)
const solutionMemoryLimitMb = ref(256)

// dualMode 关闭时清空 RuntimeConfig
watch(dualMode, (on) => {
  if (!on) {
    evaluatorImage.value = ""
    evaluatorCommand.value = ""
    evaluatorTimeLimitMs.value = 5000
    evaluatorMemoryLimitMb.value = 512
    solutionImage.value = ""
    solutionEntry.value = "solution.py"
    solutionCallTimeoutMs.value = 1000
    solutionMemoryLimitMb.value = 256
  }
})

/** 组装 RuntimeConfig 用于提交；dualMode 关闭返回 null */
const runtimeConfigPayload = computed(() => {
  if (!dualMode.value) return null
  return {
    evaluator: {
      image: evaluatorImage.value.trim(),
      command: evaluatorCommand.value.trim(),
      time_limit_ms: evaluatorTimeLimitMs.value,
      memory_limit_mb: evaluatorMemoryLimitMb.value,
    },
    solution: {
      image: solutionImage.value.trim(),
      entry: solutionEntry.value.trim(),
      call_timeout_ms: solutionCallTimeoutMs.value,
      memory_limit_mb: solutionMemoryLimitMb.value,
    },
  }
})

// 仅 admin 可启用 dual mode
const canDualMode = computed(() => isAdmin.value)

// ── 分类选项 ──
const categories = ref<{ id: string; name: string }[]>([])

async function loadCategories() {
  try {
    const res = await $fetch<{ data: { id: string; name: string }[] }>("/api/v1/categories")
    categories.value = res.data
  } catch { /* 静默失败 */ }
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
      categories: { id: string }[]
      runtime_config: RuntimeConfigPayload | null
    } }>(`/api/v1/problems/${props.problemId}`)
    const p = res.data
    displayId.value = p.display_id
    problemType.value = p.type
    title.value = p.title; description.value = p.description
    difficulty.value = p.difficulty
    judgeImage.value = p.judge_image; judgeCommand.value = p.judge_command
    timeLimitMs.value = p.time_limit_ms; memoryLimitMb.value = p.memory_limit_mb
    categoryIds.value = p.categories.map((c) => c.id)
    hasSupportPackage.value = (p as Record<string, unknown>).has_support_package === true

    // 加载 runtime_config（如果有）
    if (p.runtime_config) {
      dualMode.value = true
      const rc = p.runtime_config
      evaluatorImage.value = rc.evaluator.image
      evaluatorCommand.value = rc.evaluator.command
      evaluatorTimeLimitMs.value = rc.evaluator.time_limit_ms
      evaluatorMemoryLimitMb.value = rc.evaluator.memory_limit_mb
      solutionImage.value = rc.solution.image
      solutionEntry.value = rc.solution.entry
      solutionCallTimeoutMs.value = rc.solution.call_timeout_ms
      solutionMemoryLimitMb.value = rc.solution.memory_limit_mb
    } else {
      dualMode.value = false
    }
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
  if (!judgeImage.value.trim()) errors.judge_image = "请输入评测镜像"
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
          // 双容器 Runtime 配置（仅 admin 可设置）
          ...(canDualMode.value && dualMode.value
            ? { runtime_config: runtimeConfigPayload.value }
            : { runtime_config: null }),
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
          <select v-model="judgeImage" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white" :disabled="dualMode || judgeImagesLoading">
            <option value="" disabled>{{ judgeImagesLoading ? "加载中..." : (dualMode ? "双容器模式：使用 Evaluator 镜像" : (judgeImages.length === 0 ? "暂无可用评测镜像" : "请选择评测镜像")) }}</option>
            <option v-for="ji in judgeImages.filter(j => (j.kind ?? 'evaluator') === 'evaluator')" :key="ji.image" :value="ji.image">{{ ji.image }}</option>
          </select>
          <p v-if="!judgeImagesLoading && judgeImages.length === 0 && !fieldErrors.judge_image" class="text-xs text-warning-text">白名单未配置，需管理员在后台添加评测镜像</p>
          <p v-if="fieldErrors.judge_image" class="text-xs text-red-600">{{ fieldErrors.judge_image }}</p>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">评测命令 <span class="text-red-600">*</span></label>
          <input v-model="judgeCommand" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white" :disabled="dualMode" placeholder="如：python3 /tmp/evaluate.py" />
          <p v-if="fieldErrors.judge_command" class="text-xs text-red-600">{{ fieldErrors.judge_command }}</p>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">时间限制 (ms)</label>
          <input v-model.number="timeLimitMs" type="number" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" :disabled="dualMode" min="100" max="30000" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">内存限制 (MB)</label>
          <input v-model.number="memoryLimitMb" type="number" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" :disabled="dualMode" min="16" max="4096" />
        </div>
      </div>

      <!-- 双容器 Runtime 配置（仅 admin 可启用） -->
      <div v-if="canDualMode" class="mt-4 pt-4 border-t border-border">
        <label class="flex items-center gap-2 text-xs font-semibold text-text cursor-pointer">
          <input v-model="dualMode" type="checkbox" class="accent-primary" />
          <span>启用双容器 Runtime（Evaluator + Solution）</span>
          <span class="text-text-muted font-normal">— 仅 admin 可见，参考 openspec/changes/dual-container-judge</span>
        </label>
        <p class="text-xs text-text-muted mt-1">
          双容器模式：Evaluator（可信）运行 evaluate.py + 支持包；Solution（不可信）单独运行用户代码。
          启用后将覆盖上方"评测配置"中的镜像/命令/时间/内存字段。
        </p>

        <div v-if="dualMode" class="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <!-- Evaluator 卡片 -->
          <div class="border border-border rounded-lg p-3.5 bg-gray-50">
            <h3 class="text-xs font-semibold text-text mb-2.5 flex items-center gap-1.5">
              <span class="px-1.5 py-0.5 bg-primary text-white text-[10px] rounded">Evaluator</span>
              可信端（运行 evaluate.py + 支持包）
            </h3>
            <div class="flex flex-col gap-2.5">
              <div class="flex flex-col gap-1">
                <label class="text-xs font-semibold text-text">镜像 <span class="text-red-600">*</span></label>
                <select v-model="evaluatorImage" class="px-2.5 py-1.5 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" :disabled="judgeImagesLoading">
                  <option value="" disabled>{{ judgeImagesLoading ? "加载中..." : evaluatorImages.length === 0 ? "暂无可用 evaluator 镜像" : "请选择 evaluator 镜像" }}</option>
                  <option v-for="ji in evaluatorImages" :key="ji.image" :value="ji.image">{{ ji.image }}</option>
                </select>
                <p v-if="!judgeImagesLoading && evaluatorImages.length === 0" class="text-xs text-warning-text">白名单无 evaluator 类型镜像</p>
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs font-semibold text-text">评测命令 <span class="text-red-600">*</span></label>
                <input v-model="evaluatorCommand" class="px-2.5 py-1.5 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" placeholder="如：python3 /workspace/evaluate.py" />
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-semibold text-text">总时间 (ms)</label>
                  <input v-model.number="evaluatorTimeLimitMs" type="number" class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white" min="100" max="60000" />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-semibold text-text">内存 (MB)</label>
                  <input v-model.number="evaluatorMemoryLimitMb" type="number" class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white" min="32" max="8192" />
                </div>
              </div>
            </div>
          </div>

          <!-- Solution 卡片 -->
          <div class="border border-border rounded-lg p-3.5 bg-gray-50">
            <h3 class="text-xs font-semibold text-text mb-2.5 flex items-center gap-1.5">
              <span class="px-1.5 py-0.5 bg-warning-text text-white text-[10px] rounded">Solution</span>
              不可信端（运行用户代码，隔离)
            </h3>
            <div class="flex flex-col gap-2.5">
              <div class="flex flex-col gap-1">
                <label class="text-xs font-semibold text-text">镜像 <span class="text-red-600">*</span></label>
                <select v-model="solutionImage" class="px-2.5 py-1.5 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" :disabled="judgeImagesLoading">
                  <option value="" disabled>{{ judgeImagesLoading ? "加载中..." : solutionImages.length === 0 ? "暂无可用 solution 镜像" : "请选择 solution 镜像" }}</option>
                  <option v-for="ji in solutionImages" :key="ji.image" :value="ji.image">{{ ji.image }}</option>
                </select>
                <p v-if="!judgeImagesLoading && solutionImages.length === 0" class="text-xs text-warning-text">白名单无 solution 类型镜像 — 管理员需先添加并标记 kind='solution'</p>
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs font-semibold text-text">入口文件名 <span class="text-red-600">*</span></label>
                <input v-model="solutionEntry" class="px-2.5 py-1.5 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary bg-white" placeholder="如：solution.py" />
                <p class="text-xs text-text-muted">禁止包含路径分隔符或 ..</p>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-semibold text-text">单次调用超时 (ms)</label>
                  <input v-model.number="solutionCallTimeoutMs" type="number" class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white" min="100" max="30000" />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-semibold text-text">内存 (MB)</label>
                  <input v-model.number="solutionMemoryLimitMb" type="number" class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white" min="16" max="4096" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 支持包上传 -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <SupportPackageUpload :problem-id="uploadProblemId" :has-package="hasSupportPackage" :disabled="!uploadProblemId" @package-changed="(val: boolean) => hasSupportPackage = val" />
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
