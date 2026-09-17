<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'
import type { ObjectiveQuestion } from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'
import { publicUrl } from '~/utils/publicIdentifiers'
import { extractApiError } from '~/utils/apiError'
import { toContestProblemView } from '~/utils/problemView'

/**
 * 竞赛题目详情页：
 * - 编程题：仅展示题目陈述，做题跳转独立编辑器页
 *   （/contests/:id/problems/:label/editor）
 * - 客观题套卷（is_objective）：内联渲染客观题表单，
 *   竞赛模式一次性提交（contest_id 携带），不展示解析（防泄题）
 *
 * #511：头部与题面改用 `components/problem/*` 共用组件，
 * 消除第二份题面实现与第二套硬编码难度色（`bg-green-100` 等）。
 */
definePageMeta({ middleware: 'auth', ssr: false })

const route = useRoute()
const contestId = route.params.contestId as string
const label = route.params.label as string
const { user } = useAuth()
const { submitPaper } = useObjective()

const { data: contestData } = await useFetch<{ data: Contest }>(
  `/api/v1/contests/${contestId}`,
  { server: false },
)
const { data, pending, error, refresh } = await useFetch<{ data: ContestProblem }>(
  `/api/v1/contests/${contestId}/problems/${label}`,
  { server: false },
)
const problem = computed(() => data.value?.data ?? null)
const contest = computed(() => contestData.value?.data ?? null)

/** 统一视图模型：与独立题目页共用同一形状（#511）。 */
const problemView = computed(() => (problem.value ? toContestProblemView(problem.value) : null))

const isObjective = computed(() => problemView.value?.is_objective === true)
const isArtifact = computed(() => problemView.value?.submission_mode === 'artifact')

// ── artifact 提交 ──
const artifactFile = ref<File | null>(null)
const artifactSubmitting = ref(false)
const artifactError = ref('')
const artifactSuccessId = ref('')
const { api } = useApi()

function formatMb(mb: number | null | undefined): string {
  if (mb == null) return 'NOJ 默认上限'
  return `${mb} MB`
}

async function handleArtifactSubmit() {
  if (!problem.value) return
  if (!artifactFile.value) {
    artifactError.value = '请选择 zip 文件'
    return
  }
  artifactError.value = ''
  artifactSubmitting.value = true
  try {
    const form = new FormData()
    form.append('problem_id', problem.value.problem_id)
    form.append('language', 'python3')
    form.append('file', artifactFile.value)
    const res = await api.post<{ data: { id: string; public_id?: string } }>(
      `/api/v1/contests/${contestId}/submit`,
      form,
    )
    artifactSuccessId.value = res.data.id
    artifactFile.value = null
  } catch (err: unknown) {
    artifactError.value = extractApiError(err).message
  } finally {
    artifactSubmitting.value = false
  }
}

// 去做题：仅竞赛进行中且为参赛者/管理员时可进入编辑器；
// 结束后仅可查看题目（issue：编辑器权限控制）
const canUseEditor = computed(() => {
  const c = contest.value
  if (!c) return false
  const isAdmin = user.value?.is_admin === true
  const isParticipant = c.is_registered === true
  return c.status === 'running' && (isParticipant || isAdmin)
})

const accessHint = computed(() => {
  const c = contest.value
  if (!c) return ''
  if (c.status === 'pending') return '竞赛尚未开始'
  if (c.status === 'ended') return '比赛已结束，仅可查看题目'
  if (!(c.is_registered === true || user.value?.is_admin === true)) {
    return '报名后可进入做题'
  }
  return ''
})

// ── 客观题分支 ────────────────────────────────
// paperId 未加载（problem 请求未返回）时 URL 返回 null，useFetch 跳过请求，
// 避免对空 paperId 发出无效请求（404 / 误判已提交闪烁）
const paperId = computed(() => problem.value?.display_id ?? problem.value?.problem_id ?? '')
const qUrl = computed(() =>
  paperId.value
    ? `/api/v1/problems/${paperId.value}/questions?contest_id=${contestId}`
    : null
)
// Nuxt UseFetch 的 url getter 类型不接受 null，运行时支持返回 null 跳过请求；断言仅类型层面。
const { data: qData, error: qError } = await useFetch<{ data: ObjectiveQuestion[] }>(
  qUrl as unknown as Ref<`/api/v1/problems/${string}`>,
  { server: false },
)
const questions = computed(() => qData.value?.data ?? [])

