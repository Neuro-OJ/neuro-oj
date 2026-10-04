<script setup lang="ts">
import { extractApiError } from "~/utils/apiError"
import { useToast } from "~/composables/useToast"

interface Props {
  initialType?: "U" | "P"
  mode?: "create" | "edit"
  problemId?: string
}

const props = withDefaults(defineProps<Props>(), { initialType: "U", mode: "create" })
const emit = defineEmits<{ saved: [problemId: string] }>()
const { api } = useApi()
const { toast } = useToast()
const isEditMode = computed(() => props.mode === "edit")

const title = ref("")
const description = ref("")
const difficulty = ref("medium")
const problemType = ref(props.initialType)
const backend = ref<"native" | "wasm">("native")
const languages = ref<Array<"c" | "cc">>(["c", "cc"])
const timeLimitMs = ref(1000)
const memoryLimitMb = ref(256)
const checkerType = ref<"default" | "strict" | "testlib">("default")
const checkerPath = ref("")
const subtasks = ref([
  { id: "all", score: 100, depends_on: "", cases: "testdata/1.in|testdata/1.out" },
])
const saving = ref(false)
const error = ref("")
const savedProblemId = ref<string | null>(null)
const pageLoading = ref(false)
const notFound = ref(false)

interface OiProblemResponse {
  id: string
  title: string
  description: string
  difficulty: string
  type: "U" | "P"
  judge_type?: "dual" | "oi"
  runtime_config?: OiRuntimeConfigResponse | null
}

interface OiRuntimeConfigResponse {
    backend: "native" | "wasm"
    languages: Array<"c" | "cc">
    time_limit_ms: number
    memory_limit_mb: number
    checker: { type: "default" | "strict" | "testlib"; path?: string }
    filename?: string
    compile_extra_files?: string[]
    checker_extra_files?: string[]
    user_extra_files?: string[]
    subtasks: Array<{
      id: string
      score: number
      depends_on?: string[]
      time_limit_ms?: number
      memory_limit_mb?: number
      cases: Array<{
        input: string
        output: string
        time_limit_ms?: number
        memory_limit_mb?: number
      }>
    }>
}

const originalRuntimeConfig = ref<OiRuntimeConfigResponse | null>(null)

function toggleLanguage(language: "c" | "cc") {
  languages.value = languages.value.includes(language)
    ? languages.value.filter((item) => item !== language)
    : [...languages.value, language]
}

function addSubtask() {
  subtasks.value.push({
    id: `subtask${subtasks.value.length + 1}`,
    score: 0,
    depends_on: "",
    cases: "testdata/1.in|testdata/1.out",
  })
}

function removeSubtask(index: number) {
  if (subtasks.value.length <= 1) return
  subtasks.value.splice(index, 1)
}

function makeRuntimeConfig() {
  const parsedSubtasks = subtasks.value.map((subtask, subtaskIndex) => {
    const originalSubtask = originalRuntimeConfig.value?.subtasks.find((item) => item.id === subtask.id.trim()) ??
      originalRuntimeConfig.value?.subtasks[subtaskIndex]
    const originalCases = new Map((originalSubtask?.cases ?? []).map((item) => [item.input, item]))
    const cases = subtask.cases.split("\n").map((line) => {
      const [rawInput, rawOutput] = line.split("|")
      const input = rawInput?.trim() ?? ""
      const output = rawOutput?.trim() ?? ""
      return { ...originalCases.get(input), input, output }
    })
    return {
      ...(originalSubtask
        ? {
            ...(originalSubtask.time_limit_ms !== undefined ? { time_limit_ms: originalSubtask.time_limit_ms } : {}),
            ...(originalSubtask.memory_limit_mb !== undefined ? { memory_limit_mb: originalSubtask.memory_limit_mb } : {}),
          }
        : {}),
      id: subtask.id.trim(),
      score: Number(subtask.score),
      ...(subtask.depends_on.trim()
        ? { depends_on: subtask.depends_on.split(",").map((item) => item.trim()).filter(Boolean) }
        : {}),
      cases,
    }
  })
  return {
    ...(originalRuntimeConfig.value
      ? {
          ...(originalRuntimeConfig.value.filename ? { filename: originalRuntimeConfig.value.filename } : {}),
          ...(originalRuntimeConfig.value.compile_extra_files ? { compile_extra_files: originalRuntimeConfig.value.compile_extra_files } : {}),
          ...(originalRuntimeConfig.value.checker_extra_files ? { checker_extra_files: originalRuntimeConfig.value.checker_extra_files } : {}),
          ...(originalRuntimeConfig.value.user_extra_files ? { user_extra_files: originalRuntimeConfig.value.user_extra_files } : {}),
        }
      : {}),
    backend: backend.value,
    languages: languages.value,
    time_limit_ms: Number(timeLimitMs.value),
    memory_limit_mb: Number(memoryLimitMb.value),
    checker: {
      type: checkerType.value,
      ...(checkerType.value === "testlib" ? { path: checkerPath.value.trim() } : {}),
    },
    subtasks: parsedSubtasks,
  }
}

