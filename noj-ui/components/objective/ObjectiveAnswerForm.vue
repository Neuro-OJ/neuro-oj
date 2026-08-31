<script setup lang="ts">
import type { ObjectiveQuestion, ObjectiveSubmission, SubmitResult } from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'
import { formatObjectiveAnswer } from '~/utils/objectiveFormat'

/**
 * 客观题作答表单（练习模式；并入 problems 详情页）。
 * 加载套卷小题、作答、提交即时判定、展示判定结果与练习最高分。
 */
const props = defineProps<{
  /** 套卷题目 ID（problems.id） */
  paperId: string
}>()

const { listQuestions, submitPaper, listSubmissions } = useObjective()

const { data: qData, error: qError, refresh: refreshQuestions } = await useFetch<
  { data: ObjectiveQuestion[] }
>(`/api/v1/problems/${props.paperId}/questions`, { server: false })
const questions = computed(() => qData.value?.data ?? [])

// 答案状态：{ question_id: (string|boolean)[] }
const answers = ref<Record<string, (string | boolean)[]>>({})

// 提交状态与判定结果
const submitting = ref(false)
const lastResult = ref<SubmitResult | null>(null)
const submissionError = ref('')

// 历史最高分（练习模式；竞赛提交不计入）
const { data: histData, refresh: refreshHist } = await useFetch<{
  data: {
    data: ObjectiveSubmission[]
    total: number
    best_score: number | null
  }
}>(
  `/api/v1/problems/submissions?paper_id=${props.paperId}&per_page=20`,
  { server: false },
)
const bestScore = computed(() => histData.value?.data?.best_score ?? null)
const submitCount = computed(() => histData.value?.data?.total ?? 0)
const submissions = computed(() => histData.value?.data?.data ?? [])

// 提交记录展开状态
const showHistory = ref(false)
const expandedSubmissionId = ref<string | null>(null)
const questionMap = computed(() => new Map(questions.value.map((q) => [q.id, q])))

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

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
    const res = await submitPaper(props.paperId, answers.value)
    lastResult.value = res.data
    await refreshQuestions()
    await refreshHist()
  } catch {
    // 错误 toast 由 useApi 统一弹出
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div v-if="bestScore !== null" class="text-sm text-text-secondary">
      最高分：<span class="font-semibold text-primary">{{ (bestScore / 100).toFixed(0) }}</span>
      <span v-if="submitCount > 1" class="text-text-muted">（已提交 {{ submitCount }} 次）</span>
    </div>

    <AsyncContent
      :status="qError ? 'error' : questions.length ? 'data' : 'empty'"
      error="题目加载失败"
      empty-text="该套卷暂无小题"
      @retry="refreshQuestions"
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
              :class="isSelected(q.id, opt.key === 'true') ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
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
              :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
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
              :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
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

        <!-- 提交记录列表 -->
        <section class="rounded-xl border border-border bg-white">
          <button
            type="button"
            class="flex w-full items-center justify-between px-5 py-4 text-sm font-semibold text-text"
            @click="showHistory = !showHistory"
          >
            <span class="flex items-center gap-2">
              <UIcon name="i-lucide-history" class="size-4 text-text-muted" />
              提交记录（{{ submitCount }}）
            </span>
            <UIcon
              :name="showHistory ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="size-4 text-text-muted"
            />
          </button>

          <div v-if="showHistory" class="border-t border-border divide-y divide-border">
            <p v-if="submissions.length === 0" class="px-5 py-4 text-sm text-text-secondary">
              暂无提交记录
            </p>
            <div v-for="sub in submissions" :key="sub.id" class="px-5 py-3">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 text-left"
                @click="expandedSubmissionId = expandedSubmissionId === sub.id ? null : sub.id"
              >
                <span class="text-sm text-text-secondary">{{ formatTime(sub.created_at) }}</span>
                <span class="text-sm font-semibold text-primary">
                  {{ (sub.score / 100).toFixed(0) }} 分
                </span>
              </button>

              <div v-if="expandedSubmissionId === sub.id" class="mt-3 space-y-2 rounded-lg bg-bg-page p-3">
                <div v-for="(detail, qid) in sub.details" :key="qid" class="text-xs">
                  <div class="flex items-center gap-2">
                    <UIcon
                      :name="detail.correct ? 'i-lucide-check-circle' : 'i-lucide-x-circle'"
                      class="size-3.5"
                      :class="detail.correct ? 'text-green-600' : 'text-red-600'"
                    />
                    <span class="font-medium text-text">{{ questionMap.get(qid)?.prompt ?? '未知题目' }}</span>
                  </div>
                  <p class="mt-1 pl-5 text-text-secondary">
                    作答：{{ formatObjectiveAnswer(questionMap.get(qid), detail.given) }}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

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
</template>
