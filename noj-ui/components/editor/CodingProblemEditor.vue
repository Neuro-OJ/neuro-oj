<script setup lang="ts">
import SupportPackageUpload from "~/components/admin/SupportPackageUpload.vue"
import { extractApiError } from "~/utils/apiError"
import { isAdminUser } from "~/utils/isAdminUser"
import { useToast } from "~/composables/useToast"
import { useProblemStats } from "~/composables/useProblemStats"
import type { ProblemStatsDetail } from "~/utils/problemStats"

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
const versions = useProblemVersions()

const isAdmin = computed(() => isAdminUser(user.value))

/**
 * 草稿与版本（Handbook §6.8）：编辑模式下的两个动作。
 *
 * - 内容（题面/样例/运行配置/模板/LLM）写**共享草稿**，携带 `If-Match` 乐观锁；
 * - 管理信息（难度/可见性/标签）仍直接维护在题目行；
 * - 发布是新版本的唯一入口：发布前先保存草稿，避免"改了没发"。
 * 未发布题目的投影仍是唯一读取面，但编辑器一律以草稿为编辑初值。
 */
const draftRevision = ref<number | null>(null)
const latestVersion = ref<number | null>(null)
const draftSaving = ref(false)
const publishing = ref(false)

// ── 表单数据 ──
const { title, description, difficulty, samples, tagIds, visibility } = useProblemAuthorFields()
const problemType = ref(props.initialType)
const submissionMode = ref<'code' | 'artifact'>('code')
const artifactMaxSizeMb = ref<number | null>(null)

// 编辑模式专用
const displayId = ref("")
const isEditMode = computed(() => props.mode === "edit")

// ── 题目数据（仅编辑模式）：按需加载，避免每次打开编辑页都跑一次聚合 ──
const { fetchDetail } = useProblemStats()
const statsDetail = ref<ProblemStatsDetail | null>(null)
const statsLoading = ref(false)
const statsError = ref("")

async function loadStats() {
  if (!props.problemId) return
  statsLoading.value = true
  statsError.value = ""
  try {
    const res = await fetchDetail(props.problemId)
    statsDetail.value = res.data
  } catch (e) {
    statsError.value = extractApiError(e).message
    statsDetail.value = null
  } finally {
    statsLoading.value = false
  }
}

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
const llmMaxCalls = ref("")
const llmMaxTokens = ref("")

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
      samples?: import("~/utils/oiWorkspace").ProblemSample[]; visibility: "public" | "private";
      title: string; description: string; difficulty: string
      time_limit_ms: number; memory_limit_mb: number
      display_id: string; type: string; number: number
      tags: { id: string }[]
      submission_mode?: 'code' | 'artifact'
      artifact_max_size_mb?: number | null
      runtime_config: RuntimeConfigPayload | null
      latest_version?: number | null
    } }>(`/api/v1/problems/${props.problemId}`, { silent: true })
    const p = res.data
    displayId.value = p.display_id
    problemType.value = p.type === 'U' ? 'U' : 'P'
    title.value = p.title; description.value = p.description
    samples.value = p.samples ?? []
    visibility.value = p.visibility
    difficulty.value = p.difficulty
    tagIds.value = p.tags.map((c) => c.id)
    submissionMode.value = p.submission_mode ?? 'code'
    artifactMaxSizeMb.value = p.artifact_max_size_mb ?? null
    latestVersion.value = p.latest_version ?? null
    hasSupportPackage.value = (p as Record<string, unknown>).has_support_package === true

    // 加载 runtime_config
    if (p.runtime_config) {
      applyRuntimeConfig(p.runtime_config)
    }
    // 加载 LLM 配置
    const llmConfig = (p as {
      llm_config?: {
        max_calls?: number | null
        max_tokens?: number | null
      } | null
    }).llm_config
    if (llmConfig) {
      llmEnabled.value = true
      llmMaxCalls.value = llmConfig.max_calls != null ? String(llmConfig.max_calls) : ""
      llmMaxTokens.value = llmConfig.max_tokens != null ? String(llmConfig.max_tokens) : ""
    }

    // 内容以**草稿**为编辑初值（投影只在发布时更新，可能落后于草稿）
    const draft = await versions.getDraft(props.problemId)
    draftRevision.value = draft.revision
    applyDraftContent(draft.content)
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

