<script setup lang="ts">
import type {
  ObjectivePaper,
  ObjectiveQuestion,
  ObjectiveQuestionType,
  QuestionInput,
} from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'

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
    })
    activePaperId.value = res.data.id
    toast.success('套卷已创建，开始添加小题')
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
const { data: qData, error: qError, refresh: refreshQuestions } = await useFetch<
  { data: ObjectiveQuestion[] }
>(
  computed(() =>
    activePaperId.value
      ? `/api/v1/problems/${activePaperId.value}/questions`
      : null
  ),
  { server: false },
)

const paper = computed(() => paperData.value?.data ?? null)
const questions = computed(() => qData.value?.data ?? [])

const title = ref('')
const description = ref('')
watchEffect(() => {
  if (paper.value) {
    title.value = paper.value.title
    description.value = paper.value.description
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
    await updatePaper(activePaperId.value!, { title: title.value.trim(), description: description.value.trim() })
    toast.success('套卷信息已保存')
  } catch {
    // useApi 已弹错误
  } finally {
    savingMeta.value = false
  }
}

async function onDeletePaper() {
  if (!confirm('确定删除该套卷？其下全部小题与提交记录将一并删除。')) return
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

async function onSaveQuestion() {
  const e = editing.value
  if (!e) return
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

  try {
    if (e.id === null) {
      await createQuestion(activePaperId.value!, payload)
      toast.success('小题已添加')
    } else {
      await updateQuestion(activePaperId.value!, e.id, payload)
      toast.success('小题已更新')
    }
    closeEditor()
    await refreshQuestions()
  } catch {
    // useApi 已弹错误
  }
}

async function onDeleteQuestion(q: ObjectiveQuestion) {
  if (!confirm(`确定删除小题「${q.prompt.slice(0, 20)}…」？`)) return
  try {
    await deleteQuestion(activePaperId.value!, q.id)
    toast.success('小题已删除')
    await refreshQuestions()
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
        <UField label="题目类型">
          <USelect
            v-model="createType"
            :items="[
              { label: '用户题库（U 型）', value: 'U' },
              { label: '主题库（P 型，仅管理员）', value: 'P' },
            ]"
          />
        </UField>
        <UField label="标题">
          <UInput v-model="createTitle" placeholder="套卷标题" />
        </UField>
        <UField label="描述">
          <UTextarea v-model="createDescription" placeholder="套卷描述" :rows="3" />
        </UField>
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
        <UButton color="neutral" variant="outline" icon="i-lucide-arrow-left" :to="`/problems/${paper.id}`">
          返回答题页
        </UButton>
      </header>

      <!-- 套卷元信息 -->
      <section class="rounded-xl border border-border bg-white p-5">
        <h2 class="mb-3 text-sm font-semibold text-text">套卷信息</h2>
        <div class="flex flex-col gap-3">
          <UField label="标题">
            <UInput v-model="title" placeholder="套卷标题" />
          </UField>
          <UField label="描述">
            <UTextarea v-model="description" placeholder="套卷描述" :rows="3" />
          </UField>
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
          :status="qError ? 'error' : questions.length ? 'data' : 'empty'"
          error="小题加载失败"
          empty-text="暂无小题，点击「添加小题」开始出题"
          @retry="refreshQuestions"
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
          <UField label="题型">
            <USelect
              v-model="editing.type"
              :items="[
                { label: '单选', value: 'single' },
                { label: '多选', value: 'multiple' },
                { label: '判断', value: 'judge' },
              ]"
            />
          </UField>

          <UField label="题干">
            <UTextarea v-model="editing.prompt" :rows="2" placeholder="输入题目内容" />
          </UField>

          <!-- 选项（判断题固定对/错） -->
          <UField v-if="editing.type !== 'judge'" label="选项与答案">
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
          </UField>

          <!-- 判断题答案 -->
          <UField v-else label="正确答案">
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
          </UField>

          <UField label="解析（判卷后展示，可选）">
            <UTextarea v-model="editing.explanation" :rows="2" placeholder="答案解析" />
          </UField>

          <div class="flex gap-2">
            <UButton color="primary" @click="onSaveQuestion">保存小题</UButton>
            <UButton color="neutral" variant="outline" @click="closeEditor">取消</UButton>
          </div>
        </div>
      </section>
    </div>
  </AsyncContent>
</template>
