<script setup lang="ts">
import type { Contest, KaggleRankingRow } from '~/composables/useContests'
import { extractApiError } from '~/utils/apiError'
import { formatDateTime } from '~/utils/submissionFormat'

const props = defineProps<{ contestId: string }>()
const { api } = useApi()
const rows = ref<KaggleRankingRow[]>([])

const { data: contestData, pending: contestPending } = await useFetch<{ data: Contest }>(
  `/api/v1/contests/${props.contestId}`,
  { server: false },
)
const contest = computed(() => contestData.value?.data ?? null)
const rankingError = ref('')
const rankingLoading = ref(true)
const officialSnapshot = ref<{ version: number; note: string; created_at: string } | null>(null)
const rankingView = ref<'live' | 'frozen' | 'official'>('live')
const settlementPending = ref(false)
const adminLive = ref(false)
const resultLabel = computed(() => officialSnapshot.value
  ? `正式成绩 · 版本 ${officialSnapshot.value.version}`
  : rankingView.value === 'frozen'
    ? '封榜冻结视图 · 待正式成绩发布'
    : rankingView.value === 'live' && settlementPending.value
      ? '管理员实时榜 · 待结算'
      : '实时成绩')

async function loadRanking() {
  rankingLoading.value = true
  rankingError.value = ''
  try {
    const response = await api.get<{
      data: KaggleRankingRow[]
      view?: 'live' | 'frozen' | 'official'
      settlement_pending?: boolean
      admin_live?: boolean
    }>(`/api/v1/contests/${props.contestId}/ranking`, { silent: true })
    rows.value = response.data
    rankingView.value = response.view ?? 'live'
    settlementPending.value = response.settlement_pending === true
    adminLive.value = response.admin_live === true
    if (contest.value?.status === 'ended') {
      try {
        const official = await api.get<{
          data: KaggleRankingRow[]
          snapshot: { version: number; note: string; created_at: string }
        }>(`/api/v1/contests/${props.contestId}/final-ranking`, { silent: true })
        rows.value = official.data
        officialSnapshot.value = official.snapshot
      } catch {
        officialSnapshot.value = null
      }
    } else {
      officialSnapshot.value = null
    }
  } catch (fetchError: unknown) {
    rankingError.value = extractApiError(fetchError).message
  } finally {
    rankingLoading.value = false
  }
}

onMounted(() => void loadRanking())

const { state: eventState } = useEventSource({
  url: `/api/v1/contests/${props.contestId}/events`,
  enabled: ref(true),
  onEvent: {
    'contest:ranking:snapshot': (payload) => {
      if (officialSnapshot.value) return
      const event = payload as { data?: KaggleRankingRow[]; view?: 'live' | 'frozen' | 'official'; settlement_pending?: boolean; admin_live?: boolean }
      if (event.data) rows.value = event.data
      if (event.view) rankingView.value = event.view
      settlementPending.value = event.settlement_pending === true
      adminLive.value = event.admin_live === true
    },
    'contest:ranking:updated': (payload) => {
      if (officialSnapshot.value) return
      const event = payload as { data?: KaggleRankingRow[]; view?: 'live' | 'frozen' | 'official'; settlement_pending?: boolean; admin_live?: boolean }
      if (event.data) rows.value = event.data
      if (event.view) rankingView.value = event.view
      settlementPending.value = event.settlement_pending === true
      adminLive.value = event.admin_live === true
    },
  },
  fetchFn: loadRanking,
  fallbackIntervalMs: 5000,
})

const problemLabels = computed(() => {
  const first = rows.value[0]
  if (!first) return []
  return first.problem_scores.map((item) => item.label)
})

function score(value: number) {
  return (value / 100).toFixed(value % 100 === 0 ? 0 : 2)
}
</script>