// 竞赛已提交状态（一次性）；仅当 paperId 已加载时判定
const subUrl = computed(() =>
  paperId.value
    ? `/api/v1/problems/submissions?paper_id=${paperId.value}&contest_id=${contestId}&per_page=1`
    : null
)
const { data: subData, refresh: refreshSubs } = await useFetch<{
  data: { total: number; best_score: number | null }
}>(
  subUrl as unknown as Ref<`/api/v1/problems/submissions${string}`>,
  { server: false },
)
const alreadySubmitted = computed(() =>
  paperId.value !== '' && (subData.value?.data?.total ?? 0) > 0
)

const answers = ref<Record<string, (string | boolean)[]>>({})
const submitting = ref(false)
const submitError = ref('')
const lastScore = ref<number | null>(null)

function toggleOption(qid: string, value: string | boolean) {
  const q = questions.value.find((item) => item.id === qid)
  if (!q) return
  const current = answers.value[qid] ?? []
  if (q.type === 'multiple') {
    const idx = current.indexOf(value)
    if (idx >= 0) current.splice(idx, 1)
    else current.push(value)
    answers.value = { ...answers.value, [qid]: [...current] }
  } else {
    answers.value = { ...answers.value, [qid]: [value] }
  }
}

function isSelected(qid: string, value: string | boolean) {
  return (answers.value[qid] ?? []).includes(value)
}