async function loadProblem() {
  if (!isEditMode.value || !props.problemId) return
  pageLoading.value = true
  error.value = ""
  try {
    const res = await api.get<{ data: OiProblemResponse }>(
      `/api/v1/problems/${props.problemId}`,
      { silent: true },
    )
    const problem = res.data
    if (problem.judge_type !== "oi" || !problem.runtime_config) {
      error.value = "该题不是传统 OI 题，不能使用 OI 编辑器"
      return
    }
    originalRuntimeConfig.value = structuredClone(problem.runtime_config)
    title.value = problem.title
    description.value = problem.description
    difficulty.value = problem.difficulty
    problemType.value = problem.type
    backend.value = problem.runtime_config.backend
    languages.value = [...problem.runtime_config.languages]
    timeLimitMs.value = problem.runtime_config.time_limit_ms
    memoryLimitMb.value = problem.runtime_config.memory_limit_mb
    checkerType.value = problem.runtime_config.checker.type
    checkerPath.value = problem.runtime_config.checker.path ?? ""
    subtasks.value = problem.runtime_config.subtasks.map((subtask) => ({
      id: subtask.id,
      score: subtask.score,
      depends_on: (subtask.depends_on ?? []).join(","),
      cases: subtask.cases.map((item) => `${item.input}|${item.output}`).join("\n"),
    }))
  } catch (err: unknown) {
    const status = err && typeof err === "object" && "status" in err
      ? (err as { status?: number }).status
      : undefined
    if (status === 404) notFound.value = true
    else error.value = extractApiError(err).message
  } finally {
    pageLoading.value = false
  }
}

function validate(): boolean {
  error.value = ""
  if (!title.value.trim() || !description.value.trim()) {
    error.value = "标题和题面不能为空"
    return false
  }
  if (languages.value.length === 0) {
    error.value = "至少选择一种 C/C++ 语言"
    return false
  }
  if (!Number.isInteger(timeLimitMs.value) || timeLimitMs.value <= 0 || timeLimitMs.value > 60000) {
    error.value = "总时限必须是 1～60000 毫秒"
    return false
  }
  if (!Number.isInteger(memoryLimitMb.value) || memoryLimitMb.value <= 0 || memoryLimitMb.value > 512) {
    error.value = "内存必须是 1～512 MiB"
    return false
  }
  if (checkerType.value === "testlib" && !checkerPath.value.trim()) {
    error.value = "testlib checker 必须填写题包内路径"
    return false
  }
  return true
}

async function save() {
  if (!validate()) return
  saving.value = true
  try {
    const payload = {
      title: title.value.trim(),
      description: description.value.trim(),
      difficulty: difficulty.value,
      judge_type: "oi" as const,
      runtime_config: makeRuntimeConfig(),
    }
    if (isEditMode.value) {
      await api.put(`/api/v1/problems/${props.problemId}`, payload)
      toast.success("OI 题目配置已更新")
      emit("saved", props.problemId!)
    } else {
      const res = await api.post<{ data: { id: string } }>("/api/v1/problems", {
        ...payload,
        type: problemType.value,
      })
      savedProblemId.value = res.data.id
      toast.success("OI 题目配置已保存，请继续导入题目包")
      emit("saved", res.data.id)
    }
  } catch (err) {
    error.value = extractApiError(err).message
  } finally {
    saving.value = false
  }
}

onMounted(loadProblem)
</script>

