<script setup lang="ts">
import type {
  ObjectiveOption,
  ObjectivePaper,
  ObjectiveQuestion,
  ObjectiveQuestionType,
  QuestionDraft,
  QuestionInput,
} from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'
import { useToast } from '~/composables/useToast'
import { problemUrl } from '~/utils/publicIdentifiers'

/**
 * 客观题套卷编辑器（并入 problems 体系：is_objective 题目）。
 * 创建模式（无 paperId）：填元信息创建套卷后自动进入小题管理；
 * 编辑模式（有 paperId）：管理套卷元信息与小题（单选/多选/判断）CRUD。
 *
 * 版本化（Handbook §6.4/§6.8，批次 2d）：小题与套卷内容都写**共享草稿**并共用
 * 同一个 revision 乐观锁；「发布版本」才把草稿固定成新的作答版本。已发布内容
 * 不因草稿编辑而改变，作答者读的是版本快照。
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
  getDraft,
  publishDraft,
  createQuestion,
  updateQuestion,
  deleteQuestion,
} = useObjective()
const { toast } = useToast()
const { dialog } = useDialog()
const { api } = useApi()
const router = useRouter()

/** 共享草稿 revision（小题与套卷内容写入的乐观锁）。 */
const draftRevision = ref<number | null>(null)
/** 最新已发布版本号（null = 尚未发布）。 */
const latestVersion = ref<number | null>(null)
const publishing = ref(false)
/** 草稿是否已加载（避免投影里的旧标题覆盖草稿标题）。 */
const draftLoaded = ref(false)

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

// Nuxt UseFetch 的 url getter 类型不接受 null，但运行时支持返回 null 跳过请求；
  // 断言仅为通过类型检查，行为不变。
  // eslint/deno lint: Ref 类型仅用于类型断言
  const paperUrl = computed(() =>
    activePaperId.value
      ? `/api/v1/problems/${activePaperId.value}`
      : null
  )
  const { data: paperData, error: paperError } = await useFetch<{ data: ObjectivePaper }>(
    paperUrl as unknown as Ref<`/api/v1/problems/${string}`>,
    { server: false },
  )

// 小题列表用手动 API 拉取（不用 useFetch），确保保存/删除后刷新绝对生效。
const questions = ref<ObjectiveQuestion[]>([])
const qError = ref(false)
const qLoading = ref(false)

/**
 * 加载套卷草稿：小题列表与 revision 来自**同一个响应**，保证编辑初值一致。
 *
 * 编辑者的题面/小题事实源是草稿（投影只在发布时更新，可能落后）。
 */
async function loadQuestions() {
  if (!activePaperId.value) return
  qLoading.value = true
  qError.value = false
  try {
    const res = await getDraft(activePaperId.value)
    draftRevision.value = res.data.revision
    const content = res.data.content as {
      title?: string
      description?: string
      questions?: Array<Record<string, unknown>>
    }
    if (typeof content.title === 'string') title.value = content.title
    if (typeof content.description === 'string') description.value = content.description
    questions.value = (content.questions ?? []).map((item) => ({
      id: String(item.key),
      paper_id: activePaperId.value as string,
      sort_order: Number(item.sort_order ?? 0),
      type: item.type as ObjectiveQuestionType,
      prompt: String(item.prompt ?? ''),
      options: (item.options ?? []) as ObjectiveOption[],
      answer: (item.answer ?? []) as (string | boolean)[],
      explanation: String(item.explanation ?? ''),
      created_at: '',
      updated_at: '',
    })).sort((a, b) => a.sort_order - b.sort_order)
    draftLoaded.value = true
  } catch {
    // 回退：草稿读取失败（如旧版后端）时仍用小题接口展示
    try {
      const res = await listQuestions(activePaperId.value)
      questions.value = res.data ?? []
    } catch {
      qError.value = true
      questions.value = []
    }
  } finally {
    qLoading.value = false
  }
}

