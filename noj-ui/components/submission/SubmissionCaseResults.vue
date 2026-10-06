<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatMemory, formatTime } from '~/utils/submissionFormat'
import { isSubmissionCasePassed, submissionCasesWithProgress, type SubmissionCaseResult, type SubmissionCaseProgress } from '~/utils/submissionCaseResults'
import { useCopyText } from '~/composables/useCopyText'

const props = defineProps<{
  details: unknown
  progress?: SubmissionCaseProgress | null
}>()

const { copyText } = useCopyText()

const cases = computed(() => submissionCasesWithProgress(props.details, props.progress))
const completedCount = computed(() => cases.value.filter((item) => !['RUNNING', 'PENDING'].includes(item.status)).length)
const hasScores = computed(() => Boolean(props.progress) || cases.value.some((item) => item.score != null))
const passedCount = computed(() => cases.value.filter((item) => isSubmissionCasePassed(item.status)).length)
const visibleCount = computed(() => cases.value.filter((item) => item.visibility === 'visible').length)
const hiddenCount = computed(() => cases.value.length - visibleCount.value)

// 当前展开的测试点（单行展开）
const expandedId = ref<string | null>(null)

function hasOutput(item: SubmissionCaseResult) {
  return item.expectedOutput !== null || item.actualOutput !== null
}

function canExpand(item: SubmissionCaseResult) {
  return item.visibility !== 'hidden' && hasOutput(item)
}

function toggleExpand(item: SubmissionCaseResult) {
  if (!canExpand(item)) return
  expandedId.value = expandedId.value === item.caseId ? null : item.caseId
}

const statusLabels: Record<string, string> = {
  AC: '通过',
  WA: '错误',
  TLE: '超时',
  MLE: '内存超限',
  OLE: '输出超限',
  RE: '运行时错误',
  CE: '编译错误',
  SE: '系统错误',
  FE: '格式错误',
  IGN: '跳过',
  RUNNING: '评测中',
  PENDING: '等待评测',
  Accepted: '通过',
  PASS: '通过',
  Pass: '通过',
  passed: '通过',
  WrongAnswer: '错误',
  FAIL: '失败',
  Fail: '失败',
  RuntimeError: '运行时错误',
  TimeLimitExceeded: '超时',
  MemoryLimitExceeded: '内存超限',
}

function statusLabel(status: string) {
  return statusLabels[status] ?? status
}

function statusClass(status: string) {
  if (status === 'RUNNING') return 'bg-primary-bg text-primary'
  if (status === 'PENDING' || status === 'IGN') return 'bg-bg-page text-text-muted'
  return isSubmissionCasePassed(status)
    ? 'bg-green-50 text-success-text'
    : 'bg-red-50 text-error-text'
}

function statusIcon(status: string) {
  if (status === 'RUNNING') return 'i-lucide-loader-2'
  if (status === 'PENDING') return 'i-lucide-clock'
  if (status === 'IGN') return 'i-lucide-skip-forward'
  return isSubmissionCasePassed(status) ? 'i-lucide-check' : 'i-lucide-x'
}
</script>