function applyRuntimeConfig(rc: RuntimeConfigPayload) {
  evaluatorImage.value = rc.evaluator.image
  evaluatorCommand.value = rc.evaluator.command
  evaluatorTimeLimitMs.value = rc.evaluator.time_limit_ms
  evaluatorMemoryLimitMb.value = rc.evaluator.memory_limit_mb
  evaluatorNetworkEnabled.value = rc.evaluator.network?.enabled === true
  solutionImage.value = rc.solution.image
  solutionCallTimeoutMs.value = rc.solution.call_timeout_ms
  solutionMemoryLimitMb.value = rc.solution.memory_limit_mb
}

/** 用草稿内容覆盖表单（kind=ai 的内容快照）。 */
function applyDraftContent(content: Record<string, unknown>) {
  if (typeof content.title === "string") title.value = content.title
  if (typeof content.description === "string") description.value = content.description
  if (Array.isArray(content.samples)) {
    samples.value = content.samples as import("~/utils/oiWorkspace").ProblemSample[]
  }
  if (content.submission_mode === "code" || content.submission_mode === "artifact") {
    submissionMode.value = content.submission_mode
  }
  if (content.artifact_max_size_mb === null || typeof content.artifact_max_size_mb === "number") {
    artifactMaxSizeMb.value = content.artifact_max_size_mb as number | null
  }
  if (content.runtime_config) {
    applyRuntimeConfig(content.runtime_config as RuntimeConfigPayload)
  }
  const llmConfig = content.llm_config as { max_calls?: number | null; max_tokens?: number | null } | null
  if (llmConfig) {
    llmEnabled.value = true
    llmMaxCalls.value = llmConfig.max_calls != null ? String(llmConfig.max_calls) : ""
    llmMaxTokens.value = llmConfig.max_tokens != null ? String(llmConfig.max_tokens) : ""
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
  if (isEditMode.value) loadProblem()
})

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
    if (!evaluatorNetworkEnabled.value) errors.evaluator_network = "启用 LLM 必须开启 Evaluator 联网"
    const maxCalls = llmMaxCalls.value === "" ? null : Number(llmMaxCalls.value)
    const maxTokens = llmMaxTokens.value === "" ? null : Number(llmMaxTokens.value)
    if (maxCalls !== null && (!Number.isInteger(maxCalls) || maxCalls <= 0)) {
      errors.llm_max_calls = "调用上限必须是正整数"
    }
    if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      errors.llm_max_tokens = "token 上限必须是正整数"
    }
  }
  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

