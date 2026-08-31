<script setup lang="ts">
import type { Contest, ContestProblem } from '~/composables/useContests'
import type { ObjectiveQuestion } from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'
import { publicUrl } from '~/utils/publicIdentifiers'
import { extractApiError } from '~/utils/apiError'

/**
 * 竞赛题目详情页：
 * - 编程题：仅展示题目陈述，做题跳转独立编辑器页
 *   （/contests/:id/problems/:label/editor）
 * - 客观题套卷（is_objective）：内联渲染客观题表单，
 *   竞赛模式一次性提交（contest_id 携带），不展示解析（防泄题）
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

const isObjective = computed(() => problem.value?.is_objective === true)
const isArtifact = computed(() => problem.value?.submission_mode === 'artifact')

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

const difficultyLabel: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
}
const badgeColors: Record<string, string> = {
  easy: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  hard: 'bg-red-100 text-red-800',
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
const { data: qData, error: qError } = await useFetch<{ data: ObjectiveQuestion[] }>(
  computed(() =>
    paperId.value
      ? `/api/v1/problems/${paperId.value}/questions`
      : null
  ),
  { server: false },
)
const questions = computed(() => qData.value?.data ?? [])

// 竞赛已提交状态（一次性）；仅当 paperId 已加载时判定
const { data: subData, refresh: refreshSubs } = await useFetch<{
  data: { total: number; best_score: number | null }
}>(
  computed(() =>
    paperId.value
      ? `/api/v1/problems/submissions?paper_id=${paperId.value}&contest_id=${contestId}&per_page=1`
      : null
  ),
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
      :status="pending ? 'loading' : error ? 'error' : problem ? 'data' : 'empty'"
      error="竞赛题目加载失败"
      @retry="refresh"
    >
      <div v-if="problem" class="mx-auto flex max-w-[960px] flex-col gap-4">
        <header class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-white px-4 py-3">
          <NuxtLink
            :to="publicUrl('contest', contestId)"
            class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"
          >
            <UIcon name="i-lucide-arrow-left" class="size-4" />返回竞赛
          </NuxtLink>
          <span class="h-5 w-px bg-border" />
          <span class="flex size-8 items-center justify-center rounded-lg bg-bg-dark font-mono text-sm font-bold text-white">{{ problem.label }}</span>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-bold text-text">{{ problem.title }}</h1>
            <p class="text-xs text-text-muted">{{ contest?.title }} · {{ problem.display_id }}</p>
          </div>
          <span
            v-if="!isObjective"
            class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
            :class="badgeColors[problem.difficulty] || ''"
          >
            {{ difficultyLabel[problem.difficulty] || problem.difficulty }}
          </span>
          <span
            v-else
            class="inline-flex items-center rounded-full bg-signal/10 px-2 py-0.5 text-xs font-semibold text-primary"
          >
            客观题
          </span>
          <template v-if="!isObjective && !isArtifact && canUseEditor">
            <UButton
              color="primary"
              class="gap-1.5 px-4 py-2 text-xs"
              :to="`/editor/${problem.display_id}?contest=${contestId}&label=${label}`"
            >
              <UIcon name="i-lucide-pencil-ruler" class="size-3.5" />去做题
            </UButton>
          </template>
          <span v-else-if="!isObjective && !isArtifact && accessHint" class="text-xs text-text-muted">{{ accessHint }}</span>
        </header>

        <!-- 客观题：内联答题表单（竞赛一次性提交） -->
        <template v-if="isObjective">
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
                  <span class="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-text-secondary">
                    {{ idx + 1 }}. {{ QUESTION_TYPE_LABELS[q.type] }}
                  </span>
                </div>
                <p class="mb-3 whitespace-pre-wrap text-sm text-text">{{ q.prompt }}</p>

                <div v-if="q.type === 'judge'" class="flex flex-col gap-2">
                  <label
                    v-for="opt in q.options"
                    :key="opt.key"
                    class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
                    :class="isSelected(q.id, opt.key === 'true') ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
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
                    :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
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
                    :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
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
                class="rounded-xl border border-green-200 bg-green-50 px-5 py-4 text-sm text-green-700"
              >
                <UIcon name="i-lucide-check-circle" class="mr-1" />
                本套卷已提交（竞赛内仅可提交一次）<span v-if="lastScore !== null">，得分 {{ lastScore.toFixed(0) }} 分</span>
              </div>
              <p v-else-if="submitError" class="text-sm text-red-600">{{ submitError }}</p>

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

        <!-- 编程题：题目陈述 -->
        <section v-else class="rounded-xl border border-border bg-white p-6 lg:p-8">
          <!-- artifact 题：zip 上传提交 -->
          <div v-if="isArtifact" class="mb-6 rounded-xl border border-border bg-bg-page p-5">
            <h2 class="text-base font-semibold text-text mb-1">提交产物（zip）</h2>
            <p class="text-sm text-text-secondary">
              请上传包含 <code class="font-mono text-primary">submission.py</code> 的 zip 压缩包。
              大小上限：{{ formatMb(problem.artifact_max_size_mb) }}。
            </p>
            <div class="mt-4 flex flex-col gap-3">
              <input
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                class="block w-full text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-signal file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-signal/80"
                @change="(e) => artifactFile = (e.target as HTMLInputElement).files?.[0] ?? null"
              />
              <div v-if="artifactError" class="text-sm text-red-600">{{ artifactError }}</div>
              <div v-if="artifactSuccessId" class="text-sm text-green-600">
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
          </div>
          <MarkdownRenderer :content="problem.description" />
        </section>
      </div>
    </AsyncContent>
  </div>
</template>
