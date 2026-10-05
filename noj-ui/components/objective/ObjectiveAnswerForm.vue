<script setup lang="ts">
import type { ObjectiveQuestion, ObjectiveSubmission, SubmitResult } from '~/composables/useObjective'
import { QUESTION_TYPE_LABELS } from '~/composables/useObjective'
import { formatObjectiveAnswer } from '~/utils/objectiveFormat'
import {
  correctnessByQuestion,
  hasPendingObjectiveScore,
  OBJECTIVE_PENDING_HINT,
  objectiveScoreView,
  objectiveSubmissionScoreText,
} from '~/utils/objectiveResult'

/**
 * 客观题作答表单（练习模式；并入 problems 详情页）。
 * 加载套卷小题、作答、提交即时判定、展示判定结果与练习最高分。
 */
const props = defineProps<{
  /** 套卷题目 ID（problems.id） */
  paperId: string
}>()

const { listQuestions, submitPaper, listSubmissions } = useObjective()

const { data: qData, error: qError, status: qStatus, refresh: refreshQuestions } = await useFetch<
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

/**
 * 单题对错：仅当服务端确实返回了 `correct` 时才有值（VULN-03）。
 *
 * 竞赛进行中后端只返回 `given`，此时表内没有该题 —— 模板据此**完全不渲染**
 * 对错徽标与红绿色，而不是把缺失当成 `false` 显示"回答错误"。
 */
const correctness = computed(() => correctnessByQuestion(lastResult.value?.details))

/** 判定汇总视图：`pending` 表示成绩未公布（score === null），不渲染分数与正确题数。 */
const scoreView = computed(() =>
  lastResult.value
    ? objectiveScoreView(
      lastResult.value.score,
      lastResult.value.correct_count,
      lastResult.value.total_count,
    )
    : null
)

/** 历史记录里存在"成绩未公布"的竞赛提交（用于给出统一说明）。 */
const hasPendingContestScores = computed(() => hasPendingObjectiveScore(submissions.value))

