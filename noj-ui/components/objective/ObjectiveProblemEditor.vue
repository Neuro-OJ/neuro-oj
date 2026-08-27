<script setup lang="ts">
import type {
  ObjectivePaper,
  ObjectiveQuestion,
  ObjectiveQuestionType,
  QuestionInput,
} from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'
import { useToast } from '~/composables/useToast'
import { problemUrl } from '~/utils/publicIdentifiers'

/**
 * 客观题套卷编辑器（并入 problems 体系：is_objective 题目）。
 * 创建模式（无 paperId）：填元信息创建套卷后自动进入小题管理；
 * 编辑模式（有 paperId）：管理套卷元信息与小题（单选/多选/判断）CRUD。
 */
const props = defineProps<{
  /** 套卷题目 ID（problems.id）；缺省 = 创建模式 */
  paperId?: string
}>()

const {
  createPaper,
  updatePaper,
  deletePaper,
  listQuestions,
  createQuestion,
  updateQuestion,
  deleteQuestion,
} = useObjective()
const { toast } = useToast()
const { dialog } = useDialog()
const { api } = useApi()
const router = useRouter()

// 创建模式：先填元信息创建套卷，创建成功后进入编辑模式
const activePaperId = ref<string | null>(props.paperId ?? null)
watchEffect(() => {
  activePaperId.value = props.paperId ?? null
})

// ── 创建表单 ────────────────────────────────

const creating = ref(false)
const createType = ref<'U' | 'P'>('U')
const createTitle = ref('')
const createDescription = ref('')
const createError = ref('')

// ── 标签选择（仅允许选用已有标签；客观题只展示题目标签） ──
const tagOptions = ref<{ id: string; name: string; kind: 'problem' | 'algorithm' }[]>([])
const tagSearch = ref("")
// 创建模式勾选的标签
const createTagIds = ref<string[]>([])

async function loadTagOptions() {
  try {
    const res = await api.get<{ data: { id: string; name: string; kind: 'problem' | 'algorithm' }[] }>(
      "/api/v1/tags",
      { silent: true },
    )
    // 客观题套卷只允许题目标签（kind=problem）
    tagOptions.value = (res.data ?? []).filter((t) => t.kind === "problem")
  } catch {
    tagOptions.value = []
  }
}

// 标签选项：题目标签按名称排序，label 仅展示名称（客观题仅 problem 标签）
const filteredTagOptions = computed(() => {
  const keyword = tagSearch.value.trim().toLowerCase()
  const sorted = [...tagOptions.value].sort((a, b) => a.name.localeCompare(b.name))
  if (!keyword) return sorted.map((t) => ({ label: t.name, value: t.id }))
  return sorted
    .filter((t) => t.name.toLowerCase().includes(keyword))
    .map((t) => ({ label: t.name, value: t.id }))
})

onMounted(() => {
  loadTagOptions()
})

async function onCreate() {
  if (creating.value) return
  if (!createTitle.value.trim()) {
    createError.value = '请输入套卷标题'
    return
  }
  createError.value = ''
  creating.value = true
  try {
    const res = await createPaper({
      title: createTitle.value.trim(),
      description: createDescription.value.trim(),
      type: createType.value,
      tag_ids: createTagIds.value,
    })
    toast.success('套卷已创建，开始添加小题')
    // 创建成功后跳转到编辑套卷地址（display_id 可读可分享）。
    // 不在此处设置 activePaperId：让路由跳转驱动组件重新挂载为编辑模式。
    const id = res.data.display_id || res.data.id
    await router.push(`/problems/${id}/edit`)
  } catch {
    // useApi 已弹错误
  } finally {
    creating.value = false
  }
}

// ── 编辑模式数据加载（activePaperId 为 null 时跳过请求） ──

const { data: paperData, error: paperError } = await useFetch<{ data: ObjectivePaper }>(
  computed(() =>
    activePaperId.value
      ? `/api/v1/problems/${activePaperId.value}`
      : null
  ),
  { server: false },
)

// 小题列表用手动 API 拉取（不用 useFetch），确保保存/删除后刷新绝对生效。
const questions = ref<ObjectiveQuestion[]>([])
const qError = ref(false)
const qLoading = ref(false)

async function loadQuestions() {
  if (!activePaperId.value) return
  qLoading.value = true
  qError.value = false
  try {
    const res = await listQuestions(activePaperId.value)
    questions.value = res.data ?? []
  } catch {
    qError.value = true
    questions.value = []
  } finally {
    qLoading.value = false
  }
}

const paper = computed(() => paperData.value?.data ?? null)

