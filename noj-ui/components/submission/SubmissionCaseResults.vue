<script setup lang="ts">
import { computed } from 'vue'
import { formatMemory, formatTime } from '~/utils/submissionFormat'
import { isSubmissionCasePassed, normalizeSubmissionCases } from '~/utils/submissionCaseResults'

const props = defineProps<{
  details: unknown
}>()

const cases = computed(() => normalizeSubmissionCases(props.details))
const passedCount = computed(() => cases.value.filter((item) => isSubmissionCasePassed(item.status)).length)
const visibleCount = computed(() => cases.value.filter((item) => item.visibility === 'visible').length)
const hiddenCount = computed(() => cases.value.length - visibleCount.value)

const statusLabels: Record<string, string> = {
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
  return isSubmissionCasePassed(status)
    ? 'bg-green-50 text-success-text'
    : 'bg-red-50 text-error-text'
}
</script>

<template>
  <section
    v-if="cases.length"
    class="overflow-hidden rounded-xl border border-border bg-white"
    aria-labelledby="submission-case-results-title"
  >
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-page px-4 py-3">
      <div>
        <h2 id="submission-case-results-title" class="text-sm font-semibold text-text">测试点明细</h2>
        <p class="mt-1 text-xs text-text-muted">
          {{ passedCount }}/{{ cases.length }} 个测试点通过
          <span v-if="visibleCount"> · {{ visibleCount }} 个可见</span>
          <span v-if="hiddenCount"> · {{ hiddenCount }} 个隐藏</span>
        </p>
      </div>
      <UIcon name="i-lucide-list-checks" class="size-5 text-text-muted" />
    </div>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[680px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs font-semibold text-text-muted">
            <th scope="col" class="px-4 py-3">测试点</th>
            <th scope="col" class="px-4 py-3">状态</th>
            <th scope="col" class="px-4 py-3">耗时</th>
            <th scope="col" class="px-4 py-3">内存</th>
            <th scope="col" class="px-4 py-3">输出</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in cases" :key="`${item.visibility}-${item.caseId}`" class="border-b border-border last:border-0">
            <th scope="row" class="px-4 py-3 text-left font-mono text-xs font-medium text-text">
              {{ item.caseId }}
              <span v-if="item.visibility === 'hidden'" class="ml-1 text-[11px] font-sans text-text-muted">隐藏</span>
            </th>
            <td class="px-4 py-3">
              <span class="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold" :class="statusClass(item.status)">
                <UIcon :name="isSubmissionCasePassed(item.status) ? 'i-lucide-check' : 'i-lucide-x'" class="size-3.5" />
                {{ statusLabel(item.status) }}
              </span>
            </td>
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
              <details v-else-if="item.expectedOutput !== null || item.actualOutput !== null" class="max-w-[440px]">
                <summary class="cursor-pointer select-none text-primary hover:underline">查看期望与实际输出</summary>
                <div class="mt-2 grid gap-2 sm:grid-cols-2">
                  <div class="min-w-0">
                    <p class="mb-1 text-[11px] font-semibold text-text-muted">期望输出</p>
                    <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-page p-2 font-mono text-[11px] text-text">{{ item.expectedOutput ?? '--' }}</pre>
                  </div>
                  <div class="min-w-0">
                    <p class="mb-1 text-[11px] font-semibold text-text-muted">实际输出</p>
                    <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-page p-2 font-mono text-[11px] text-text">{{ item.actualOutput ?? '--' }}</pre>
                  </div>
                </div>
              </details>
              <span v-else>--</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