// 提交记录展开状态
const showHistory = ref(false)
const expandedSubmissionId = ref<string | null>(null)
const questionMap = computed(() => new Map(questions.value.map((q) => [q.id, q])))
/** 小题 ID → 题号（从 1 开始），用于提交记录展示 */
const questionIndex = computed(() => new Map(questions.value.map((q, i) => [q.id, i + 1])))

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
      :status="qError ? 'error' : questions.length ? 'data' : qStatus === 'success' ? 'empty' : 'loading'"
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
            <!-- 判定信息缺失（竞赛进行中）时整块不渲染：既不显示徽标也不着色（VULN-03） -->
            <span
              v-if="correctness.has(q.id)"
              class="inline-flex items-center gap-1 text-xs font-medium"
              :class="correctness.get(q.id) ? 'text-green-600' : 'text-red-600'"
            >
              <UIcon :name="correctness.get(q.id) ? 'i-lucide-check-circle' : 'i-lucide-x-circle'" />
              {{ correctness.get(q.id) ? '回答正确' : '回答错误' }}
            </span>
          </div>
          <ObjectiveRichText class="mb-3" :content="q.prompt" />

          <!-- 判断：固定对/错 -->
          <div v-if="q.type === 'judge'" class="flex flex-col gap-2">
            <label
              v-for="opt in q.options"
              :key="opt.key"
              class="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
              :class="isSelected(q.id, opt.key === 'true') ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
            >
              <input
                type="radio"
                :name="q.id"
                class="mt-1 shrink-0 accent-primary"
                :checked="isSelected(q.id, opt.key === 'true')"
                @change="toggleOption(q.id, opt.key === 'true')"
              />
              <ObjectiveRichText class="flex-1" :content="opt.text" />
            </label>
          </div>

          <!-- 单选 -->
          <div v-else-if="q.type === 'single'" class="flex flex-col gap-2">
            <label
              v-for="opt in q.options"
              :key="opt.key"
              class="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
              :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
            >
              <input
                type="radio"
                :name="q.id"
                class="mt-1 shrink-0 accent-primary"
                :checked="isSelected(q.id, opt.key)"
                @change="toggleOption(q.id, opt.key)"
              />
              <span class="shrink-0 font-medium">{{ opt.key }}.</span>
              <ObjectiveRichText class="flex-1" :content="opt.text" />
            </label>
          </div>

          <!-- 多选 -->
          <div v-else class="flex flex-col gap-2">
            <label
              v-for="opt in q.options"
              :key="opt.key"
              class="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
              :class="isSelected(q.id, opt.key) ? 'border-signal bg-signal/5' : 'border-border hover:bg-gray-50'"
            >
              <input
                type="checkbox"
                class="mt-1 shrink-0 accent-primary"
                :checked="isSelected(q.id, opt.key)"
                @change="toggleOption(q.id, opt.key)"
              />
              <span class="shrink-0 font-medium">{{ opt.key }}.</span>
              <ObjectiveRichText class="flex-1" :content="opt.text" />
            </label>
          </div>

          <!-- 判定后解析（练习模式） -->
          <div
            v-if="lastResult?.details[q.id]?.explanation"
            class="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-text-secondary"
          >
            <div class="mb-1 text-xs font-medium">解析</div>
            <ObjectiveRichText :content="lastResult.details[q.id]?.explanation ?? ''" />
          </div>
        </section>

        <!-- 判定汇总：score 为 null（竞赛进行中）时不显示分数与正确题数（VULN-03） -->
        <div
          v-if="lastResult"
          class="rounded-xl border px-5 py-4 text-sm"
          :class="lastResult.score === 100 ? 'border-green-200 bg-green-50 text-green-700' : 'border-border bg-white'"
        >
          <template v-if="scoreView?.pending">
            <span class="font-semibold text-text">{{ OBJECTIVE_PENDING_HINT }}</span>
            <span class="ml-2 text-text-muted">（本套卷共 {{ lastResult.total_count }} 题，已提交）</span>
          </template>
          <template v-else>
            <span class="font-semibold">{{ scoreView?.text }}</span>
            <span v-if="lastResult.contest_mode" class="ml-2 text-text-muted">竞赛提交（仅一次）</span>
          </template>
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
            <p v-else-if="hasPendingContestScores" class="px-5 py-3 text-xs text-text-muted">
              竞赛进行中，成绩与解析将在比赛结束后开放。
            </p>
            <div v-for="sub in submissions" :key="sub.id" class="px-5 py-3">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 text-left"
                @click="expandedSubmissionId = expandedSubmissionId === sub.id ? null : sub.id"
              >
                <span class="text-sm text-text-secondary">{{ formatTime(sub.created_at) }}</span>
                <span class="text-sm font-semibold" :class="sub.score === null ? 'text-text-muted' : 'text-primary'">
                  {{ objectiveSubmissionScoreText(sub.score) }}
                </span>
              </button>

              <div v-if="expandedSubmissionId === sub.id" class="mt-3 space-y-2 rounded-lg bg-bg-page p-3">
                <div v-for="(detail, qid) in sub.details" :key="qid" class="text-xs">
                  <div class="flex items-center gap-2">
                    <!-- correct 缺失（竞赛进行中）时不渲染对错图标与颜色（VULN-03） -->
                    <UIcon
                      v-if="typeof detail.correct === 'boolean'"
                      :name="detail.correct ? 'i-lucide-check-circle' : 'i-lucide-x-circle'"
                      class="size-3.5"
                      :class="detail.correct ? 'text-green-600' : 'text-red-600'"
                    />
                    <!-- 题干可能含表格 / 公式，记录里只显示题号 -->
                    <span class="font-medium text-text">{{ questionIndex.has(qid) ? `第 ${questionIndex.get(qid)} 题` : '未知题目' }}</span>
                  </div>
                  <p class="mt-1 text-text-secondary" :class="typeof detail.correct === 'boolean' ? 'pl-5' : ''">
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