<template>
  <div class="space-y-5">
    <header class="flex flex-wrap items-center gap-4 rounded-2xl bg-bg-dark px-6 py-6 text-white shadow-card">
      <UIcon name="i-lucide-trophy" class="text-amber-300 size-6" />
      <div class="min-w-0 flex-1"><h1 class="truncate text-xl font-bold">{{ contest?.title || '竞赛排名' }}</h1><p class="mt-1 text-xs text-slate-400">{{ resultLabel }} · 总分优先，同分按最后一次刷新最高分的时间排序</p></div>
      <div class="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs text-slate-300"><UIcon name="i-lucide-radio" :class="eventState === 'connected' ? 'text-green-400' : 'text-amber-300'" class="size-3" />{{ eventState === 'connected' ? '实时更新' : eventState === 'fallback' ? '轮询更新' : '正在连接' }}</div>
      <button class="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-2 text-xs hover:bg-white/10" @click="loadRanking"><UIcon name="i-lucide-refresh-cw" class="size-3.5" />刷新</button>
    </header>

    <div v-if="officialSnapshot" class="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <UIcon name="i-lucide-lock-keyhole" class="size-4" />
      <span>这是已冻结的正式成绩（版本 {{ officialSnapshot.version }}，发布于 {{ formatDateTime(officialSnapshot.created_at) }}）。后续重测不会覆盖此版本。</span>
    </div>
    <div v-if="adminLive" class="flex flex-wrap items-center gap-2 rounded-xl border border-purple-200 bg-purple-50 px-4 py-3 text-sm text-purple-900">
      <UIcon name="i-lucide-eye" class="size-4" />
      <span>管理员实时完整榜：此视图仅供结算与复核，不代表已向参赛者公开的成绩。</span>
    </div>
    <div v-else-if="rankingView === 'frozen'" class="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <UIcon name="i-lucide-lock-keyhole" class="size-4" />
      <span>当前为服务端封榜冻结视图，封榜期间的新提交与评测不会改变此榜单。</span>
    </div>
    <div v-else-if="rankingView === 'live' && settlementPending" class="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      <UIcon name="i-lucide-shield-check" class="size-4" />
      <span>管理员实时榜：比赛已结束但正式成绩仍在待结算，当前数据不会对普通参赛者公开。</span>
    </div>

    <div v-if="rankingError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-error-text">{{ rankingError }}</div>

    <div class="overflow-x-auto rounded-2xl border border-border bg-white shadow-sm">
      <div v-if="contestPending || rankingLoading" class="py-20 text-center text-sm text-text-muted">排名计算中...</div>
      <div v-else-if="rows.length === 0" class="py-20 text-center text-sm text-text-muted">暂无排名数据</div>
      <table v-else class="w-full min-w-[760px] border-collapse">
        <thead>
          <tr class="border-b border-border bg-bg-page text-left text-xs font-semibold uppercase tracking-wide text-text-muted">
            <th class="px-4 py-3 text-center">排名</th>
            <th class="px-4 py-3">参赛者</th>
            <th v-for="labelName in problemLabels" :key="labelName" class="px-3 py-3 text-center">{{ labelName }}</th>
            <th class="px-4 py-3 text-center">总分</th>
            <th class="px-4 py-3 text-center">最后刷新</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.user_id" class="border-b border-border last:border-0 hover:bg-bg-page">
            <td class="px-4 py-4 text-center"><span class="inline-flex size-8 items-center justify-center rounded-full font-mono text-sm font-bold" :class="row.rank <= 3 ? 'bg-amber-100 text-amber-800' : 'text-text-secondary'">{{ row.rank }}</span></td>
            <td class="px-4 py-4"><UserIdentity :user="{ id: row.user_id, username: row.username, avatar_url: row.avatar_url }" size="sm" /></td>
            <td v-for="detail in row.problem_scores" :key="detail.label" class="px-3 py-4 text-center">
              <span class="text-sm font-semibold" :class="detail.best_score > 0 ? 'text-success-text' : 'text-text-muted'">{{ score(detail.best_score) }}</span>
              <div v-if="detail.attempts" class="text-[10px] text-text-muted">{{ detail.attempts }} 次</div>
            </td>
            <td class="px-4 py-4 text-center text-lg font-bold text-text">{{ score(row.total_score) }}</td>
            <td class="px-4 py-4 text-center font-mono text-xs text-text-secondary">{{ row.last_submission_at ? formatDateTime(row.last_submission_at) : '--' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
