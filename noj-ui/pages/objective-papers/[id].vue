<script setup lang="ts">
import type { ObjectivePaper, ObjectiveQuestion, SubmitResult } from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'

definePageMeta({ middleware: 'auth', ssr: false })

useHead({ title: '客观题卷 - Neuro OJ' })

const route = useRoute()
const paperId = route.params.id as string
const { getPaper, listQuestions, submitPaper, listSubmissions } = useObjective()
const { user } = useAuth()

const { data: paperData, error: paperError } = await useFetch<{ data: ObjectivePaper }>(
  `/api/v1/problems/${paperId}`,
  { server: false },
)
const { data: qData, error: qError, refresh: refreshQuestions } = await useFetch<
  { data: ObjectiveQuestion[] }
>(`/api/v1/objective/papers/${paperId}/questions`, { server: false })

const paper = computed(() => paperData.value?.data ?? null)
const questions = computed(() => qData.value?.data ?? [])
const isOwner = computed(() => user.value?.id === paper.value?.owner_id || user.value?.is_admin === true)

// 答案状态：{ question_id: (string|boolean)[] }
const answers = ref<Record<string, (string | boolean)[]>>({})

// 提交状态与判定结果
const submitting = ref(false)
const lastResult = ref<SubmitResult | null>(null)
const submissionError = ref('')

// 历史最高分
const { data: histData, refresh: refreshHist } = await useFetch<{
  data: { total: number; best_score: number | null }
}>(
  `/api/v1/objective/submissions?paper_id=${paperId}&per_page=5`,
  { server: false },
)
const bestScore = computed(() => histData.value?.data?.best_score ?? null)
const submitCount = computed(() => histData.value?.data?.total ?? 0)

function toggleOption(qid: string, value: string | boolean) {
  const q = questions.value.find((item) => item.id === qid)
  if (!q) return
  const current = answers.value[qid] ?? []
  if (q.type === 'multiple') {
    const idx = current.indexOf(value)
    if (idx >= 0) {
      current.splice(idx, 1)
    } else {
      current.push(value)
    }
    answers.value = { ...answers.value, [qid]: [...current] }
  } else {
    answers.value = { ...answers.value, [qid]: [value] }
  }
}

function isSelected(qid: string, value: string | boolean) {
  return (answers.value[qid] ?? []).includes(value)
}

async function onSubmit() {
  if (submitting.value) return
  // 校验：所有题目必须作答
  const unanswered = questions.value.filter((q) => (answers.value[q.id] ?? []).length === 0)
  if (unanswered.length > 0) {
    submissionError.value = `还有 ${unanswered.length} 道题未作答`
    return
  }
  submissionError.value = ''
  submitting.value = true
  lastResult.value = null
  try {
    const res = await submitPaper(paperId, answers.value)
    lastResult.value = res.data
    await refreshQuestions()
    await refreshHistory()
  } catch {
    // 错误 toast 由 useApi 统一弹出
  } finally {
    submitting.value = false
  }
}

async function refreshHistory() {
  await refreshHist()
}
</script>