/** 重新读取草稿 revision（管理信息保存会递增它）。 */
async function refreshRevision() {
  if (!activePaperId.value) return
  try {
    const res = await getDraft(activePaperId.value)
    draftRevision.value = res.data.revision
  } catch {
    // useApi 已弹错误
  }
}

const paper = computed(() => paperData.value?.data ?? null)

const title = ref('')
const description = ref('')
// 编辑模式已选标签（仅套卷自己的题目标签 id）
const editTagIds = ref<string[]>([])
watchEffect(() => {
  if (paper.value) {
    // 管理信息（标签、最新版）来自题目行；内容以草稿为准（draftLoaded 时）
    editTagIds.value = (paper.value.tags ?? []).map((t) => t.id)
    latestVersion.value =
      (paper.value as { latest_version?: number | null }).latest_version ?? latestVersion.value
    if (!draftLoaded.value) {
      title.value = paper.value.title
      description.value = paper.value.description
    }
  }
})

// activePaperId 变化时重新加载套卷草稿（元信息 + 小题 + revision）
watchEffect(() => {
  if (activePaperId.value) {
    draftLoaded.value = false
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
    // 套卷内容（题面/描述）写草稿，管理信息（标签）直接生效
    await updatePaper(activePaperId.value!, {
      title: title.value.trim(),
      description: description.value.trim(),
      tag_ids: editTagIds.value,
    })
    await refreshRevision()
    await loadQuestions()
    toast.success('套卷信息已保存（发布后才会成为新的作答版本）')
  } catch {
    // useApi 已弹错误
  } finally {
    savingMeta.value = false
  }
}

/** 发布当前草稿为新版本（相同内容复用既有版本，不制造空版本）。 */
async function onPublish() {
  if (!activePaperId.value || publishing.value) return
  publishing.value = true
  try {
    const res = await publishDraft(activePaperId.value, draftRevision.value ?? 0)
    draftRevision.value = res.data.draft_revision
    latestVersion.value = res.data.version
    toast.success(
      res.data.unchanged
        ? `内容未变化，继续使用 V${res.data.version}`
        : `已发布 V${res.data.version}`,
    )
  } catch {
    // useApi 已弹错误（409 时提示重新加载）
  } finally {
    publishing.value = false
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

// ── 小题编辑器（在列表中原地展开） ────────────────────────────────

const editing = ref<QuestionDraft | null>(null)
// 打开时的快照，用于判断是否有未保存修改
const editingSnapshot = ref('')
// 每次打开新草稿递增，强制表单重新挂载（避免题型 watcher 误清空新草稿的答案）
const draftKey = ref(0)

const isEditingDirty = computed(() =>
  editing.value !== null && JSON.stringify(editing.value) !== editingSnapshot.value
)

/** 有未保存修改时确认是否放弃；无修改或确认放弃返回 true */
async function confirmDiscard(): Promise<boolean> {
  if (!isEditingDirty.value) return true
  return await dialog.confirm('当前小题有未保存的修改，确定放弃？', {
    title: '放弃修改',
    danger: true,
    confirmText: '放弃修改',
  })
}

function startEditing(draft: QuestionDraft) {
  editing.value = draft
  editingSnapshot.value = JSON.stringify(draft)
  draftKey.value++
  // 等表单渲染后滚动到可视区域（新建时表单位于列表末尾）
  nextTick(() => {
    document.getElementById('objective-question-editor')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

function blankDraft(): QuestionDraft {
  return {
    id: null,
    type: 'single',
    prompt: '',
    options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: '' })),
    answer: [],
    explanation: '',
  }
}

async function openCreate() {
  if (editing.value?.id === null) {
    document.getElementById('objective-question-editor')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    return
  }
  if (!(await confirmDiscard())) return
  startEditing(blankDraft())
}

async function openEdit(q: ObjectiveQuestion) {
  if (editing.value?.id === q.id) return
  if (!(await confirmDiscard())) return
  startEditing({
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    options: q.options.map((o) => ({ ...o })),
    answer: q.answer ? [...q.answer] : [],
    explanation: q.explanation ?? '',
  })
}

function closeEditor() {
  editing.value = null
  editingSnapshot.value = ''
}

async function onCancelEdit() {
  if (!(await confirmDiscard())) return
  closeEditor()
}

// 离开页面前提示未保存的小题修改
onBeforeRouteLeave(async () => {
  if (!(await confirmDiscard())) return false
})

/** 列表展示：该选项是否为正确答案（判断题选项键为 'true' / 'false'） */
function isCorrectOption(q: ObjectiveQuestion, key: string): boolean {
  if (!q.answer) return false
  return q.type === 'judge' ? q.answer.includes(key === 'true') : q.answer.includes(key)
}

// 防止连点「保存小题」导致同一小题被重复创建
const savingQuestion = ref(false)

async function onSaveQuestion(next = false) {
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
      const res = await createQuestion(
        activePaperId.value!,
        payload,
        draftRevision.value ?? 0,
      )
      draftRevision.value = res.data.draft_revision ?? draftRevision.value
      toast.success('小题已添加（发布后才会生效）')
    } else {
      const res = await updateQuestion(
        activePaperId.value!,
        e.id,
        payload,
        draftRevision.value ?? 0,
      )
      draftRevision.value = res.data.draft_revision ?? draftRevision.value
      toast.success('小题已更新（发布后才会生效）')
    }
    closeEditor()
    // 重新拉取题单，确保新增/编辑的小题立即出现在列表中
    await loadQuestions()
    // 「保存并继续添加」：直接打开下一道空白小题
    if (next) startEditing(blankDraft())
  } catch {
    // useApi 已弹错误（409 时需重新加载草稿）
    await refreshRevision()
  } finally {
    savingQuestion.value = false
  }
}

async function onDeleteQuestion(q: ObjectiveQuestion, index: number) {
  // 题干可能含表格 / 公式源码，确认框只显示题号
  const ok = await dialog.confirm(`确定删除第 ${index + 1} 题？删除后不可恢复。`, {
    title: '删除小题',
    danger: true,
    confirmText: '删除',
  })
  if (!ok) return
  try {
    const res = await deleteQuestion(
      activePaperId.value!,
      q.id,
      draftRevision.value ?? 0,
    )
    draftRevision.value = res.data.draft_revision
    if (editing.value?.id === q.id) closeEditor()
    toast.success('小题已删除（发布后才会生效）')
    await loadQuestions()
  } catch {
    // useApi 已弹错误（409 时需重新加载草稿）
    await refreshRevision()
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
          <UInput v-model="createTitle" class="w-full" placeholder="套卷标题" />
        </UFormField>
        <UFormField label="描述">
          <UTextarea v-model="createDescription" class="w-full" placeholder="套卷描述（支持 Markdown）" :rows="3" autoresize :maxrows="20" />
        </UFormField>
        <UFormField label="标签">
          <div class="flex flex-col gap-1">
            <input
              v-model="tagSearch"
              class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:input-base-focus bg-white"
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
            <UInput v-model="title" class="w-full" placeholder="套卷标题" />
          </UFormField>
          <UFormField label="描述">
            <UTextarea v-model="description" class="w-full" placeholder="套卷描述（支持 Markdown）" :rows="3" autoresize :maxrows="20" />
          </UFormField>
          <UFormField label="标签">
            <div class="flex flex-col gap-1">
              <input
                v-model="tagSearch"
                class="px-3 py-2 text-sm border border-border rounded-md outline-none transition-colors focus:input-base-focus bg-white"
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
          <div class="flex flex-wrap items-center gap-2">
            <span class="mr-auto text-xs text-text-secondary">
              {{ latestVersion ? `当前最新版 V${latestVersion}` : '尚未发布（发布后才可作答）' }}
              <span v-if="draftRevision !== null" class="text-text-muted">· 草稿 revision {{ draftRevision }}</span>
            </span>
            <UButton color="primary" variant="outline" :loading="savingMeta" @click="onSaveMeta">保存信息</UButton>
            <UButton
              color="primary"
              class="border border-transparent bg-signal text-on-signal hover:bg-signal/80"
              :loading="publishing"
              :disabled="savingMeta || draftRevision === null"
              @click="onPublish"
            >
              发布版本
            </UButton>
            <UButton color="error" variant="outline" @click="onDeletePaper">删除套卷</UButton>
          </div>
        </div>
      </section>

      <!-- 小题列表：渲染后的题面 + 正确答案高亮；点「编辑」在原位置展开表单 -->
      <section class="rounded-xl border border-border bg-white p-5">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-text">小题（{{ questions.length }}）</h2>
          <UButton color="primary" size="sm" icon="i-lucide-plus" @click="openCreate">添加小题</UButton>
        </div>

        <AsyncContent
          :status="qLoading && !questions.length ? 'loading' : qError ? 'error' : questions.length || editing ? 'data' : 'empty'"
          error="小题加载失败"
          empty-text="暂无小题，点击「添加小题」开始出题"
          @retry="loadQuestions"
        >
          <div class="flex flex-col gap-3">
            <template v-for="(q, idx) in questions" :key="q.id">
              <ObjectiveQuestionForm
                v-if="editing && editing.id === q.id"
                :key="draftKey"
                v-model="editing"
                :saving="savingQuestion"
                @save="onSaveQuestion"
                @cancel="onCancelEdit"
              />
              <article
                v-else
                class="rounded-lg border border-border p-4 transition-colors hover:border-primary/40"
              >
                <div class="mb-2 flex items-center gap-2">
                  <span class="text-sm font-semibold tabular-nums text-text-muted">{{ idx + 1 }}.</span>
                  <span class="inline-flex items-center rounded bg-bg-sunken px-2 py-0.5 text-xs text-text-secondary">
                    {{ QUESTION_TYPE_LABELS[q.type] }}
                  </span>
                  <div class="ml-auto flex gap-1">
                    <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-pencil" @click="openEdit(q)">编辑</UButton>
                    <UButton color="error" variant="ghost" size="xs" icon="i-lucide-trash-2" :aria-label="`删除第 ${idx + 1} 题`" @click="onDeleteQuestion(q, idx)" />
                  </div>
                </div>
                <ObjectiveRichText class="mb-2" :content="q.prompt" />
                <div class="flex flex-col gap-1">
                  <div
                    v-for="opt in q.options"
                    :key="opt.key"
                    class="flex items-start gap-2 rounded px-2 py-1 text-sm"
                    :class="isCorrectOption(q, opt.key) ? 'bg-success-text/10 text-success-text' : 'text-text'"
                  >
                    <UIcon
                      :name="isCorrectOption(q, opt.key) ? 'i-lucide-check' : 'i-lucide-dot'"
                      class="mt-1 size-3.5 shrink-0"
                    />
                    <span v-if="q.type !== 'judge'" class="shrink-0 font-medium">{{ opt.key }}.</span>
                    <ObjectiveRichText class="flex-1" :content="opt.text" />
                  </div>
                </div>
                <details v-if="q.explanation" class="mt-2 text-text-secondary">
                  <summary class="cursor-pointer select-none text-xs">解析</summary>
                  <ObjectiveRichText class="mt-1" :content="q.explanation" />
                </details>
              </article>
            </template>

            <!-- 新建小题：表单出现在列表末尾 -->
            <ObjectiveQuestionForm
              v-if="editing && editing.id === null"
              :key="draftKey"
              v-model="editing"
              :saving="savingQuestion"
              @save="onSaveQuestion"
              @cancel="onCancelEdit"
            />
            <UButton
              v-else-if="questions.length"
              class="self-start"
              size="sm"
              variant="outline"
              icon="i-lucide-plus"
              @click="openCreate"
            >
              添加小题
            </UButton>
          </div>
        </AsyncContent>
      </section>
    </div>
  </AsyncContent>
</template>
