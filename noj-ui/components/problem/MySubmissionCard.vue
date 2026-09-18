<script setup lang="ts">
import type { SubmissionListItem } from '~/utils/submissionFormat'
import { formatScore, formatTime, getStatusColor, getStatusLabel } from '~/utils/submissionFormat'

/**
 * 「我的提交」卡片（#511，右栏）。
 *
 * 复用既有 `GET /api/v1/submissions?problem_id=<uuid>&per_page=1`（需登录）。
 * 未登录展示登录引导；请求失败静默降级为空态，不影响主内容渲染。
 */
const props = defineProps<{ problemId: string }>()

const { api } = useApi()
const { isLoggedIn } = useAuth()
const { locale } = useI18n()

const latest = ref<SubmissionListItem | null>(null)
const loading = ref(false)

watch(
  [() => props.problemId, isLoggedIn],
  async ([id, loggedIn]) => {
    if (!loggedIn || !id) {
      latest.value = null
      return
    }
    loading.value = true
    try {
      const res = await api.get<{ data: SubmissionListItem[] }>(
        `/api/v1/submissions?problem_id=${id}&per_page=1`,
        { silent: true },
      )
      latest.value = res.data?.[0] ?? null
    } catch {
      latest.value = null
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="rounded-xl border border-border bg-white p-5">
    <div class="mb-3 flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold text-text">我的提交</h2>
      <NuxtLink
        v-if="isLoggedIn"
        :to="`/submissions?problem_id=${problemId}`"
        class="text-xs font-medium text-primary no-underline hover:underline"
      >
        全部提交
      </NuxtLink>
    </div>

    <!-- 未登录：登录引导 -->
    <p v-if="!isLoggedIn" class="text-sm text-text-secondary">
      <NuxtLink to="/login" class="text-primary no-underline hover:underline">登录</NuxtLink>
      后查看本题的提交记录。
    </p>

    <p v-else-if="loading" class="text-sm text-text-muted">加载中…</p>

    <!-- 无提交：空态 -->
    <p v-else-if="!latest" class="text-sm text-text-secondary">你还没有提交过本题。</p>

    <!-- 最近一次提交 -->
    <NuxtLink
      v-else
      :to="`/submissions/${latest.public_id || latest.id}`"
      class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 no-underline transition-colors hover:border-signal/40"
    >
      <span class="flex flex-col gap-0.5">
        <span
          class="text-xs font-semibold"
          :style="{ color: getStatusColor(latest.status, latest.result?.status) }"
        >
          {{ getStatusLabel(latest.status, latest.result?.status, locale) }}
        </span>
        <span class="text-xs text-text-muted">{{ latest.language }}</span>
      </span>
      <span class="flex flex-col items-end gap-0.5 text-xs tabular-nums text-text-secondary">
        <span>{{ latest.result ? formatScore(latest.result.score) + ' 分' : '—' }}</span>
        <span>{{ latest.result ? formatTime(latest.result.time_ms) : '' }}</span>
      </span>
    </NuxtLink>
  </section>
</template>