/** 双容器运行配置负载（AI 题内容的一部分）。 */
function buildRuntimeConfig(): RuntimeConfigPayload {
  return {
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
}

function buildLlmPayload() {
  const llmMaxCallsNum = llmMaxCalls.value === "" ? null : Number(llmMaxCalls.value)
  const llmMaxTokensNum = llmMaxTokens.value === "" ? null : Number(llmMaxTokens.value)
  return llmEnabled.value
    ? {
        ...(llmMaxCallsNum !== null ? { max_calls: llmMaxCallsNum } : {}),
        ...(llmMaxTokensNum !== null ? { max_tokens: llmMaxTokensNum } : {}),
      }
    : null
}

/** 草稿内容（kind=ai）：题面 + 评测配置 + 模板 + 产物上限 + LLM。 */
function buildContent(): Record<string, unknown> {
  return {
    kind: "ai",
    title: title.value.trim(),
    description: description.value.trim(),
    samples: samples.value,
    submission_mode: submissionMode.value,
    runtime_config: buildRuntimeConfig(),
    template_content: "",
    artifact_max_size_mb: artifactMaxSizeMb.value,
    llm_config: buildLlmPayload(),
  }
}

/** 管理信息（题目行）：难度、可见性、标签；内容不在这里提交。 */
async function saveManagement(): Promise<void> {
  await api.put(`/api/v1/problems/${props.problemId}`, {
    difficulty: difficulty.value,
    visibility: visibility.value,
    tag_ids: tagIds.value,
  })
}

/** 保存草稿（编辑模式）：管理信息 + 共享草稿内容，两个动作都成功才算保存。 */
async function handleSaveDraft() {
  if (!validate() || !props.problemId) return
  draftSaving.value = true
  saveError.value = ""
  try {
    await saveManagement()
    const saved = await versions.saveDraft(
      props.problemId,
      buildContent(),
      draftRevision.value ?? 0,
    )
    draftRevision.value = saved.revision
    toast.success("草稿已保存（发布后才会成为新的作答版本）")
  } catch (err: unknown) {
    saveError.value = extractApiError(err).message
  } finally {
    draftSaving.value = false
  }
}

/** 发布草稿为新版本：先保存当前编辑内容，再显式发布。 */
async function handlePublish() {
  if (!validate() || !props.problemId) return
  publishing.value = true
  saveError.value = ""
  try {
    await saveManagement()
    const saved = await versions.saveDraft(
      props.problemId,
      buildContent(),
      draftRevision.value ?? 0,
    )
    draftRevision.value = saved.revision
    const published = await versions.publish(props.problemId, saved.revision)
    draftRevision.value = published.draft_revision
    latestVersion.value = published.version
    toast.success(
      published.unchanged
        ? `内容未变化，继续使用 V${published.version}`
        : `已发布 V${published.version}`,
    )
    await loadProblem()
  } catch (err: unknown) {
    saveError.value = extractApiError(err).message
  } finally {
    publishing.value = false
  }
}

async function handleSubmit() {
  if (isEditMode.value) return
  if (!validate()) return
  saving.value = true
  saveError.value = ""
  try {
    const res = await api.post<{ data: { id: string } }>("/api/v1/problems", {
      title: title.value.trim(), description: description.value.trim(), samples: samples.value, visibility: visibility.value,
      difficulty: difficulty.value,
      tag_ids: tagIds.value,
      type: problemType.value,
      runtime_config: buildRuntimeConfig(),
      submission_mode: submissionMode.value,
      artifact_max_size_mb: artifactMaxSizeMb.value,
      llm: buildLlmPayload(),
    })
    savedProblemId.value = res.data.id
    toast.success("题目已创建（尚未发布：发布后才可作答）")
    emit("saved", res.data.id)
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
          <input v-model="title" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:input-base-focus bg-white" placeholder="题目标题" />
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
          <input v-model.number="artifactMaxSizeMb" type="number" min="1" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:input-base-focus bg-white" placeholder="留空使用 NOJ 默认上限" />
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
            class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:input-base-focus bg-white"
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
      <h2 class="text-sm font-semibold text-text mb-3">题目描述 <span class="text-red-600">*</span></h2>
      <p v-if="fieldErrors.description" class="text-xs text-red-600 mb-2">{{ fieldErrors.description }}</p>
      <MarkdownEditor v-model="description" height="480px" placeholder="支持 Markdown 格式的题目描述..." />
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
                  <span class="block text-xs text-text-muted">启用后必须开启 Evaluator 联网；模型与供应商由平台统一配置</span>
                </span>
              </label>
              <div v-if="llmEnabled" class="flex flex-col gap-2">
                <div class="grid grid-cols-2 gap-2">
                  <div class="flex flex-col gap-1">
                    <label class="text-xs font-semibold text-text">调用上限</label>
                    <input
                      v-model="llmMaxCalls"
                      type="number"
                      min="1"
                      class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white"
                      placeholder="留空使用平台默认"
                    />
                    <p v-if="fieldErrors.llm_max_calls" class="text-xs text-red-600">{{ fieldErrors.llm_max_calls }}</p>
                  </div>
                  <div class="flex flex-col gap-1">
                    <label class="text-xs font-semibold text-text">Token 上限</label>
                    <input
                      v-model="llmMaxTokens"
                      type="number"
                      min="1"
                      class="px-2.5 py-1.5 text-sm border border-border rounded-md bg-white"
                      placeholder="留空使用平台默认"
                    />
                    <p v-if="fieldErrors.llm_max_tokens" class="text-xs text-red-600">{{ fieldErrors.llm_max_tokens }}</p>
                  </div>
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
      <UFormField v-if="problemType === 'U'" label="可见性"><USelect v-model="visibility" :items="[{label:'公开',value:'public'},{label:'私有',value:'private'}]" class="w-full" /></UFormField>
      <ProblemSampleEditor v-model="samples" v-model:statement="description" />
      <SupportPackageUpload :problem-id="uploadProblemId" :has-package="hasSupportPackage" :disabled="!uploadProblemId" @package-changed="(val: boolean) => hasSupportPackage = val" />
    </section>

    <!-- 题目数据（仅编辑模式）：出题人视角的评测洞察 -->
    <section v-if="isEditMode" class="px-6 py-5 border-b border-border last:border-b-0">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-base font-semibold text-text">题目数据</h3>
          <p class="mt-1 text-xs text-text-secondary">评测状态分布与用例失败分布，用于定位题面歧义与数据强度问题。</p>
        </div>
        <UButton color="neutral" variant="outline" size="sm" :loading="statsLoading" @click="loadStats">
          {{ statsDetail ? "刷新" : "加载数据" }}
        </UButton>
      </div>
      <p v-if="statsError" class="mt-3 text-sm text-error-text">{{ statsError }}</p>
      <div v-if="statsDetail" class="mt-4">
        <ProblemStatsPanel :stats="statsDetail" />
      </div>
      <p v-else-if="!statsLoading && !statsError" class="mt-3 text-xs text-text-muted">
        点击"加载数据"查看本题的评测统计。
      </p>
    </section>

    <!-- 提交按钮：创建 = 建题；编辑 = 保存草稿 / 发布版本两个独立动作 -->
    <div class="flex flex-wrap items-center justify-end gap-2.5 px-6 py-4">
      <span v-if="isEditMode" class="mr-auto text-xs text-text-secondary">
        {{ latestVersion ? `当前最新版 V${latestVersion}` : "尚未发布（发布后才可作答）" }}
        <span v-if="draftRevision !== null" class="text-text-muted">· 草稿 revision {{ draftRevision }}</span>
      </span>
      <template v-if="isEditMode">
        <UButton
          color="neutral"
          variant="outline"
          class="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="draftSaving || publishing"
          :loading="draftSaving"
          @click="handleSaveDraft"
        >
          <UIcon name="i-lucide-save" class="size-4" />
          保存草稿
        </UButton>
        <UButton
          color="primary"
          class="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-lg border border-transparent bg-signal text-on-signal cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-signal/80 hover:border-signal/80"
          :disabled="draftSaving || publishing"
          :loading="publishing"
          @click="handlePublish"
        >
          <UIcon name="i-lucide-upload" class="size-4" />
          发布版本
        </UButton>
      </template>
      <UButton
        v-else
        color="primary"
        class="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-lg border border-transparent bg-signal text-on-signal cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-signal/80 hover:border-signal/80"
        :disabled="saving"
        @click="handleSubmit"
      >
        <UIcon name="i-lucide-save" class="size-4" />
        {{ saving ? "创建中..." : "创建题目" }}
      </UButton>
    </div>
  </div>

  <!-- 新建标签弹窗（仅 tag:manage 权限可见；API 层仍以 tag:manage RBAC 判定） -->
  <UModal v-model:open="showNewTagForm" title="新建标签" :unmount-on-hide="true">
    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-13px font-semibold text-text">名称 <span class="text-error-text">*</span></label>
          <input v-model="newTagName" class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:input-base-focus" placeholder="标签名称" />
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