const title = ref('')
const description = ref('')
// 编辑模式已选标签（仅套卷自己的题目标签 id）
const editTagIds = ref<string[]>([])
watchEffect(() => {
  if (paper.value) {
    title.value = paper.value.title
    description.value = paper.value.description
    editTagIds.value = (paper.value.tags ?? []).map((t) => t.id)
  }
})

// activePaperId 变化时重新加载套卷元信息与小题列表
watchEffect(() => {
  if (activePaperId.value) {
    loadQuestions()
  } else {
    questions.value = []
  }
})

const savingMeta = ref(false)
async function onSaveMeta() {
  if (!title.value.trim()) {
    toast.error('标题不能为空')
    return
  }
  savingMeta.value = true
  try {
    await updatePaper(activePaperId.value!, {
      title: title.value.trim(),
      description: description.value.trim(),
      tag_ids: editTagIds.value,
    })
    toast.success('套卷信息已保存')
  } catch {
    // useApi 已弹错误
  } finally {
    savingMeta.value = false
  }
}

async function onDeletePaper() {
  const ok = await dialog.confirm('确定删除该套卷？其下全部小题与提交记录将一并删除。', {
    title: '删除套卷',
    danger: true,
    confirmText: '删除',
  })
  if (!ok) return
  try {
    await deletePaper(activePaperId.value!)
    toast.success('套卷已删除')
    router.push('/problems')
  } catch {
    // useApi 已弹错误
  }
}

// ── 小题编辑器 ────────────────────────────────

const editing = ref<{
  id: string | null // null = 新建
  type: ObjectiveQuestionType
  prompt: string
  options: { key: string; text: string }[]
  answer: (string | boolean)[]
  explanation: string
} | null>(null)

function openCreate() {
  editing.value = { id: null, type: 'single', prompt: '', options: [{ key: 'A', text: '' }], answer: [], explanation: '' }
}

function openEdit(q: ObjectiveQuestion) {
  editing.value = {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    options: q.options.map((o) => ({ ...o })),
    answer: q.answer ? [...q.answer] : [],
    explanation: q.explanation ?? '',
  }
}

function closeEditor() {
  editing.value = null
}

function addOption() {
  if (!editing.value) return
  const nextKey = String.fromCharCode(65 + editing.value.options.length)
  editing.value.options.push({ key: nextKey, text: '' })
}

function removeOption(idx: number) {
  if (!editing.value) return
  editing.value.options.splice(idx, 1)
}

function toggleAnswer(key: string) {
  if (!editing.value) return
  const arr = editing.value.answer
  if (editing.value.type === 'single' || editing.value.type === 'judge') {
    editing.value.answer = [key === 'true' ? true : key]
    return
  }
  const idx = arr.indexOf(key)
  if (idx >= 0) arr.splice(idx, 1)
  else arr.push(key)
  editing.value.answer = [...arr]
}

function isAnswer(key: string) {
  if (!editing.value) return false
  const arr = editing.value.answer
  if (editing.value.type === 'judge') return arr.includes(key === 'true')
  // 单选只允许一个答案被勾选；避免从多选/判断切换后旧答案导致多个 radio 同时高亮
  if (editing.value.type === 'single') return arr.length === 1 && arr[0] === key
  return arr.includes(key)
}

// 防止连点「保存小题」导致同一小题被重复创建
const savingQuestion = ref(false)

async function onSaveQuestion() {
  const e = editing.value
  if (!e || savingQuestion.value) return
  if (!e.prompt.trim()) {
    toast.error('题干不能为空')
    return
  }
  let payload: QuestionInput
  if (e.type === 'judge') {
    if (e.answer.length !== 1 || typeof e.answer[0] !== 'boolean') {
      toast.error('请选择正确答案')
      return
    }
    payload = { type: 'judge', prompt: e.prompt.trim(), answer: e.answer, explanation: e.explanation.trim() }
  } else {
    const opts = e.options.filter((o) => o.text.trim())
    if (opts.length < 2) {
      toast.error('至少需要两个选项')
      return
    }
    if (e.answer.length === 0) {
      toast.error('请选择正确答案')
      return
    }
    // 单选只允许一个答案；多选/判断切换残留的旧答案会在保存前被拦截
    if (e.type === 'single' && e.answer.length !== 1) {
      toast.error('单选题请只选择一个正确答案')
      return
    }
    payload = {
      type: e.type,
      prompt: e.prompt.trim(),
      options: opts,
      answer: e.answer,
      explanation: e.explanation.trim(),
    }
  }

  savingQuestion.value = true
  try {
    if (e.id === null) {
      await createQuestion(activePaperId.value!, payload)
      toast.success('小题已添加')
    } else {
      await updateQuestion(activePaperId.value!, e.id, payload)
      toast.success('小题已更新')
    }
    closeEditor()
    // 重新拉取题单，确保新增/编辑的小题立即出现在列表中
    await loadQuestions()
  } catch {
    // useApi 已弹错误
  } finally {
    savingQuestion.value = false
  }
}

