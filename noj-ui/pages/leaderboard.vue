<script setup lang="ts">
import { formatAcceptanceRate } from '~/utils/domain/submission/submissionFormat';
import type { RankingRow } from '~/composables/useRankings';
import { normalizeMonth } from '~/utils/domain/community/checkinCalendar';

definePageMeta({
  // 公开页面，无需登录（OJ 榜单标准）
});

const route = useRoute();
const router = useRouter();
const { user: currentUser, isLoggedIn } = useAuth();

const page = computed<number>(() => {
  const raw = route.query.page;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
});

const limit = 50;

const { data, pending, error, refresh } = useRankings(page, limit);

const rows = computed<RankingRow[]>(() => data.value?.data ?? []);
const total = computed<number>(() => data.value?.pagination.total ?? 0);
const totalPages = computed<number>(() => {
  if (total.value === 0) return 0;
  return Math.ceil(total.value / limit);
});

function setPage(p: number) {
  router.push({ query: { ...route.query, page: String(p) } });
}

// 榜单切换（#580）：`?board=checkin` 为签到活跃榜，缺省为解题榜
// UTabs v-model 类型为 string | number，这里用 string 承接
const board = computed<string>({
  get: () => (route.query.board === 'checkin' ? 'checkin' : 'solved'),
  // 切换榜单时重置页码与月份，避免沿用另一榜单的分页
  set: (value: string) => {
    router.push({ query: value === 'checkin' ? { board: 'checkin' } : {} });
  },
});
const boardItems = [
  { label: '解题榜', value: 'solved', icon: 'i-lucide-trophy' },
  { label: '签到活跃榜', value: 'checkin', icon: 'i-lucide-calendar-check' },
];

const checkinMonth = computed(() => normalizeMonth(route.query.month));
function setCheckinMonth(month: string) {
  router.push({ query: { board: 'checkin', month } });
}
</script>

<template>
  <div class="mx-auto max-w-[1440px] space-y-3 px-4 pt-4 pb-8 sm:px-6">
    <LibraryPageHeader title="全站榜单" description="解题成就与每月签到活跃排行榜"
      :count="board === 'solved' ? `${total} 人上榜` : undefined" />

    <UTabs v-model="board" :items="boardItems" :content="false" class="w-fit" />

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
        <p>还没有用户通过任何题目，来做第一个吧</p>
        <UButton size="xs" to="/problems">去做题</UButton>
      </template>

      <!-- 榜单表格 -->
      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th scope="col"
                class="w-24 px-3 py-2 text-xs font-medium text-text-muted text-left bg-bg-sunken/60 border-b border-border">排名</th>
              <th scope="col"
                class="px-3 py-2 text-xs font-medium text-text-muted text-left bg-bg-sunken/60 border-b border-border">选手</th>
              <th scope="col"
                class="w-24 px-3 py-2 text-xs font-medium text-text-muted text-right bg-bg-sunken/60 border-b border-border">解题数</th>
              <th scope="col"
                class="w-24 px-3 py-2 text-xs font-medium text-text-muted text-right bg-bg-sunken/60 border-b border-border hidden sm:table-cell">通过率</th>
              <th scope="col"
                class="w-24 px-3 py-2 text-xs font-medium text-text-muted text-right bg-bg-sunken/60 border-b border-border hidden sm:table-cell">总提交</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="row in rows"
              :key="row.user_id"
              :class="[
                                isLoggedIn && currentUser?.id === row.user_id
                  ? 'bg-primary-bg/60'
                  : 'hover:bg-bg-sunken/40',
              ]"
            >
              <td class="w-24 px-3 py-1.5">
                <RankBadge :rank="row.rank" />
              </td>
              <td class="px-3 py-1.5">
                <UserIdentity :user="{ id: row.user_id, username: row.username, avatar_url: row.avatar_url }"
                  size="sm" />
              </td>
              <td class="w-24 px-3 py-1.5 text-right font-mono font-medium text-text tabular-nums">
                {{ row.solved_count }}
              </td>
              <td class="w-24 px-3 py-1.5 text-right font-mono text-text-secondary tabular-nums hidden sm:table-cell">
                {{ formatAcceptanceRate(row.acceptance_rate) }}
              </td>
              <td class="w-24 px-3 py-1.5 text-right font-mono text-text-secondary tabular-nums hidden sm:table-cell">
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
