<script setup lang="ts">
/**
 * 练习能力值榜（Best-30 Practice Rating，issue #810）。
 * 数据源 `GET /api/v1/rankings/practice-rating`；页码由父页面通过 URL query 驱动。
 */
import type { PracticeRatingLeaderboardRow } from '~/composables/useRankings';
import { getPracticeRatingTierMeta } from '~/utils/domain/ranking/practiceRatingFormat';

const props = defineProps<{ page: number }>();
const emit = defineEmits<{
  'update:page': [page: number];
}>();

const { user: currentUser, isLoggedIn } = useAuth();

const perPage = 50;
const page = computed(() => props.page);
const { data, pending, error, refresh } = usePracticeRatingRankings(page, perPage);

const rows = computed<PracticeRatingLeaderboardRow[]>(() => data.value?.data ?? []);
const total = computed(() => data.value?.pagination.total ?? 0);
const totalPages = computed(() => data.value?.pagination.total_pages ?? 0);
const userRank = computed(() => data.value?.user_rank ?? null);
const userRating = computed(() => data.value?.user_rating ?? null);
</script>

<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
      <span>基于官方主域公开题库 Best 30 有效最高分计算（与竞赛 Rating 独立）</span>
      <div class="flex items-center gap-3">
        <span
          v-if="isLoggedIn && userRank !== null && userRating !== null"
          class="font-mono text-text-secondary tabular-nums"
        >
          我的名次 #{{ userRank }} · {{ userRating }} 分
        </span>
        <span class="font-mono tabular-nums">共 {{ total }} 人上榜</span>
      </div>
    </div>

    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : rows.length === 0 ? 'empty' : 'data'"
      error="练习能力值榜加载失败"
      @retry="refresh"
    >
      <template #loading>
        <TableSkeleton :rows="10" :columns="['w-16', 'flex-1', 'w-20', 'w-24', 'w-24', 'w-24']" />
      </template>
      <template #empty>
        <p>还没有用户产生练习能力值记录，去主域题库做题吧</p>
        <UButton size="xs" to="/problems">去做题</UButton>
      </template>

      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th
                scope="col"
                class="w-20 px-3 py-2 text-xs font-medium text-text-muted text-left bg-bg-sunken/60 border-b border-border"
              >
                排名
              </th>
              <th
                scope="col"
                class="px-3 py-2 text-xs font-medium text-text-muted text-left bg-bg-sunken/60 border-b border-border"
              >
                选手
              </th>
              <th
                scope="col"
                class="w-24 px-3 py-2 text-xs font-medium text-text-muted text-left bg-bg-sunken/60 border-b border-border"
              >
                段位
              </th>
              <th
                scope="col"
                class="w-28 px-3 py-2 text-xs font-medium text-text-muted text-right bg-bg-sunken/60 border-b border-border"
              >
                练习能力值
              </th>
              <th
                scope="col"
                class="w-24 px-3 py-2 text-xs font-medium text-text-muted text-right bg-bg-sunken/60 border-b border-border hidden sm:table-cell"
              >
                B30 题数
              </th>
              <th
                scope="col"
                class="w-28 px-3 py-2 text-xs font-medium text-text-muted text-right bg-bg-sunken/60 border-b border-border hidden sm:table-cell"
              >
                最高单题分
              </th>
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
              <td class="w-20 px-3 py-1.5">
                <RankBadge :rank="row.rank" />
              </td>
              <td class="px-3 py-1.5">
                <UserIdentity
                  :user="{ id: row.user_id, username: row.username, avatar_url: row.avatar_url }"
                  size="sm"
                />
              </td>
              <td class="w-24 px-3 py-1.5">
                <span
                  class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
                  :class="getPracticeRatingTierMeta(row.tier).badgeClass"
                >
                  {{ getPracticeRatingTierMeta(row.tier).label }}
                </span>
              </td>
              <td
                class="w-28 px-3 py-1.5 text-right font-mono font-semibold tabular-nums"
                :class="getPracticeRatingTierMeta(row.tier).scoreClass"
              >
                {{ row.rating }}
              </td>
              <td class="w-24 px-3 py-1.5 text-right font-mono text-text-secondary tabular-nums hidden sm:table-cell">
                {{ row.counted_problems }} / 30
              </td>
              <td class="w-28 px-3 py-1.5 text-right font-mono text-text-secondary tabular-nums hidden sm:table-cell">
                {{ row.top_problem_rating }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PaginationNav
        :current-page="props.page"
        :total-pages="totalPages"
        @page-change="emit('update:page', $event)"
      />
    </AsyncContent>
  </div>
</template>
