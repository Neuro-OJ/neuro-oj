<script setup lang="ts">
import SupportPackageUpload from "~/components/admin/SupportPackageUpload.vue"
import { extractApiError } from "~/utils/apiError"
import { isAdminUser } from "~/utils/isAdminUser"
import { useToast } from "~/composables/useToast"

interface RuntimeConfigPayload {
  evaluator: {
    image: string
    command: string
    time_limit_ms: number
    memory_limit_mb: number
    network?: { enabled: boolean }
  }
  solution: {
    image: string
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
const { user, fetchUser } = useAuth()
const { api } = useApi()
const { toast } = useToast()

const isAdmin = computed(() => isAdminUser(user.value))

// ── 表单数据 ──
const title = ref("")
const description = ref("")
const difficulty = ref("medium")
const tagIds = ref<string[]>([])
const problemType = ref(props.initialType)
const submissionMode = ref<'code' | 'artifact'>('code')
const artifactMaxSizeMb = ref<number | null>(null)

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
    const res = await api.get<{ data: { image: string; kind?: string }[] }>(
      "/api/v1/judge-images",
      { silent: true },
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

// ── 双容器 Runtime 配置（所有题目统一使用双容器模式） ──
const evaluatorImage = ref("")
const evaluatorCommand = ref("python3 /workspace/evaluate.py")
const evaluatorTimeLimitMs = ref(5000)
const evaluatorMemoryLimitMb = ref(512)
const evaluatorNetworkEnabled = ref(false)
const solutionImage = ref("")
const solutionCallTimeoutMs = ref(1000)
const solutionMemoryLimitMb = ref(256)

// ── LLM 配置（仅 P 型/官方题可启用） ──
const llmEnabled = ref(false)
const llmProviderId = ref("")
const llmModel = ref("")
const llmProviders = ref<{ id: string; name: string; base_url: string; model: string }[]>([])

async function loadLlmProviders() {
  try {
    const res = await api.get<{ data: { id: string; name: string; base_url: string; model: string }[] }>(
      "/api/v1/admin/llm/providers",
      { silent: true },
    )
    llmProviders.value = res.data ?? []
  } catch { /* 非 admin 或 gateway 未启用时静默 */ }
}

// 启用 LLM 必须同时开启 evaluator 网络
watch(llmEnabled, (val) => {
  if (val) evaluatorNetworkEnabled.value = true
})

// ── 标签选项 ──
const tags = ref<{ id: string; name: string; kind: 'problem' | 'algorithm' }[]>([])

async function loadTags() {
  try {
    const res = await api.get<{ data: { id: string; name: string; kind: 'problem' | 'algorithm' }[] }>(
      "/api/v1/tags",
      { silent: true },
    )
    tags.value = res.data
  } catch { /* 静默失败 */ }
}

// 标签选项：按 kind 排序（题目标签在前），label 带 kind 前缀区分
const tagSearch = ref("")
const tagOptions = computed(() =>
  [...tags.value]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'problem' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((t) => ({
      label: `${t.kind === 'algorithm' ? '算法标签' : '题目标签'}: ${t.name}`,
      value: t.id,
    })),
)
// 标签搜索过滤：匹配 label（含题目标签/算法标签前缀与名称）
const filteredTagOptions = computed(() => {
  const keyword = tagSearch.value.trim().toLowerCase()
  if (!keyword) return tagOptions.value
  return tagOptions.value.filter((t) => t.label.toLowerCase().includes(keyword))
})

// 新建标签：仅拥有 tag:manage 权限（或 admin 通配）的用户可见
const canManageTags = computed(
  () => isAdmin.value || user.value?.permissions?.includes("tag:manage") === true,
)

// ── 新建标签（API 层以 tag:manage RBAC 判定、默认仅 admin） ──
const showNewTagForm = ref(false)
const newTagName = ref("")
const newTagKind = ref<'problem' | 'algorithm'>('problem')
const creatingTag = ref(false)
const newTagError = ref("")

function openNewTag() {
  newTagName.value = ""
  newTagKind.value = "problem"
  newTagError.value = ""
  showNewTagForm.value = true
}

async function handleCreateTag() {
  if (!newTagName.value.trim()) {
    newTagError.value = "请输入标签名称"
    return
  }
  creatingTag.value = true
  newTagError.value = ""
  try {
    const res = await api.post<{ data: { id: string; name: string; kind: 'problem' | 'algorithm' } }>(
      "/api/v1/tags",
      { name: newTagName.value.trim(), kind: newTagKind.value },
    )
    // 成功后加入选项并自动选中
    tags.value = [...tags.value, res.data]
    if (!tagIds.value.includes(res.data.id)) {
      tagIds.value = [...tagIds.value, res.data.id]
    }
    showNewTagForm.value = false
    toast.success("标签已创建")
  } catch (err: unknown) {
    newTagError.value = extractApiError(err).message
  } finally {
    creatingTag.value = false
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
    const res = await api.get<{ data: {
      title: string; description: string; difficulty: string
      time_limit_ms: number; memory_limit_mb: number
      display_id: string; type: string; number: number
      tags: { id: string }[]
      submission_mode?: 'code' | 'artifact'
      artifact_max_size_mb?: number | null
      runtime_config: RuntimeConfigPayload | null
    } }>(`/api/v1/problems/${props.problemId}`, { silent: true })
    const p = res.data
    displayId.value = p.display_id
    problemType.value = p.type
    title.value = p.title; description.value = p.description
    difficulty.value = p.difficulty
    tagIds.value = p.tags.map((c) => c.id)
    submissionMode.value = p.submission_mode ?? 'code'
    artifactMaxSizeMb.value = p.artifact_max_size_mb ?? null
    hasSupportPackage.value = (p as Record<string, unknown>).has_support_package === true

    // 加载 runtime_config
    if (p.runtime_config) {
      const rc = p.runtime_config
      evaluatorImage.value = rc.evaluator.image
      evaluatorCommand.value = rc.evaluator.command
      evaluatorTimeLimitMs.value = rc.evaluator.time_limit_ms
      evaluatorMemoryLimitMb.value = rc.evaluator.memory_limit_mb
      evaluatorNetworkEnabled.value = rc.evaluator.network?.enabled === true
      solutionImage.value = rc.solution.image
      solutionCallTimeoutMs.value = rc.solution.call_timeout_ms
      solutionMemoryLimitMb.value = rc.solution.memory_limit_mb
    }
    // 加载 LLM 配置
    const llmConfig = (p as { llm_config?: { provider_id: string; model: string } | null }).llm_config
    if (llmConfig) {
      llmEnabled.value = true
      llmProviderId.value = llmConfig.provider_id
      llmModel.value = llmConfig.model
    }
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      notFound.value = true
    } else {
      loadError.value = extractApiError(err).message
    }
  } finally {
    pageLoading.value = false
  }
}

onMounted(async () => {
  // 登录态可能只有 session 基础信息，先拉取完整用户（含 RBAC permissions），
  // 供「新建标签」按钮按 tag:manage 权限正确显隐。
  if (user.value && !user.value.permissions) {
    await fetchUser()
  }
  loadTags()
  loadJudgeImages()
  loadLlmProviders()
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
  if (!evaluatorImage.value.trim()) errors.evaluator_image = "请选择 evaluator 镜像"
  if (!solutionImage.value.trim()) errors.solution_image = "请选择 solution 镜像"
  if (llmEnabled.value) {
    if (!llmProviderId.value.trim()) errors.llm_provider = "请选择 LLM Provider"
    if (!llmModel.value.trim()) errors.llm_model = "请输入模型名"
    if (!evaluatorNetworkEnabled.value) errors.evaluator_network = "启用 LLM 必须开启 Evaluator 联网"
  }
  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

async function handleSubmit() {
  if (!validate()) return
  saving.value = true
  saveError.value = ""
  try {
    const runtimeConfigPayload = {
      evaluator: {
        image: evaluatorImage.value.trim(),
        command: evaluatorCommand.value.trim(),
        time_limit_ms: evaluatorTimeLimitMs.value,
        memory_limit_mb: evaluatorMemoryLimitMb.value,
        ...(evaluatorNetworkEnabled.value ? { network: { enabled: true } } : {}),
      },
      solution: {
        image: solutionImage.value.trim(),
        call_timeout_ms: solutionCallTimeoutMs.value,
        memory_limit_mb: solutionMemoryLimitMb.value,
      },
    }
    const llmPayload = llmEnabled.value
      ? { provider_id: llmProviderId.value.trim(), model: llmModel.value.trim() }
      : null
    const submissionModePayload = submissionMode.value
    const artifactMaxSizePayload = artifactMaxSizeMb.value
    if (isEditMode.value) {
      await api.put(`/api/v1/problems/${props.problemId}`, {
        title: title.value.trim(), description: description.value.trim(),
        difficulty: difficulty.value,
        tag_ids: tagIds.value,
        runtime_config: runtimeConfigPayload,
        submission_mode: submissionModePayload,
        artifact_max_size_mb: artifactMaxSizePayload,
        llm: llmPayload,
      })
      emit("saved", props.problemId!)
    } else {
      const res = await api.post<{ data: { id: string } }>("/api/v1/problems", {
        title: title.value.trim(), description: description.value.trim(),
        difficulty: difficulty.value,
        tag_ids: tagIds.value,
        type: problemType.value,
        runtime_config: runtimeConfigPayload,
        submission_mode: submissionModePayload,
        artifact_max_size_mb: artifactMaxSizePayload,
        llm: llmPayload,
      })
      savedProblemId.value = res.data.id
      emit("saved", res.data.id)
    }
  } catch (err: unknown) {
    saveError.value = extractApiError(err).message
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
          <USelect
            v-model="problemType"
            :items="[
              ...(isAdmin ? [{ label: '主题库（P）', value: 'P' }] : []),
              { label: '用户题库（U）', value: 'U' },
            ]"
            class="w-full"
          />
          </div>
        </template>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">标题 <span class="text-red-600">*</span></label>
          <input v-model="title" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)] bg-white" placeholder="题目标题" />
          <p v-if="fieldErrors.title" class="text-xs text-red-600">{{ fieldErrors.title }}</p>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">难度</label>
          <USelect v-model="difficulty" :items="[{ label: '简单', value: 'easy' }, { label: '中等', value: 'medium' }, { label: '困难', value: 'hard' }]" class="w-full" />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">提交模式</label>
          <USelect
            v-model="submissionMode"
            :items="[
              { label: '代码提交（code）', value: 'code' },
              { label: '产物提交（artifact / zip）', value: 'artifact' },
            ]"
            class="w-full"
          />
        </div>

        <div v-if="submissionMode === 'artifact'" class="flex flex-col gap-1">
          <label class="text-xs font-semibold text-text">artifact 大小上限（MB）</label>
          <input v-model.number="artifactMaxSizeMb" type="number" min="1" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)] bg-white" placeholder="留空使用 NOJ 默认上限" />
        </div>

        <div class="flex flex-col gap-1 col-span-2">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold text-text">标签</label>
            <UButton v-if="canManageTags" color="neutral" variant="outline" size="xs" @click="openNewTag">
              <UIcon name="i-lucide-plus" class="size-3" />
              新建标签
            </UButton>
          </div>
          <input
            v-model="tagSearch"
            class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)] bg-white"
            placeholder="搜索标签..."
          />
          <div class="flex flex-wrap gap-2">
            <label v-for="t in filteredTagOptions" :key="t.value" class="flex items-center gap-1 text-xs text-text cursor-pointer">
              <input v-model="tagIds" type="checkbox" :value="t.value" class="accent-primary" />
              {{ t.label }}
            </label>
            <span v-if="filteredTagOptions.length === 0" class="text-xs text-text-muted">{{ tags.length === 0 ? '暂无标签' : '无匹配标签' }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 题目描述 -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm font-semibold text-text mb-0">题目描述 <span class="text-red-600">*</span></h2>
        <UButton color="neutral" variant="outline" size="sm" class="py-1 text-text-secondary border-border hover:border-text-secondary hover:text-text" @click="previewMode = !previewMode">
          <UIcon name="i-lucide-eye" class="size-3.5" v-if="!previewMode"/>
          <UIcon name="i-lucide-edit-3" class="size-3.5" v-else/>
          {{ previewMode ? "编辑" : "预览" }}
        </UButton>
      </div>
      <p v-if="fieldErrors.description" class="text-xs text-red-600 mb-2">{{ fieldErrors.description }}</p>

      <textarea
        v-if="!previewMode"
        v-model="description"
        class="w-full px-3 py-3 text-sm font-mono leading-relaxed border border-border rounded-md outline-none resize-y min-h-[200px] box-border transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]"
        placeholder="支持 Markdown 格式的题目描述..."
        rows="12"
      />
      <div v-else class="px-3 py-3 border border-border rounded-md min-h-[200px]">
        <MarkdownRenderer v-if="description.trim()" :content="description" />
        <p v-else class="text-xs text-text-muted">暂无内容</p>
      </div>
    </section>

    <!-- 评测配置（双容器模式） -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <h2 class="text-sm font-semibold text-text mb-3">评测配置（双容器）</h2>
      <p class="text-xs text-text-muted mb-3">
        所有题目统一使用双容器模式：Evaluator（可信）运行 evaluate.py + 支持包；Solution（不可信）单独运行用户代码。
      </p>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Evaluator 卡片 -->
        <div class="border border-border rounded-lg p-3.5 bg-gray-50">
          <h3 class="text-xs font-semibold text-text mb-2.5 flex items-center gap-1.5">
            <span class="px-1.5 py-0.5 bg-signal text-on-signal text-[10px] rounded">Evaluator</span>
            可信端（运行 evaluate.py + 支持包）
          </h3>
          <div class="flex flex-col gap-2.5">
            <div class="flex flex-col gap-1">
              <label class="text-xs font-semibold text-text">镜像 <span class="text-red-600">*</span></label>
              <USelect
                v-model="evaluatorImage"
                :items="evaluatorImages.map((ji) => ({ label: ji.image, value: ji.image }))"
                :disabled="judgeImagesLoading"
                placeholder="请选择 evaluator 镜像"
                class="w-full"
              />
              <p v-if="!judgeImagesLoading && evaluatorImages.length === 0" class="text-xs text-warning-text">白名单无 evaluator 类型镜像</p>
              <p v-if="fieldErrors.evaluator_image" class="text-xs text-red-600">{{ fieldErrors.evaluator_image }}</p>
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs font-semibold text-text">评测命令 <span class="text-red-600">*</span></label>
              <input v-model="evaluatorCommand" class="px-2.5 py-1.5 text-sm border border-border rounded-md outline-none transition-colors focus:border-signal bg-white" placeholder="如：python3 /workspace/evaluate.py" />
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
            <label class="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-text">
              <input v-model="evaluatorNetworkEnabled" type="checkbox" class="size-4 accent-primary" :disabled="llmEnabled">
              <span>
                允许 Evaluator 联网
                <span class="block text-xs text-text-muted">开启后 evaluator 容器以 bridge 模式联网（solution 保持无网，仅能通过 capability 调用间接使用网络）</span>
              </span>
            </label>

            <!-- LLM 配置 -->
            <div class="border-t border-border mt-2 pt-2.5 flex flex-col gap-2">
              <label class="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-text">
                <input v-model="llmEnabled" type="checkbox" class="size-4 accent-primary">
                <span>
                  启用 LLM 调用（仅 P 型/官方题）
                  <span class="block text-xs text-text-muted">启用后必须开启 Evaluator 联网，题目固定 provider/model</span>
                </span>
              </label>
              <div v-if="llmEnabled" class="flex flex-col gap-2">
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-semibold text-text">LLM Provider <span class="text-red-600">*</span></label>
                  <USelect v-model="llmProviderId" :items="llmProviders.map((p) => ({ label: `${p.name} (${p.model})`, value: p.id }))" placeholder="请选择 Provider" class="w-full" />
                  <p v-if="fieldErrors.llm_provider" class="text-xs text-red-600">{{ fieldErrors.llm_provider }}</p>
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-semibold text-text">模型 <span class="text-red-600">*</span></label>
                  <input v-model="llmModel" class="px-2.5 py-1.5 text-sm border border-border rounded-md outline-none focus:border-signal bg-white" placeholder="如：qwen-plus" />
                  <p v-if="fieldErrors.llm_model" class="text-xs text-red-600">{{ fieldErrors.llm_model }}</p>
                </div>
                <div class="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                  <p class="font-semibold mb-1 flex items-center gap-1.5"><UIcon name="i-lucide-triangle-alert" class="size-3.5" />启用 LLM 调用必须开启 Evaluator 联网</p>
                  <p>联网已自动开启且不可关闭，直到移除 LLM 配置。</p>
                </div>
                <p v-if="fieldErrors.evaluator_network" class="text-xs text-red-600">{{ fieldErrors.evaluator_network }}</p>
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
              <USelect
                v-model="solutionImage"
                :items="solutionImages.map((ji) => ({ label: ji.image, value: ji.image }))"
                :disabled="judgeImagesLoading"
                placeholder="请选择 solution 镜像"
                class="w-full"
              />
              <p v-if="!judgeImagesLoading && solutionImages.length === 0" class="text-xs text-warning-text">白名单无 solution 类型镜像 — 管理员需先添加并标记 kind='solution'</p>
              <p v-if="fieldErrors.solution_image" class="text-xs text-red-600">{{ fieldErrors.solution_image }}</p>
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
    </section>

    <!-- 支持包上传 -->
    <section class="px-6 py-5 border-b border-border last:border-b-0">
      <SupportPackageUpload :problem-id="uploadProblemId" :has-package="hasSupportPackage" :disabled="!uploadProblemId" @package-changed="(val: boolean) => hasSupportPackage = val" />
    </section>

    <!-- 提交按钮 -->
    <div class="flex gap-2.5 justify-end px-6 py-4">
      <UButton color="primary" class="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-lg border border-transparent bg-signal text-on-signal cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-signal/80 hover:border-signal/80" :disabled="saving" @click="handleSubmit">
        <UIcon name="i-lucide-save" class="size-4" />
        {{ saving ? (isEditMode ? "保存中..." : "创建中...") : (isEditMode ? "保存修改" : "创建题目") }}
      </UButton>
    </div>
  </div>

  <!-- 新建标签弹窗（仅 tag:manage 权限可见；API 层仍以 tag:manage RBAC 判定） -->
  <UModal v-model:open="showNewTagForm" title="新建标签" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">名称 <span class="text-error-text">*</span></label>
          <input v-model="newTagName" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-signal focus:shadow-[0_0_0_2px_rgba(0,214,138,0.1)]" placeholder="标签名称" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">类型 <span class="text-error-text">*</span></label>
          <USelect
            v-model="newTagKind"
            :items="[{ label: '题目标签', value: 'problem' }, { label: '算法标签', value: 'algorithm' }]"
            class="w-full"
          />
        </div>
        <p v-if="newTagError" class="text-error-text text-13px">{{ newTagError }}</p>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="creatingTag" @click="showNewTagForm = false">取消</UButton>
      <UButton color="primary" :loading="creatingTag" @click="handleCreateTag">创建</UButton>
    </template>
  </UModal>
</template>