<template>
  <div v-if="isEditMode && pageLoading" class="py-12 text-center text-text-secondary">加载 OI 题目配置...</div>
  <div v-else-if="notFound" class="py-12 text-center text-text-secondary">题目不存在</div>
  <div v-else-if="isEditMode && error && !title" class="py-12 text-center text-error-text">{{ error }}</div>
  <div v-else class="flex flex-col gap-5 rounded-xl border border-border bg-white p-5 sm:p-6">
    <div v-if="error" class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</div>
    <section class="grid gap-3 sm:grid-cols-2">
      <label class="flex flex-col gap-1 text-sm sm:col-span-2">
        <span class="font-semibold">标题</span>
        <input v-model="title" class="rounded-md border border-border px-3 py-2" placeholder="例如：两数之和" />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-semibold">题目类型</span>
        <select v-model="problemType" class="rounded-md border border-border px-3 py-2" :disabled="isEditMode || props.initialType === 'P'">
          <option value="U">用户题库（U）</option>
          <option value="P">主题库（P）</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-semibold">难度</span>
        <select v-model="difficulty" class="rounded-md border border-border px-3 py-2">
          <option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm sm:col-span-2">
        <span class="font-semibold">题面</span>
        <textarea v-model="description" rows="7" class="rounded-md border border-border px-3 py-2 font-mono text-sm" placeholder="支持 Markdown，输入/输出说明写在这里" />
      </label>
    </section>

    <section class="border-t border-border pt-4">
      <div class="mb-3 flex items-center justify-between">
        <div><h2 class="font-semibold">OI 评测配置</h2><p class="mt-1 text-xs text-text-secondary">题目固定选择原生或 WASM 后端；WASM 成本表由服务器校准后注入。</p></div>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="flex flex-col gap-1 text-sm"><span>后端</span><select v-model="backend" class="rounded-md border border-border px-3 py-2"><option value="native">原生 go-judge</option><option value="wasm">WASM（等效计时）</option></select></label>
        <label class="flex flex-col gap-1 text-sm"><span>默认时限（ms）</span><input v-model.number="timeLimitMs" type="number" min="1" max="60000" class="rounded-md border border-border px-3 py-2" /></label>
        <label class="flex flex-col gap-1 text-sm"><span>默认内存（MiB）</span><input v-model.number="memoryLimitMb" type="number" min="1" max="512" class="rounded-md border border-border px-3 py-2" /></label>
      </div>
      <div class="mt-3 flex flex-wrap gap-4 text-sm">
        <label v-for="language in (['c', 'cc'] as const)" :key="language" class="inline-flex items-center gap-2"><input type="checkbox" :checked="languages.includes(language)" @change="toggleLanguage(language)" /><span>{{ language === 'c' ? 'C99' : 'C++11（cc）' }}</span></label>
      </div>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-sm"><span>比较器</span><select v-model="checkerType" class="rounded-md border border-border px-3 py-2"><option value="default">default（忽略空白）</option><option value="strict">strict（逐字节）</option><option value="testlib">testlib（受信 checker）</option></select></label>
        <label v-if="checkerType === 'testlib'" class="flex flex-col gap-1 text-sm"><span>checker 路径</span><input v-model="checkerPath" class="rounded-md border border-border px-3 py-2" placeholder="checker.cpp" /></label>
      </div>
    </section>

    <section class="border-t border-border pt-4">
      <div class="mb-3 flex items-center justify-between"><div><h2 class="font-semibold">子任务</h2><p class="mt-1 text-xs text-text-secondary">所有测试点通过才得分；依赖未通过的子任务显示 IGN。</p></div><UButton size="sm" variant="outline" icon="i-lucide-plus" @click="addSubtask">新增</UButton></div>
      <div v-for="(subtask, index) in subtasks" :key="index" class="mb-3 grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_110px_1fr_2fr_auto]">
        <input v-model="subtask.id" class="rounded border border-border px-2 py-1.5 text-sm" placeholder="ID" />
        <input v-model.number="subtask.score" type="number" min="0" max="100" step="0.01" class="rounded border border-border px-2 py-1.5 text-sm" placeholder="分值" />
        <input v-model="subtask.depends_on" class="rounded border border-border px-2 py-1.5 text-sm" placeholder="依赖 ID（逗号分隔）" />
        <textarea v-model="subtask.cases" rows="2" class="rounded border border-border px-2 py-1.5 font-mono text-xs" placeholder="每行 input|output" />
        <UButton size="xs" color="error" variant="ghost" :disabled="subtasks.length <= 1" icon="i-lucide-trash-2" @click="removeSubtask(index)" />
      </div>
    </section>

    <div class="flex items-center justify-between border-t border-border pt-4">
      <p class="text-xs text-text-secondary">保存后请上传包含 problem.json/config.yaml 与 testdata 的题目 ZIP。</p>
      <UButton color="primary" :loading="saving" @click="save">{{ isEditMode ? '更新 OI 题目' : '保存 OI 题目' }}</UButton>
    </div>
    <div v-if="savedProblemId" class="rounded-md bg-primary-bg px-3 py-2 text-xs text-primary">题目已创建：{{ savedProblemId }}。可在题目管理页导入支持包。</div>
  </div>
</template>