async function onSubmit() {
  if (submitting.value || alreadySubmitted.value) return
  const unanswered = questions.value.filter((q) => (answers.value[q.id] ?? []).length === 0)
  if (unanswered.length > 0) {
    submitError.value = `还有 ${unanswered.length} 道题未作答`
    return
  }
  submitError.value = ''
  submitting.value = true
  try {
    const res = await submitPaper(paperId.value, answers.value, contestId)
    lastScore.value = res.data.score
    await refreshSubs()
  } catch {
    // useApi 已弹错误
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-[calc(100vh-64px)] bg-bg-page p-4 lg:p-6">
    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : problemView ? 'data' : 'empty'"
      error="竞赛题目加载失败"
      @retry="refresh"
    >
      <div v-if="problemView" class="mx-auto flex max-w-[960px] flex-col gap-4">
        <ProblemHeader :problem="problemView">
          <!-- 返回竞赛入口：竞赛内返回语义，由 #512 面包屑统一后收敛 -->
          <template #leading>
            <NuxtLink
              :to="publicUrl('contest', contestId)"
              class="inline-flex items-center gap-1.5 text-xs text-text-secondary no-underline hover:text-primary"
            >
              <UIcon name="i-lucide-arrow-left" class="size-3.5" />返回竞赛
            </NuxtLink>
            <span class="flex size-7 items-center justify-center rounded-lg bg-bg-dark font-mono text-xs font-bold text-white">{{ problem?.label }}</span>
          </template>
          <template #titleSuffix>
            <span class="text-xs text-text-muted">{{ contest?.title }} · {{ problem?.display_id }}</span>
          </template>
          <template #actions>
            <UButton
              v-if="!isObjective && !isArtifact && canUseEditor"
              color="primary"
              class="gap-1.5 px-4 py-2 text-xs"
              :to="`/editor/${problem?.display_id}?contest=${contestId}&label=${label}`"
            >
              <UIcon name="i-lucide-pencil-ruler" class="size-3.5" />去做题
            </UButton>
            <span v-else-if="!isObjective && !isArtifact && accessHint" class="text-xs text-text-muted">{{ accessHint }}</span>
          </template>
        </ProblemHeader>

        <!-- 客观题：内联答题表单（竞赛一次性提交） -->
        <ProblemStatement
          v-if="isObjective"
          title="作答"
          :content="problemView.description"
          :collapsible="false"
          :copyable="false"
        >
          <template #body>
            <AsyncContent
              :status="qError ? 'error' : questions.length ? 'data' : 'empty'"
              error="客观题加载失败"
              empty-text="该套卷暂无小题"
            >
              <div v-if="questions.length" class="flex flex-col gap-4">
                <section
                  v-for="(q, idx) in questions"
                  :key="q.id"
                  class="rounded-xl border border-border bg-white p-5"
                >
                  <div class="mb-3 flex items-center gap-2">
                    <span class="inline-flex items-center rounded bg-bg-sunken px-2 py-0.5 text-xs font-medium text-text-secondary">
                      {{ idx + 1 }}. {{ QUESTION_TYPE_LABELS[q.type] }}
                    </span>
                  </div>
                  <p class="mb-3 whitespace-pre-wrap text-sm text-text">{{ q.prompt }}</p>

                  <div v-if="q.type === 'judge'" class="flex flex-col gap-2">
                    <label
                      v-for="opt in q.options"
                      :key="opt.key"
                      class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
                      :class="isSelected(q.id, opt.key === 'true') ? 'border-signal bg-signal/5' : 'border-border hover:bg-bg-page'"
                    >
                      <input
                        type="radio"
                        :name="q.id"
                        class="accent-primary"
                        :disabled="alreadySubmitted"
                        :checked="isSelected(q.id, opt.key === 'true')"
                        @change="toggleOption(q.id, opt.key === 'true')"
                      />
                      {{ opt.text }}
                    </label>
                  </div>

                  <div v-else-if="q.type === 'single'" class="flex flex-col gap-2">
                    <label
                      v-for="opt in q.options"
                      :key="opt.key"
                      class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
                      :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-bg-page'"
                    >
                      <input
                        type="radio"
                        :name="q.id"
                        class="accent-primary"
                        :disabled="alreadySubmitted"
                        :checked="isSelected(q.id, opt.key)"
                        @change="toggleOption(q.id, opt.key)"
                      />
                      <span class="font-medium">{{ opt.key }}.</span> {{ opt.text }}
                    </label>
                  </div>

                  <div v-else class="flex flex-col gap-2">
                    <label
                      v-for="opt in q.options"
                      :key="opt.key"
                      class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
                      :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-bg-page'"
                    >
                      <input
                        type="checkbox"
                        class="accent-primary"
                        :disabled="alreadySubmitted"
                        :checked="isSelected(q.id, opt.key)"
                        @change="toggleOption(q.id, opt.key)"
                      />
                      <span class="font-medium">{{ opt.key }}.</span> {{ opt.text }}
                    </label>
                  </div>
                </section>

                <div
                  v-if="alreadySubmitted"
                  class="rounded-xl border border-success-text/30 bg-success-text/5 px-5 py-4 text-sm text-success-text"
                >
                  <UIcon name="i-lucide-check-circle" class="mr-1" />
                  本套卷已提交（竞赛内仅可提交一次）<span v-if="lastScore !== null">，得分 {{ lastScore.toFixed(0) }} 分</span>
                </div>
                <p v-else-if="submitError" class="text-sm text-error-text">{{ submitError }}</p>

                <UButton
                  v-if="!alreadySubmitted"
                  class="w-full"
                  color="primary"
                  size="lg"
                  :loading="submitting"
                  :disabled="questions.length === 0 || !canUseEditor"
                  @click="onSubmit"
                >
                  提交答案
                </UButton>
                <p v-else-if="!canUseEditor" class="text-center text-xs text-text-muted">{{ accessHint }}</p>
              </div>
            </AsyncContent>
          </template>
        </ProblemStatement>

        <!-- 编程题：题面（artifact 题在题面上方追加 zip 上传） -->
        <template v-else>
          <section v-if="isArtifact" class="rounded-xl border border-border bg-white p-6">
            <h2 class="text-base font-semibold text-text mb-1">提交产物（zip）</h2>
            <p class="text-sm text-text-secondary">
              请上传包含 <code class="font-mono text-primary">submission.py</code> 的 zip 压缩包。
              大小上限：{{ formatMb(problemView.artifact_max_size_mb) }}。
            </p>
            <div class="mt-4 flex flex-col gap-3">
              <input
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                class="block w-full text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-signal file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-signal/80"
                @change="(e: Event) => artifactFile = (e.target as HTMLInputElement).files?.[0] ?? null"
              />
              <div v-if="artifactError" class="text-sm text-error-text">{{ artifactError }}</div>
              <div v-if="artifactSuccessId" class="text-sm text-success-text">
                提交成功！
                <NuxtLink :to="publicUrl('submission', artifactSuccessId)" class="text-primary no-underline hover:underline">查看评测结果</NuxtLink>
              </div>
              <div class="flex items-center gap-3">
                <UButton color="primary" :loading="artifactSubmitting" :disabled="!canUseEditor || artifactSubmitting" @click="handleArtifactSubmit">
                  <UIcon name="i-lucide-upload" class="size-4" />
                  上传并提交
                </UButton>
                <span v-if="!canUseEditor" class="text-xs text-text-muted">{{ accessHint }}</span>
              </div>
            </div>
          </section>
          <ProblemStatement :content="problemView.description" />
        </template>
      </div>
    </AsyncContent>
  </div>
</template>
