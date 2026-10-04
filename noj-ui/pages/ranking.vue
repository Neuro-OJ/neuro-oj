<script setup lang="ts">
import { formatAcceptanceRate } from "~/utils/submissionFormat";
import type { RankingRow } from "~/composables/useRankings"
import { normalizeMonth } from "~/utils/checkinCalendar"

definePageMeta({
  // 公开页面，无需登录（OJ 榜单标准）
})

const route = useRoute()
const router = useRouter()
const { user: currentUser, isLoggedIn } = useAuth()

const page = computed<number>(() => {
  const raw = route.query.page
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})

const limit = 50

const { data, pending, error, refresh } = useRankings(page, limit)

const rows = computed<RankingRow[]>(() => data.value?.data ?? [])
const total = computed<number>(() => data.value?.pagination.total ?? 0)
const totalPages = computed<number>(() => {
  if (total.value === 0) return 0
  return Math.ceil(total.value / limit)
})

function setPage(p: number) {
  router.push({ query: { ...route.query, page: String(p) } })
}

// 榜单切换（#580）：`?board=checkin` 为签到活跃榜，缺省为解题榜
// UTabs v-model 类型为 string | number，这里用 string 承接
const board = computed<string>({
  get: () => (route.query.board === "checkin" ? "checkin" : "solved"),
  // 切换榜单时重置页码与月份，避免沿用另一榜单的分页
  set: (value: string) => {
    router.push({ query: value === "checkin" ? { board: "checkin" } : {} })
  },
})
const boardItems = [
  { label: "解题榜", value: "solved", icon: "i-lucide-trophy" },
  { label: "签到活跃榜", value: "checkin", icon: "i-lucide-calendar-check" },
]

const checkinMonth = computed(() => normalizeMonth(route.query.month))
function setCheckinMonth(month: string) {
  router.push({ query: { board: "checkin", month } })
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[960px] mx-auto">
    <div class="flex items-center justify-between mb-6">
      <div class="flex items-center gap-3">
        <div class="flex size-10 items-center justify-center rounded-lg bg-primary-bg text-primary border border-primary/20 shadow-xs">
          <UIcon name="i-lucide-trophy" class="size-5" />
        </div>
        <div>
          <h1 class="text-2xl font-bold text-text leading-tight">全站榜单</h1>
          <p class="text-xs text-text-muted mt-0.5">解题成就与每月签到活跃排行榜</p>
        </div>
      </div>
      <span v-if="board === 'solved'" class="text-xs text-text-muted px-2.5 py-1 rounded-md bg-bg-sunken border border-border tabular-nums font-mono">共 {{ total }} 位上榜选手</span>
    </div>

    <UTabs v-model="board" :items="boardItems" :content="false" class="mb-5 w-fit" />

    <!-- 签到活跃榜 -->
    <CheckinLeaderboard
      v-if="board === 'checkin'"
      :month="checkinMonth"
      :page="page"
      @update:month="setCheckinMonth"
      @update:page="setPage"
    />

    <!-- 解题榜 -->
    <AsyncContent
      v-else
      :status="pending ? 'loading' : error ? 'error' : rows.length === 0 ? 'empty' : 'data'"
      error="榜单加载失败"
      @retry="refresh"
    >
      <template #loading>
        <TableSkeleton :rows="10" :columns="['w-16', 'flex-1', 'w-16', 'w-20', 'w-20']" />
      </template>
      <template #empty>
        <UIcon name="i-lucide-trophy" class="opacity-30 size-[48px]" />
        <p>还没有用户通过任何题目，来做第一个吧</p>
        <UButton color="primary" class="px-4 py-1.5 text-xs" to="/problems">去做题</UButton>
      </template>

      <!-- 榜单表格 -->
      <div class="bg-white border border-border rounded-lg shadow-card overflow-x-auto">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" class="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-bg-sunken/60 border-b border-border">排名</th>
              <th scope="col" class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-bg-sunken/60 border-b border-border">选手</th>
              <th scope="col" class="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-right bg-bg-sunken/60 border-b border-border">解题数</th>
              <th scope="col" class="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-right bg-bg-sunken/60 border-b border-border hidden sm:table-cell">通过率</th>
              <th scope="col" class="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-right bg-bg-sunken/60 border-b border-border hidden sm:table-cell">总提交</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="row in rows"
              :key="row.user_id"
              :class="[
                'transition-colors duration-150',
                isLoggedIn && currentUser?.id === row.user_id
                  ? 'bg-signal/5 hover:bg-signal/10 ring-1 ring-inset ring-signal/30'
                  : row.rank === 1
                  ? 'bg-amber-500/[0.03] hover:bg-amber-500/[0.06]'
                  : row.rank === 2
                  ? 'bg-slate-500/[0.02] hover:bg-slate-500/[0.05]'
                  : row.rank === 3
                  ? 'bg-orange-500/[0.02] hover:bg-orange-500/[0.05]'
                  : 'hover:bg-bg-sunken/40',
              ]"
            >
              <td class="w-24 px-4 py-3.5">
                <RankBadge :rank="row.rank" />
              </td>
              <td class="px-4 py-3.5">
                <UserIdentity :user="{ id: row.user_id, username: row.username, avatar_url: row.avatar_url }" size="sm" />
              </td>
              <td class="w-24 px-4 py-3.5 text-right text-base font-bold text-primary tabular-nums">
                {{ row.solved_count }}
              </td>
              <td class="w-24 px-4 py-3.5 text-right text-sm text-text-secondary tabular-nums hidden sm:table-cell">
                {{ formatAcceptanceRate(row.acceptance_rate) }}
              </td>
              <td class="w-24 px-4 py-3.5 text-right text-sm text-text-secondary tabular-nums hidden sm:table-cell">
                {{ row.total_submissions }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <PaginationNav
        :current-page="page"
        :total-pages="totalPages"
        @page-change="setPage($event)"
      />
    </AsyncContent>
  </div>
</template>