<template>
  <div class="min-h-[calc(100vh-64px)] bg-bg-page p-4 lg:p-6">
    <AsyncContent
      :status="paperError ? 'error' : paper ? 'data' : 'loading'"
      error="套卷加载失败"
    >
      <div v-if="paper" class="mx-auto flex max-w-[860px] flex-col gap-4">
        <header class="rounded-xl border border-border bg-white px-5 py-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {{ paper.display_id }}
            </span>
            <h1 class="text-lg font-bold text-text">{{ paper.title }}</h1>
            <span v-if="bestScore !== null" class="ml-auto text-sm text-text-secondary">
              最高分：<span class="font-semibold text-primary">{{ (bestScore / 100).toFixed(0) }}</span>
              <span v-if="submitCount > 1" class="text-text-muted">（已提交 {{ submitCount }} 次）</span>
            </span>
          </div>
          <p class="mt-2 whitespace-pre-wrap text-sm text-text-secondary">{{ paper.description }}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <NuxtLink
              v-if="isOwner"
              :to="`/objective-papers/${paper.id}/edit`"
              class="inline-flex items-center gap-1 text-sm text-primary no-underline hover:underline"
            >
              <UIcon name="i-lucide-pencil" /> 管理套卷
            </NuxtLink>
            <NuxtLink
              to="/objective-papers"
              class="inline-flex items-center gap-1 text-sm text-text-secondary no-underline hover:text-primary"
            >
              ← 返回列表
            </NuxtLink>
          </div>
        </header>

        <AsyncContent
          :status="qError ? 'error' : questions.length ? 'data' : 'empty'"
          error="题目加载失败"
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
                <span
                  v-if="lastResult?.details[q.id]"
                  class="inline-flex items-center gap-1 text-xs font-medium"
                  :class="lastResult.details[q.id].correct ? 'text-green-600' : 'text-red-600'"
                >
                  <UIcon :name="lastResult.details[q.id].correct ? 'i-lucide-check-circle' : 'i-lucide-x-circle'" />
                  {{ lastResult.details[q.id].correct ? '回答正确' : '回答错误' }}
                </span>
              </div>
              <p class="mb-3 whitespace-pre-wrap text-sm text-text">{{ q.prompt }}</p>

              <!-- 判断：固定对/错 -->
              <div v-if="q.type === 'judge'" class="flex flex-col gap-2">
                <label
                  v-for="opt in q.options"
                  :key="opt.key"
                  class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
                  :class="isSelected(q.id, opt.key === 'true') ? 'border-primary bg-primary/5' : 'border-border hover:bg-gray-50'"
                >
                  <input
                    type="radio"
                    :name="q.id"
                    class="accent-primary"
                    :checked="isSelected(q.id, opt.key === 'true')"
                    @change="toggleOption(q.id, opt.key === 'true')"
                  />
                  {{ opt.text }}
                </label>
              </div>

              <!-- 单选 -->
              <div v-else-if="q.type === 'single'" class="flex flex-col gap-2">
                <label
                  v-for="opt in q.options"
                  :key="opt.key"
                  class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
                  :class="isSelected(q.id, opt.key) ? 'border-primary bg-primary/5' : 'border-border hover:bg-gray-50'"
                >
                  <input
                    type="radio"
                    :name="q.id"
                    class="accent-primary"
                    :checked="isSelected(q.id, opt.key)"
                    @change="toggleOption(q.id, opt.key)"
                  />
                  <span class="font-medium">{{ opt.key }}.</span> {{ opt.text }}
                </label>
              </div>

              <!-- 多选 -->
              <div v-else class="flex flex-col gap-2">
                <label
                  v-for="opt in q.options"
                  :key="opt.key"
                  class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
                  :class="isSelected(q.id, opt.key) ? 'border-primary bg-primary/5' : 'border-border hover:bg-gray-50'"
                >
                  <input
                    type="checkbox"
                    class="accent-primary"
                    :checked="isSelected(q.id, opt.key)"
                    @change="toggleOption(q.id, opt.key)"
                  />
                  <span class="font-medium">{{ opt.key }}.</span> {{ opt.text }}
                </label>
              </div>

              <!-- 判定后解析（练习模式） -->
              <p
                v-if="lastResult?.details[q.id] && lastResult.details[q.id].explanation"
                class="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-text-secondary"
              >
                解析：{{ lastResult.details[q.id].explanation }}
              </p>
            </section>

            <!-- 判定汇总 -->
            <div
              v-if="lastResult"
              class="rounded-xl border px-5 py-4 text-sm"
              :class="lastResult.score === 100 ? 'border-green-200 bg-green-50 text-green-700' : 'border-border bg-white'"
            >
              <span class="font-semibold">
                本次得分：{{ lastResult.score.toFixed(0) }} 分（{{ lastResult.correct_count }}/{{ lastResult.total_count }}）
              </span>
              <span v-if="lastResult.contest_mode" class="ml-2 text-text-muted">竞赛提交（仅一次）</span>
            </div>

            <p v-if="submissionError" class="text-sm text-red-600">{{ submissionError }}</p>

            <UButton
              class="w-full"
              color="primary"
              size="lg"
              :loading="submitting"
              :disabled="questions.length === 0"
              @click="onSubmit"
            >
              提交答案
            </UButton>
          </div>
        </AsyncContent>
      </div>
    </AsyncContent>
  </div>
</template>
