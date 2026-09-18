<script setup lang="ts">
import {
  caseBarWidth,
  formatFirstAcMedian,
  type ProblemStatsDetail,
  sortedStatusDistribution,
  topFailedCases,
} from '~/utils/problemStats'

const props = defineProps<{ stats: ProblemStatsDetail }>()

// 该组件与其使用者（CodingProblemEditor）均未接入 i18n（全仓约定：低频管理页面硬编码中文）
const statusRows = computed(() => sortedStatusDistribution(props.stats.status_distribution))
const failedCases = computed(() => topFailedCases(props.stats.case_failure_distribution))
const firstAcText = computed(() => formatFirstAcMedian(props.stats.first_ac_median_ms))
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">尝试人数</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">{{ stats.attempt_count }}</div>
      </div>
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">提交数</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">{{ stats.submit_count }}</div>
      </div>
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">通过数</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">{{ stats.accepted_count }}</div>
      </div>
      <div class="rounded-xl border border-border p-3">
        <div class="text-xs text-text-muted">首次通过中位耗时</div>
        <div class="mt-1 text-lg font-semibold tabular-nums text-text">{{ firstAcText }}</div>
      </div>
    </div>

    <p v-if="stats.truncated" class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
      样本已达上限（最近 {{ stats.window_days }} 天），实际数据更多，统计为近似值。
    </p>
    <p class="text-xs text-text-muted">
      基于最近 {{ stats.window_days }} 天的 {{ stats.sample_size }} 次提交。
    </p>

    <section>
      <h3 class="text-sm font-semibold text-text">评测状态分布</h3>
      <div v-if="statusRows.length" class="mt-2 space-y-1">
        <div v-for="[status, count] in statusRows" :key="status" class="flex items-center justify-between text-xs">
          <span class="text-text-secondary">{{ status }}</span>
          <span class="font-mono tabular-nums text-text">{{ count }}</span>
        </div>
      </div>
      <p v-else class="mt-2 text-xs text-text-muted">暂无数据</p>
    </section>

    <section>
      <h3 class="text-sm font-semibold text-text">用例失败分布</h3>
      <p class="mt-1 text-xs text-text-muted">失败次数最多的用例优先；隐藏用例已匿名化。</p>
      <div v-if="failedCases.length" class="mt-3 space-y-2">
        <div v-for="item in failedCases" :key="item.case_id">
          <div class="flex items-center justify-between text-xs">
            <code class="font-mono" :class="item.hidden ? 'italic text-text-muted' : 'text-text'">{{ item.case_id }}</code>
            <span class="font-mono tabular-nums text-text-secondary">{{ item.failed }}</span>
          </div>
          <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-sunken">
            <div
              class="h-full rounded-full"
              :class="item.hidden ? 'bg-border' : 'bg-signal'"
              :style="{ width: caseBarWidth(item.failed, stats.case_failure_distribution) }"
            />
          </div>
        </div>
      </div>
      <p v-else class="mt-2 text-xs text-text-muted">暂无数据</p>
    </section>
  </div>
</template>
