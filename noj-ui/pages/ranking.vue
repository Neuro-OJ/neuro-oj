<script setup lang="ts">
import { Trophy } from "@lucide/vue"
import type { RankingRow } from "~/composables/useRankings"

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
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[960px] mx-auto">
    <div class="flex items-baseline gap-3 mb-6">
      <Trophy :size="22" class="text-primary self-center" />
      <h1 class="text-2xl font-bold text-text">榜单</h1>
      <span class="text-sm text-text-muted">共 {{ total }} 位上榜用户</span>
    </div>

    <!-- 异步内容 -->
    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : rows.length === 0 ? 'empty' : 'data'"
      error="榜单加载失败"
      @retry="refresh"
    >
      <template #empty>
        <Trophy :size="48" class="opacity-30" />
        <p>还没有用户通过任何题目，做第一个吧 👉</p>
        <NuxtLink to="/problems" class="btn btn-primary px-4 py-1.5 text-xs">去做题</NuxtLink>
      </template>

      <!-- 榜单表格 -->
      <div class="bg-white border border-border rounded-xl overflow-x-auto">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" class="w-20 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">排名</th>
              <th scope="col" class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-left bg-gray-50 border-b border-border">用户</th>
              <th scope="col" class="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-right bg-gray-50 border-b border-border">解题数</th>
              <th scope="col" class="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-right bg-gray-50 border-b border-border hidden sm:table-cell">通过率</th>
              <th scope="col" class="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-secondary text-right bg-gray-50 border-b border-border hidden sm:table-cell">提交数</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="row in rows"
              :key="row.user_id"
              :class="[
                'transition-colors duration-150',
                isLoggedIn && currentUser?.id === row.user_id
                  ? 'bg-primary/5 hover:bg-primary/10'
                  : 'hover:bg-gray-50',
              ]"
            >
              <td class="w-20 px-4 py-3.5">
                <span
                  class="inline-flex items-center justify-center min-w-[2.25rem] px-2 py-0.5 rounded-full text-sm font-bold tabular-nums"
                  :class="{
                    'bg-yellow-100 text-yellow-800': row.rank === 1,
                    'bg-gray-200 text-gray-700': row.rank === 2,
                    'bg-orange-100 text-orange-800': row.rank === 3,
                    'bg-gray-50 text-text-secondary': row.rank > 3,
                  }"
                >
                  #{{ row.rank }}
                </span>
              </td>
              <td class="px-4 py-3.5">
                <NuxtLink
                  :to="`/users/${row.user_id}`"
                  class="text-text no-underline font-medium hover:text-primary"
                >
                  {{ row.username }}
                </NuxtLink>
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