<template>
  <section
    v-if="cases.length"
    class="overflow-hidden rounded-xl border border-border bg-white"
    aria-labelledby="submission-case-results-title"
  >
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-page px-4 py-3">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-list-checks" class="size-5 text-text-muted" />
        <div>
          <h2 id="submission-case-results-title" class="text-sm font-semibold text-text">测试点明细</h2>
          <p class="mt-1 text-xs text-text-muted">
            <template v-if="progress">
              {{ progress.phase === 'compiling' ? '编译中' : progress.phase === 'judging' ? '评测中' : '排队中' }}
              · 已完成 {{ completedCount }}/{{ cases.length }} · {{ passedCount }} 个通过
            </template>
            <template v-else>{{ passedCount }}/{{ cases.length }} 个测试点通过</template>
            <span v-if="visibleCount"> · {{ visibleCount }} 个可见</span>
            <span v-if="hiddenCount"> · {{ hiddenCount }} 个隐藏</span>
          </p>
        </div>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[680px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs font-semibold text-text-muted">
            <th scope="col" class="px-4 py-3">测试点</th>
            <th scope="col" class="px-4 py-3">状态</th>
            <th v-if="hasScores" scope="col" class="px-4 py-3">得分</th>
            <th scope="col" class="px-4 py-3">耗时</th>
            <th scope="col" class="px-4 py-3">内存</th>
            <th scope="col" class="px-4 py-3">输出</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in cases" :key="`${item.visibility}-${item.caseId}`">
            <tr
              class="border-b border-border last:border-0 transition-colors"
              :class="canExpand(item) ? 'cursor-pointer hover:bg-primary-hover' : ''"
              :tabindex="canExpand(item) ? 0 : undefined"
              :role="canExpand(item) ? 'button' : undefined"
              :aria-expanded="canExpand(item) ? expandedId === item.caseId : undefined"
              @click="toggleExpand(item)"
              @keydown.enter.prevent="toggleExpand(item)"
              @keydown.space.prevent="toggleExpand(item)"
            >
              <th scope="row" class="px-4 py-3 text-left font-mono text-xs font-medium text-text">
                {{ item.displayLabel ?? item.caseId }}
                <span v-if="item.visibility === 'hidden'" class="ml-1 text-[11px] font-sans text-text-muted">隐藏</span>
              </th>
              <td class="px-4 py-3">
                <span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold" :class="statusClass(item.status)">
                  <UIcon :name="statusIcon(item.status)" class="size-3.5" :class="item.status === 'RUNNING' ? 'animate-spin' : ''" />
                  {{ statusLabel(item.status) }}
                </span>
              </td>
              <td v-if="hasScores" class="px-4 py-3 text-xs tabular-nums">{{item.score??'—'}} / {{item.maxScore??'—'}}</td>
            <td class="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-secondary">
                {{ formatTime(item.timeMs) }}
              </td>
              <td class="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-secondary">
                {{ formatMemory(item.memoryKb) }}
              </td>
              <td class="px-4 py-3 text-xs text-text-secondary">
                <span v-if="item.visibility === 'hidden'" class="inline-flex items-center gap-1 text-text-muted">
                  <UIcon name="i-lucide-lock" class="size-3.5" />
                  隐藏用例不展示输出
                </span>
                <span v-else class="inline-flex items-center gap-1">
                  <UIcon
                    v-if="hasOutput(item)"
                    :name="expandedId === item.caseId ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                    class="size-3.5"
                  />
                  <span v-if="hasOutput(item)">查看期望与实际输出</span>
                  <span v-else class="text-text-muted">--</span>
                </span>
              </td>
            </tr>
            <!-- 展开详情行（紧跟对应测试点下方） -->
            <tr
              v-if="expandedId === item.caseId && (item.expectedOutput !== null || item.actualOutput !== null)"
              class="border-b border-border bg-bg-page/50"
            >
              <td :colspan="hasScores?6:5" class="px-4 py-4">
                <div class="grid gap-4">
                  <!-- 期望输出 -->
                  <div class="min-w-0">
                    <div class="mb-1.5 flex items-center justify-between">
                      <p class="text-[11px] font-semibold text-text-muted">期望输出</p>
                      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" @click.stop="copyText(item.expectedOutput, '期望输出')">复制</UButton>
                    </div>
                    <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#0d1117] p-3 font-mono text-[11px] leading-relaxed text-[#e6edf3]">{{ item.expectedOutput ?? '--' }}</pre>
                  </div>
                  <!-- 实际输出 -->
                  <div class="min-w-0">
                    <div class="mb-1.5 flex items-center justify-between">
                      <p class="text-[11px] font-semibold text-text-muted">实际输出</p>
                      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" @click.stop="copyText(item.actualOutput, '实际输出')">复制</UButton>
                    </div>
                    <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#0d1117] p-3 font-mono text-[11px] leading-relaxed text-[#e6edf3]">{{ item.actualOutput ?? '--' }}</pre>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>
