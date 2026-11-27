<script setup lang="ts">
/**
 * 签到活跃榜（issue #184 / #580）。
 * 数据源 `GET /api/v1/rankings/checkin`；月份与页码由父页面通过 URL query 驱动。
 */
import type { CheckinRankingRow } from '~/composables/useRankings';
import { currentUtcMonth, shiftMonth } from '~/utils/domain/community/checkinCalendar';

const props = defineProps<{ month: string; page: number }>();
const emit = defineEmits<{
  'update:month': [month: string];
  'update:page': [page: number];
}>();

const { user: currentUser, isLoggedIn } = useAuth();

const perPage = 50;
const month = computed(() => props.month);
const page = computed(() => props.page);
const { data, pending, error, refresh } = useCheckinRankings(month, page, perPage);

const rows = computed<CheckinRankingRow[]>(() => data.value?.data ?? []);
const total = computed(() => data.value?.pagination.total ?? 0);
const totalPages = computed(() => data.value?.pagination.total_pages ?? 0);
const userRank = computed(() => data.value?.user_rank ?? null);

// 不允许翻到未来月份（必然为空榜）
const isCurrentMonth = computed(() => props.month >= currentUtcMonth());
</script>

<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-1">
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-chevron-left"
          aria-label="上个月"
          @click="emit('update:month', shiftMonth(props.month, -1))"
        />
        <span
          class="min-w-[5.5rem] text-center font-mono text-[13px] font-medium text-text tabular-nums">{{ props.month }}</span>
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-chevron-right"
          aria-label="下个月"
          :disabled="isCurrentMonth"
          @click="emit('update:month', shiftMonth(props.month, 1))"
        />
        <span class="ml-1 text-xs text-text-muted">按 UTC 自然月统计</span>
      </div>
      <div class="flex items-center gap-2 text-xs text-text-muted">
        <span v-if="isLoggedIn && userRank !== null" class="font-mono text-text-secondary tabular-nums">
          我的名次 #{{ userRank }}
        </span>
        <span class="font-mono tabular-nums">共 {{ total }} 人签到</span>
      </div>
    </div>

    <AsyncContent
      :status="pending ? 'loading' : error ? 'error' : rows.length === 0 ? 'empty' : 'data'"
      error="签到榜加载失败"
      @retry="refresh"
    >
      <template #loading>
        <TableSkeleton :rows="10" :columns="['w-16', 'flex-1', 'w-20']" />
      </template>
      <template #empty>
        <p>该月还没有人签到</p>
      </template>

      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel">
        <table class="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th scope="col"
                class="w-24 px-3 py-2 text-xs font-medium text-text-muted text-left bg-bg-sunken/60 border-b border-border">排名</th>
              <th scope="col"
                class="px-3 py-2 text-xs font-medium text-text-muted text-left bg-bg-sunken/60 border-b border-border">选手</th>
              <th scope="col"
                class="w-28 px-3 py-2 text-xs font-medium text-text-muted text-right bg-bg-sunken/60 border-b border-border">签到天数</th>
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
                <UserIdentity :user="{ id: row.user_id, username: row.username }" size="sm" />
              </td>
              <td class="w-28 px-3 py-1.5 text-right font-mono font-medium text-text tabular-nums">
                {{ row.days }}
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
