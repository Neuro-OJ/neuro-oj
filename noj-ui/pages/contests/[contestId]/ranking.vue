<script setup lang="ts">
import type { Contest, IcpcRankingRow, ScoreRankingRow } from '~/composables/useContests'
import { extractApiError } from '~/utils/apiError'

const route = useRoute()
const contestId = route.params.contestId as string
const { isLoggedIn } = useAuth()
const { api } = useApi()
const rows = ref<Array<IcpcRankingRow | ScoreRankingRow>>([])

const { data: contestData, pending: contestPending } = await useFetch<{ data: Contest }>(
  `/api/v1/contests/${contestId}`,
  { server: false },
)
const contest = computed(() => contestData.value?.data ?? null)
const rankingError = ref('')
const rankingLoading = ref(true)

async function loadRanking() {
  rankingLoading.value = true
  rankingError.value = ''
  try {
    const response = await api.get<{ data: Array<IcpcRankingRow | ScoreRankingRow> }>(`/api/v1/contests/${contestId}/ranking`, { silent: true })
    rows.value = response.data
  } catch (fetchError: unknown) {
    rankingError.value = extractApiError(fetchError).message
  } finally {
    rankingLoading.value = false
  }
}

onMounted(() => void loadRanking())

const eventEnabled = computed(() => !!contest.value && !(contest.value.type === 'oi' && contest.value.status === 'running' && !isLoggedIn.value))
const { state: eventState } = useEventSource({
  url: `/api/v1/contests/${contestId}/events`,
  enabled: eventEnabled,
  onEvent: {
    'contest:ranking:snapshot': (payload) => {
      const event = payload as { data?: Array<IcpcRankingRow | ScoreRankingRow> }
      if (event.data) rows.value = event.data
    },
    'contest:ranking:updated': (payload) => {
      const event = payload as { data?: Array<IcpcRankingRow | ScoreRankingRow> }
      if (event.data) rows.value = event.data
    },
  },
  fetchFn: loadRanking,
  fallbackIntervalMs: 5000,
})

const isIcpc = computed(() => contest.value?.type === 'icpc')
const problemLabels = computed(() => {
  const first = rows.value[0]
  if (!first) return []
  return 'problem_details' in first ? first.problem_details.map((item) => item.label) : first.problem_scores.map((item) => item.label)
})

function score(value: number) {
  return (value / 100).toFixed(value % 100 === 0 ? 0 : 2)
}
</script>

<template>
  <div class="min-h-full bg-bg-page py-8">
    <div class="mx-auto max-w-[960px] space-y-5 px-4 sm:px-7">
      <header class="flex flex-wrap items-center gap-4 rounded-2xl bg-bg-dark px-6 py-6 text-white shadow-card">
        <NuxtLink :to="`/contests/${contestId}`" class="inline-flex items-center gap-1.5 text-sm text-slate-300 no-underline hover:text-white"><UIcon name="i-lucide-arrow-left" class="size-4" />返回竞赛</NuxtLink>
        <div class="h-8 w-px bg-white/15" />
        <UIcon name="i-lucide-trophy" class="text-amber-300 size-6" />
        <div class="min-w-0 flex-1"><h1 class="truncate text-xl font-bold">{{ contest?.title || '竞赛排名' }}</h1><p class="mt-1 text-xs text-slate-400">{{ isIcpc ? '解题数优先，其次按罚时排序' : '总分优先，同分按总耗时排序' }}</p></div>
        <div class="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs text-slate-300"><UIcon name="i-lucide-radio" :class="eventState === 'connected' ? 'text-green-400' : 'text-amber-300'" class="size-3" />{{ eventState === 'connected' ? '实时更新' : eventState === 'fallback' ? '轮询更新' : '正在连接' }}</div>
        <button class="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-2 text-xs hover:bg-white/10" @click="loadRanking"><UIcon name="i-lucide-refresh-cw" class="size-3.5" />刷新</button>
      </header>

      <div v-if="contest?.type === 'oi' && contest.status === 'running'" class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-warning-text">OI 竞赛进行期间仅显示你自己的排名，竞赛结束后公开完整榜单。</div>
      <div v-if="rankingError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-error-text">{{ rankingError }}</div>

      <div class="overflow-x-auto rounded-2xl border border-border bg-white shadow-sm">
        <div v-if="contestPending || rankingLoading" class="py-20 text-center text-sm text-text-muted">排名计算中...</div>
        <div v-else-if="rows.length === 0" class="py-20 text-center text-sm text-text-muted">暂无排名数据</div>
        <table v-else class="w-full min-w-[760px] border-collapse">
          <thead><tr class="border-b border-border bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-text-muted"><th class="px-4 py-3 text-center">排名</th><th class="px-4 py-3">参赛者</th><th v-for="labelName in problemLabels" :key="labelName" class="px-3 py-3 text-center">{{ labelName }}</th><th class="px-4 py-3 text-center">{{ isIcpc ? '解题' : '总分' }}</th><th class="px-4 py-3 text-center">{{ isIcpc ? '罚时' : '耗时' }}</th></tr></thead>
          <tbody>
            <tr v-for="row in rows" :key="row.user_id" class="border-b border-border last:border-0 hover:bg-bg-page">
              <td class="px-4 py-4 text-center"><span class="inline-flex size-8 items-center justify-center rounded-full font-mono text-sm font-bold" :class="row.rank <= 3 ? 'bg-amber-100 text-amber-800' : 'text-text-secondary'">{{ row.rank }}</span></td>
              <td class="px-4 py-4"><NuxtLink :to="`/users/${row.user_id}`" class="font-semibold text-text no-underline hover:text-primary">{{ row.username }}</NuxtLink></td>
              <template v-if="'problem_details' in row"><td v-for="detail in row.problem_details" :key="detail.label" class="px-3 py-4 text-center"><span class="inline-flex min-w-12 flex-col rounded-md px-2 py-1 text-xs" :class="detail.solved ? 'bg-green-50 text-success-text' : detail.attempts ? 'bg-red-50 text-error-text' : 'text-text-muted'"><strong>{{ detail.solved ? `${detail.solve_time_minutes ?? 0}m` : detail.attempts ? `-${detail.attempts}` : '·' }}</strong><span v-if="detail.solved && detail.attempts">+{{ detail.attempts }}</span></span></td></template>
              <template v-else><td v-for="detail in row.problem_scores" :key="detail.label" class="px-3 py-4 text-center"><span class="text-sm font-semibold" :class="detail.best_score > 0 ? 'text-success-text' : 'text-text-muted'">{{ score(detail.best_score) }}</span><div v-if="detail.attempts" class="text-[10px] text-text-muted">{{ detail.attempts }} 次</div></td></template>
              <td class="px-4 py-4 text-center text-lg font-bold text-text">{{ 'solved' in row ? row.solved : score(row.total_score) }}</td>
              <td class="px-4 py-4 text-center font-mono text-sm text-text-secondary">{{ 'penalty' in row ? `${row.penalty}m` : `${Math.floor(row.total_time_seconds / 60)}m` }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