async function onDeleteQuestion(q: ObjectiveQuestion) {
  // 只对超长题干做截断并追加省略号；短题干不显示「…」
  const preview = q.prompt.length > 20 ? `${q.prompt.slice(0, 20)}…` : q.prompt
  const ok = await dialog.confirm(`确定删除小题「${preview}」？`, {
    title: '删除小题',
    danger: true,
    confirmText: '删除',
  })
  if (!ok) return
  try {
    await deleteQuestion(activePaperId.value!, q.id)
    toast.success('小题已删除')
    await loadQuestions()
  } catch {
    // useApi 已弹错误
  }
}
</script>

<template>
  <!-- 创建模式：先填套卷元信息 -->
  <div v-if="activePaperId === null" class="flex flex-col gap-4">
    <section class="rounded-xl border border-border bg-white p-5">
      <h2 class="mb-3 text-sm font-semibold text-text">套卷信息</h2>
      <div class="flex flex-col gap-3">
        <UFormField label="题目类型">
          <USelect
            v-model="createType"
            :items="[
              { label: '用户题库（U 型）', value: 'U' },
              { label: '主题库（P 型，仅管理员）', value: 'P' },
            ]"
          />
        </UFormField>
        <UFormField label="标题">
          <UInput v-model="createTitle" placeholder="套卷标题" />
        </UFormField>
        <UFormField label="描述">
          <UTextarea v-model="createDescription" placeholder="套卷描述" :rows="3" />
        </UFormField>
        <UFormField label="标签">
          <div class="flex flex-col gap-1">
            <input
              v-model="tagSearch"
              class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white"
              placeholder="搜索标签..."
              aria-label="搜索标签"
            />
            <div class="flex flex-wrap gap-2">
              <label v-for="t in filteredTagOptions" :key="t.value" class="flex items-center gap-1 text-xs text-text cursor-pointer">
                <input v-model="createTagIds" type="checkbox" :value="t.value" class="accent-primary" />
                {{ t.label }}
              </label>
              <span v-if="filteredTagOptions.length === 0" class="text-xs text-text-muted">{{ tagOptions.length === 0 ? '暂无标签' : '无匹配标签' }}</span>
            </div>
          </div>
        </UFormField>
        <p v-if="createError" class="text-sm text-red-600">{{ createError }}</p>
        <div class="flex items-center gap-3">
          <UButton color="primary" :loading="creating" @click="onCreate">创建套卷</UButton>
          <span class="text-xs text-text-muted">创建后自动进入小题管理（单选 / 多选 / 判断）</span>
        </div>
      </div>
    </section>
  </div>

  <!-- 编辑模式：元信息 + 小题管理 -->
  <AsyncContent
    v-else
    :status="paperError ? 'error' : paper ? 'data' : 'loading'"
    error="套卷加载失败"
  >
    <div v-if="paper" class="flex flex-col gap-4">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-lg font-bold text-text">编辑套卷：{{ paper.title }}</h1>
          <p class="text-xs text-text-secondary">{{ paper.display_id }} · 客观题</p>
        </div>
        <UButton color="neutral" variant="outline" icon="i-lucide-arrow-left" :to="problemUrl(paper.id, paper.display_id)">
          返回答题页
        </UButton>
      </header>

      <!-- 套卷元信息 -->
      <section class="rounded-xl border border-border bg-white p-5">
        <h2 class="mb-3 text-sm font-semibold text-text">套卷信息</h2>
        <div class="flex flex-col gap-3">
          <UFormField label="标题">
            <UInput v-model="title" placeholder="套卷标题" />
          </UFormField>
          <UFormField label="描述">
            <UTextarea v-model="description" placeholder="套卷描述" :rows="3" />
          </UFormField>
          <UFormField label="标签">
            <div class="flex flex-col gap-1">
              <input
                v-model="tagSearch"
                class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_2px_rgba(59,130,246,0.1)] bg-white"
                placeholder="搜索标签..."
              />
              <div class="flex flex-wrap gap-2">
                <label v-for="t in filteredTagOptions" :key="t.value" class="flex items-center gap-1 text-xs text-text cursor-pointer">
                  <input v-model="editTagIds" type="checkbox" :value="t.value" class="accent-primary" />
                  {{ t.label }}
                </label>
                <span v-if="filteredTagOptions.length === 0" class="text-xs text-text-muted">{{ tagOptions.length === 0 ? '暂无标签' : '无匹配标签' }}</span>
              </div>
            </div>
          </UFormField>
          <div class="flex gap-2">
            <UButton color="primary" :loading="savingMeta" @click="onSaveMeta">保存信息</UButton>
            <UButton color="red" variant="outline" @click="onDeletePaper">删除套卷</UButton>
          </div>
        </div>
      </section>

      <!-- 小题列表 -->
      <section class="rounded-xl border border-border bg-white p-5">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-text">小题（{{ questions.length }}）</h2>
          <UButton color="primary" size="sm" icon="i-lucide-plus" @click="openCreate">添加小题</UButton>
        </div>

        <AsyncContent
          :status="qLoading ? 'loading' : qError ? 'error' : questions.length ? 'data' : 'empty'"
          error="小题加载失败"
          empty-text="暂无小题，点击「添加小题」开始出题"
          @retry="loadQuestions"
        >
          <div v-if="questions.length" class="flex flex-col gap-2">
            <div
              v-for="(q, idx) in questions"
              :key="q.id"
              class="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
            >
              <span class="w-6 shrink-0 text-sm text-text-muted">{{ idx + 1 }}</span>
              <span class="inline-flex shrink-0 items-center rounded bg-gray-100 px-2 py-0.5 text-xs text-text-secondary">
                {{ QUESTION_TYPE_LABELS[q.type] }}
              </span>
              <p class="min-w-0 flex-1 truncate text-sm text-text">{{ q.prompt }}</p>
              <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-pencil" @click="openEdit(q)" />
              <UButton color="red" variant="ghost" size="sm" icon="i-lucide-trash-2" @click="onDeleteQuestion(q)" />
            </div>
          </div>
        </AsyncContent>
      </section>

      <!-- 小题编辑器 -->
      <section v-if="editing" class="rounded-xl border border-primary/30 bg-white p-5">
        <h2 class="mb-3 text-sm font-semibold text-text">
          {{ editing.id === null ? '添加小题' : '编辑小题' }}
        </h2>
        <div class="flex flex-col gap-3">
          <UFormField label="题型">
            <USelect
              v-model="editing.type"
              :items="[
                { label: '单选', value: 'single' },
                { label: '多选', value: 'multiple' },
                { label: '判断', value: 'judge' },
              ]"
            />
          </UFormField>

          <UFormField label="题干">
            <UTextarea v-model="editing.prompt" :rows="2" placeholder="输入题目内容" />
          </UFormField>

          <!-- 选项（判断题固定对/错） -->
          <UFormField v-if="editing.type !== 'judge'" label="选项与答案">
            <div class="flex flex-col gap-2">
              <div
                v-for="(opt, i) in editing.options"
                :key="i"
                class="flex items-center gap-2"
              >
                <input
                  :type="editing.type === 'single' ? 'radio' : 'checkbox'"
                  :checked="isAnswer(opt.key)"
                  class="accent-primary"
                  @change="toggleAnswer(opt.key)"
                />
                <span class="w-5 text-sm font-medium">{{ opt.key }}.</span>
                <UInput v-model="opt.text" class="flex-1" :placeholder="`选项 ${opt.key} 内容`" />
                <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-x" @click="removeOption(i)" />
              </div>
              <UButton size="sm" variant="outline" icon="i-lucide-plus" @click="addOption">添加选项</UButton>
            </div>
          </UFormField>

          <!-- 判断题答案 -->
          <UFormField v-else label="正确答案">
            <div class="flex gap-4">
              <label class="flex items-center gap-1.5 text-sm">
                <input type="radio" class="accent-primary" :checked="isAnswer('true')" @change="toggleAnswer('true')" />
                正确
              </label>
              <label class="flex items-center gap-1.5 text-sm">
                <input type="radio" class="accent-primary" :checked="isAnswer('false')" @change="toggleAnswer('false')" />
                错误
              </label>
            </div>
          </UFormField>

          <UFormField label="解析（判卷后展示，可选）">
            <UTextarea v-model="editing.explanation" :rows="2" placeholder="答案解析" />
          </UFormField>

          <div class="flex gap-2">
            <UButton color="primary" :loading="savingQuestion" :disabled="savingQuestion" @click="onSaveQuestion">保存小题</UButton>
            <UButton color="neutral" variant="outline" @click="closeEditor">取消</UButton>
          </div>
        </div>
      </section>
    </div>
  </AsyncContent>
</template>
